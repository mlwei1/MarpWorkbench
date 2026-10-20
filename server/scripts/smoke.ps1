# MarpWorkbench 服务端冒烟测试（可重复）
# 用法：
#   powershell -ExecutionPolicy Bypass -File server/scripts/smoke.ps1
#   powershell -File server/scripts/smoke.ps1 -Exe target\release\MarpWorkbench.exe
# 说明：
#   - 使用独立临时数据目录（MWB_DATA_DIR）+ 固定端口，不污染用户真实数据；
#   - PowerShell 5.1 的 Invoke-RestMethod 会把无 charset 的 JSON 按 Latin-1 解码（中文乱码），
#     因此所有 API 调用统一走 curl.exe + UTF-8 显式解码。
param(
  [string]$Exe = "target\debug\MarpWorkbench.exe",
  [int]$Port = 18999,
  [switch]$KeepData
)
$ErrorActionPreference = 'Stop'
$script:Utf8 = New-Object System.Text.UTF8Encoding $false
$OutputEncoding = $script:Utf8
[Console]::OutputEncoding = $script:Utf8

$ServerRoot = Split-Path -Parent $PSScriptRoot
$ExePath = if ([System.IO.Path]::IsPathRooted($Exe)) { $Exe } else { Join-Path $ServerRoot $Exe }
if (-not (Test-Path $ExePath)) { throw "未找到 exe: $ExePath（先 cargo build）" }

