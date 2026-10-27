# Build a signed ZXP of this extension for sharing.
# Usage:  .\build-zxp.ps1            (uses the version in CSXS\manifest.xml)
#         .\build-zxp.ps1 1.1.0      (bumps the manifest to that version first)
param([string]$Version)
$ErrorActionPreference = "Stop"

$root  = $PSScriptRoot
$tools = "$env:LOCALAPPDATA\cep-tools"
$sign  = "$tools\ZXPSignCmd.exe"
$cert  = "$tools\cep-selfsigned.p12"
$pwF   = "$tools\cep-selfsigned.pw"
$RequiredBins = @("ffmpeg.exe", "ffprobe.exe")

if (!(Test-Path $sign)) {
  New-Item -ItemType Directory -Force $tools | Out-Null
  Write-Host "Downloading ZXPSignCmd..."
  Invoke-WebRequest "https://raw.githubusercontent.com/Adobe-CEP/CEP-Resources/master/ZXPSignCMD/4.1.3/x64/ZXPSignCmd.exe" -OutFile $sign
}
if (!(Test-Path $cert)) {
  $chars = (48..57) + (65..90) + (97..122)
  $pw = -join ((1..24) | ForEach-Object { [char]($chars | Get-Random) })
  & $sign -selfSignedCert US NY "CEP Panels" "CEP Panels" $pw $cert
  if ($LASTEXITCODE -ne 0) { throw "certificate creation failed" }
  Set-Content -Path $pwF -Value $pw -NoNewline -Encoding ascii
  Write-Host "Created self-signed certificate $cert"
}
$pw = (Get-Content $pwF -Raw).Trim()

$manifestPath = "$root\CSXS\manifest.xml"
[xml]$m = Get-Content $manifestPath
$name = $m.ExtensionManifest.ExtensionBundleName
if ($Version) {
  $m.ExtensionManifest.ExtensionBundleVersion = $Version
  foreach ($e in $m.ExtensionManifest.ExtensionList.Extension) { $e.Version = $Version }
  $m.Save($manifestPath)
  Write-Host "Manifest bumped to $Version"
} else {
  $Version = $m.ExtensionManifest.ExtensionBundleVersion
}

foreach ($b in $RequiredBins) {
  if (!(Test-Path "$root\bin\win\$b")) { throw "bin\win\$b is missing - run get-bins.ps1 first; the ZXP must carry its own binaries" }
}

# Windows ZXP carries bin\win only. The Mac ZXP is built on a Mac with build-zxp.sh (Adobe: sign on the target platform).
$stage = Join-Path $env:TEMP "zxp-stage-$name"
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory $stage | Out-Null
foreach ($d in "CSXS", "client", "host") { Copy-Item "$root\$d" "$stage\$d" -Recurse }
New-Item -ItemType Directory "$stage\bin" | Out-Null
Copy-Item "$root\bin\win" "$stage\bin\win" -Recurse
Get-ChildItem "$stage\bin\win" -Force -Filter ".gitkeep" | Remove-Item -Force
foreach ($f in "README.md", "INSTALL.md") { if (Test-Path "$root\$f") { Copy-Item "$root\$f" $stage } }
Get-ChildItem $stage -Recurse -Force -Include ".DS_Store", "Thumbs.db", "*.part" | Remove-Item -Force

$dist = "$root\dist"
New-Item -ItemType Directory -Force $dist | Out-Null
$out = "$dist\$name-$Version-win.zxp"
if (Test-Path $out) { Remove-Item $out -Force }

Write-Host "Signing $out ..."
& $sign -sign $stage $out $cert $pw -tsa http://timestamp.digicert.com
if ($LASTEXITCODE -ne 0) {
  Write-Host "Timestamp server failed; signing without timestamp."
  & $sign -sign $stage $out $cert $pw
  if ($LASTEXITCODE -ne 0) { throw "signing failed" }
}
& $sign -verify $out
if ($LASTEXITCODE -ne 0) { throw "verify failed" }
Remove-Item $stage -Recurse -Force

$mb = [math]::Round((Get-Item $out).Length / 1MB, 1)
Write-Host ""
Write-Host "OK  $out  ($mb MB)"
