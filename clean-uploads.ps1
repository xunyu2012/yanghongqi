#Requires -Version 5.1
<#
  清空本机与/或服务器上的 uploads/ 缓存（仅顶层文件，与后台「立即清空 uploads」一致）。
  用法: .\clean-uploads.ps1              # 仅本地项目 uploads/
        .\clean-uploads.ps1 -Remote      # 仅远程（默认 deploy 同机：root + xunyu-aliyun.pem）
        .\clean-uploads.ps1 -Remote -Local  # 本地 + 远程
  默认仅本地；传 -Remote 时不会默认清本地，需同时传 -Local 才双清。
#>
param(
  [switch]$Remote,
  [switch]$Local
)

$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot
$Upload = Join-Path $Root 'uploads'

if (-not $Remote -and -not $Local) { $Local = $true }

if ($Local) {
  if (Test-Path $Upload) {
    Get-ChildItem -Path $Upload -File -ErrorAction SilentlyContinue | Remove-Item -Force
    Write-Host "Local cleared: $Upload"
  } else {
    Write-Host "Local skip (no folder): $Upload"
  }
}

if ($Remote) {
  $RemoteHost = '8.160.178.167'
  $RemoteUser = 'root'
  $Key = Join-Path $env:USERPROFILE '.ssh\xunyu-aliyun.pem'
  if (-not (Test-Path $Key)) { Write-Error "未找到 SSH 私钥: $Key" }
  $cmd = 'mkdir -p /root/xunyu/uploads && find /root/xunyu/uploads -mindepth 1 -maxdepth 1 -type f -delete && echo remote_ok'
  & ssh -i $Key -o BatchMode=yes "${RemoteUser}@${RemoteHost}" $cmd
  Write-Host 'Remote uploads cleared.'
}