$DataDir = Join-Path ([System.IO.Path]::GetTempPath()) ("mwb-smoke-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
$env:MWB_DATA_DIR = $DataDir
$env:MWB_PORT = "$Port"
$env:MWB_NO_OPEN = '1'

$script:Pass = 0
$script:Fail = 0
function Check($Name, $Condition, $Detail = '') {
  if ($Condition) { $script:Pass++; Write-Host ("  [PASS] " + $Name) }
  else { $script:Fail++; Write-Host ("  [FAIL] " + $Name + "  " + $Detail) -ForegroundColor Red }
}

# curl.exe 统一 API 调用（UTF-8 安全）；JsonBody 传 JSON 字符串
function Invoke-Mwb {
  param(
    [string]$Method,
    [string]$Path,
    $JsonBody = $null,
    [string[]]$Extra = @()
  )
  $outFile = [IO.Path]::GetTempFileName()
  $inFile = $null
  $argsList = @('-s', '-o', $outFile, '-w', '%{http_code}', '-X', $Method, '-H', "X-MWB-Token: $script:Token")
  if ($null -ne $JsonBody) {
    $inFile = [IO.Path]::GetTempFileName()
    [IO.File]::WriteAllText($inFile, [string]$JsonBody, $script:Utf8)
    $argsList += @('-H', 'Content-Type: application/json', '--data-binary', "@$inFile")
  }
  $argsList += $Extra
  $argsList += "$script:Base$Path"
  $statusText = (& curl.exe @argsList) | Select-Object -Last 1
  $text = ''
  if (Test-Path $outFile) { $text = [IO.File]::ReadAllText($outFile, $script:Utf8) }
  Remove-Item $outFile -Force -ErrorAction SilentlyContinue
  if ($null -ne $inFile) { Remove-Item $inFile -Force -ErrorAction SilentlyContinue }
  $json = $null
  if ($text) { try { $json = $text | ConvertFrom-Json } catch { $json = $null } }
  [pscustomobject]@{ Status = [int]$statusText; Text = $text; Json = $json }
}
function Json { param($Value) $Value | ConvertTo-Json -Depth 8 -Compress }

$proc = $null
try {
  Write-Host "== 启动服务 ==" -ForegroundColor Cyan
  $proc = Start-Process -FilePath $ExePath -ArgumentList '--no-open' -PassThru -WindowStyle Hidden

  $inst = $null
  for ($i = 0; $i -lt 100; $i++) {
    $instFile = Join-Path $DataDir 'instance.json'
    if (Test-Path $instFile) {
      try { $inst = Get-Content $instFile -Raw -Encoding UTF8 | ConvertFrom-Json } catch {}
      if ($inst) { break }
    }
    Start-Sleep -Milliseconds 100
  }
  if (-not $inst) { throw "服务未在 10s 内就绪（$DataDir）" }
  $script:Base = "http://127.0.0.1:$($inst.port)"
  $script:Token = $inst.token
  Check "instance.json 含 port/token" ($inst.port -gt 0 -and $inst.token.Length -ge 32) "port=$($inst.port)"
  Check "端口 = 指定端口" ($inst.port -eq $Port) "actual=$($inst.port) expected=$Port"

  # ---------- §1.1 health / browser ----------
  Write-Host "== §1.1 health / browser ==" -ForegroundColor Cyan
  $health = (Invoke-Mwb GET '/api/health').Json
  Check "health.ok" ($health.ok -eq $true)
  Check "health.app = MarpWorkbench" ($health.app -eq 'MarpWorkbench')
  Check "health.port" ($health.port -eq $Port)
  Check "health.workspaceRoot = 临时数据目录" ($health.workspaceRoot -eq $DataDir) "actual=$($health.workspaceRoot)"
  $browser = (Invoke-Mwb GET '/api/browser').Json
  Check "browser.usable 有可用浏览器" ($browser.usable -eq $true) ($browser | ConvertTo-Json -Compress)
  Check "browser.preferred 非空" ($null -ne $browser.preferred)

  # ---------- §1.2 settings ----------
  Write-Host "== §1.2 settings ==" -ForegroundColor Cyan
  $settings = (Invoke-Mwb GET '/api/settings').Json
  Check "settings 默认值" ($settings.defaultTheme -eq 'business-blue' -and $settings.autosaveMs -eq 800) ($settings | ConvertTo-Json -Compress)
  $settings2 = (Invoke-Mwb PUT '/api/settings' (Json @{ defaultTheme = 'tech-dark'; autosaveMs = 1000 })).Json
  Check "settings PUT 生效" ($settings2.defaultTheme -eq 'tech-dark' -and $settings2.autosaveMs -eq 1000)
  Check "settings.json 已落盘" (Test-Path (Join-Path $DataDir 'settings.json'))

  # ---------- §1.7 静态资源 ----------
  Write-Host "== §1.7 静态资源 ==" -ForegroundColor Cyan
  $page = & curl.exe -s -o (Join-Path $DataDir 'page.html') -w '%{http_code}' "$script:Base/"
  $pageText = [IO.File]::ReadAllText((Join-Path $DataDir 'page.html'), $script:Utf8)
  Check "GET / 返回 200 HTML" ($page -eq '200' -and $pageText -match '<html')
  $spa = & curl.exe -s -o NUL -w '%{http_code}' "$script:Base/edit/whatever"
  Check "SPA fallback /edit/:id" ($spa -eq '200') "actual=$spa"
  $spa2 = & curl.exe -s -o NUL -w '%{http_code}' "$script:Base/settings"
  Check "SPA fallback /settings" ($spa2 -eq '200') "actual=$spa2"

  # ---------- §1.3 deck CRUD ----------
  Write-Host "== §1.3 workspace / decks ==" -ForegroundColor Cyan
  $created = (Invoke-Mwb POST '/api/decks' (Json @{ name = '冒烟测试'; template = 'sample' })).Json
  Check "POST /api/decks 返回 id/content/rev" ($created.id -eq '冒烟测试' -and $created.content -match 'MarpWorkbench' -and $created.rev.Length -eq 16) ("id=" + $created.id + " rev=" + $created.rev)
  $deckId = $created.id
  $encId = [uri]::EscapeDataString($deckId)

  $workspace = (Invoke-Mwb GET '/api/workspace').Json
  Check "workspace.root" ($workspace.root -eq $DataDir)
  Check "workspace 列表包含新 deck" (@($workspace.decks | Where-Object { $_.id -eq $deckId }).Count -eq 1)
  Check "slides.md 已落盘" (Test-Path (Join-Path $DataDir "$deckId\slides.md"))

  $detail = (Invoke-Mwb GET "/api/decks/$encId").Json
  Check "GET deck 内容/rev 一致" ($detail.rev -eq $created.rev -and $detail.content -eq $created.content)

  $newContent = $created.content + "`n---`n`n## 追加页（冒烟）`n"
  $saved = (Invoke-Mwb PUT "/api/decks/$encId" (Json @{ content = $newContent; ifRev = $created.rev })).Json
  Check "PUT 保存返回新 rev/savedAt" ($saved.rev.Length -eq 16 -and $saved.rev -ne $created.rev -and $saved.savedAt) ("rev=" + $saved.rev)
  $reload = (Invoke-Mwb GET "/api/decks/$encId").Json
  Check "GET 读回内容与 rev" ($reload.content -eq $newContent -and $reload.rev -eq $saved.rev)

  $conflict = Invoke-Mwb PUT "/api/decks/$encId" (Json @{ content = 'old'; ifRev = $created.rev })
  Check "PUT 旧 ifRev → 409 CONFLICT" ($conflict.Status -eq 409) "actual=$($conflict.Status)"

  $renamed = (Invoke-Mwb POST "/api/decks/$encId/rename" (Json @{ name = '冒烟测试-改名' })).Json
  Check "rename 返回新 id" ($renamed.id -eq '冒烟测试-改名') "actual=$($renamed.id)"
  $encRenamed = [uri]::EscapeDataString($renamed.id)
  $recent = (Invoke-Mwb GET '/api/recent').Json
  Check "recent 含改名后的 deck" (@($recent | Where-Object { $_.id -eq $renamed.id }).Count -eq 1)
  $del = (Invoke-Mwb DELETE "/api/decks/$encRenamed").Json
  Check "DELETE deck ok" ($del.ok -eq $true)
  Check "删除进入 .trash" (@(Get-ChildItem (Join-Path $DataDir '.trash') -Directory -ErrorAction SilentlyContinue).Count -ge 1)

  # ---------- §1.4 assets ----------
  Write-Host "== §1.4 assets ==" -ForegroundColor Cyan
  $assetDeck = (Invoke-Mwb POST '/api/decks' (Json @{ name = '资源测试'; template = 'blank' })).Json
  $encAssetDeck = [uri]::EscapeDataString($assetDeck.id)
  $png = Join-Path $DataDir 'sample.png'
  [IO.File]::WriteAllBytes($png, [Convert]::FromBase64String('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='))
  $upload = (Invoke-Mwb POST "/api/decks/$encAssetDeck/assets" $null @('-F', "file=@$png")).Json
  Check "上传返回 path/url/bytes" ($upload.path -match '^assets/.+\.png$' -and $upload.url -match '/api/decks/' -and $upload.bytes -gt 0) ($upload | ConvertTo-Json -Compress)
  $assetStatus = & curl.exe -s -o NUL -w '%{http_code}|%{content_type}' -H "X-MWB-Token: $($script:Token)" "$script:Base$($upload.url)"
  Check "下载资源 200 + image/png" ($assetStatus -match '^200\|image/png') "actual=$assetStatus"
  $deckWithAsset = (Invoke-Mwb GET "/api/decks/$encAssetDeck").Json
  Check "GET deck assets 列表含上传文件" (@($deckWithAsset.assets).Count -eq 1)

  # ---------- §1.5 themes ----------
  Write-Host "== §1.5 themes ==" -ForegroundColor Cyan
  $list = (Invoke-Mwb GET '/api/themes').Json
  Check "GET /api/themes 返回 themes 数组" ($null -ne $list.themes) ("count=" + @($list.themes).Count)
  $css = "/* @theme smoke-theme */`n/* @name 冒烟主题 */`n/* @tags 测试,冒烟 */`n/* @size 16:9 1280px 720px */`nsection { background: #123456; color: #fff; }`n"
  $imported = (Invoke-Mwb POST '/api/themes' (Json @{ css = $css; fileName = 'smoke-theme.css' })).Json
  Check "导入主题 meta 解析" ($imported.name -eq 'smoke-theme' -and $imported.displayName -eq '冒烟主题' -and $imported.source -eq 'user' -and $imported.tags.Count -eq 2) ($imported | ConvertTo-Json -Compress)
  $list2 = (Invoke-Mwb GET '/api/themes').Json
  Check "主题列表含导入主题" (@($list2.themes | Where-Object { $_.name -eq 'smoke-theme' }).Count -eq 1)
  $cssStatus = & curl.exe -s -o (Join-Path $DataDir 'theme.css') -w '%{http_code}|%{content_type}' -H "X-MWB-Token: $($script:Token)" "$script:Base/api/themes/smoke-theme/css"
  Check "GET 主题 CSS 200 text/css" ($cssStatus -match '^200\|text/css') "actual=$cssStatus"
  $css2 = $css -replace '#123456', '#654321'
  $updated = (Invoke-Mwb PUT '/api/themes/smoke-theme' (Json @{ css = $css2 })).Json
  Check "PUT 更新主题" ($updated.name -eq 'smoke-theme')
  $bad = Invoke-Mwb POST '/api/themes' (Json @{ css = 'section { color: red; }' })
  Check "非法主题（缺 @theme）→ 400" ($bad.Status -eq 400) "actual=$($bad.Status)"
  $deletedTheme = (Invoke-Mwb DELETE '/api/themes/smoke-theme').Json
  Check "DELETE 用户主题" ($deletedTheme.ok -eq $true)

  # ---------- 鉴权 ----------
  Write-Host "== 鉴权 ==" -ForegroundColor Cyan
  $noToken = & curl.exe -s -o NUL -w '%{http_code}' "$script:Base/api/workspace"
  Check "无 token → 401" ($noToken -eq '401') "actual=$noToken"

  # ---------- 单实例 ----------
  Write-Host "== 单实例 ==" -ForegroundColor Cyan
  $second = Start-Process -FilePath $ExePath -ArgumentList '--no-open' -PassThru -WindowStyle Hidden
  $exited = $second.WaitForExit(15000)
  Check "第二实例自动退出" ($exited) ("exitCode=" + $second.ExitCode)
  $health2 = (Invoke-Mwb GET '/api/health').Json
  Check "原实例仍在运行（端口不变）" ($health2.port -eq $Port)

  # ---------- 退出 ----------
  Write-Host "== §1.1 shutdown ==" -ForegroundColor Cyan
  $sd = (Invoke-Mwb POST '/api/shutdown').Json
  Check "shutdown 返回 ok" ($sd.ok -eq $true)
  $procExited = $proc.WaitForExit(10000)
  Check "进程在 10s 内退出" ($procExited)
  Check "instance.json 已清理" (-not (Test-Path (Join-Path $DataDir 'instance.json')))
}
finally {
  if ($proc -and -not $proc.HasExited) { try { $proc.Kill() } catch {} }
  Remove-Item Env:\MWB_DATA_DIR, Env:\MWB_PORT, Env:\MWB_NO_OPEN -ErrorAction SilentlyContinue
  if (-not $KeepData) { Remove-Item -Recurse -Force $DataDir -ErrorAction SilentlyContinue }
  else { Write-Host "数据目录保留：$DataDir" }
}
Write-Host ""
Write-Host ("== 结果：PASS=" + $script:Pass + "  FAIL=" + $script:Fail + " ==") -ForegroundColor ($(if ($script:Fail -eq 0) { 'Green' } else { 'Red' }))
if ($script:Fail -gt 0) { exit 1 }
exit 0
