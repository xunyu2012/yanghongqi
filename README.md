# 讯语 (Xunyu)

一体化 Web 应用：超级编导分镜、无限画布、管理后台与图片/视频生成等能力（Node.js + Express + SQLite）。

## 环境要求

- Node.js **≥ 18**
- 按需配置反向代理（生产环境建议为长耗时接口增加超时，参见仓库内 `nginx-timeouts.example.conf`）

## 快速开始

```bash
npm install
cp .env.example .env
# 编辑 .env 填入会话密钥、第三方 API 等
npm start
```

默认由 `server.js` 提供 HTTP 服务；数据库与用户上传目录见 `.gitignore`（`data/`、`uploads/` 不会进入版本库）。

## 部署

`deploy.ps1` 等为示例脚本，内含主机、路径等占位或示例配置。**开源发布前请自行改为环境变量或私有配置**，勿将密钥、私钥提交到仓库。

## 开源协议

本项目以 [MIT License](./LICENSE) 发布。

## 发布到 GitHub

1. 安装 [Git for Windows](https://git-scm.com/download/win)，安装时勾选将 Git 加入 `PATH`。
2. 在仓库根目录打开终端，执行（将 `YOUR_USER` / `YOUR_REPO` 换成你的账号与仓库名；若仓库在 GitHub 网页端已创建，可跳过 `gh repo create`）：

```bash
cd c:\Users\Administrator\Desktop\xunyu
git init
git branch -M main
git add -A
git commit -m "chore: initial open-source release"
git remote add origin https://github.com/YOUR_USER/YOUR_REPO.git
git push -u origin main
```

首次提交前建议配置身份（只需一次）：

```bash
git config --global user.name "你的名字"
git config --global user.email "你的邮箱"
```

若使用 SSH：`git remote add origin git@github.com:YOUR_USER/YOUR_REPO.git`。

**注意**：确认 `deploy.ps1` 等不含生产密钥与私钥路径后再推送；本仓库 `.gitignore` 已忽略 `.env`、`*.pem`、`data/`、`uploads/`、`backups/` 等。

## 免责声明

第三方 AI 与存储服务的使用须遵守各服务商条款；生成内容的责任由部署者与最终用户自行承担。
