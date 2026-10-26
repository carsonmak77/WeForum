# 微坛 WeForum

一个**微信风格**的论坛社区，支持 **手机 / 平板 / 电脑** 三端自适应。

纯 Python 标准库实现（`http.server` + `sqlite3`），前端零依赖原生 JS，**无需安装任何第三方包**。

## 快速开始

```bash
cd weforum/server
python3 server.py          # 默认 0.0.0.0:8000
# 自定义端口：PORT=9000 python3 server.py
```

打开 <http://localhost:8000> 即可访问。

**演示账号**

| 账号 | 密码 | 说明 |
|------|------|------|
| admin | admin123 | 管理员 |
| linda | 123456 | 普通用户 |
| kevin / mia / zj | 123456 | 普通用户 |

## 功能

- **账号**：注册 / 登录（PBKDF2 加盐哈希 + HMAC 签名 Token）、编辑资料、上传头像
- **帖子**：发帖（Markdown + 图片 + 语音）、浏览、置顶/精华标识、热榜、搜索
- **评论**：楼中楼回复（@某人）、评论点赞、删除
- **互动**：点赞、收藏、关注用户、举报
- **通知**：被赞 / 被评论 / 被回复 / 被关注时推送站内消息，支持未读角标
- **管理后台**（独立页面 `/admin`，仅管理员可见入口，后台内可直接登录）：
  - 概览：用户/帖子/评论/版块统计、近 14 天发帖与评论趋势图、待处理事项
  - 版块：新建 / 编辑（名称、图标、主题色、简介、排序）/ 删除
  - 帖子：搜索筛选、编辑标题正文与所属版块、置顶 / 精华 / 隐藏 / 恢复 / 彻底删除、管理员备注
  - 评论：搜索、删除（连同楼中楼回复）
  - 用户：编辑资料、更换头像、重置密码、封禁 / 解封、授予 / 撤销管理员
  - 举报：查看与标记处理
- **三端**：
  - 手机（<768px）：底部 Tab 导航 + 浮动发布按钮
  - 平板（768–1023px）：单栏宽屏布局
  - 桌面（≥1024px）：微信 PC 风格三栏（导航 / 列表 / 阅读区）
- **深色模式**：跟随系统自动切换
- 其他：图片压缩上传、语音录制（MediaRecorder）、图片查看器、Toast、确认弹窗、滚动位置记忆、SPA 路由

## 目录结构

```
weforum/
├── server/
│   └── server.py      # 服务端（API + 静态文件 + 种子数据）
├── web/
│   ├── index.html     # 入口页
│   ├── css/app.css    # 全部样式（微信风格设计体系）
│   └── js/app.js      # 前端逻辑（路由/渲染/编辑器/录音等）
└── data/              # 运行时自动创建：SQLite 数据库 + 上传文件
```

## 主要 API

```
POST /api/register | /api/login | /api/logout
GET  /api/me        PUT /api/me
GET  /api/boards    GET /api/posts    POST /api/posts    GET /api/hot
GET  /api/posts/:id DELETE /api/posts/:id
POST /api/posts/:id/like | /favorite    GET|POST /api/posts/:id/comments
POST /api/comments/:id/like          DELETE /api/comments/:id
GET  /api/users/:id  /api/users/:id/posts   POST /api/users/:id/follow
GET  /api/notifications  POST /api/notifications/read
GET  /api/search  /api/users/search   POST /api/report  POST /api/upload

# 管理后台（需管理员 Token）
GET    /api/admin/overview
GET|POST /api/admin/boards      GET|PUT|DELETE /api/admin/boards/:id
GET    /api/admin/posts         GET|PUT|DELETE /api/admin/posts/:id
GET    /api/admin/comments      DELETE /api/admin/comments/:id
GET    /api/admin/users         PUT|DELETE /api/admin/users/:id
GET    /api/admin/reports       DELETE /api/admin/reports/:id
```

## 数据说明

- 数据保存在 `weforum/data/weforum.db`（SQLite，WAL 模式）
- 首次启动自动写入演示版块、用户与帖子；删除 `data/` 目录可重置全部数据
- 上传的图片/语音保存在 `weforum/data/uploads/`（单文件 ≤ 8MB）
