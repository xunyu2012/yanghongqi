# XunyuAI-V1多智能体协作短剧工作流

一体化 Web 应用：超级编导分镜、无限画布、管理后台与图片/视频生成等能力（Node.js + Express + SQLite）。
<img width="1899" height="940" alt="1" src="https://github.com/user-attachments/assets/a50b38d3-8b17-4ee4-9dd1-2f58e201b64f" />
<img width="1891" height="945" alt="2" src="https://github.com/user-attachments/assets/a76286e4-6e96-4ea0-95ee-844a8cf2c2c0" />
<img width="1901" height="948" alt="3" src="https://github.com/user-attachments/assets/568dd13e-0a48-40aa-aee1-1859d8f865b9" />

## 环境要求

- Node.js **≥ 18**
- 按需配置反向代理（生产环境建议为长耗时接口增加超时，参见仓库内 `nginx-timeouts.example.conf`）
# AI 短剧全自动工作流
> 一站式 AI 短剧生成工具链，支持剧本生成、分镜拆解、文生视频、配音、字幕、自动剪辑与成片导出。

## 项目简介
本项目旨在降低短剧制作门槛，通过 AI 技术实现从文本到成片的全流程自动化。
适用于个人创作者、短剧工作室、自媒体团队快速批量生产短剧内容。

## 功能特性
- 智能剧本生成与剧情优化
- 自动分镜拆解与镜头描述
- AI 文生图 / 文生视频生成
- TTS 智能配音 & 多音色切换
- 自动字幕生成与时间轴对齐
- 背景音乐、音效智能匹配
- 成片自动剪辑与格式导出
- 支持常见短视频平台尺寸适配

## 快速开始
1. 克隆本仓库
2. 安装依赖环境
3. 配置相关模型与 API
4. 运行工作流脚本
5. 输入文案，一键生成短剧

## 技术栈
Python / FFmpeg / 大模型接口 / 文生视频模型

## 更新日志
- v1.0.0 初始版本发布
- 支持完整短剧生成工作流

---

## English Description
AI Short Drama Automation Workflow. One-click solution for script generation, storyboard, voiceover, subtitles, video generation and final editing.

---

## 联系方式
- 微信：xunyu201611（技术交流、定制开发）
- 邮箱：xunyu2012@qq.com
- 商务合作 & 定制开发：欢迎联系洽谈

## 快速开始

```bash
npm install
cp .env.example .env
# 编辑 .env 填入会话密钥、第三方 API 等
npm start
```

## 开源协议

本项目以 [MIT License](./LICENSE) 发布。


## 免责声明

第三方 AI 与存储服务的使用须遵守各服务商条款；生成内容的责任由部署者与最终用户自行承担。
