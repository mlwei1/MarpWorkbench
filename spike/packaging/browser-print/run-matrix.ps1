# Edge/Chrome headless 本地 HTTP 页面 → PDF 打印实测（可复现）
# 用法：pwsh -File browser-print/run-matrix.ps1
$ErrorActionPreference = 'Stop'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = Split-Path -Parent $Here
$Slides = Join-Path $Root 'slides'
$Out = Join-Path $Root 'out'
New-Item -ItemType Directory -Force -Path $Out | Out-Null

$Edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$Chrome = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
$Port = 18765
$env:PORT = "$Port"
$BaseUrl = "http://127.0.0.1:$Port"
$TempDir = [System.IO.Path]::GetTempPath()

$profDir = Join-Path $TempDir ("headless-profile-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $profDir | Out-Null

# 1) 启动静态服务
$srvOut = Join-Path $TempDir 'headless-serve-out.txt'
$srvErr = Join-Path $TempDir 'headless-serve-err.txt'
$srv = Start-Process -FilePath node -ArgumentList (Join-Path $Here 'serve.mjs') -PassThru -WindowStyle Hidden
$ready = $false
for ($i = 0; $i -lt 200; $i++) {
  try { $r = Invoke-WebRequest -Uri "$BaseUrl/" -UseBasicParsing -TimeoutSec 1; if ($r.StatusCode -eq 200) { $ready = $true; break } } catch { Start-Sleep -Milliseconds 25 }
}
if (-not $ready) { throw "本地 HTTP 服务未就绪：$(Get-Content $srvErr -Raw -ErrorAction SilentlyContinue)" }

function Run-Case {
  param($Exe, $Label, $Url, [string[]]$ExtraArgs = @(), $OutName, $TimeoutSec = 60)
  $outFile = Join-Path $Out $OutName
  if (Test-Path $outFile) { Remove-Item $outFile -Force }
  $args = @('--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-sync', '--disable-background-networking', '--disable-component-update', '--disable-breakpad',
    "--user-data-dir=$profDir", "--print-to-pdf=$outFile", '--virtual-time-budget=4000') + $ExtraArgs + @($Url)
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $p = Start-Process -FilePath $Exe -ArgumentList $args -PassThru -WindowStyle Hidden
  $exited = $p.WaitForExit($TimeoutSec * 1000)
  $sw.Stop()
  if (-not $exited) {
    try { $p.Kill() } catch {}
    try { & taskkill /PID $p.Id /T /F 2>$null | Out-Null } catch {}
  }
  $size = 0
  if (Test-Path $outFile) { $size = (Get-Item $outFile).Length }
  $errTail = ''
  [pscustomobject]@{
    name = $Label; browser = (Split-Path -Leaf $Exe); url = $Url
    exitCode = if ($exited) { $p.ExitCode } else { $null }
    timedOut = (-not $exited); elapsed_ms = $sw.ElapsedMilliseconds
    pdfExists = (Test-Path $outFile); pdfBytes = $size; stderrTail = $errTail
  }
}

$cases = @()
# 1) 主用例：Edge + 本地 HTTP + @page 1280x720
$cases += Run-Case -Exe $Edge -Label 'Edge headless HTTP deck (@page 1280x720, no header/footer)' -Url "$BaseUrl/deck.html" -ExtraArgs @('--no-pdf-header-footer') -OutName 'edge-deck-http.pdf' -TimeoutSec 20
# 2) Chrome 同参数
$cases += Run-Case -Exe $Chrome -Label 'Chrome headless HTTP deck (@page 1280x720, no header/footer)' -Url "$BaseUrl/deck.html" -ExtraArgs @('--no-pdf-header-footer') -OutName 'chrome-deck-http.pdf'
# 3) 对照：无 @page
$cases += Run-Case -Exe $Chrome -Label 'Chrome HTTP deck (control: no @page)' -Url "$BaseUrl/deck-no-page-css.html" -ExtraArgs @('--no-pdf-header-footer') -OutName 'chrome-no-page.pdf'
# 4) 对照：默认页眉页脚
$cases += Run-Case -Exe $Chrome -Label 'Chrome HTTP deck (control: default header/footer)' -Url "$BaseUrl/deck.html" -OutName 'chrome-header-footer.pdf'
# 5) 100 页性能
$cases += Run-Case -Exe $Chrome -Label 'Chrome HTTP deck-100 (performance)' -Url "$BaseUrl/deck-100.html" -ExtraArgs @('--no-pdf-header-footer') -OutName 'chrome-deck-100.pdf' -TimeoutSec 120
# 6) file:// 对照
$fileUrl = 'file:///' + ((Resolve-Path (Join-Path $Slides 'deck.html')).Path -replace '\\', '/')
$cases += Run-Case -Exe $Chrome -Label 'Chrome file:// deck (control)' -Url $fileUrl -ExtraArgs @('--no-pdf-header-footer') -OutName 'chrome-file.pdf'

try { $srv.Kill() } catch {}
$report = [pscustomobject]@{
  browserVersions = [pscustomobject]@{
    edge = (Get-Item $Edge).VersionInfo.ProductVersion
    chrome = (Get-Item $Chrome).VersionInfo.ProductVersion
  }
  port = $Port; cases = $cases; testedAt = (Get-Date).ToString('o')
}
$report | ConvertTo-Json -Depth 6 | Set-Content -Path (Join-Path $Out 'edge-export-report.json') -Encoding utf8
$report | ConvertTo-Json -Depth 6
