#Requires -Version 5.1
<#
  在服务器打包 data、uploads、.env（若存在），再 scp 到本地 backups\
  用法: .\backup-remote.ps1
#>
param(
  [string]$RemoteHost = '8.160.178.167',
  [string]$RemoteUser = 'root',
  [string]$RemotePath = '/root/xunyu'
)
$ErrorActionPreference = 'Stop'
$Key = Join-Path $env:USERPROFILE '.ssh\xunyu-aliyun.pem'
if (-not (Test-Path $Key)) { Write-Error "SSH key not found: $Key" }

$Root = $PSScriptRoot
$outDir = Join-Path $Root 'backups'
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir | Out-Null }
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$remoteName = "xunyu-server-$stamp.tar.gz"
$localTar = Join-Path $outDir $remoteName
$remoteTmp = "/tmp/$remoteName"

$bash = "cd $RemotePath && tar -czf $remoteTmp data uploads .env 2>/dev/null || tar -czf $remoteTmp data uploads 2>/dev/null || tar -czf $remoteTmp data 2>/dev/null; test -f $remoteTmp && ls -la $remoteTmp"
ssh -i $Key -o BatchMode=yes "${RemoteUser}@${RemoteHost}" $bash
scp -i $Key -o BatchMode=yes "${RemoteUser}@${RemoteHost}:${remoteTmp}" $localTar
ssh -i $Key -o BatchMode=yes "${RemoteUser}@${RemoteHost}" "rm -f $remoteTmp"
Write-Host "Remote backup OK: $localTar"
