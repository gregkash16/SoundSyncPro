# Fetch the Windows binaries SoundSyncPro bundles: ffmpeg + ffprobe  ->  bin\win\
$ErrorActionPreference = "Stop"
$bin = Join-Path $PSScriptRoot "bin\win"
New-Item -ItemType Directory -Force $bin | Out-Null

if ((Test-Path "C:\ffmpeg\bin\ffmpeg.exe") -and (Test-Path "C:\ffmpeg\bin\ffprobe.exe")) {
  Write-Host "ffmpeg + ffprobe (from C:\ffmpeg\bin)..."
  Copy-Item "C:\ffmpeg\bin\ffmpeg.exe", "C:\ffmpeg\bin\ffprobe.exe" $bin -Force
} else {
  $tmp = Join-Path $env:TEMP "ssp-bins"
  New-Item -ItemType Directory -Force $tmp | Out-Null
  Write-Host "ffmpeg (gyan.dev essentials, ~100 MB)..."
  Invoke-WebRequest "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip" -OutFile "$tmp\ffmpeg.zip"
  Expand-Archive "$tmp\ffmpeg.zip" "$tmp\ffmpeg" -Force
  foreach ($n in "ffmpeg.exe", "ffprobe.exe") {
    $exe = Get-ChildItem "$tmp\ffmpeg" -Recurse -Filter $n | Select-Object -First 1
    Copy-Item $exe.FullName "$bin\$n" -Force
  }
  Remove-Item $tmp -Recurse -Force
}
Get-ChildItem $bin -Filter *.exe | Select-Object Name, @{n = "MB"; e = { [math]::Round($_.Length / 1MB, 1) } }
