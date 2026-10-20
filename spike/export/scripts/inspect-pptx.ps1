# PPTX unpack validation (no python needed; PowerShell Expand-Archive)
# Checks: slide count / sldSz 16:9 exact / notes text / per-slide background image + pixel size
# Usage: powershell -File scripts/inspect-pptx.ps1 -Pptx out/export-cdp.pptx
# NOTE: keep comments ASCII-only. PowerShell 5.1 reads BOM-less .ps1 as ANSI and would merge
# lines if a UTF-8 Chinese comment ends the line.
param(
  [Parameter(Mandatory = $true)][string]$Pptx,
  [string]$WorkDir = ''
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$Pptx = if ([System.IO.Path]::IsPathRooted($Pptx)) { $Pptx } else { Join-Path $root $Pptx }
if (-not (Test-Path $Pptx)) { throw "PPTX not found: $Pptx" }
if (-not $WorkDir) { $WorkDir = Join-Path $root 'out\unpacked' }
if (Test-Path $WorkDir) { Remove-Item $WorkDir -Recurse -Force }
New-Item -ItemType Directory -Path $WorkDir -Force | Out-Null

$zip = Join-Path $WorkDir 'deck.zip'
Copy-Item $Pptx $zip
Expand-Archive -Path $zip -DestinationPath (Join-Path $WorkDir 'x') -Force
$x = Join-Path $WorkDir 'x'

$presXml = [xml](Get-Content (Join-Path $x 'ppt\presentation.xml') -Raw -Encoding UTF8)
$sldSz = $presXml.presentation.sldSz
$slides = Get-ChildItem (Join-Path $x 'ppt\slides') -Filter 'slide*.xml' | Sort-Object Name
$notes = Get-ChildItem (Join-Path $x 'ppt\notesSlides') -Filter 'notesSlide*.xml' -ErrorAction SilentlyContinue | Sort-Object Name
$media = Get-ChildItem (Join-Path $x 'ppt\media') -File -ErrorAction SilentlyContinue

# ---- notes text ----
$notesTexts = @()
foreach ($n in ($notes | Sort-Object { [int]($_.BaseName -replace '\D','') })) {
  $doc = [xml](Get-Content $n.FullName -Raw -Encoding UTF8)
  $texts = @()
  foreach ($t in $doc.GetElementsByTagName('a:t')) { $texts += $t.InnerText }
  $joined = ($texts -join ' ').Trim()
  $notesTexts += [pscustomobject]@{ file = $n.Name; text = $joined }
}

# ---- slide xml summary ----
$slideInfo = @()
foreach ($s in ($slides | Sort-Object { [int]($s.BaseName -replace '\D','') })) {
  $raw = Get-Content $s.FullName -Raw -Encoding UTF8
  $slideInfo += [pscustomobject]@{
    file       = $s.Name
    bytes      = (Get-Item $s.FullName).Length
    hasText    = ($raw -match '<a:t>')
    hasImageBg = ($raw -match 'blipFill|r:embed')
  }
}

# ---- media pixel size by magic bytes (not extension: pptxgenjs names JPEG bg as *.png) ----
$mediaInfo = @()
foreach ($m in $media) {
  $info = [pscustomobject]@{ file = $m.Name; bytes = $m.Length; format = $null; w = $null; h = $null }
  $bytes = [System.IO.File]::ReadAllBytes($m.FullName)
  if ($bytes.Length -gt 24 -and $bytes[0] -eq 0x89 -and $bytes[1] -eq 0x50 -and $bytes[2] -eq 0x4E -and $bytes[3] -eq 0x47) {
    # PNG IHDR big-endian: width@16, height@20
    $info.format = 'png'
    $info.w = ([int]$bytes[16] -shl 24) -bor ([int]$bytes[17] -shl 16) -bor ([int]$bytes[18] -shl 8) -bor [int]$bytes[19]
    $info.h = ([int]$bytes[20] -shl 24) -bor ([int]$bytes[21] -shl 16) -bor ([int]$bytes[22] -shl 8) -bor [int]$bytes[23]
  }
  elseif ($bytes.Length -gt 9 -and $bytes[0] -eq 0xFF -and $bytes[1] -eq 0xD8) {
    # JPEG: scan SOF0..SOF3 / C5-C7 / C9-CB / CD-CF frame headers
    $info.format = 'jpeg'
    $i = 2
    while ($i -lt ($bytes.Length - 9)) {
      if ($bytes[$i] -ne 0xFF) { $i++; continue }
      $marker = $bytes[$i + 1]
      if ($marker -eq 0xD8 -or $marker -eq 0xD9) { $i += 2; continue }
      $segLen = ([int]$bytes[$i + 2] -shl 8) -bor [int]$bytes[$i + 3]
      $isSof = (($marker -ge 0xC0) -and ($marker -le 0xC3)) -or (($marker -ge 0xC5) -and ($marker -le 0xC7)) -or (($marker -ge 0xC9) -and ($marker -le 0xCB)) -or (($marker -ge 0xCD) -and ($marker -le 0xCF))
      if ($isSof) {
        $info.h = ([int]$bytes[$i + 5] -shl 8) -bor [int]$bytes[$i + 6]
        $info.w = ([int]$bytes[$i + 7] -shl 8) -bor [int]$bytes[$i + 8]
        break
      }
      $i += 2 + $segLen
    }
  }
  $mediaInfo += $info
}

$result = [pscustomobject]@{
  ok         = ($slides.Count -ge 1 -and $sldSz.cx -eq '12192000' -and $sldSz.cy -eq '6858000')
  pptx       = $Pptx
  pptxBytes  = (Get-Item $Pptx).Length
  slideCount = $slides.Count
  sldSz      = @{ cx = $sldSz.cx; cy = $sldSz.cy; inches = "$([math]::Round([int]$sldSz.cx / 914400, 3)) x $([math]::Round([int]$sldSz.cy / 914400, 3))" }
  slides     = $slideInfo
  notes      = $notesTexts
  media      = $mediaInfo
}
$result | ConvertTo-Json -Depth 6
