# Copyright 2026 Julien Bombled
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[a-p]{32}$')]
  [string]$ExtensionId
)

$ErrorActionPreference = 'Stop'

$HostName = 'com.mediaharvest.companion'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$BatchPath = Join-Path $ScriptDir 'media_harvest_host.bat'
if (-not (Test-Path -LiteralPath $BatchPath)) {
  throw "Missing host launcher: $BatchPath"
}

$AppDataDir = Join-Path $env:LOCALAPPDATA 'MediaHarvest'
New-Item -ItemType Directory -Path $AppDataDir -Force | Out-Null

$ManifestPath = Join-Path $AppDataDir "$HostName.json"
$ManifestObj = [ordered]@{
  name = $HostName
  description = 'Media Harvest Native Messaging companion for yt-dlp and ffmpeg'
  path = $BatchPath
  type = 'stdio'
  allowed_origins = @(
    "chrome-extension://$ExtensionId/"
  )
}
$ManifestJson = $ManifestObj | ConvertTo-Json -Depth 4
[System.IO.File]::WriteAllText($ManifestPath, $ManifestJson, [System.Text.UTF8Encoding]::new($false))

$RegistryPaths = @(
  "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName",
  "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$HostName"
)
foreach ($RegPath in $RegistryPaths) {
  New-Item -Path $RegPath -Force | Out-Null
  Set-ItemProperty -Path $RegPath -Name '(Default)' -Value $ManifestPath
}

$HasPython = [bool](Get-Command python -ErrorAction SilentlyContinue) -or [bool](Get-Command py -ErrorAction SilentlyContinue)
$HasYtDlp = [bool](Get-Command yt-dlp -ErrorAction SilentlyContinue)
$HasFfmpeg = [bool](Get-Command ffmpeg -ErrorAction SilentlyContinue)

Write-Host "Registered Native Messaging host manifest at $ManifestPath"
Write-Host "Checks -> Python: $HasPython | yt-dlp: $HasYtDlp | ffmpeg: $HasFfmpeg"
