#Requires -Version 5.1
<#
  同步讯语项目到服务器并重启 xunyu 服务。
  默认：阿里云 ECS，root 登录，密钥 ~/.ssh/xunyu-aliyun.pem，代码目录 /root/xunyu（请与 systemd WorkingDirectory 一致）。
  用法: .\deploy.ps1
        .\deploy.ps1 -InstallDeps   # 改了 package.json 依赖时
        .\deploy.ps1 -SkipBackup     # 跳过部署前本地 backup.ps1
#>
param(
  [switch]$InstallDeps,
  [switch]$SkipBackup
)

$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot
$RemoteHost = '8.160.178.167'
$RemoteUser = 'root'
$Key = Join-Path $env:USERPROFILE '.ssh\xunyu-aliyun.pem'
$RemotePath = '/root/xunyu'

if (-not (Test-Path $Key)) {
  Write-Error "未找到 SSH 私钥: $Key"
}

$files = @(
  '09c8069dbc33cf26b12cde8ab8cd2571.txt',
  'director.html',
  'logo.png',
  'admin.html',
  'canvas.html',
  'server.js',
  'package.json',
  'Dockerfile',
  '.dockerignore',
  'docker-compose.yml',
  'xunyu.service',
  'backup.ps1',
  'backup-remote.ps1',
  'clean-uploads.ps1',
  '.env.example',
  'nginx-timeouts.example.conf'
)

$toCopy = @()
foreach ($f in $files) {
  $p = Join-Path $Root $f
  if (Test-Path $p) { $toCopy += $p }
}

if ($toCopy.Count -eq 0) {
  Write-Error '没有可上传的文件'
}

if (-not $SkipBackup) {
  $bp = Join-Path $Root 'backup.ps1'
  if (Test-Path $bp) {
    Write-Host 'Running local backup.ps1 ...'
    & powershell -ExecutionPolicy Bypass -File $bp
  }
}

Write-Host "Upload:" (($toCopy | ForEach-Object { Split-Path $_ -Leaf }) -join ', ')
$scpArgs = @('-i', $Key, '-o', 'BatchMode=yes') + $toCopy + "${RemoteUser}@${RemoteHost}:${RemotePath}/"
& scp @scpArgs

$inner = "cd $RemotePath"
if ($InstallDeps) {
  $inner += ' && npm install --omit=dev'
}
$inner += ' && systemctl restart xunyu && sleep 1 && systemctl is-active xunyu && curl -s http://127.0.0.1:3000/api/health'
ssh -i $Key -o BatchMode=yes "${RemoteUser}@${RemoteHost}" "bash -lc '$inner'"
Write-Host 'Deploy done.'
