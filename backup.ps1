#Requires -Version 5.1
<#
  本地备份讯语项目：源码 + data + uploads（排除 node_modules）
  输出到 backups\xunyu-backup-YYYYMMDD-HHmmss.zip
  用法: .\backup.ps1
#>
$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$outDir = Join-Path $Root 'backups'
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir | Out-Null }
$zip = Join-Path $outDir "xunyu-backup-$stamp.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }

$items = @(
  'server.js', 'package.json',
  'director.html', 'logo.png', 'admin.html', 'canvas.html',
  '09c8069dbc33cf26b12cde8ab8cd2571.txt',
  'Dockerfile', 'docker-compose.yml', 'xunyu.service',
  'deploy.ps1', 'backup.ps1', 'backup-remote.ps1', 'clean-uploads.ps1',
  '.env.example', 'nginx-timeouts.example.conf'
)
$existing = @()
foreach ($f in $items) {
  $p = Join-Path $Root $f
  if (Test-Path $p) { $existing += $p }
}
$lock = Join-Path $Root 'package-lock.json'
if (Test-Path $lock) { $existing += $lock }
foreach ($d in @('data', 'uploads')) {
  $p = Join-Path $Root $d
  if (Test-Path $p) { $existing += $p }
}
if ($existing.Count -eq 0) {
  Write-Error 'Nothing to backup (no files found).'
}
Compress-Archive -Path $existing -DestinationPath $zip -CompressionLevel Optimal
Write-Host "Backup OK: $zip ($([math]::Round((Get-Item $zip).Length/1MB, 2)) MB)"
