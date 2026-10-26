#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
微坛 WeForum —— 三端自适应论坛社区（服务端）
纯 Python 标准库实现（http.server + sqlite3），零第三方依赖，可直接运行。

启动：  python3 server.py            # 默认 0.0.0.0:8000
        PORT=9000 python3 server.py

特性：
- 用户名+密码注册登录（PBKDF2 加盐哈希），HMAC 签名 Token，无需额外依赖
- 版块 / 主题 / 楼中楼回复 / 点赞 / 收藏 / 关注 / 举报 / 通知 / 搜索
- 图片与语音上传（data URL 落盘）
- 三端自适应：PC / 平板 / 手机 共用一套接口
"""

import base64
import binascii
import hashlib
import hmac
import html
import json
import mimetypes
import os
import re
import secrets
import shutil
import smtplib
import sqlite3
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta
from email.header import Header
from email.mime.text import MIMEText
from email.utils import formataddr, formatdate, make_msgid
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs, unquote

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.dirname(BASE_DIR)
WEB_DIR = os.path.join(ROOT_DIR, "web")
DATA_DIR = os.environ.get("WEFORUM_DATA", os.path.join(ROOT_DIR, "data"))
UPLOAD_DIR = os.path.join(DATA_DIR, "uploads")
DB_PATH = os.path.join(DATA_DIR, "weforum.db")
HOST = os.environ.get("HOST", "0.0.0.0")
PORT = int(os.environ.get("PORT") or "8000")

SECRET_FILE = os.path.join(DATA_DIR, ".secret")
TOKEN_TTL = 60 * 60 * 24 * 30  # 30 天（滑动续期，见 parse_token 注释）


def get_secret(conn=None):
    """获取 token 签名密钥，优先级：环境变量 > 数据库 meta > 本地文件 > 新建随机。

    ⚠️ 关键教训：云端部署时 data 目录可能不持久（每次冷启动都是新的空库），
    如果密钥在那里生成，就会出现「登录成功 → 下一个请求就变成请先登录」。
    因此支持用 WEFORUM_SECRET 环境变量注入一把固定密钥，这是部署时最稳的做法。
    """
    env_secret = (os.environ.get("WEFORUM_SECRET") or "").strip()
    if env_secret:
        return env_secret

    own = conn is None
    conn = conn or db()
    try:
        row = conn.execute("SELECT value FROM meta WHERE key='token_secret'").fetchone()
        if row and row["value"]:
            return row["value"]
        # 首次：沿用旧文件里的密钥（老用户 token 不失效），否则新生成
        secret = ""
        if os.path.exists(SECRET_FILE):
            try:
                with open(SECRET_FILE) as f:
                    secret = f.read().strip()
            except OSError:
                secret = ""
        if not secret:
            secret = secrets.token_hex(32)
        conn.execute("INSERT OR REPLACE INTO meta(key,value) VALUES('token_secret',?)", (secret,))
        conn.commit()
        return secret
    finally:
        if own:
            conn.close()


SECRET = None


# --------------------------------------------------------------------------
# 数据库
# --------------------------------------------------------------------------
SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT
);
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    nickname TEXT NOT NULL,
    password TEXT NOT NULL,
    email TEXT DEFAULT '',
    email_verified INTEGER DEFAULT 0,
    avatar TEXT DEFAULT '',
    bio TEXT DEFAULT '',
    role TEXT DEFAULT 'user',
    status INTEGER DEFAULT 1,
    created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS email_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    code TEXT NOT NULL,
    purpose TEXT DEFAULT 'register',
    expire INTEGER NOT NULL,
    used INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS boards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    icon TEXT DEFAULT '',
    color TEXT DEFAULT '#07C160',
    description TEXT DEFAULT '',
    layout TEXT DEFAULT 'list',
    sort INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS site_settings (
    key TEXT PRIMARY KEY,
    value TEXT
);
CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    board_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    images TEXT DEFAULT '[]',
    audio TEXT DEFAULT '',
    views INTEGER DEFAULT 0,
    likes INTEGER DEFAULT 0,
    comments INTEGER DEFAULT 0,
    is_top INTEGER DEFAULT 0,
    is_essence INTEGER DEFAULT 0,
    admin_note TEXT DEFAULT '',
    board_locked INTEGER DEFAULT 0,
    status INTEGER DEFAULT 1,
    created_at INTEGER NOT NULL,
    last_active INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    parent_id INTEGER DEFAULT 0,
    reply_to_uid INTEGER DEFAULT 0,
    content TEXT NOT NULL,
    likes INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS likes (
    user_id INTEGER NOT NULL,
    target_type TEXT NOT NULL,
    target_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, target_type, target_id)
);
CREATE TABLE IF NOT EXISTS favorites (
    user_id INTEGER NOT NULL,
    post_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, post_id)
);
CREATE TABLE IF NOT EXISTS follows (
    follower_id INTEGER NOT NULL,
    followee_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (follower_id, followee_id)
);
CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    actor_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    post_id INTEGER DEFAULT 0,
    comment_id INTEGER DEFAULT 0,
    content TEXT DEFAULT '',
    is_read INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    target_type TEXT NOT NULL,
    target_id INTEGER NOT NULL,
    reason TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS user_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    icon TEXT DEFAULT '🌱',
    color TEXT DEFAULT '#07C160',
    level INTEGER DEFAULT 1,
    min_exp INTEGER DEFAULT 0,
    sort INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS badges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    icon TEXT DEFAULT '🏅',
    color TEXT DEFAULT '#07C160',
    description TEXT DEFAULT '',
    sort INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS user_badges (
    user_id INTEGER NOT NULL,
    badge_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, badge_id)
);
CREATE TABLE IF NOT EXISTS board_moderators (
    board_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (board_id, user_id)
);
CREATE TABLE IF NOT EXISTS board_access (
    board_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    approved_by INTEGER DEFAULT 0,
    approved_at INTEGER DEFAULT 0,
    PRIMARY KEY (board_id, user_id)
);
CREATE TABLE IF NOT EXISTS board_applications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    board_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    status TEXT DEFAULT 'pending',
    reason TEXT DEFAULT '',
    created_at INTEGER NOT NULL,
    handled_by INTEGER DEFAULT 0,
    handled_at INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_ba_board ON board_applications(board_id, status);
CREATE INDEX IF NOT EXISTS idx_posts_board ON posts(board_id, last_active DESC);
CREATE INDEX IF NOT EXISTS idx_posts_user ON posts(user_id);
CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id, id);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, is_read);
CREATE TABLE IF NOT EXISTS points_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    delta INTEGER NOT NULL,
    reason TEXT DEFAULT '',
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_points_log_user ON points_log(user_id, id DESC);
CREATE TABLE IF NOT EXISTS daily_checkin (
    user_id INTEGER NOT NULL,
    day TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, day)
);
"""

BOARD_SEED = [
    # name, slug, icon, color, desc, layout, access_mode
    ("技术交流", "tech", "💻", "#07C160", "代码、架构、踩坑与心得", "list", "public"),
    ("产品设计", "product", "🎨", "#576B95", "需求、交互、视觉与体验", "list", "public"),
    ("社区交友", "social", "🤝", "#E6655C", "图文分享，认识有趣的朋友", "image", "vip"),
    ("职场生活", "life", "💼", "#FA9D3B", "升职加薪、打工人的日常", "list", "public"),
    ("闲聊灌水", "chat", "🍵", "#8B7BD8", "随便聊聊，什么都行", "list", "public"),
    ("二手闲置", "market", "📦", "#E6655C", "闲置好物，物尽其用", "list", "public"),
    ("公告建议", "notice", "📢", "#10AEFF", "站点公告与意见建议", "list", "public"),
]

GROUP_SEED = [
    # name, icon, color, level, min_exp
    ("新手上路", "🌱", "#9AA0A6", 1, 0),
    ("注册会员", "🌿", "#07C160", 2, 50),
    ("活跃会员", "⭐", "#FA9D3B", 3, 200),
    ("资深会员", "💎", "#10AEFF", 4, 500),
    ("社区元老", "👑", "#E6655C", 5, 1500),
    ("荣誉管理员", "🛡", "#8B7BD8", 6, 5000),
]

BADGE_SEED = [
    # name, icon, color, description
    ("新人报到", "🎉", "#07C160", "完成首次发帖，正式加入社区"),
    ("妙笔生花", "✍️", "#10AEFF", "累计发布 10 篇优质帖子"),
    ("人气之星", "🔥", "#FA9D3B", "帖子累计获得 50 个点赞"),
    ("答疑达人", "🎓", "#8B7BD8", "积极回复他人，解答社区疑问"),
    ("社区守护", "🛡", "#576B95", "参与举报违规内容，维护社区秩序"),
    ("元老勋章", "👑", "#E6655C", "陪伴社区成长满一年"),
]

# VIP 套餐配置（可通过站点设置 site_vip_plans 覆盖，JSON 格式）
DEFAULT_VIP_PLANS = [
    {"id": "month", "name": "月度会员", "icon": "🥈", "days": 30, "points": 300, "color": "#07C160"},
    {"id": "quarter", "name": "季度会员", "icon": "🥇", "days": 90, "points": 800, "color": "#10AEFF"},
    {"id": "year", "name": "年度会员", "icon": "👑", "days": 365, "points": 2800, "color": "#FA9D3B", "hot": True},
]

# VIP 套餐可选图标（皇冠 / 金币 / 钻石 / 珠宝 / 奖杯 / 尊贵身份等 VIP 主题，共 85 个）
VIP_ICONS = [
    "👑", "🤴", "👸", "🏰", "💰", "🪙", "💵", "💴", "💶", "💷",
    "💸", "💎", "💍", "💠", "🔮", "🏆", "🥇", "🥈", "🥉", "🏅",
    "🎖", "⭐", "🌟", "✨", "💫", "⚡", "🔥", "💥", "💯", "🎯",
    "🎁", "🎀", "🎉", "🎊", "🛍", "🏵", "🎗", "🍾", "🥂", "🍷",
    "🥃", "🎂", "🎈", "🎇", "🎆", "🛡", "🧭", "🚀", "🎲", "🎰",
    "🎪", "🎭", "🎨", "🎬", "🔔", "📯", "🎺", "🎸", "🎹", "🎻",
    "🔷", "🔶", "🔹", "🔸", "💒", "👝", "👛", "💄", "🪞", "💝",
    "💚", "💙", "💜", "🩷", "🖤", "🩶", "💗", "💖", "💘", "🌹",
    "💐", "🌺", "🪻", "🦋", "🦚", "🐉", "🦁", "🐆", "🎩", "💳",
    "🗡", "⚔", "🔱", "🌙", "🌠",
]

# 登录弹窗里默认展示的演示账号说明（可在后台「站点设置」修改）
DEFAULT_DEMO_ACCOUNTS = ("演示账号：admin / admin123（管理员）\n"
                         "linda / 123456 · kevin / 123456 · mia / 123456")

SEED_USERS = [
    ("admin", "阿甘", "admin123", "论坛管理员，有问题随时私信。"),
    ("linda", "林小满", "123456", "前端工程师 / 喜欢折腾 UI 细节"),
    ("kevin", "老K", "123456", "后端十年，专注高并发。"),
    ("mia", "米娅", "123456", "产品经理，热爱观察用户。"),
    ("zj", "张建", "123456", "全栈搬砖，周末摄影。"),
]

SEED_POSTS = [
    dict(board="notice", user="admin", top=1, essence=1,
         title="欢迎来到微坛 · 社区公约（新人必读）",
         content="欢迎加入微坛！这里是一个干净、友善、有人情味的社区。\n\n"
                 "【三条底线】\n1. 友善交流，就事论事，不人身攻击；\n2. 不发广告、不刷屏、不传播违法内容；\n3. 尊重原创，转载注明出处。\n\n"
                 "【让帖子更受欢迎的小技巧】\n· 标题写清楚你在问什么，比如「Vue3 里 ref 和 reactive 怎么选？」\n"
                 "· 贴代码请使用代码块，方便他人阅读；\n· 问题解决了记得回来补一句结论，帮到后面的人。\n\n"
                 "祝大家在这里都能有所收获 🌱"),
    dict(board="tech", user="kevin", essence=1,
         title="高并发接口设计：从 2000 QPS 到 4 万的实践总结",
         content="最近把一个核心查询接口优化到了原来的 20 倍，简单记录下思路。\n\n"
                 "1. 先做度量：压测前先用火焰图确认瓶颈，别凭感觉优化。我们最终发现 70% 耗时在序列化与日志。\n"
                 "2. 缓存分层：本地 LRU + Redis，热点 key 命中率从 62% 提到 97%。\n"
                 "3. 数据库：把 ORM 的 N+1 全部改写成批量查询，SQL 数量从 380 条降到 6 条。\n"
                 "4. 异步化：非核心逻辑（埋点、通知）丢进消息队列。\n\n"
                 "```python\n# 批量查询示例\nusers = User.objects.filter(id__in=user_ids)\nuser_map = {u.id: u for u in users}\n```\n\n"
                 "一句话总结：先量化，再优化，最后一定要做回归压测。"),
    dict(board="product", user="mia", essence=1,
         title="为什么你的「已读」功能让用户更焦虑了？",
         content="做 IM 类产品时，我们上线了已读回执，结果 DAU 没涨、卸载率涨了 3%。\n\n"
                 "复盘后发现三个问题：\n· 对方读了不回，发送方焦虑；\n· 无法关闭，隐私感缺失；\n· 群聊里已读人数变成「社交压力榜」。\n\n"
                 "后来改成：单聊默认开启、可关闭；群聊只显示「N 人已读」不展示具体名单。数据才回来。\n\n"
                 "结论：功能是中性的，**给用户控制权**才是关键。你们怎么看已读功能？"),
    dict(board="tech", user="linda",
         title="分享一个移动端 1px 边框的完美方案",
         content="移动端 1px 边框一直是个老问题，DPR 为 2 或 3 时 1px 会被放大。\n\n"
                 "最稳的方案还是用伪元素 + transform 缩放：\n\n"
                 "```css\n.hairline::after {\n  content: '';\n  position: absolute;\n  inset: 0;\n  border: 1px solid var(--border);\n  border-radius: inherit;\n  transform: scale(0.5);\n  transform-origin: 0 0;\n  width: 200%;\n  height: 200%;\n  pointer-events: none;\n}\n@media (min-resolution: 3dppx) {\n  .hairline::after { transform: scale(0.3333); width: 300%; height: 300%; }\n}\n```\n\n"
                 "注意：父元素要 `position: relative`，且伪元素要设 `pointer-events: none`，否则会挡住点击事件。",
         images=["linear-gradient(135deg,#95EC69,#07C160)"]),
    dict(board="life", user="zj",
         title="通勤 2 小时，我把地铁变成了自习室",
         content="每天往返 210 分钟的上班路，曾经是我最讨厌的部分。\n\n"
                 "半年前开始做三件事：\n1. 早上听播客或行业新闻，把碎片信息塞进耳朵；\n"
                 "2. 晚上在地铁上读 20 页书，不带手机刷短视频；\n3. 用备忘录记下当天想不清楚的一件事，通勤时想明白。\n\n"
                 "半年下来读完 11 本，还顺手考了个证。时间真的可以被「捡」回来。\n\n"
                 "有同样长通勤的朋友吗？你们怎么利用这段时间的？"),
    dict(board="chat", user="linda",
         title="深夜发帖：你们下班后还有精力做副业吗？",
         content="最近在纠结要不要开始做点自己的小产品。\n\n"
                 "白天写代码已经写到手软，晚上回家只想躺着刷手机。可是看到别人一年做出个小工具月入几千，又很心动。\n\n"
                 "想听听过来人的真实体验：副业到底消耗了多少精力？值不值得？"),
    dict(board="market", user="kevin",
         title="【闲置】九成新机械键盘，青轴，自提",
         content="自用一年多的 87 键青轴机械键盘，手感很好，因为换办公室怕吵到同事所以出掉。\n\n"
                 "· 成色：九成新，键帽无油光\n· 价格：¥260（可小刀）\n· 交易方式：同城自提，可当面试用\n\n"
                 "有意向的在楼下回复，我会私信你。",
         images=["linear-gradient(135deg,#E8E8E8,#C9C9C9)"]),
    dict(board="tech", user="zj",
         title="SQLite 到底能不能上生产？聊聊我的踩坑",
         content="很多人觉得 SQLite 只适合做本地 Demo，其实只要搞清楚它的并发模型，小中型业务完全够用。\n\n"
                 "关键点：\n· 开启 WAL 模式，读写不互相阻塞；\n· `busy_timeout` 设足够大，避免 SQLITE_BUSY；\n"
                 "· 单写多读，写操作串行化；\n· 定期 `VACUUM` / 备份。\n\n"
                 "我们一个日活几千的内部工具跑了一年多，0 运维成本。当然，写入非常频繁的场景还是建议上 PG / MySQL。"),
    dict(board="social", user="linda",
         title="周末去了趟郊野公园，秋天真的太美了",
         content="趁着天气好，约了朋友去近郊徒步。满山的银杏和红叶，随手拍都是壁纸级别。\n\n"
                 "推荐大家周末多出去走走，比窝在家里刷手机舒服多了～ 有想一起组队的可以评论区约！",
         images=["linear-gradient(135deg,#FF9A9E,#FAD0C4)", "linear-gradient(135deg,#A1C4FD,#C2E9FB)", "linear-gradient(135deg,#FBC2EB,#A6C1EE)"]),
    dict(board="social", user="mia",
         title="分享一下我的手账日常 📒",
         content="坚持写手账第三个月了，把每天的小确幸都记下来，回头看真的很治愈。\n\n"
                 "工具：一本空白本 + 几支彩笔 + 贴纸。不需要画画好看，记录本身就是意义。",
         images=["linear-gradient(135deg,#FDFBFB,#E0EAFC)", "linear-gradient(135deg,#D4FC79,#96E6A1)"]),
    dict(board="social", user="zj",
         title="刚入手了一台胶片相机，拍出来的味道绝了",
         content="一直想试试胶片，终于咬牙入了一台二手的。等了三天冲扫出来，颗粒感和色彩真的是数码给不了的。\n\n"
                 "有玩胶片的朋友吗？求推荐胶卷！",
         images=["linear-gradient(135deg,#FFECD2,#FCB69F)", "linear-gradient(135deg,#A18CD1,#FBC2EB)", "linear-gradient(135deg,#FCCB90,#F093FB)"]),
]

SEED_COMMENTS = {
    0: [["linda", "新人报到，规则已读，一起维护好社区氛围～", None],
        ["kevin", "建议再加一条：提问前先搜索，能省很多时间。", None],
        ["mia", "官方要不要开个产品经理专区？", None],
        ["admin", "产品设计版块就是呀，欢迎来发帖：）", [3, "看到了，已经关注！"]]],
    1: [["linda", "第 3 点太真实了，N+1 是万恶之源。", None],
        ["zj", "本地 LRU 有推荐实现吗？", None],
        ["kevin", "我们自己写了个带 TTL 的简化版，不到 200 行，够用。", [1, "求分享！"]]],
    2: [["linda", "已读名单确实会让人有压力，我们后来也去掉了。", None],
        ["kevin", "技术上「可关闭」比「做不做」更难，涉及两端状态同步。", None]],
    4: [["mia", "羡慕，我的通勤只有 15 分钟却全用来刷短视频了……", None],
        ["linda", "建议试试早睡半小时，早上通勤效率会高很多。", None]],
    5: [["zj", "试过，一年半，副业收入约等于零，但学到了很多。", None],
        ["kevin", "先别想收入，想清楚你要解决谁的什么问题。", [1, "扎心了，但确实"]],
        ["mia", "精力是有限的，先保证主业不掉队。", None]],
}


def db():
    conn = sqlite3.connect(DB_PATH, timeout=15, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def hash_password(password, salt=None):
    salt = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 120000).hex()
    return f"pbkdf2${salt}${digest}"


def verify_password(password, stored):
    try:
        _, salt, digest = stored.split("$", 2)
    except ValueError:
        return False
    return hmac.compare_digest(hash_password(password, salt).split("$", 2)[2], digest)


def make_token(uid):
    exp = int(time.time()) + TOKEN_TTL
    payload = f"{uid}.{exp}"
    sig = hmac.new(SECRET.encode(), payload.encode(), hashlib.sha256).hexdigest()[:32]
    return f"{payload}.{sig}"


def parse_token(token, with_exp=False):
    try:
        uid, exp, sig = token.split(".")
        payload = f"{uid}.{exp}"
        expect = hmac.new(SECRET.encode(), payload.encode(), hashlib.sha256).hexdigest()[:32]
        if not hmac.compare_digest(sig, expect) or int(exp) < time.time():
            return None
        return (int(uid), int(exp)) if with_exp else int(uid)
    except Exception:
        return None


# --------------------------------------------------------------------------
# 初始化与种子数据
# --------------------------------------------------------------------------
MIGRATIONS = {
    "users": {"role": "TEXT DEFAULT 'user'", "status": "INTEGER DEFAULT 1", "group_id": "INTEGER DEFAULT 0",
              "points": "INTEGER DEFAULT 0", "vip_expire": "INTEGER DEFAULT 0",
              "email": "TEXT DEFAULT ''", "email_verified": "INTEGER DEFAULT 0"},
    "posts": {"admin_note": "TEXT DEFAULT ''", "board_locked": "INTEGER DEFAULT 0"},
    "boards": {"layout": "TEXT DEFAULT 'list'", "access_mode": "TEXT DEFAULT 'public'"},
}


def migrate(conn):
    """老库自动补齐新增字段。"""
    for table, cols in MIGRATIONS.items():
        exist = {r["name"] for r in conn.execute(f"PRAGMA table_info({table})")}
        for name, ddl in cols.items():
            if name not in exist:
                conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {ddl}")
    conn.execute("UPDATE users SET role='admin' WHERE username='admin' AND role IS NOT 'admin'")
    conn.execute("UPDATE users SET status=1 WHERE status IS NULL")
    # 社区交友版块默认设为需申请访问（VIP 可直接进入）
    conn.execute("UPDATE boards SET access_mode='apply' WHERE slug='social' AND (access_mode IS NULL OR access_mode='public')")
    conn.commit()


def init_db():
    os.makedirs(DATA_DIR, exist_ok=True)
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    conn = db()
    conn.executescript(SCHEMA)
    migrate(conn)
    if conn.execute("SELECT COUNT(*) c FROM boards").fetchone()["c"] == 0:
        for i, (name, slug, icon, color, desc, layout, access_mode) in enumerate(BOARD_SEED):
            conn.execute(
                "INSERT INTO boards(name,slug,icon,color,description,layout,sort,access_mode) VALUES(?,?,?,?,?,?,?,?)",
                (name, slug, icon, color, desc, layout, i, access_mode),
            )
        # 将社区交友版块设为需申请访问（同时支持 VIP 直接进入）
        conn.execute("UPDATE boards SET access_mode='apply' WHERE slug='social'")
    if conn.execute("SELECT COUNT(*) c FROM users").fetchone()["c"] == 0:
        seed(conn)
    if conn.execute("SELECT COUNT(*) c FROM user_groups").fetchone()["c"] == 0:
        for i, (name, icon, color, level, min_exp) in enumerate(GROUP_SEED):
            conn.execute(
                "INSERT INTO user_groups(name,icon,color,level,min_exp,sort) VALUES(?,?,?,?,?,?)",
                (name, icon, color, level, min_exp, i),
            )
    if conn.execute("SELECT COUNT(*) c FROM badges").fetchone()["c"] == 0:
        for i, (name, icon, color, desc) in enumerate(BADGE_SEED):
            conn.execute(
                "INSERT INTO badges(name,icon,color,description,sort) VALUES(?,?,?,?,?)",
                (name, icon, color, desc, i),
            )
    # 演示：给种子用户发几枚勋章，方便前台用户中心展示
    if conn.execute("SELECT COUNT(*) c FROM user_badges").fetchone()["c"] == 0:
        bg = {r["name"]: r["id"] for r in conn.execute("SELECT id,name FROM badges")}
        demo = {
            "admin": ["新人报到", "答疑达人", "社区守护", "元老勋章"],
            "linda": ["新人报到", "妙笔生花"],
            "kevin": ["新人报到", "妙笔生花", "人气之星"],
            "mia": ["新人报到", "人气之星"],
            "zj": ["新人报到"],
        }
        for uname, names in demo.items():
            row = conn.execute("SELECT id FROM users WHERE username=?", (uname,)).fetchone()
            if not row:
                continue
            for nm in names:
                if nm in bg:
                    conn.execute("INSERT OR IGNORE INTO user_badges(user_id,badge_id,created_at) VALUES(?,?,?)",
                                 (row["id"], bg[nm], now_ts()))
    conn.commit()
    conn.close()


def seed(conn):
    now = int(time.time())
    uid = {}
    board_ids = {}
    for row in conn.execute("SELECT id, slug FROM boards"):
        board_ids[row["slug"]] = row["id"]
    for i, (u, nick, pwd, bio) in enumerate(SEED_USERS):
        colors = ["#07C160", "#576B95", "#FA9D3B", "#E6655C", "#10AEFF"]
        # 给种子用户一些初始积分，管理员赠送年度 VIP
        init_points = 5000 if u == "admin" else 1000
        vip_expire = now + 365 * 86400 if u == "admin" else 0
        cur = conn.execute(
            "INSERT INTO users(username,nickname,password,avatar,bio,role,status,created_at,points,vip_expire) VALUES(?,?,?,?,?,?,?,?,?,?)",
            (u, nick, hash_password(pwd), f"avatar:{colors[i % len(colors)]}:{nick[0]}", bio,
             "admin" if u == "admin" else "user", 1, now - 86400 * (60 - i * 3), init_points, vip_expire),
        )
        uid[u] = cur.lastrowid

    post_ids = []
    for i, p in enumerate(SEED_POSTS):
        ts = now - 3600 * (2 + i * 9)
        cur = conn.execute(
            """INSERT INTO posts(board_id,user_id,title,content,images,views,likes,is_top,is_essence,created_at,last_active)
               VALUES(?,?,?,?,?,?,?,?,?,?,?)""",
            (board_ids[p["board"]], uid[p["user"]], p["title"], p["content"],
             json.dumps(p.get("images", []), ensure_ascii=False),
             120 + i * 37, 3 + (i * 7) % 40, p.get("top", 0), p.get("essence", 0), ts, ts + 1800),
        )
        post_ids.append(cur.lastrowid)

    # 建立关注关系、点赞
    for a, b in [("linda", "kevin"), ("linda", "mia"), ("zj", "linda"), ("mia", "kevin"), ("kevin", "zj")]:
        conn.execute("INSERT OR IGNORE INTO follows VALUES(?,?,?)", (uid[a], uid[b], now))
    for i, pid in enumerate(post_ids):
        for j, u in enumerate(SEED_USERS):
            if (i + j) % 3 == 0 and u[0] != SEED_POSTS[i]["user"]:
                conn.execute("INSERT OR IGNORE INTO likes VALUES(?,?,?,?)", (uid[u[0]], "post", pid, now))

    # 评论与楼中楼：reply = [被回复楼层序号, 兜底文案]
    for idx, items in SEED_COMMENTS.items():
        target_post = post_ids[idx]
        fmap = {}
        replies_to_fix = []
        for i, row in enumerate(items):
            author, body, reply = row[0], row[1], row[2]
            created = now - 3600 * (idx + 1) - 600 + i * 60
            cur = conn.execute(
                "INSERT INTO comments(post_id,user_id,parent_id,reply_to_uid,content,created_at) VALUES(?,?,?,?,?,?)",
                (target_post, uid[author], 0, 0, body, created),
            )
            fmap[i] = cur.lastrowid
            conn.execute("UPDATE posts SET comments = comments + 1 WHERE id=?", (target_post,))
        for i, row in enumerate(items):
            reply = row[2]
            if not reply:
                continue
            ridx = reply[0]
            if ridx not in fmap:
                continue
            child = conn.execute(
                "INSERT INTO comments(post_id,user_id,parent_id,reply_to_uid,content,created_at) VALUES(?,?,?,?,?,?)",
                (target_post, uid[row[0]], 0, uid[items[ridx][0]], reply[1] or "同意", now - 3600 * (idx + 1) + i * 60),
            )
            replies_to_fix.append((child.lastrowid, fmap[ridx]))
            conn.execute("UPDATE posts SET comments = comments + 1 WHERE id=?", (target_post,))
        for i in fmap:
            conn.execute("UPDATE comments SET parent_id=id WHERE id=?", (fmap[i],))
        for child_id, parent_id in replies_to_fix:
            conn.execute("UPDATE comments SET parent_id=? WHERE id=?", (parent_id, child_id))
    conn.commit()


# --------------------------------------------------------------------------
# 工具
# --------------------------------------------------------------------------
def now_ts():
    return int(time.time())


# ---------------- 公告有效期 ----------------
ANNOUNCE_MAX = 10          # 与后台 ANN_MAX 保持一致
ANNOUNCE_TEXT_MAX = 200    # 单条公告文本上限


def parse_announcements(raw, fallback_single=""):
    """把公告数据解析成 [{text, start, end}]，兼容旧的纯字符串数组格式。

    start / end 为 Unix 时间戳（秒），0 表示该端不限（长期有效）。
    """
    if isinstance(raw, (list, tuple)):
        items = list(raw)
    else:
        items = []
        if raw:
            try:
                parsed = json.loads(raw)
                if isinstance(parsed, list):
                    items = parsed
            except (ValueError, TypeError):
                items = []
    out = []
    for it in items:
        if isinstance(it, dict):
            text = str(it.get("text", "")).strip()
            if not text:
                continue
            try:
                start = max(0, int(it.get("start") or 0))
            except (ValueError, TypeError):
                start = 0
            try:
                end = max(0, int(it.get("end") or 0))
            except (ValueError, TypeError):
                end = 0
        else:
            text = str(it or "").strip()
            start = end = 0
            if not text:
                continue
        out.append({"text": text[:ANNOUNCE_TEXT_MAX], "start": start, "end": end})
    if not out and str(fallback_single or "").strip():
        out = [{"text": str(fallback_single).strip()[:ANNOUNCE_TEXT_MAX], "start": 0, "end": 0}]
    return out[:ANNOUNCE_MAX]


def active_announcements(items, now=None):
    """按有效期过滤公告：start <= now <= end（0 表示该端不限）。"""
    now = int(now if now is not None else time.time())
    out = []
    for it in items:
        start = int(it.get("start") or 0)
        end = int(it.get("end") or 0)
        if start and now < start:   # 还没到开始时间
            continue
        if end and now > end:       # 已过结束时间
            continue
        out.append(it)
    return out


def ok(data=None, **extra):
    payload = {"ok": True}
    if data is not None:
        payload["data"] = data
    payload.update(extra)
    return payload


def fail(msg, code=400):
    return {"__status": code, "ok": False, "error": msg}


def row_user(r, prefix=""):
    if r is None:
        return None
    d = {
        "id": r[f"{prefix}user_id"] if f"{prefix}user_id" in r.keys() else r["id"],
        "nickname": r[f"{prefix}nickname"],
        "username": r[f"{prefix}username"],
        "avatar": r[f"{prefix}avatar"],
    }
    if "bio" in r.keys():
        d["bio"] = r["bio"]
    return d


# ---------------- 外部存储（WebDAV） ----------------
# 支持坚果云 / InfiniCloud / Yandex Disk / Nextcloud / Seafile 等一切 WebDAV 协议网盘
# 使用标准库 urllib 实现，无需第三方依赖

WEBDAV_NS = "DAV:"


class _WebdavError(Exception):
    def __init__(self, status, message=""):
        self.status = int(status) if status else 0
        self.message = message
        super().__init__(f"WebDAV {self.status}: {message}")


def _webdav_request(url, method, body=None, headers=None, timeout=30, auth=None):
    """发送 WebDAV 请求，返回 (status, response_body)。"""
    hdrs = headers.copy() if headers else {}
    if body is not None:
        hdrs.setdefault("Content-Length", str(len(body)))
    # Basic Auth
    if auth:
        import base64 as _b64
        token = _b64.b64encode(f"{auth[0]}:{auth[1]}".encode("utf-8")).decode("ascii")
        hdrs["Authorization"] = f"Basic {token}"
    req = urllib.request.Request(url, data=body, method=method, headers=hdrs)
    ctx = ssl.create_default_context()
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        body = b""
        try:
            body = e.read()
        except Exception:
            pass
        msg = body[:200].decode("utf-8", errors="ignore") if body else ""
        raise _WebdavError(e.code, msg)
    except Exception as e:
        raise _WebdavError(0, str(e))


def _webdav_mkdir_p(base_url, path, auth=None):
    """递归创建 WebDAV 目录。"""
    # 规范化 path，去掉首尾多余的 /
    parts = [p for p in path.split("/") if p]
    if not parts:
        return
    cur = base_url.rstrip("/") + "/"
    for p in parts:
        cur += urllib.parse.quote(p, safe="") + "/"
        try:
            _webdav_request(cur, "MKCOL", auth=auth)
        except _WebdavError as e:
            # 405 Method Not Allowed / 409 Conflict 通常表示目录已存在
            if e.status not in (405, 409):
                raise


def _webdav_upload_file(base_url, remote_path, raw_bytes, content_type=None, auth=None,
                        public_url_base=None):
    """上传文件到 WebDAV，返回可访问的公开 URL。"""
    full_url = base_url.rstrip("/") + "/" + urllib.parse.quote(remote_path.lstrip("/"), safe="/")
    headers = {}
    if content_type:
        headers["Content-Type"] = content_type
    status, _ = _webdav_request(full_url, "PUT", body=raw_bytes, headers=headers, auth=auth)
    if status not in (200, 201, 204):
        raise _WebdavError(status, "上传失败")
    # 拼装公开 URL
    if public_url_base:
        pub = public_url_base.rstrip("/") + "/" + urllib.parse.quote(remote_path.lstrip("/"), safe="/")
        return pub
    return full_url


def webdav_test_connection(cfg):
    """测试 WebDAV 连接是否可达。cfg 是 dict，返回 (ok: bool, msg: str)。"""
    url = (cfg.get("url") or "").strip().rstrip("/")
    user = (cfg.get("user") or "").strip()
    pwd = cfg.get("pass") or ""
    sub_path = (cfg.get("path") or "").strip()
    public = (cfg.get("public_url") or "").strip()
    if not url:
        return False, "未填写 WebDAV 服务器地址"
    auth = (user, pwd) if user else None
    try:
        _webdav_mkdir_p(url, sub_path, auth=auth)
    except _WebdavError as e:
        return False, f"连接失败：HTTP {e.status} {e.message[:100]}"
    try:
        test_file = sub_path + "/.weforum_test" if sub_path else ".weforum_test"
        _webdav_upload_file(url, test_file, b"ok", content_type="text/plain", auth=auth)
        full = url.rstrip("/") + "/" + urllib.parse.quote(test_file.lstrip("/"), safe="/")
        _webdav_request(full, "DELETE", auth=auth)
    except _WebdavError as e:
        return False, f"上传/删除测试失败：HTTP {e.status} {e.message[:100]}"
    msg = "连接成功"
    if public:
        msg += f"（公开地址前缀：{public.rstrip('/')}/）"
    return True, msg


# ---------------- 百度网盘原生上传 ----------------
# 文档：https://pan.baidu.com/union/doc/
# OAuth 获取 access_token：http://openapi.baidu.com/oauth/2.0/authorize?response_type=token&client_id=APPKEY&redirect_uri=oob&scope=basic,netdisk
# 实际使用：用户授权后，从浏览器地址栏 #access_token=... 中复制 token 填入后台即可

BAIDU_XPAN_BASE = "https://pan.baidu.com/rest/2.0/xpan"
BAIDU_PAN_BASE = "https://d.pcs.baidu.com/rest/2.0/pcs"
BAIDU_BLOCK_SIZE = 4 * 1024 * 1024  # 百度单片固定 4MB


class _BaiduError(Exception):
    def __init__(self, errno=0, msg=""):
        self.errno = errno
        self.msg = msg
        super().__init__(f"百度网盘 errno={errno} {msg}")


def _baidu_req(url, params=None, method="GET", body=None, headers=None, timeout=30):
    hdrs = headers.copy() if headers else {}
    full = url
    if params:
        q = urllib.parse.urlencode(params)
        sep = "&" if "?" in full else "?"
        full = full + sep + q
    if body is not None:
        hdrs.setdefault("Content-Length", str(len(body)))
        if isinstance(body, str):
            body = body.encode("utf-8")
    req = urllib.request.Request(full, data=body, method=method, headers=hdrs)
    ctx = ssl.create_default_context()
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
            raw = resp.read().decode("utf-8", errors="ignore")
    except urllib.error.HTTPError as e:
        raw = ""
        try:
            raw = e.read().decode("utf-8", errors="ignore")
        except Exception:
            pass
        try:
            j = json.loads(raw)
        except Exception:
            j = {"error_code": e.code, "error_msg": raw[:200]}
        raise _BaiduError(j.get("error_code") or j.get("errno") or e.code,
                         j.get("error_msg") or j.get("errmsg") or raw[:200])
    except Exception as e:
        raise _BaiduError(0, str(e))
    # 百度部分接口返回 JSON，部分返回纯文本；纯文本时尝试解析
    try:
        j = json.loads(raw)
    except Exception:
        return raw
    # 百度统一 errno 字段
    if "errno" in j and j.get("errno", 0) not in (0, None):
        raise _BaiduError(j["errno"], j.get("errmsg") or j.get("error_msg") or "")
    if "error_code" in j and j.get("error_code", 0) not in (0, None):
        raise _BaiduError(j["error_code"], j.get("error_msg") or "")
    return j


def _baidu_md5(data):
    """计算 md5，返回 32 位小写 hex。"""
    import hashlib as _h
    return _h.md5(data).hexdigest()


def baidu_test_connection(cfg):
    """验证百度网盘 access_token 是否有效。返回 (ok, msg)。"""
    token = (cfg.get("token") or "").strip()
    if not token:
        return False, "未填写 access_token"
    try:
        j = _baidu_req(f"{BAIDU_XPAN_BASE}/nas", params={"method": "uinfo", "access_token": token})
    except _BaiduError as e:
        return False, f"鉴权失败：errno={e.errno} {e.msg[:100]}"
    nick = (j or {}).get("baidu_name") or (j or {}).get("netdisk_name") or "未知用户"
    return True, f"连接成功：{nick}"


def _baidu_mkdir_p(access_token, path):
    """递归创建百度网盘目录（使用 filemetas + mkdir 接口）。"""
    parts = [p for p in path.split("/") if p]
    if not parts:
        return
    cur = ""
    for p in parts:
        cur += "/" + p
        try:
            _baidu_req(f"{BAIDU_XPAN_BASE}/file",
                       params={"method": "mkdir", "access_token": access_token, "dir": cur})
        except _BaiduError as e:
            # 已存在时 errno=-7 / -10 / 5 都不算致命错误
            if e.errno not in (-7, -10, 5):
                raise


def baidu_upload_file(raw_bytes, remote_path, access_token):
    """上传文件到百度网盘，返回公开 URL。
    小于 4MB 直接 precreate + create；大于 4MB 走分片。
    成功后返回的是百度网盘的分享链接，或者返回指定 public_url_prefix 拼出的地址。
    """
    if not access_token:
        raise ValueError("百度网盘 access_token 未配置")
    size = len(raw_bytes)
    md5 = _baidu_md5(raw_bytes)

    # 1. precreate：预上传，拿 uploadid
    if size <= BAIDU_BLOCK_SIZE:
        block_list = [md5]
    else:
        # 分片 md5 数组
        blocks = [raw_bytes[i:i + BAIDU_BLOCK_SIZE] for i in range(0, size, BAIDU_BLOCK_SIZE)]
        block_list = [_baidu_md5(b) for b in blocks]
    precreate_params = {
        "method": "precreate",
        "access_token": access_token,
        "path": remote_path,
        "size": size,
        "block_list": json.dumps(block_list),
        "isdir": 0,
        "autoinit": 1,
    }
    pre = _baidu_req(f"{BAIDU_XPAN_BASE}/file", params=precreate_params)
    upload_id = pre.get("uploadid")
    if not upload_id:
        raise _BaiduError(pre.get("errno", 0), f"precreate 未返回 uploadid：{pre}")
    # 如果命中秒传，返回中会有 fsid，跳过分片直接 create
    if pre.get("fsid") and size <= BAIDU_BLOCK_SIZE:
        pass  # 小文件秒传，直接 create 即可
    else:
        # 2. 分片上传
        if size <= BAIDU_BLOCK_SIZE:
            r = _baidu_req(f"{BAIDU_PAN_BASE}/superfile",
                           params={
                               "method": "upload",
                               "access_token": access_token,
                               "path": remote_path,
                               "uploadid": upload_id,
                               "partseq": 0,
                           },
                           method="POST",
                           body=raw_bytes,
                           headers={"Content-Type": "application/octet-stream"})
            if not isinstance(r, dict) or r.get("errno", 0) != 0:
                raise _BaiduError(r.get("errno", 0) if isinstance(r, dict) else 0,
                                  f"分片上传失败: {r}")
        else:
            # 大文件暂不实现分片（论坛图片一般 <8MB，单分片够用）
            raise ValueError(f"百度网盘大文件（>{BAIDU_BLOCK_SIZE}B）暂不支持分片上传")
    # 3. create：创建最终文件
    create_params = {
        "method": "create",
        "access_token": access_token,
        "path": remote_path,
        "size": size,
        "uploadid": upload_id,
        "block_list": json.dumps(block_list),
        "isdir": 0,
    }
    created = _baidu_req(f"{BAIDU_XPAN_BASE}/file", params=create_params)
    if not isinstance(created, dict) or created.get("errno", 0) not in (0, None):
        raise _BaiduError(created.get("errno", 0) if isinstance(created, dict) else 0,
                          f"create 失败: {created}")
    fsid = created.get("fsid")
    # 返回路径本身作为可访问地址（百度网盘直链需另外签名，非用户场景下难以直接用）
    # 实际可访问链接 = public_url_prefix + remote_path，或者分享接口 dlink
    return remote_path, fsid


# ---------------- Cloudflare R2（S3 兼容） ----------------
# 使用标准库实现 AWS Signature Version 4，向 R2 的 S3 兼容 API 上传对象。

R2_REGION = "auto"
R2_SERVICE = "s3"


class _R2Error(Exception):
    def __init__(self, status, message=""):
        self.status = int(status) if status else 0
        self.message = message
        super().__init__(f"R2 {self.status}: {message}")


def _r2_sha256(data):
    if isinstance(data, str):
        data = data.encode("utf-8")
    return hashlib.sha256(data).hexdigest()


def _r2_hmac(key, msg):
    if isinstance(msg, str):
        msg = msg.encode("utf-8")
    return hmac.new(key, msg, hashlib.sha256).digest()


def _r2_request(cfg, method, object_key, body=b"", headers=None, timeout=30):
    """向 R2 发起已签名的 S3 请求。object_key 为 bucket 内的对象键（不含 bucket）。"""
    endpoint = cfg.get("r2_endpoint", "").rstrip("/")
    bucket = cfg.get("r2_bucket", "")
    access_key = cfg.get("r2_access_key_id", "")
    secret_key = cfg.get("r2_secret_access_key", "")
    if not endpoint or not bucket or not access_key or not secret_key:
        raise _R2Error(0, "R2 配置不完整")

    host = urllib.parse.urlparse(endpoint).netloc
    raw_path = f"/{bucket}/{object_key.lstrip('/')}"
    canonical_uri = urllib.parse.quote(raw_path, safe="/") or "/"

    amz_date = datetime.utcnow().strftime("%Y%m%dT%H%M%SZ")
    date_stamp = amz_date[:8]
    payload_hash = _r2_sha256(body)

    hdrs = {}
    if headers:
        for k, v in headers.items():
            hdrs[k] = v
    hdrs.setdefault("Host", host)
    hdrs.setdefault("X-Amz-Content-Sha256", payload_hash)
    hdrs.setdefault("X-Amz-Date", amz_date)
    if body is not None:
        hdrs.setdefault("Content-Length", str(len(body)))

    # 规范请求头
    canon = {k.lower(): str(v).strip() for k, v in hdrs.items()}
    signed_headers = ";".join(sorted(canon.keys()))
    canonical_headers = "".join(f"{k}:{canon[k]}\n" for k in sorted(canon.keys()))

    canonical_request = (
        f"{method}\n{canonical_uri}\n\n{canonical_headers}\n{signed_headers}\n{payload_hash}"
    )
    algorithm = "AWS4-HMAC-SHA256"
    credential_scope = f"{date_stamp}/{R2_REGION}/{R2_SERVICE}/aws4_request"
    string_to_sign = (
        f"{algorithm}\n{amz_date}\n{credential_scope}\n{_r2_sha256(canonical_request)}"
    )

    k_date = _r2_hmac(f"AWS4{secret_key}".encode("utf-8"), date_stamp)
    k_region = _r2_hmac(k_date, R2_REGION)
    k_service = _r2_hmac(k_region, R2_SERVICE)
    k_signing = _r2_hmac(k_service, "aws4_request")
    signature = hmac.new(k_signing, string_to_sign.encode("utf-8"), hashlib.sha256).hexdigest()

    hdrs["Authorization"] = (
        f"{algorithm} Credential={access_key}/{credential_scope}, "
        f"SignedHeaders={signed_headers}, Signature={signature}"
    )

    full_url = endpoint + urllib.parse.quote(raw_path, safe="/")
    req = urllib.request.Request(full_url, data=body, method=method, headers=hdrs)
    ctx = ssl.create_default_context()
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        err_body = b""
        try:
            err_body = e.read()
        except Exception:
            pass
        msg = err_body[:300].decode("utf-8", errors="ignore") if err_body else ""
        raise _R2Error(e.code, msg)
    except Exception as e:
        raise _R2Error(0, str(e))


def r2_test_connection(cfg):
    """测试 R2 连接是否可达。返回 (ok: bool, msg: str)。"""
    endpoint = (cfg.get("endpoint") or "").strip().rstrip("/")
    bucket = (cfg.get("bucket") or "").strip()
    access_key = (cfg.get("access_key_id") or "").strip()
    secret_key = cfg.get("secret_access_key") or ""
    if not endpoint:
        return False, "未填写 R2 endpoint"
    if not bucket:
        return False, "未填写 R2 bucket"
    if not access_key:
        return False, "未填写 Access Key ID"
    if not secret_key:
        return False, "未填写 Secret Access Key"

    full_cfg = {
        "r2_endpoint": endpoint,
        "r2_bucket": bucket,
        "r2_access_key_id": access_key,
        "r2_secret_access_key": secret_key,
    }
    test_key = ".weforum_r2_test"
    try:
        status, _ = _r2_request(full_cfg, "PUT", test_key, body=b"ok",
                                headers={"Content-Type": "text/plain"})
        if status not in (200, 201):
            raise _R2Error(status, "上传测试对象失败")
    except _R2Error as e:
        return False, f"连接/上传测试失败：HTTP {e.status} {e.message[:120]}"
    try:
        _r2_request(full_cfg, "DELETE", test_key)
    except _R2Error as e:
        return False, f"测试文件删除失败：HTTP {e.status} {e.message[:120]}"
    return True, "连接成功"


# ---------------- 上传路由：本地 or 外部存储 ----------------

def _storage_config(conn):
    """读取当前存储配置（从 site_settings）。"""
    return {
        "mode": (setting(conn, "storage_mode", "local") or "local").strip().lower(),
        # WebDAV
        "webdav_url": (setting(conn, "webdav_url", "") or "").strip(),
        "webdav_user": (setting(conn, "webdav_user", "") or "").strip(),
        "webdav_pass": setting(conn, "webdav_pass", "") or "",
        "webdav_path": (setting(conn, "webdav_path", "") or "").strip(),
        "webdav_public_url": (setting(conn, "webdav_public_url", "") or "").strip(),
        # 百度网盘
        "baidu_token": setting(conn, "baidu_token", "") or "",
        "baidu_dir": (setting(conn, "baidu_dir", "") or "weforum/uploads").strip() or "weforum/uploads",
        "baidu_public_url": (setting(conn, "baidu_public_url", "") or "").strip(),
        # Cloudflare R2（S3 兼容）
        "r2_endpoint": (setting(conn, "r2_endpoint", "") or "").strip(),
        "r2_bucket": (setting(conn, "r2_bucket", "") or "").strip(),
        "r2_access_key_id": (setting(conn, "r2_access_key_id", "") or "").strip(),
        "r2_secret_access_key": setting(conn, "r2_secret_access_key", "") or "",
        "r2_public_url": (setting(conn, "r2_public_url", "") or "").strip(),
        "r2_path_prefix": (setting(conn, "r2_path_prefix", "") or "").strip(),
    }


def save_to_webdav(raw_bytes, filename, content_type, conn):
    """把已解码的原始字节上传到 WebDAV，返回公开 URL。"""
    cfg = _storage_config(conn)
    if cfg["mode"] != "webdav" or not cfg["webdav_url"]:
        raise ValueError("WebDAV 未配置")
    auth = (cfg["webdav_user"], cfg["webdav_pass"]) if cfg["webdav_user"] else None
    base_url = cfg["webdav_url"].rstrip("/")
    remote = f"{cfg['webdav_path'].strip('/')}/{filename}" if cfg["webdav_path"] else filename
    _webdav_mkdir_p(base_url, cfg["webdav_path"], auth=auth)
    return _webdav_upload_file(base_url, remote, raw_bytes, content_type=content_type,
                               auth=auth, public_url_base=cfg["webdav_public_url"] or base_url)


def save_to_baidu(raw_bytes, filename, conn):
    """上传到百度网盘，返回可访问 URL（前缀由 baidu_public_url 决定）。"""
    cfg = _storage_config(conn)
    if cfg["mode"] != "baidu" or not cfg["baidu_token"]:
        raise ValueError("百度网盘未配置")
    token = cfg["baidu_token"]
    remote_dir = cfg["baidu_dir"].strip("/")
    remote = f"/{remote_dir}/{filename}" if remote_dir else f"/{filename}"
    _baidu_mkdir_p(token, remote_dir)
    _baidu_upload_file(raw_bytes, remote, token)
    pub_base = cfg["baidu_public_url"].rstrip("/") if cfg["baidu_public_url"] else ""
    if pub_base:
        return pub_base + "/" + remote.lstrip("/")
    # 没配置公开前缀时，返回百度网盘的文件路径作为"软链接"
    # 这种情况下建议管理员填一个公开分享前缀（比如 Cloudreve/CDN 代理）
    return remote


def save_to_r2(raw_bytes, filename, content_type, conn):
    """把已解码的原始字节上传到 Cloudflare R2，返回公开可访问 URL。"""
    cfg = _storage_config(conn)
    if cfg["mode"] != "r2" or not cfg["r2_endpoint"] or not cfg["r2_bucket"]:
        raise ValueError("R2 未配置")
    if not cfg["r2_access_key_id"] or not cfg["r2_secret_access_key"]:
        raise ValueError("R2 密钥未配置")

    prefix = cfg["r2_path_prefix"].strip("/")
    object_key = f"{prefix}/{filename}" if prefix else filename

    headers = {}
    if content_type:
        headers["Content-Type"] = content_type
    status, _ = _r2_request(cfg, "PUT", object_key, body=raw_bytes, headers=headers)
    if status not in (200, 201):
        raise _R2Error(status, "上传失败")

    pub_base = cfg["r2_public_url"].rstrip("/") if cfg["r2_public_url"] else ""
    if pub_base:
        return pub_base + "/" + urllib.parse.quote(object_key, safe="/")
    endpoint = cfg["r2_endpoint"].rstrip("/")
    return endpoint + "/" + cfg["r2_bucket"] + "/" + urllib.parse.quote(object_key, safe="/")


def save_data_url(data_url, conn=None):
    """把 data:image/...;base64,xxx 保存为文件，返回可访问 URL。
    conn 传入时支持自动路由到外部存储（WebDAV / 百度网盘 / R2），不传则永远本地。
    """
    m = re.match(r"^data:(image|audio)/([a-zA-Z0-9.+-]+);base64,(.+)$", data_url, re.S)
    if not m:
        raise ValueError("不支持的格式")
    kind, ext, b64 = m.group(1), m.group(2).lower(), m.group(3)
    ext = {"jpeg": "jpg", "svg+xml": "svg", "mpeg": "mp3", "mp4": "m4a", "webm": "webm", "x-m4a": "m4a"}.get(ext, ext)
    if ext not in {"jpg", "jpeg", "png", "gif", "webp", "svg", "mp3", "m4a", "webm", "wav", "ogg"}:
        raise ValueError("不支持的文件类型")
    raw = base64.b64decode(b64)
    if len(raw) > 8 * 1024 * 1024:
        raise ValueError("文件超过 8MB")
    name = f"{kind}_{int(time.time()*1000)}_{secrets.token_hex(4)}.{ext}"
    # 智能路由：配置为外部存储且传入 conn 时尝试推到网盘，失败自动回退本地
    if conn is not None:
        try:
            cfg = _storage_config(conn)
            if cfg["mode"] == "webdav" and cfg["webdav_url"]:
                ct = m.group(1) + "/" + ext
                return save_to_webdav(raw, name, ct, conn)
            if cfg["mode"] == "baidu" and cfg["baidu_token"]:
                return save_to_baidu(raw, name, conn)
            if cfg["mode"] == "r2" and cfg["r2_endpoint"] and cfg["r2_bucket"]:
                ct = m.group(1) + "/" + ext
                return save_to_r2(raw, name, ct, conn)
        except Exception:
            # 外部存储失败时自动回退到本地，不影响用户上传
            pass
    with open(os.path.join(UPLOAD_DIR, name), "wb") as f:
        f.write(raw)
    return f"/uploads/{name}"


def time_ago(ts):
    diff = now_ts() - ts
    if diff < 60:
        return "刚刚"
    if diff < 3600:
        return f"{diff // 60}分钟前"
    if diff < 86400:
        return f"{diff // 3600}小时前"
    if diff < 86400 * 30:
        return f"{diff // 86400}天前"
    return datetime.fromtimestamp(ts).strftime("%Y-%m-%d")


def fmt_ts(ts):
    """时间戳格式化为 YYYY-MM-DD HH:MM。"""
    if not ts:
        return ""
    return datetime.fromtimestamp(int(ts)).strftime("%Y-%m-%d %H:%M")


def to_csv(header, rows):
    """把二维数据转成带 BOM 的 CSV 文本（Excel 友好）。"""
    def cell(v):
        s = "" if v is None else str(v)
        if any(ch in s for ch in (",", '"', "\n", "\r")):
            s = '"' + s.replace('"', '""') + '"'
        return s
    lines = [",".join(cell(c) for c in header)]
    for r in rows:
        lines.append(",".join(cell(c) for c in r))
    return "\ufeff" + "\r\n".join(lines) + "\r\n"


# ---------------- 用户组 / 等级 / 勋章 ----------------
def compute_exp(conn, uid):
    """经验值：发帖、评论、被点赞、被关注综合计算（简单可预期）。"""
    r = conn.execute(
        "SELECT (SELECT COUNT(*) FROM posts WHERE user_id=? AND status=1) pc,"
        " (SELECT COUNT(*) FROM comments WHERE user_id=?) cc,"
        " (SELECT COUNT(*) FROM likes l JOIN posts p ON p.id=l.target_id"
        "   WHERE l.target_type='post' AND p.user_id=?) lk,"
        " (SELECT COUNT(*) FROM follows WHERE followee_id=?) fc",
        (uid, uid, uid, uid)).fetchone()
    return (r["pc"] or 0) * 10 + (r["cc"] or 0) * 3 + (r["lk"] or 0) * 2 + (r["fc"] or 0) * 2


def group_dict(g):
    if not g:
        return None
    return {"id": g["id"], "name": g["name"], "icon": g["icon"], "color": g["color"],
            "level": g["level"], "minExp": g["min_exp"]}


def groups_list(conn):
    return [{"id": g["id"], "name": g["name"], "icon": g["icon"], "color": g["color"],
             "level": g["level"], "minExp": g["min_exp"], "sort": g["sort"]}
            for g in conn.execute("SELECT * FROM user_groups ORDER BY sort, level, id")]


def badges_list(conn):
    return [{"id": b["id"], "name": b["name"], "icon": b["icon"], "color": b["color"],
             "description": b["description"] or "", "sort": b["sort"]}
            for b in conn.execute("SELECT * FROM badges ORDER BY sort, id")]


def user_badges(conn, uid):
    rows = conn.execute(
        "SELECT b.* FROM user_badges ub JOIN badges b ON b.id=ub.badge_id "
        "WHERE ub.user_id=? ORDER BY b.sort, b.id", (uid,)).fetchall()
    return [{"id": b["id"], "name": b["name"], "icon": b["icon"], "color": b["color"],
             "description": b["description"] or ""} for b in rows]


def moderators_of(conn, board_id):
    """版块版主（名额不限，按加入时间排序）。"""
    rows = conn.execute(
        "SELECT u.id, u.nickname, u.username, u.avatar FROM board_moderators bm "
        "JOIN users u ON u.id=bm.user_id WHERE bm.board_id=? ORDER BY bm.created_at, u.id",
        (board_id,)).fetchall()
    return [{"id": r["id"], "nickname": r["nickname"], "username": r["username"], "avatar": r["avatar"]}
            for r in rows]


def board_access_info(conn, board_id, uid=0):
    """返回版块访问模式及当前用户是否有权限。"""
    b = conn.execute("SELECT access_mode FROM boards WHERE id=?", (board_id,)).fetchone()
    if not b:
        return {"mode": "public", "canAccess": True}
    mode = b["access_mode"] or "public"
    if mode == "public":
        return {"mode": "public", "canAccess": True}
    # VIP 或申请制：VIP 会员可直接访问
    if uid:
        u = conn.execute("SELECT vip_expire FROM users WHERE id=?", (uid,)).fetchone()
        if u and (u["vip_expire"] or 0) > now_ts():
            return {"mode": mode, "canAccess": True}
        # 版主/管理员可访问
        is_mod = conn.execute("SELECT 1 FROM board_moderators WHERE board_id=? AND user_id=?", (board_id, uid)).fetchone()
        if is_mod:
            return {"mode": mode, "canAccess": True}
        is_admin = conn.execute("SELECT role FROM users WHERE id=?", (uid,)).fetchone()
        if is_admin and is_admin["role"] == "admin":
            return {"mode": mode, "canAccess": True}
        # 已通过申请的用户
        if mode == "apply":
            ok = conn.execute("SELECT 1 FROM board_access WHERE board_id=? AND user_id=?", (board_id, uid)).fetchone()
            if ok:
                return {"mode": mode, "canAccess": True}
            pending = conn.execute(
                "SELECT id FROM board_applications WHERE board_id=? AND user_id=? AND status='pending'",
                (board_id, uid)).fetchone()
            return {"mode": mode, "canAccess": False, "pending": bool(pending)}
    return {"mode": mode, "canAccess": False}



def resolve_group(conn, uid, exp=None):
    """用户组：管理员手动指定优先（返回 manual=True），否则按经验值自动匹配。"""
    row = conn.execute("SELECT group_id FROM users WHERE id=?", (uid,)).fetchone()
    gid = int(row["group_id"] or 0) if row else 0
    if gid:
        g = conn.execute("SELECT * FROM user_groups WHERE id=?", (gid,)).fetchone()
        if g:
            return g, True
    if exp is None:
        exp = compute_exp(conn, uid)
    g = conn.execute(
        "SELECT * FROM user_groups WHERE min_exp<=? ORDER BY min_exp DESC, level DESC LIMIT 1",
        (exp,)).fetchone()
    if not g:
        g = conn.execute("SELECT * FROM user_groups ORDER BY level, sort LIMIT 1").fetchone()
    return g, False


def level_payload(conn, uid):
    exp = compute_exp(conn, uid)
    g, manual = resolve_group(conn, uid, exp)
    nxt = None
    if not manual:
        nxt = conn.execute(
            "SELECT * FROM user_groups WHERE min_exp>? ORDER BY min_exp ASC LIMIT 1", (exp,)).fetchone()
    base = g["min_exp"] if g else 0
    if nxt:
        span = max(1, nxt["min_exp"] - base)
        progress = max(0, min(100, round((exp - base) * 100 / span)))
    else:
        progress = 100
    return {
        "exp": exp,
        "level": g["level"] if g else 1,
        "group": group_dict(g),
        "isManualGroup": manual,
        "nextExp": nxt["min_exp"] if nxt else 0,
        "nextGroupName": nxt["name"] if nxt else "",
        "progress": progress,
    }


def vip_plans(conn):
    """获取 VIP 套餐配置（支持站点设置覆盖）。"""
    row = conn.execute("SELECT value FROM site_settings WHERE key='site_vip_plans'").fetchone()
    if row and row["value"]:
        try:
            plans = json.loads(row["value"])
            if isinstance(plans, list) and plans:
                return plans
        except (ValueError, TypeError):
            pass
    return DEFAULT_VIP_PLANS


def fmt_user(conn, u, viewer_id=0):
    if u is None:
        return {"id": 0, "nickname": "已注销用户", "username": "", "avatar": ""}
    stats = conn.execute(
        "SELECT (SELECT COUNT(*) FROM posts WHERE user_id=? AND status=1) p,"
        " (SELECT COUNT(*) FROM follows WHERE followee_id=?) f,"
        " (SELECT COUNT(*) FROM follows WHERE follower_id=?) ing",
        (u["id"], u["id"], u["id"]),
    ).fetchone()
    lv = level_payload(conn, u["id"])
    vip_expire = int(u["vip_expire"] or 0)
    return {
        "id": u["id"],
        "nickname": u["nickname"],
        "username": u["username"],
        "avatar": u["avatar"],
        "bio": u["bio"] or "",
        "postCount": stats["p"],
        "followerCount": stats["f"],
        "followingCount": stats["ing"],
        "exp": lv["exp"],
        "level": lv["level"],
        "group": lv["group"],
        "isManualGroup": lv["isManualGroup"],
        "badges": user_badges(conn, u["id"]),
        "points": int(u["points"] or 0),
        "vipExpire": vip_expire,
        "isVip": vip_expire > now_ts(),
        "isFollowing": bool(viewer_id and viewer_id != u["id"] and conn.execute(
            "SELECT 1 FROM follows WHERE follower_id=? AND followee_id=?", (viewer_id, u["id"])).fetchone()),
        "isMe": viewer_id == u["id"],
    }


def post_brief(conn, r, viewer_id=0):
    images = json.loads(r["images"] or "[]")
    return {
        "id": r["id"],
        "title": r["title"],
        "summary": re.sub(r"\s+", " ", re.sub(r"```[\s\S]*?```", " [代码] ", r["content"]))[:120],
        "images": images,
        "hasAudio": bool(r["audio"]),
        "board": {"id": r["board_id"], "name": r["board_name"], "slug": r["board_slug"], "icon": r["board_icon"], "color": r["board_color"]},
        "user": {"id": r["user_id"], "nickname": r["nickname"], "avatar": r["avatar"]},
        "views": r["views"],
        "likes": r["likes"],
        "comments": r["comments"],
        "isTop": bool(r["is_top"]),
        "isEssence": bool(r["is_essence"]),
        "liked": bool(viewer_id and conn.execute(
            "SELECT 1 FROM likes WHERE user_id=? AND target_type='post' AND target_id=?", (viewer_id, r["id"])).fetchone()),
        "favorited": bool(viewer_id and conn.execute(
            "SELECT 1 FROM favorites WHERE user_id=? AND post_id=?", (viewer_id, r["id"])).fetchone()),
        "createdAt": r["created_at"],
        "lastActive": r["last_active"],
        "timeAgo": time_ago(r["last_active"]),
        "createdAgo": time_ago(r["created_at"]),
    }


POST_JOIN = """
SELECT p.*, b.name board_name, b.slug board_slug, b.icon board_icon, b.color board_color,
       u.nickname, u.avatar
FROM posts p JOIN boards b ON b.id=p.board_id LEFT JOIN users u ON u.id=p.user_id
"""


def notify(conn, user_id, actor_id, ntype, post_id=0, comment_id=0, content=""):
    # actor_id=0 表示系统通知（官方），此时不跳过；普通互动 actor 与接收者相同才跳过
    if not user_id or (actor_id and user_id == actor_id):
        return
    conn.execute(
        "INSERT INTO notifications(user_id,actor_id,type,post_id,comment_id,content,created_at) VALUES(?,?,?,?,?,?,?)",
        (user_id, actor_id, ntype, post_id, comment_id, content[:80], now_ts()),
    )


def add_points(conn, user_id, delta, reason=""):
    """增加/扣减积分并写入积分流水。"""
    if not user_id or not delta:
        return
    conn.execute("UPDATE users SET points=MAX(0, points+?) WHERE id=?", (int(delta), user_id))
    conn.execute("INSERT INTO points_log(user_id,delta,reason,created_at) VALUES(?,?,?,?)",
                 (user_id, int(delta), str(reason)[:40], now_ts()))


DEFAULT_POINTS = {"post": 5, "comment": 2, "checkin": 5, "checkinBonusMax": 5}
DEFAULT_QUICK_REPLIES = ["感谢分享", "很有帮助，谢谢", "学到了，支持一下", "占楼，稍后细看"]


def points_config(conn):
    """读取后台可配置的积分项（缺失时回退默认值）。"""
    rows = conn.execute("SELECT key,value FROM site_settings WHERE key LIKE 'points_%'").fetchall()
    m = {r["key"]: r["value"] for r in rows}

    def gi(key, default):
        raw = (m.get(key) or "").strip()
        if raw == "":
            return default
        try:
            return max(0, min(1000, int(raw)))
        except (ValueError, TypeError):
            return default

    return {
        "post": gi("points_post", DEFAULT_POINTS["post"]),
        "comment": gi("points_comment", DEFAULT_POINTS["comment"]),
        "checkin": gi("points_checkin", DEFAULT_POINTS["checkin"]),
        "checkinBonusMax": gi("points_checkin_bonus_max", DEFAULT_POINTS["checkinBonusMax"]),
    }


def quick_replies(conn):
    """快捷回复短语，后台以站点设置 quick_replies（JSON 数组）保存。"""
    row = conn.execute("SELECT value FROM site_settings WHERE key='quick_replies'").fetchone()
    if row and row["value"]:
        try:
            parsed = json.loads(row["value"])
            if isinstance(parsed, list):
                out = [str(x).strip() for x in parsed if str(x).strip()]
                if out:
                    return out[:20]
        except (ValueError, TypeError):
            pass
    return list(DEFAULT_QUICK_REPLIES)


# --------------------------------------------------------------------------
# 邮件（SMTP 发信 + 邮箱验证码）
# --------------------------------------------------------------------------
EMAIL_RE = re.compile(r"^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$")
EMAIL_CODE_TTL = 600   # 验证码有效期（秒）
EMAIL_CODE_GAP = 60    # 同一邮箱两次发送的最小间隔（秒）


def setting(conn, key, default=""):
    """读取单个站点设置项（缺失时返回默认值）。"""
    row = conn.execute("SELECT value FROM site_settings WHERE key=?", (key,)).fetchone()
    if row and row["value"] is not None:
        return row["value"]
    return default


def normalize_email(raw):
    return str(raw or "").strip().lower()


def valid_email(email):
    return bool(email) and len(email) <= 120 and bool(EMAIL_RE.match(email))


def email_config(conn):
    """读取 SMTP 配置；enabled 为 True 表示已配置服务器，可真实发信。"""
    host = (setting(conn, "smtp_host") or "").strip()
    try:
        port = int((setting(conn, "smtp_port") or "").strip() or 465)
    except (ValueError, TypeError):
        port = 465
    user = (setting(conn, "smtp_user") or "").strip()
    return {
        "host": host,
        "port": max(1, min(65535, port)),
        "user": user,
        "password": setting(conn, "smtp_pass") or "",
        "sender": (setting(conn, "smtp_from") or "").strip() or user,
        "name": (setting(conn, "smtp_name") or "").strip() or (setting(conn, "site_name") or "微坛"),
        "ssl": (setting(conn, "smtp_ssl") or "1") != "0",
        "enabled": bool(host),
    }


def send_email(conn, to_addr, subject, html):
    """发送 HTML 邮件。返回 (ok, err)，未配置 SMTP 时 err='not_configured'。"""
    cfg = email_config(conn)
    if not cfg["enabled"]:
        return False, "not_configured"
    if not cfg["sender"]:
        return False, "未配置发件人地址"
    server = None
    try:
        msg = MIMEText(html, "html", "utf-8")
        msg["Subject"] = Header(subject, "utf-8")
        msg["From"] = formataddr((str(Header(cfg["name"], "utf-8")), cfg["sender"]))
        msg["To"] = to_addr
        msg["Date"] = formatdate(localtime=True)
        msg["Message-ID"] = make_msgid()
        if cfg["ssl"]:
            server = smtplib.SMTP_SSL(cfg["host"], cfg["port"], timeout=15,
                                      context=ssl.create_default_context())
        else:
            server = smtplib.SMTP(cfg["host"], cfg["port"], timeout=15)
            server.ehlo()
            try:
                server.starttls(context=ssl.create_default_context())
                server.ehlo()
            except smtplib.SMTPException:
                pass
        if cfg["user"]:
            server.login(cfg["user"], cfg["password"])
        server.sendmail(cfg["sender"], [to_addr], msg.as_string())
        return True, ""
    except Exception as e:  # 网络 / 认证等异常统一兜底
        return False, f"{type(e).__name__}: {e}"
    finally:
        if server is not None:
            try:
                server.quit()
            except Exception:
                pass


def email_code_html(app_name, code, ttl_minutes):
    """验证码邮件模板。"""
    return f"""<div style="margin:0;padding:32px 16px;background:#f5f6f8;font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif">
  <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:14px;padding:28px 26px">
    <div style="font-size:18px;font-weight:700;color:#111">欢迎加入 {app_name}</div>
    <div style="margin-top:14px;font-size:14px;color:#555;line-height:1.8">你正在注册账号，请将下方验证码填入注册页面完成验证：</div>
    <div style="margin:20px 0;padding:16px;background:#f0faf4;border-radius:10px;text-align:center;font-size:30px;font-weight:700;letter-spacing:8px;color:#07C160">{code}</div>
    <div style="font-size:13px;color:#888;line-height:1.8">验证码 {ttl_minutes} 分钟内有效。如果不是你本人操作，请忽略此邮件。</div>
  </div>
</div>"""


def email_welcome_html(app_name, nickname):
    """注册成功后的欢迎邮件模板。"""
    return f"""<div style="margin:0;padding:32px 16px;background:#f5f6f8;font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif">
  <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:14px;padding:28px 26px">
    <div style="font-size:20px;font-weight:700;color:#111">🎉 {nickname}，欢迎加入 {app_name}</div>
    <div style="margin-top:14px;font-size:14px;color:#555;line-height:1.9">
      你的账号已注册成功。现在就可以发帖、评论、关注感兴趣的人，和其他成员一起交流。<br>
      如账号非本人注册，请及时联系管理员。
    </div>
  </div>
</div>"""


def issue_email_code(conn, email, purpose="register"):
    """生成并保存邮箱验证码，返回明文验证码。"""
    now = now_ts()
    recent = conn.execute(
        "SELECT created_at FROM email_codes WHERE email=? AND created_at>? ORDER BY id DESC LIMIT 1",
        (email, now - EMAIL_CODE_GAP)).fetchone()
    if recent:
        wait = EMAIL_CODE_GAP - (now - recent["created_at"])
        raise ApiError(429, f"发送过于频繁，请 {max(1, wait)} 秒后再试")
    code = str(secrets.randbelow(900000) + 100000)
    conn.execute(
        "INSERT INTO email_codes(email,code,purpose,expire,used,created_at) VALUES(?,?,?,?,0,?)",
        (email, code, purpose, now + EMAIL_CODE_TTL, now))
    conn.execute("DELETE FROM email_codes WHERE expire<?", (now - 3600,))
    conn.commit()
    return code


def verify_email_code(conn, email, code, purpose="register"):
    """校验验证码，成功后标记为已使用。"""
    row = conn.execute(
        "SELECT id FROM email_codes WHERE email=? AND purpose=? AND code=? AND used=0 AND expire>=? "
        "ORDER BY id DESC LIMIT 1", (email, purpose, code, now_ts())).fetchone()
    if not row:
        return False
    conn.execute("UPDATE email_codes SET used=1 WHERE id=?", (row["id"],))
    conn.commit()
    return True


def notify_mentions(conn, actor_id, content, post_id=0, comment_id=0):
    """解析内容中的 @昵称，给被提及的用户发送通知。"""
    if not content:
        return
    names = set(re.findall(r"@([\w\u4e00-\u9fa5\-]{1,16})", content))
    for name in names:
        row = conn.execute("SELECT id FROM users WHERE nickname=? OR username=? LIMIT 1", (name, name)).fetchone()
        if row and row["id"] != actor_id:
            notify(conn, row["id"], actor_id, "mention", post_id, comment_id, content)


# --------------------------------------------------------------------------
# API
# --------------------------------------------------------------------------
class API:
    def __init__(self, conn, method, path, query, body, user_id, files):
        self.conn = conn
        self.method = method
        self.path = path
        self.q = query
        self.body = body or {}
        self.uid = user_id
        self.files = files

    # ---- 工具 ----
    def me(self):
        if not self.uid:
            return None
        return self.conn.execute("SELECT * FROM users WHERE id=?", (self.uid,)).fetchone()

    def require_login(self):
        if not self.uid:
            raise ApiError(440, "请先登录")

    def get_post(self, pid):
        r = self.conn.execute(POST_JOIN + " WHERE p.id=?", (pid,)).fetchone()
        if not r or r["status"] != 1:
            raise ApiError(404, "帖子不存在或已删除")
        return r

    # ---- 路由 ----
    def dispatch(self):
        p = self.path
        m = self.method

        if p == "/api/config" and m == "GET":
            return self.config()
        if p == "/api/register" and m == "POST":
            return self.register()
        if p == "/api/email/send-code" and m == "POST":
            return self.send_email_code_api()
        if p == "/api/login" and m == "POST":
            return self.login()
        if p == "/api/logout" and m == "POST":
            return ok()
        if p == "/api/me" and m == "GET":
            return self.profile_me()
        if p == "/api/me" and m == "PUT":
            return self.update_profile()
        if p == "/api/boards" and m == "GET":
            return self.boards()
        if p == "/api/boards/search" and m == "GET":
            return self.search_boards()
        mt = re.match(r"^/api/boards/([^/]+)/apply$", p)
        if mt:
            return self.board_apply(mt.group(1), m)
        if p == "/api/posts" and m == "GET":
            return self.posts()
        if p == "/api/posts" and m == "POST":
            return self.create_post()
        if p == "/api/upload" and m == "POST":
            return self.upload()

        mt = re.match(r"^/api/posts/(\d+)$", p)
        if mt:
            pid = int(mt.group(1))
            if m == "GET":
                return self.post_detail(pid)
            if m == "PUT":
                return self.update_post(pid)
            if m == "DELETE":
                return self.delete_post(pid)

        mt = re.match(r"^/api/posts/(\d+)/like$", p)
        if mt and m == "POST":
            return self.toggle_like("post", int(mt.group(1)))
        mt = re.match(r"^/api/posts/(\d+)/favorite$", p)
        if mt and m == "POST":
            return self.toggle_favorite(int(mt.group(1)))
        mt = re.match(r"^/api/posts/(\d+)/comments$", p)
        if mt:
            if m == "GET":
                return self.comments(int(mt.group(1)))
            if m == "POST":
                return self.add_comment(int(mt.group(1)))
        mt = re.match(r"^/api/comments/(\d+)/like$", p)
        if mt and m == "POST":
            return self.toggle_like("comment", int(mt.group(1)))
        mt = re.match(r"^/api/comments/(\d+)$", p)
        if mt and m == "DELETE":
            return self.delete_comment(int(mt.group(1)))

        if p == "/api/users/search" and m == "GET":
            return self.search_users()
        mt = re.match(r"^/api/users/(\d+)$", p)
        if mt and m == "GET":
            return self.user_profile(int(mt.group(1)))
        mt = re.match(r"^/api/users/(\d+)/follow$", p)
        if mt and m == "POST":
            return self.toggle_follow(int(mt.group(1)))
        mt = re.match(r"^/api/users/(\d+)/posts$", p)
        if mt and m == "GET":
            return self.user_posts(int(mt.group(1)))

        if p == "/api/notifications" and m == "GET":
            return self.notifications()
        if p == "/api/notifications/read" and m == "POST":
            return self.read_notifications()
        if p == "/api/favorites" and m == "GET":
            return self.my_favorites()
        if p == "/api/search" and m == "GET":
            return self.search()
        if p == "/api/report" and m == "POST":
            return self.report()
        if p == "/api/hot" and m == "GET":
            return self.hot()
        if p == "/api/hot-images" and m == "GET":
            return self.hot_images()
        if p == "/api/discover" and m == "GET":
            return self.discover()

        # ---- 签到与积分 ----
        if p == "/api/checkin" and m == "POST":
            return self.checkin()
        if p == "/api/checkin" and m == "GET":
            return self.checkin_status()
        if p == "/api/points/log" and m == "GET":
            return self.points_log()

        # ---- VIP 会员 ----
        if p == "/api/vip/plans" and m == "GET":
            return self.vip_plans_api()
        if p == "/api/vip/buy" and m == "POST":
            return self.vip_buy()

        # ---- 管理后台 ----
        if p.startswith("/api/admin/"):
            return self.admin(p, m)
        raise ApiError(404, "接口不存在")

    # ---- 账号 ----
    def config(self):
        site = self._site_settings()
        single_ann = site.get("site_announcement", "")
        # 多公告（JSON 数组，元素可带 start/end 有效期），解析失败则回退到单条公告
        items = parse_announcements(site.get("site_announcements", ""))
        if not items:
            items = parse_announcements([], single_ann)
        # 只下发当前处于有效期内的公告
        announcements = [it["text"] for it in active_announcements(items)]
        return ok({
            "appName": site.get("site_name", "微坛"),
            "appDesc": site.get("site_desc", "一个像微信一样好用的技术社区"),
            "announcement": single_ann,
            "announcements": announcements,
            "announceInterval": int(site.get("site_announce_interval", "5") or 5),
            "about": site.get("site_about", ""),
            "keywords": site.get("site_keywords", ""),
            "logo": site.get("site_logo", ""),
            "demoAccounts": site.get("site_demo_accounts", DEFAULT_DEMO_ACCOUNTS),
            "navNames": {
                "home": site.get("site_nav_home", "首页") or "首页",
                "social": site.get("site_nav_social", "社交") or "社交",
                "boards": site.get("site_nav_boards", "社区") or "社区",
                "notice": site.get("site_nav_notice", "消息") or "消息",
                "me": site.get("site_nav_me", "我") or "我",
            },
            "boardCols": int(site.get("site_board_cols", "1") or 1),
            "pointsConfig": points_config(self.conn),
            "pointsName": site.get("points_name", "积分") or "积分",
            "quickReplies": quick_replies(self.conn),
            "boards": self._board_list(),
            "groups": groups_list(self.conn),
            "badges": badges_list(self.conn),
            "vipPlans": vip_plans(self.conn),
            "vipIcons": VIP_ICONS,
            "emailVerify": (site.get("site_email_verify", "1") or "1") != "0",
            "smtpReady": bool((site.get("smtp_host") or "").strip()),
        })

    def _site_settings(self):
        rows = self.conn.execute("SELECT key, value FROM site_settings").fetchall()
        out = {r["key"]: r["value"] for r in rows}
        # 密码类敏感字段：不向前端返回明文，仅表示"已设置"或"未设置"
        for secret_key in ("smtp_pass", "webdav_pass", "baidu_token", "r2_secret_access_key"):
            if secret_key in out:
                out[secret_key] = "***" if (out.get(secret_key) or "").strip() else ""
        return out

    def send_email_code_api(self):
        """发送注册邮箱验证码。未配置 SMTP 时进入演示模式，直接返回验证码。"""
        email = normalize_email(self.body.get("email"))
        if not valid_email(email):
            raise ApiError(400, "请输入正确的邮箱地址")
        if self.conn.execute("SELECT 1 FROM users WHERE lower(email)=?", (email,)).fetchone():
            raise ApiError(400, "该邮箱已被注册")
        code = issue_email_code(self.conn, email, "register")
        app_name = setting(self.conn, "site_name", "微坛") or "微坛"
        sent, err = send_email(self.conn, email, f"【{app_name}】注册验证码",
                               email_code_html(app_name, code, EMAIL_CODE_TTL // 60))
        # 无论是否发出都写日志，便于管理员排查（演示模式下也从日志可见）
        print(f"[email] to={email} code={code} sent={sent} err={err}", flush=True)
        if sent:
            return ok({"sent": True, "ttl": EMAIL_CODE_TTL})
        if err == "not_configured":
            return ok({"sent": False, "demo": True, "code": code, "ttl": EMAIL_CODE_TTL})
        raise ApiError(500, f"邮件发送失败：{err}，请稍后重试或联系管理员")

    def register(self):
        username = str(self.body.get("username", "")).strip()
        nickname = str(self.body.get("nickname", "")).strip() or username
        password = str(self.body.get("password", ""))
        email = normalize_email(self.body.get("email"))
        code = str(self.body.get("code", "")).strip()
        if not re.match(r"^[a-zA-Z0-9_]{3,20}$", username):
            raise ApiError(400, "账号需为 3-20 位字母、数字或下划线")
        if len(password) < 6:
            raise ApiError(400, "密码至少 6 位")
        if len(nickname) > 16:
            raise ApiError(400, "昵称不超过 16 个字")
        if not valid_email(email):
            raise ApiError(400, "请输入正确的邮箱地址")
        if self.conn.execute("SELECT 1 FROM users WHERE username=?", (username,)).fetchone():
            raise ApiError(400, "该账号已被注册")
        if self.conn.execute("SELECT 1 FROM users WHERE lower(email)=?", (email,)).fetchone():
            raise ApiError(400, "该邮箱已被注册")
        verify_required = (setting(self.conn, "site_email_verify", "1") or "1") != "0"
        if verify_required:
            if not code:
                raise ApiError(400, "请填写邮箱验证码")
            if not verify_email_code(self.conn, email, code, "register"):
                raise ApiError(400, "验证码不正确或已过期")
        colors = ["#07C160", "#576B95", "#FA9D3B", "#E6655C", "#10AEFF", "#8B7BD8"]
        avatar = f"avatar:{colors[len(username) % len(colors)]}:{nickname[0]}"
        cur = self.conn.execute(
            "INSERT INTO users(username,nickname,password,email,email_verified,avatar,bio,created_at) "
            "VALUES(?,?,?,?,?,?,?,?)",
            (username, nickname, hash_password(password), email, 1 if verify_required else 0, avatar, "", now_ts()),
        )
        self.conn.commit()
        uid = cur.lastrowid
        notify(self.conn, uid, 0, "system",
               content="欢迎加入微坛！先完善资料，再选个版块发第一帖吧 🎉")
        self.conn.commit()
        # 注册成功自动发送欢迎邮件（未配置 SMTP 时静默跳过）
        try:
            app_name = setting(self.conn, "site_name", "微坛") or "微坛"
            send_email(self.conn, email, f"欢迎加入{app_name}", email_welcome_html(app_name, nickname))
        except Exception as e:
            print(f"[email] welcome mail failed: {e}", flush=True)
        return ok({"token": make_token(uid), "user": self._me_payload(uid)})

    def login(self):
        username = str(self.body.get("username", "")).strip()
        password = str(self.body.get("password", ""))
        u = self.conn.execute("SELECT * FROM users WHERE username=?", (username,)).fetchone()
        if not u or not verify_password(password, u["password"]):
            raise ApiError(400, "账号或密码不正确")
        if int(u["status"] if u["status"] is not None else 1) == 0:
            raise ApiError(403, "账号已被封禁，如有疑问请联系管理员")
        return ok({"token": make_token(u["id"]), "user": self._me_payload(u["id"])})

    def _me_payload(self, uid):
        u = self.conn.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
        d = fmt_user(self.conn, u, uid)
        d.update(level_payload(self.conn, uid))
        d["role"] = (u["role"] or "user") if u else "user"
        d["status"] = int(u["status"] if u and u["status"] is not None else 1)
        d["email"] = (u["email"] or "") if u else ""
        d["isAdmin"] = d["role"] == "admin" and d["status"] == 1
        d["unread"] = self.conn.execute(
            "SELECT COUNT(*) c FROM notifications WHERE user_id=? AND is_read=0", (uid,)).fetchone()["c"]
        d["favoriteCount"] = self.conn.execute(
            "SELECT COUNT(*) c FROM favorites WHERE user_id=?", (uid,)).fetchone()["c"]
        day = datetime.now().strftime("%Y-%m-%d")
        d["checkedInToday"] = bool(self.conn.execute(
            "SELECT 1 FROM daily_checkin WHERE user_id=? AND day=?", (uid, day)).fetchone())
        d["checkinStreak"] = self._checkin_streak(uid)
        return d

    def profile_me(self):
        if not self.uid:
            return ok({"user": None})
        return ok({"user": self._me_payload(self.uid)})

    def update_profile(self):
        self.require_login()
        nickname = str(self.body.get("nickname", "")).strip()
        bio = str(self.body.get("bio", "")).strip()
        avatar = self.body.get("avatar")
        if not nickname:
            raise ApiError(400, "昵称不能为空")
        if len(nickname) > 16:
            raise ApiError(400, "昵称不超过 16 个字")
        if len(bio) > 100:
            raise ApiError(400, "简介不超过 100 字")
        if avatar and isinstance(avatar, str) and avatar.startswith("data:"):
            avatar = save_data_url(avatar, self.conn)
        elif not avatar:
            avatar = self.me()["avatar"]
        self.conn.execute("UPDATE users SET nickname=?, bio=?, avatar=? WHERE id=?",
                          (nickname, bio, avatar, self.uid))
        self.conn.commit()
        return ok({"user": self._me_payload(self.uid)})

    # ---- 版块 ----
    def _board_list(self):
        rows = self.conn.execute("SELECT * FROM boards ORDER BY sort").fetchall()
        out = []
        for b in rows:
            stat = self.conn.execute(
                "SELECT COUNT(*) c, MAX(last_active) t FROM posts WHERE board_id=? AND status=1", (b["id"],)
            ).fetchone()
            acc = board_access_info(self.conn, b["id"], self.uid)
            out.append({
                "id": b["id"], "name": b["name"], "slug": b["slug"], "icon": b["icon"],
                "color": b["color"], "description": b["description"],
                "layout": b["layout"] or "list",
                "accessMode": b["access_mode"] or "public",
                "canAccess": acc["canAccess"],
                "accessPending": acc.get("pending", False),
                "postCount": stat["c"], "lastActive": stat["t"] or 0,
                "moderators": moderators_of(self.conn, b["id"]),
            })
        return out

    def boards(self):
        return ok(self._board_list())

    def search_boards(self):
        kw = (self.q.get("q", [""])[0] or "").strip()
        if kw:
            like = f"%{kw}%"
            rows = self.conn.execute(
                "SELECT * FROM boards WHERE name LIKE ? OR description LIKE ? OR slug LIKE ? ORDER BY sort",
                (like, like, like)).fetchall()
        else:
            rows = self.conn.execute("SELECT * FROM boards ORDER BY sort").fetchall()
        out = []
        for b in rows:
            stat = self.conn.execute(
                "SELECT COUNT(*) c, MAX(last_active) t FROM posts WHERE board_id=? AND status=1", (b["id"],)
            ).fetchone()
            out.append({
                "id": b["id"], "name": b["name"], "slug": b["slug"], "icon": b["icon"],
                "color": b["color"], "description": b["description"],
                "layout": b["layout"] or "list",
                "postCount": stat["c"], "lastActive": stat["t"] or 0,
            })
        return ok(out)

    # ---- 版块访问申请 ----
    def board_apply(self, slug, m):
        if not self.uid:
            raise ApiError(401, "请先登录")
        b = self.conn.execute("SELECT id, access_mode FROM boards WHERE slug=?", (slug,)).fetchone()
        if not b:
            raise ApiError(404, "版块不存在")
        if (b["access_mode"] or "public") != "apply":
            raise ApiError(400, "该版块无需申请")
        bid = b["id"]
        # 已通过申请
        if self.conn.execute("SELECT 1 FROM board_access WHERE board_id=? AND user_id=?", (bid, self.uid)).fetchone():
            return ok({"status": "approved"})
        if m == "GET":
            row = self.conn.execute(
                "SELECT status FROM board_applications WHERE board_id=? AND user_id=? ORDER BY id DESC LIMIT 1",
                (bid, self.uid)).fetchone()
            return ok({"status": row["status"] if row else "none"})
        if m == "POST":
            # 已有待审核申请
            if self.conn.execute(
                "SELECT 1 FROM board_applications WHERE board_id=? AND user_id=? AND status='pending'",
                (bid, self.uid)).fetchone():
                return ok({"status": "pending"})
            reason = str((self.body or {}).get("reason", "")).strip()[:200]
            self.conn.execute(
                "INSERT INTO board_applications(board_id,user_id,status,reason,created_at) VALUES(?,?,?,?,?)",
                (bid, self.uid, "pending", reason, now_ts()))
            self.conn.commit()
            return ok({"status": "pending"})
        raise ApiError(404, "接口不存在")

    # ---- 帖子 ----
    def _base_post_query(self, where, params, order, limit, offset):
        sql = POST_JOIN + f" WHERE {where} ORDER BY {order} LIMIT ? OFFSET ?"
        rows = self.conn.execute(sql, params + [limit, offset]).fetchall()
        return [post_brief(self.conn, r, self.uid) for r in rows]

    def posts(self):
        sort = self.q.get("sort", "new")[0]
        board = self.q.get("board", [""])[0]
        feed = self.q.get("feed", [""])[0]
        limit = min(int(self.q.get("limit", ["20"])[0] or 20), 50)
        offset = max(int(self.q.get("offset", ["0"])[0] or 0), 0)
        where = "p.status=1"
        params = []
        if feed == "following":
            if not self.uid:
                return ok([])
            where += " AND p.user_id IN (SELECT followee_id FROM follows WHERE follower_id=?)"
            params.append(self.uid)
        if board:
            brow = self.conn.execute("SELECT id FROM boards WHERE slug=?", (board,)).fetchone()
            if not brow:
                raise ApiError(404, "版块不存在")
            bid = brow["id"]
            acc = board_access_info(self.conn, bid, self.uid)
            if not acc["canAccess"]:
                if acc.get("pending"):
                    raise ApiError(403, "申请已提交，等待管理员或版主审批")
                raise ApiError(403, "该版块仅限 VIP 会员或申请通过后访问")
            where += " AND b.slug=?"
            params.append(board)
        if sort == "hot":
            order = "(p.likes*3 + p.comments*5 + p.views) DESC, p.last_active DESC"
        elif sort == "essence":
            where += " AND p.is_essence=1"
            order = "p.last_active DESC"
        else:
            order = "p.is_top DESC, p.last_active DESC"
        return ok(self._base_post_query(where, params, order, limit, offset))

    def hot(self):
        order = "(p.likes*3 + p.comments*5 + p.views) DESC"
        return ok(self._base_post_query("p.status=1 AND p.created_at > ?", [now_ts() - 86400 * 30], order, 5, 0))

    def hot_images(self):
        """热门图片组：带图片的热门帖子，用于首页图片网格。"""
        limit = min(int(self.q.get("limit", ["12"])[0] or 12), 30)
        rows = self.conn.execute(
            POST_JOIN + " WHERE p.status=1 AND p.images<>'[]' AND p.images<>'' "
            "ORDER BY (p.likes*3 + p.comments*5 + p.views) DESC, p.last_active DESC LIMIT ?",
            (limit,)).fetchall()
        return ok([post_brief(self.conn, r, self.uid) for r in rows])

    def discover(self):
        """发现页数据：热帖榜 + 活跃版块 + 推荐用户。"""
        hot_posts = self._base_post_query(
            "p.status=1 AND p.created_at > ?", [now_ts() - 86400 * 30],
            "(p.likes*3 + p.comments*5 + p.views) DESC, p.last_active DESC", 10, 0)
        boards = self._board_list()
        boards.sort(key=lambda b: (b["postCount"], b["lastActive"]), reverse=True)
        rows = self.conn.execute(
            """SELECT u.*,
                 (SELECT COUNT(*) FROM follows f WHERE f.followee_id=u.id) fc,
                 (SELECT COUNT(*) FROM posts p WHERE p.user_id=u.id AND p.status=1) pc
               FROM users u WHERE u.status=1
               ORDER BY (fc*2 + pc) DESC, u.id ASC LIMIT 8""").fetchall()
        users = [fmt_user(self.conn, r, self.uid) for r in rows]
        return ok({"hotPosts": hot_posts, "boards": boards[:8], "users": users})

    def create_post(self):
        self.require_login()
        title = str(self.body.get("title", "")).strip()
        content = str(self.body.get("content", "")).strip()
        board_id = int(self.body.get("boardId") or 0)
        images = self.body.get("images") or []
        audio = self.body.get("audio") or ""
        if len(title) < 2:
            raise ApiError(400, "标题至少 2 个字")
        if len(title) > 60:
            raise ApiError(400, "标题不超过 60 个字")
        if len(content) < 2:
            raise ApiError(400, "正文至少 2 个字")
        if len(content) > 20000:
            raise ApiError(400, "正文不超过 20000 字")
        if not self.conn.execute("SELECT 1 FROM boards WHERE id=?", (board_id,)).fetchone():
            raise ApiError(400, "请选择版块")
        acc = board_access_info(self.conn, board_id, self.uid)
        if not acc["canAccess"]:
            raise ApiError(403, "你没有该版块的访问权限")
        saved = []
        for img in images[:9]:
            if isinstance(img, str) and img.startswith("data:"):
                saved.append(save_data_url(img, self.conn))
            elif isinstance(img, str) and img.startswith("/uploads/"):
                saved.append(img)
        if audio and isinstance(audio, str) and audio.startswith("data:"):
            audio = save_data_url(audio, self.conn)
        ts = now_ts()
        cur = self.conn.execute(
            """INSERT INTO posts(board_id,user_id,title,content,images,audio,created_at,last_active)
               VALUES(?,?,?,?,?,?,?,?)""",
            (board_id, self.uid, title, content, json.dumps(saved, ensure_ascii=False), audio, ts, ts),
        )
        # 发帖奖励积分（后台可配置）
        add_points(self.conn, self.uid, points_config(self.conn)["post"], "发布帖子")
        notify_mentions(self.conn, self.uid, content, cur.lastrowid)
        self.conn.commit()
        return ok({"id": cur.lastrowid})

    def post_detail(self, pid):
        r = self.get_post(pid)
        self.conn.execute("UPDATE posts SET views=views+1 WHERE id=?", (pid,))
        self.conn.commit()
        r = self.get_post(pid)
        d = post_brief(self.conn, r, self.uid)
        d["content"] = r["content"]
        d["audio"] = r["audio"]
        u = self.conn.execute("SELECT * FROM users WHERE id=?", (r["user_id"],)).fetchone()
        d["author"] = fmt_user(self.conn, u, self.uid)
        d["board"] = {"id": r["board_id"], "name": r["board_name"], "slug": r["board_slug"],
                      "icon": r["board_icon"], "color": r["board_color"]}
        d["canDelete"] = bool(self.uid and (self.uid == r["user_id"] or self._is_admin()))
        d["canEdit"] = d["canDelete"]
        return ok(d)

    def update_post(self, pid):
        self.require_login()
        r = self.get_post(pid)
        if r["user_id"] != self.uid and not self._is_admin():
            raise ApiError(403, "无权编辑该帖子")
        title = str(self.body.get("title", r["title"])).strip()
        content = str(self.body.get("content", r["content"])).strip()
        board_id = int(self.body.get("boardId") or r["board_id"])
        if len(title) < 2:
            raise ApiError(400, "标题至少 2 个字")
        if len(title) > 60:
            raise ApiError(400, "标题不超过 60 个字")
        if len(content) < 2:
            raise ApiError(400, "正文至少 2 个字")
        if len(content) > 20000:
            raise ApiError(400, "正文不超过 20000 字")
        if not self.conn.execute("SELECT 1 FROM boards WHERE id=?", (board_id,)).fetchone():
            raise ApiError(400, "请选择版块")
        acc = board_access_info(self.conn, board_id, self.uid)
        if not acc["canAccess"]:
            raise ApiError(403, "你没有该版块的访问权限")
        images = self.body.get("images")
        if images is None:
            images_json = r["images"]
        else:
            saved = []
            for img in (images or [])[:9]:
                if isinstance(img, str) and img.startswith("data:"):
                    saved.append(save_data_url(img, self.conn))
                elif isinstance(img, str) and img.startswith("/uploads/"):
                    saved.append(img)
            images_json = json.dumps(saved, ensure_ascii=False)
        audio = self.body.get("audio")
        if audio is None:
            audio = r["audio"]
        elif audio and isinstance(audio, str) and audio.startswith("data:"):
            audio = save_data_url(audio, self.conn)
        self.conn.execute(
            "UPDATE posts SET title=?, content=?, board_id=?, images=?, audio=? WHERE id=?",
            (title, content, board_id, images_json, audio, pid))
        # 仅当正文发生变化时，才重新提醒被 @ 的用户，避免重复打扰
        if content != (r["content"] or ""):
            notify_mentions(self.conn, self.uid, content, pid)
        self.conn.commit()
        return ok({"id": pid})

    def _is_admin(self):
        u = self.me()
        return bool(u and (u["role"] or "") == "admin" and int(u["status"] if u["status"] is not None else 1) == 1)

    def require_admin(self):
        self.require_login()
        if not self._is_admin():
            raise ApiError(403, "需要管理员权限")

    def delete_post(self, pid):
        self.require_login()
        r = self.get_post(pid)
        if r["user_id"] != self.uid and not self._is_admin():
            raise ApiError(403, "无权删除")
        self.conn.execute("UPDATE posts SET status=0 WHERE id=?", (pid,))
        self.conn.commit()
        return ok()

    def toggle_like(self, ttype, tid):
        self.require_login()
        exists = self.conn.execute(
            "SELECT 1 FROM likes WHERE user_id=? AND target_type=? AND target_id=?", (self.uid, ttype, tid)
        ).fetchone()
        table = "posts" if ttype == "post" else "comments"
        if exists:
            self.conn.execute("DELETE FROM likes WHERE user_id=? AND target_type=? AND target_id=?",
                              (self.uid, ttype, tid))
            self.conn.execute(f"UPDATE {table} SET likes=MAX(likes-1,0) WHERE id=?", (tid,))
            liked = False
        else:
            self.conn.execute("INSERT INTO likes VALUES(?,?,?,?)", (self.uid, ttype, tid, now_ts()))
            self.conn.execute(f"UPDATE {table} SET likes=likes+1 WHERE id=?", (tid,))
            liked = True
            if ttype == "post":
                owner = self.conn.execute("SELECT user_id FROM posts WHERE id=?", (tid,)).fetchone()
                notify(self.conn, owner["user_id"] if owner else 0, self.uid, "like", tid)
            else:
                c = self.conn.execute("SELECT user_id, post_id FROM comments WHERE id=?", (tid,)).fetchone()
                notify(self.conn, c["user_id"] if c else 0, self.uid, "like_comment", c["post_id"] if c else 0, tid)
        self.conn.commit()
        likes = self.conn.execute(f"SELECT likes FROM {table} WHERE id=?", (tid,)).fetchone()
        return ok({"liked": liked, "likes": likes["likes"] if likes else 0})

    def toggle_favorite(self, pid):
        self.require_login()
        self.get_post(pid)
        if self.conn.execute("SELECT 1 FROM favorites WHERE user_id=? AND post_id=?", (self.uid, pid)).fetchone():
            self.conn.execute("DELETE FROM favorites WHERE user_id=? AND post_id=?", (self.uid, pid))
            fav = False
        else:
            self.conn.execute("INSERT INTO favorites VALUES(?,?,?)", (self.uid, pid, now_ts()))
            fav = True
        self.conn.commit()
        return ok({"favorited": fav})

    def my_favorites(self):
        self.require_login()
        rows = self.conn.execute(
            POST_JOIN + " JOIN favorites f ON f.post_id=p.id AND f.user_id=? WHERE p.status=1 ORDER BY f.created_at DESC",
            (self.uid,)).fetchall()
        return ok([post_brief(self.conn, r, self.uid) for r in rows])

    # ---- 评论 ----
    def _comment_payload(self, r, viewer_id):
        return {
            "id": r["id"],
            "parentId": r["parent_id"],
            "content": r["content"],
            "likes": r["likes"],
            "liked": bool(viewer_id and self.conn.execute(
                "SELECT 1 FROM likes WHERE user_id=? AND target_type='comment' AND target_id=?", (viewer_id, r["id"])).fetchone()),
            "createdAt": r["created_at"],
            "timeAgo": time_ago(r["created_at"]),
            "user": {"id": r["user_id"], "nickname": r["nickname"], "avatar": r["avatar"]},
            "replyTo": ({"id": r["reply_to_uid"], "nickname": r["reply_nick"]}
                        if r["reply_to_uid"] and r["reply_nick"] else None),
            "canDelete": bool(viewer_id and (viewer_id == r["user_id"] or self._is_admin())),
        }

    def comments(self, pid):
        rows = self.conn.execute(
            """SELECT c.*, u.nickname, u.avatar, ru.nickname reply_nick
               FROM comments c LEFT JOIN users u ON u.id=c.user_id
               LEFT JOIN users ru ON ru.id=c.reply_to_uid
               WHERE c.post_id=? ORDER BY c.id ASC""", (pid,)).fetchall()
        roots = []
        bucket = {}
        for r in rows:
            kid = self._comment_payload(r, self.uid)
            kid["replies"] = []
            bucket[r["id"]] = kid
        for r in rows:
            if r["parent_id"] == r["id"]:
                top = self._comment_payload(r, self.uid)
                top["replies"] = []
                roots.append(top)
                bucket[r["id"]] = top
        for r in rows:
            if r["parent_id"] != r["id"] and r["parent_id"] in bucket:
                bucket[r["parent_id"]]["replies"].append(bucket[r["id"]])
        return ok({"list": roots, "total": len(rows)})

    def add_comment(self, pid):
        self.require_login()
        post = self.get_post(pid)
        content = str(self.body.get("content", "")).strip()
        parent_id = int(self.body.get("parentId") or 0)
        if not content:
            raise ApiError(400, "评论内容不能为空")
        if len(content) > 1000:
            raise ApiError(400, "评论不超过 1000 字")
        reply_to = 0
        if parent_id:
            parent = self.conn.execute("SELECT * FROM comments WHERE id=? AND post_id=?", (parent_id, pid)).fetchone()
            if not parent:
                raise ApiError(404, "回复的评论不存在")
            root_id = parent["id"] if parent["parent_id"] == parent["id"] else parent["parent_id"]
            reply_to = parent["user_id"]
            parent_id = root_id
        ts = now_ts()
        cur = self.conn.execute(
            "INSERT INTO comments(post_id,user_id,parent_id,reply_to_uid,content,created_at) VALUES(?,?,?,?,?,?)",
            (pid, self.uid, parent_id or 0, reply_to, content, ts),
        )
        cid = cur.lastrowid
        if not parent_id:
            self.conn.execute("UPDATE comments SET parent_id=? WHERE id=?", (cid, cid))
        self.conn.execute("UPDATE posts SET comments=comments+1, last_active=? WHERE id=?", (ts, pid))
        # 评论奖励积分（后台可配置，自动记账）
        add_points(self.conn, self.uid, points_config(self.conn)["comment"], "发表评论")
        notify(self.conn, post["user_id"], self.uid, "comment", pid, cid, content)
        if reply_to:
            notify(self.conn, reply_to, self.uid, "reply", pid, cid, content)
        notify_mentions(self.conn, self.uid, content, pid, cid)
        self.conn.commit()
        return ok({"id": cid})

    def delete_comment(self, cid):
        self.require_login()
        c = self.conn.execute("SELECT * FROM comments WHERE id=?", (cid,)).fetchone()
        if not c:
            raise ApiError(404, "评论不存在")
        if c["user_id"] != self.uid and not self._is_admin():
            raise ApiError(403, "无权删除")
        n = self.conn.execute("SELECT COUNT(*) c FROM comments WHERE id=? OR parent_id=?",
                              (cid, cid if c["parent_id"] == cid else -1)).fetchone()["c"]
        self.conn.execute("DELETE FROM comments WHERE id=? OR (parent_id=? AND parent_id<>id)", (cid, cid))
        self.conn.execute("UPDATE posts SET comments=MAX(comments-?,0) WHERE id=?", (max(n, 1), c["post_id"]))
        self.conn.commit()
        return ok()

    # ---- 用户 ----
    def user_profile(self, uid):
        u = self.conn.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
        if not u:
            raise ApiError(404, "用户不存在")
        d = fmt_user(self.conn, u, self.uid)
        d.update(level_payload(self.conn, u["id"]))
        d["joinedAt"] = u["created_at"]
        return ok(d)

    def user_posts(self, uid):
        rows = self.conn.execute(POST_JOIN + " WHERE p.user_id=? AND p.status=1 ORDER BY p.created_at DESC",
                                 (uid,)).fetchall()
        return ok([post_brief(self.conn, r, self.uid) for r in rows])

    def search_users(self):
        kw = (self.q.get("q", [""])[0] or "").strip()
        if not kw:
            rows = self.conn.execute("SELECT * FROM users ORDER BY id LIMIT 10").fetchall()
        else:
            rows = self.conn.execute(
                "SELECT * FROM users WHERE nickname LIKE ? OR username LIKE ? ORDER BY id LIMIT 20",
                (f"%{kw}%", f"%{kw}%")).fetchall()
        return ok([fmt_user(self.conn, r, self.uid) for r in rows])

    def toggle_follow(self, uid):
        self.require_login()
        if uid == self.uid:
            raise ApiError(400, "不能关注自己")
        if not self.conn.execute("SELECT 1 FROM users WHERE id=?", (uid,)).fetchone():
            raise ApiError(404, "用户不存在")
        if self.conn.execute("SELECT 1 FROM follows WHERE follower_id=? AND followee_id=?", (self.uid, uid)).fetchone():
            self.conn.execute("DELETE FROM follows WHERE follower_id=? AND followee_id=?", (self.uid, uid))
            return ok({"following": False})
        self.conn.execute("INSERT INTO follows VALUES(?,?,?)", (self.uid, uid, now_ts()))
        notify(self.conn, uid, self.uid, "follow")
        self.conn.commit()
        return ok({"following": True})

    # ---- 通知 ----
    def notifications(self):
        self.require_login()
        ftype = (self.q.get("type", [""])[0] or "").strip()
        where = "n.user_id=?"
        args = [self.uid]
        if ftype == "unread":
            where += " AND n.is_read=0"
        elif ftype == "comment":
            where += " AND n.type IN ('comment','reply','mention')"
        elif ftype == "like":
            where += " AND n.type IN ('like','like_comment')"
        elif ftype in ("follow", "system"):
            where += " AND n.type=?"
            args.append(ftype)
        rows = self.conn.execute(
            f"""SELECT n.*, u.nickname, u.avatar, p.title post_title, c.content ccontent
               FROM notifications n LEFT JOIN users u ON u.id=n.actor_id
               LEFT JOIN posts p ON p.id=n.post_id LEFT JOIN comments c ON c.id=n.comment_id
               WHERE {where} ORDER BY n.id DESC LIMIT 100""", args).fetchall()
        out = []
        for r in rows:
            is_sys = r["type"] == "system"
            out.append({
                "id": r["id"], "type": r["type"], "isRead": bool(r["is_read"]),
                "timeAgo": time_ago(r["created_at"]),
                "user": {
                    "id": r["actor_id"],
                    "nickname": r["nickname"] or ("微坛官方" if is_sys else "用户"),
                    "avatar": r["avatar"] or "",
                },
                "postId": r["post_id"] or 0, "postTitle": r["post_title"] or "",
                "content": r["ccontent"] or r["content"] or "",
            })
        g = self.conn.execute(
            """SELECT COUNT(*) total,
                      SUM(CASE WHEN is_read=0 THEN 1 ELSE 0 END) unread,
                      SUM(CASE WHEN type IN ('comment','reply','mention') THEN 1 ELSE 0 END) comment,
                      SUM(CASE WHEN type IN ('like','like_comment') THEN 1 ELSE 0 END) likes,
                      SUM(CASE WHEN type='follow' THEN 1 ELSE 0 END) follow,
                      SUM(CASE WHEN type='system' THEN 1 ELSE 0 END) system
               FROM notifications WHERE user_id=?""", (self.uid,)).fetchone()
        counts = {
            "all": g["total"] or 0,
            "unread": g["unread"] or 0,
            "comment": g["comment"] or 0,
            "like": g["likes"] or 0,
            "follow": g["follow"] or 0,
            "system": g["system"] or 0,
        }
        return ok({"list": out, "unread": counts["unread"], "counts": counts})

    def read_notifications(self):
        self.require_login()
        if self.body.get("all"):
            self.conn.execute("UPDATE notifications SET is_read=1 WHERE user_id=?", (self.uid,))
        else:
            ids = [int(i) for i in (self.body.get("ids") or [])]
            for i in ids:
                self.conn.execute("UPDATE notifications SET is_read=1 WHERE id=? AND user_id=?", (i, self.uid))
        self.conn.commit()
        return ok()

    # ---- 搜索 / 举报 ----
    def search(self):
        kw = (self.q.get("q", [""])[0] or "").strip()
        if not kw:
            return ok([])
        like = f"%{kw}%"
        rows = self.conn.execute(
            POST_JOIN + " WHERE p.status=1 AND (p.title LIKE ? OR p.content LIKE ?) ORDER BY p.last_active DESC LIMIT 30",
            (like, like)).fetchall()
        return ok([post_brief(self.conn, r, self.uid) for r in rows])

    def report(self):
        self.require_login()
        ttype = self.body.get("type")
        tid = int(self.body.get("id") or 0)
        reason = str(self.body.get("reason", "")).strip()
        if ttype not in ("post", "comment", "user") or not tid:
            raise ApiError(400, "参数错误")
        if len(reason) < 2:
            raise ApiError(400, "请填写举报理由")
        self.conn.execute("INSERT INTO reports(user_id,target_type,target_id,reason,created_at) VALUES(?,?,?,?,?)",
                          (self.uid, ttype, tid, reason[:200], now_ts()))
        self.conn.commit()
        return ok()

    # ---- 上传 ----
    def upload(self):
        self.require_login()
        data = self.body.get("data", "")
        try:
            url = save_data_url(data, self.conn)
        except (ValueError, binascii.Error) as e:
            raise ApiError(400, str(e) or "上传失败")
        return ok({"url": url})

    # ---- 签到与积分 ----
    def _points_of(self, uid):
        r = self.conn.execute("SELECT points FROM users WHERE id=?", (uid,)).fetchone()
        return int(r["points"] or 0) if r else 0

    def _checkin_streak(self, uid):
        """连续签到天数：从今天（或昨天起）向前连续计数。"""
        rows = self.conn.execute(
            "SELECT day FROM daily_checkin WHERE user_id=? ORDER BY day DESC LIMIT 90", (uid,)).fetchall()
        days = [r["day"] for r in rows]
        today = datetime.now().date()
        streak = 0
        cur = today
        # 今天没签到时，允许从昨天开始衡量连续天数（用于展示签到状态）
        if days and days[0] != today.strftime("%Y-%m-%d"):
            cur = today - timedelta(days=1)
        for d in days:
            try:
                dd = datetime.strptime(d, "%Y-%m-%d").date()
            except ValueError:
                break
            if dd == cur:
                streak += 1
                cur -= timedelta(days=1)
            elif dd < cur:
                break
        return streak

    def checkin(self):
        self.require_login()
        day = datetime.now().strftime("%Y-%m-%d")
        if self.conn.execute("SELECT 1 FROM daily_checkin WHERE user_id=? AND day=?", (self.uid, day)).fetchone():
            return ok({"checked": True, "already": True, "gained": 0,
                       "streak": self._checkin_streak(self.uid), "points": self._points_of(self.uid)})
        self.conn.execute("INSERT INTO daily_checkin(user_id,day,created_at) VALUES(?,?,?)",
                          (self.uid, day, now_ts()))
        streak = self._checkin_streak(self.uid)
        pc = points_config(self.conn)
        gained = pc["checkin"] + min(max(streak - 1, 0), pc["checkinBonusMax"])  # 基础分 + 连续加成
        add_points(self.conn, self.uid, gained, f"每日签到·连续{streak}天")
        self.conn.commit()
        return ok({"checked": True, "already": False, "gained": gained,
                   "streak": streak, "points": self._points_of(self.uid),
                   "total": self.conn.execute("SELECT COUNT(*) c FROM daily_checkin WHERE user_id=?",
                                              (self.uid,)).fetchone()["c"]})

    def checkin_status(self):
        self.require_login()
        day = datetime.now().strftime("%Y-%m-%d")
        checked = bool(self.conn.execute("SELECT 1 FROM daily_checkin WHERE user_id=? AND day=?",
                                         (self.uid, day)).fetchone())
        total = self.conn.execute("SELECT COUNT(*) c FROM daily_checkin WHERE user_id=?",
                                  (self.uid,)).fetchone()["c"]
        return ok({"checked": checked, "streak": self._checkin_streak(self.uid),
                   "total": total, "points": self._points_of(self.uid)})

    def points_log(self):
        self.require_login()
        limit = min(int(self.q.get("limit", ["30"])[0] or 30), 100)
        offset = max(int(self.q.get("offset", ["0"])[0] or 0), 0)
        rows = self.conn.execute(
            "SELECT * FROM points_log WHERE user_id=? ORDER BY id DESC LIMIT ? OFFSET ?",
            (self.uid, limit, offset)).fetchall()
        total = self.conn.execute("SELECT COUNT(*) c FROM points_log WHERE user_id=?",
                                  (self.uid,)).fetchone()["c"]
        return ok({
            "points": self._points_of(self.uid),
            "total": total,
            "list": [{"id": r["id"], "delta": int(r["delta"]),
                      "reason": r["reason"] or "", "createdAt": r["created_at"],
                      "timeAgo": time_ago(r["created_at"])} for r in rows],
        })

    # ---- VIP 会员 ----
    def vip_plans_api(self):
        return ok(vip_plans(self.conn))

    def vip_buy(self):
        self.require_login()
        plan_id = str(self.body.get("planId") or "").strip()
        plans = vip_plans(self.conn)
        plan = next((p for p in plans if p.get("id") == plan_id), None)
        if not plan:
            raise ApiError(400, "套餐不存在")
        days = int(plan.get("days") or 0)
        cost = int(plan.get("points") or 0)
        if days <= 0 or cost <= 0:
            raise ApiError(400, "套餐配置异常")
        u = self.conn.execute("SELECT points, vip_expire FROM users WHERE id=?", (self.uid,)).fetchone()
        points = int(u["points"] or 0)
        if points < cost:
            raise ApiError(400, f"积分不足，需要 {cost} 积分，当前 {points} 积分")
        cur_expire = int(u["vip_expire"] or 0)
        base = max(cur_expire, now_ts())
        new_expire = base + days * 86400
        add_points(self.conn, self.uid, -cost, f"兑换{plan.get('name', 'VIP')}")
        self.conn.execute("UPDATE users SET vip_expire=? WHERE id=?", (new_expire, self.uid))
        self.conn.commit()
        d = self._me_payload(self.uid)
        return ok({"user": d, "vipExpire": new_expire, "days": days})

    # ==================== 管理后台 ====================
    def admin(self, p, m):
        self.require_admin()
        if p == "/api/admin/export" and m == "GET":
            return self._admin_export()
        # 批量接口要排在 /api/admin/posts 前缀匹配之前
        if p == "/api/admin/posts/batch" and m == "POST":
            return self._post_batch()
        if p == "/api/admin/comments/batch" and m == "POST":
            return self._comment_batch()
        if p.startswith("/api/admin/overview"):
            return self._admin_stats(p, m)
        if p.startswith("/api/admin/site"):
            return self._admin_site(p, m)
        if p.startswith("/api/admin/storage"):
            return self._admin_site(p, m)
        if p.startswith("/api/admin/groups"):
            return self._admin_groups(p, m)
        if p.startswith("/api/admin/badges"):
            return self._admin_badges(p, m)
        if p.startswith("/api/admin/boards"):
            return self._admin_boards(p, m)
        if p.startswith("/api/admin/posts"):
            return self._admin_posts(p, m)
        if p.startswith("/api/admin/comments"):
            return self._admin_comments(p, m)
        if p.startswith("/api/admin/users"):
            return self._admin_users(p, m)
        if p.startswith("/api/admin/reports"):
            return self._admin_reports(p, m)
        if p.startswith("/api/admin/board-applications"):
            return self._admin_board_applications(p, m)
        if p.startswith("/api/admin/email"):
            return self._admin_email(p, m)
        raise ApiError(404, "接口不存在")

    # ==================== 数据导出 ====================
    def _admin_export(self):
        typ = (self.q.get("type", ["users"])[0] or "users").strip()
        if typ == "users":
            rows = self.conn.execute(
                "SELECT id,username,nickname,role,status,points,vip_expire,created_at "
                "FROM users ORDER BY id").fetchall()
            header = ["ID", "账号", "昵称", "角色", "状态", "积分", "VIP到期", "注册时间"]
            data = [[r["id"], r["username"], r["nickname"], r["role"],
                     "正常" if int(r["status"] or 0) == 1 else "封禁",
                     int(r["points"] or 0),
                     fmt_ts(r["vip_expire"]) if r["vip_expire"] else "",
                     fmt_ts(r["created_at"])] for r in rows]
            filename = "weforum-users.csv"
        elif typ == "posts":
            rows = self.conn.execute(POST_JOIN + " ORDER BY p.id").fetchall()
            header = ["ID", "版块", "标题", "作者", "浏览", "点赞", "评论", "置顶", "精华", "状态", "发布时间"]
            data = [[r["id"], r["board_name"], r["title"], r["nickname"] or "",
                     r["views"], r["likes"], r["comments"],
                     "是" if r["is_top"] else "否", "是" if r["is_essence"] else "否",
                     "正常" if int(r["status"] or 0) == 1 else "已删除",
                     fmt_ts(r["created_at"])] for r in rows]
            filename = "weforum-posts.csv"
        elif typ == "comments":
            rows = self.conn.execute(
                "SELECT c.id, p.title, u.nickname, c.content, c.created_at "
                "FROM comments c LEFT JOIN posts p ON p.id=c.post_id "
                "LEFT JOIN users u ON u.id=c.user_id ORDER BY c.id").fetchall()
            header = ["ID", "所属帖子", "评论者", "内容", "时间"]
            data = [[r["id"], r["title"] or "", r["nickname"] or "", r["content"],
                     fmt_ts(r["created_at"])] for r in rows]
            filename = "weforum-comments.csv"
        else:
            raise ApiError(400, "不支持的导出类型")
        return ok({"filename": filename, "csv": to_csv(header, data), "count": len(data)})

    # ==================== 站点设置 ====================
    def _admin_site(self, p, m):
        if p == "/api/admin/site" and m == "GET":
            return ok(self._site_settings())
        if p == "/api/admin/site" and m == "PUT":
            data = self.body or {}
            allowed = ("site_name", "site_desc", "site_about", "site_announcement", "site_keywords",
                       "site_logo", "site_demo_accounts", "site_vip_plans", "site_announcements",
                       "site_announce_interval", "site_board_cols",
                       "site_nav_home", "site_nav_social", "site_nav_boards",
                       "site_nav_notice", "site_nav_me",
                       "points_post", "points_comment", "points_checkin", "points_checkin_bonus_max",
                       "points_name",
                       "quick_replies",
                       "smtp_host", "smtp_port", "smtp_user", "smtp_pass", "smtp_from",
                       "smtp_name", "smtp_ssl", "site_email_verify",
                       "storage_mode", "webdav_url", "webdav_user", "webdav_pass",
                       "webdav_path", "webdav_public_url",
                       "baidu_token", "baidu_dir", "baidu_public_url",
                       "r2_endpoint", "r2_bucket", "r2_access_key_id", "r2_secret_access_key",
                       "r2_public_url", "r2_path_prefix")
            for key, val in data.items():
                if key not in allowed:
                    continue
                # 邮件（SMTP）相关配置先做专项清洗
                if key in ("smtp_host", "smtp_user", "smtp_from", "smtp_name"):
                    val = str(val or "").strip()[:120]
                    self.conn.execute(
                        "INSERT INTO site_settings(key, value) VALUES(?, ?) "
                        "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, val))
                    continue
                if key == "smtp_pass":
                    self.conn.execute(
                        "INSERT INTO site_settings(key, value) VALUES(?, ?) "
                        "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, str(val or "")))
                    continue
                if key == "smtp_port":
                    try:
                        val = str(max(1, min(65535, int(val or 465))))
                    except (ValueError, TypeError):
                        val = "465"
                elif key in ("smtp_ssl", "site_email_verify"):
                    val = "0" if str(val).strip().lower() in ("0", "false", "off", "") else "1"
                # 存储配置专项清洗
                if key == "storage_mode":
                    v = str(val).strip().lower()
                    val = v if v in ("local", "webdav", "baidu", "r2") else "local"
                if key in ("webdav_url", "webdav_public_url", "webdav_user", "webdav_path",
                           "baidu_dir", "baidu_public_url",
                           "r2_endpoint", "r2_public_url", "r2_path_prefix"):
                    val = str(val or "").strip()[:300]
                if key in ("r2_bucket", "r2_access_key_id"):
                    val = str(val or "").strip()
                # access_token / secret key 原样存储（只做基本清理，不截断）
                if key in ("baidu_token", "r2_secret_access_key"):
                    val = str(val or "").strip()
                # JSON 类型字段直接原样存储（字符串）
                if key in ("site_vip_plans", "site_announcements", "quick_replies"):
                    if isinstance(val, (list, dict)):
                        val = json.dumps(val, ensure_ascii=False)
                    else:
                        val = str(val or "")
                # 公告：归一为 [{text,start,end}] 后再存，兼容旧的纯字符串写法
                if key == "site_announcements":
                    val = json.dumps(parse_announcements(val), ensure_ascii=False)
                else:
                    val = str(val or "")
                # 站点名 / 描述有长度限制
                if key == "site_name" and len(val) > 30:
                    val = val[:30]
                if key == "site_desc" and len(val) > 120:
                    val = val[:120]
                if key == "site_announcement" and len(val) > 300:
                    val = val[:300]
                if key == "site_about" and len(val) > 2000:
                    val = val[:2000]
                if key == "site_demo_accounts" and len(val) > 300:
                    val = val[:300]
                # 积分名称：字符串，限 10 字
                if key == "points_name":
                    val = (val or "").strip()[:10] or "积分"
                # 积分数值项：限制为 0~1000 的整数
                elif key.startswith("points_"):
                    try:
                        val = str(max(0, min(1000, int(val or 0))))
                    except (ValueError, TypeError):
                        val = "0"
                # logo 支持 data URL，落盘后存访问路径
                if key == "site_logo" and val.startswith("data:"):
                    try:
                        val = save_data_url(val, self.conn)
                    except (ValueError, binascii.Error):
                        val = ""
                self.conn.execute(
                    "INSERT INTO site_settings(key, value) VALUES(?, ?) "
                    "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                    (key, val))
            self.conn.commit()
            return ok(self._site_settings())
        # 测试外部存储连接
        if p == "/api/admin/storage/test" and m == "POST":
            self.require_admin()
            body = self.body or {}
            kind = str(body.get("kind") or "webdav").strip().lower()
            if kind == "baidu":
                ok_flag, msg = baidu_test_connection({"token": body.get("token")})
            elif kind == "r2":
                ok_flag, msg = r2_test_connection({
                    "endpoint": body.get("endpoint"), "bucket": body.get("bucket"),
                    "access_key_id": body.get("access_key_id"),
                    "secret_access_key": body.get("secret_access_key"),
                })
            else:
                ok_flag, msg = webdav_test_connection({
                    "url": body.get("url"), "user": body.get("user"), "pass": body.get("pass"),
                    "path": body.get("path"), "public_url": body.get("public_url"),
                })
            return ok({"ok": ok_flag, "msg": msg})
        raise ApiError(404, "接口不存在")

    # ==================== 用户组 ====================
    def _admin_groups(self, p, m):
        if p == "/api/admin/groups" and m == "GET":
            rows = groups_list(self.conn)
            for g in rows:
                g["memberCount"] = self.conn.execute(
                    "SELECT COUNT(*) c FROM users WHERE group_id=?", (g["id"],)).fetchone()["c"]
            return ok(rows)
        if p == "/api/admin/groups" and m == "POST":
            d = self.body or {}
            name = str(d.get("name", "")).strip()
            if not name:
                raise ApiError(400, "用户组名称不能为空")
            if len(name) > 12:
                raise ApiError(400, "用户组名称不超过 12 个字")
            icon = str(d.get("icon", "") or "🌱").strip()[:4]
            color = str(d.get("color", "") or "#07C160").strip()[:16]
            level = int(d.get("level") or 1)
            min_exp = max(0, int(d.get("minExp") or 0))
            mx = self.conn.execute("SELECT COALESCE(MAX(sort),0) s FROM user_groups").fetchone()["s"]
            cur = self.conn.execute(
                "INSERT INTO user_groups(name,icon,color,level,min_exp,sort) VALUES(?,?,?,?,?,?)",
                (name, icon, color, level, min_exp, mx + 1))
            self.conn.commit()
            return ok({"id": cur.lastrowid})
        if p.startswith("/api/admin/groups/"):
            try:
                gid = int(p.rsplit("/", 1)[-1])
            except ValueError:
                raise ApiError(404, "用户组不存在")
            g = self.conn.execute("SELECT * FROM user_groups WHERE id=?", (gid,)).fetchone()
            if not g and m != "DELETE":
                raise ApiError(404, "用户组不存在")
            if m == "PUT":
                d = self.body or {}
                name = str(d.get("name", "")).strip()
                if not name:
                    raise ApiError(400, "用户组名称不能为空")
                if len(name) > 12:
                    raise ApiError(400, "用户组名称不超过 12 个字")
                icon = str(d.get("icon", "") or "🌱").strip()[:4]
                color = str(d.get("color", "") or "#07C160").strip()[:16]
                level = int(d.get("level") or 1)
                min_exp = max(0, int(d.get("minExp") or 0))
                sort = int(d.get("sort") if d.get("sort") is not None else g["sort"])
                self.conn.execute(
                    "UPDATE user_groups SET name=?, icon=?, color=?, level=?, min_exp=?, sort=? WHERE id=?",
                    (name, icon, color, level, min_exp, sort, gid))
                self.conn.commit()
                return ok({"id": gid})
            if m == "DELETE":
                total = self.conn.execute("SELECT COUNT(*) c FROM user_groups").fetchone()["c"]
                if total <= 1:
                    raise ApiError(400, "至少需要保留一个用户组")
                used = self.conn.execute("SELECT COUNT(*) c FROM users WHERE group_id=?", (gid,)).fetchone()["c"]
                # 手动指定该组的用户回退到自动匹配，不阻塞删除
                self.conn.execute("UPDATE users SET group_id=0 WHERE group_id=?", (gid,))
                self.conn.execute("DELETE FROM user_groups WHERE id=?", (gid,))
                self.conn.commit()
                return ok({"released": used})
        raise ApiError(404, "接口不存在")

    # ==================== 勋章 ====================
    def _admin_badges(self, p, m):
        if p == "/api/admin/badges" and m == "GET":
            rows = badges_list(self.conn)
            for b in rows:
                b["grantCount"] = self.conn.execute(
                    "SELECT COUNT(*) c FROM user_badges WHERE badge_id=?", (b["id"],)).fetchone()["c"]
            return ok(rows)
        if p == "/api/admin/badges" and m == "POST":
            d = self.body or {}
            name = str(d.get("name", "")).strip()
            if not name:
                raise ApiError(400, "勋章名称不能为空")
            if len(name) > 12:
                raise ApiError(400, "勋章名称不超过 12 个字")
            icon = str(d.get("icon", "") or "🏅").strip()[:4]
            color = str(d.get("color", "") or "#07C160").strip()[:16]
            desc = str(d.get("description", "")).strip()[:60]
            mx = self.conn.execute("SELECT COALESCE(MAX(sort),0) s FROM badges").fetchone()["s"]
            cur = self.conn.execute(
                "INSERT INTO badges(name,icon,color,description,sort) VALUES(?,?,?,?,?)",
                (name, icon, color, desc, mx + 1))
            self.conn.commit()
            return ok({"id": cur.lastrowid})
        if p.startswith("/api/admin/badges/"):
            try:
                bid = int(p.rsplit("/", 1)[-1])
            except ValueError:
                raise ApiError(404, "勋章不存在")
            b = self.conn.execute("SELECT * FROM badges WHERE id=?", (bid,)).fetchone()
            if not b and m != "DELETE":
                raise ApiError(404, "勋章不存在")
            if m == "PUT":
                d = self.body or {}
                name = str(d.get("name", "")).strip()
                if not name:
                    raise ApiError(400, "勋章名称不能为空")
                if len(name) > 12:
                    raise ApiError(400, "勋章名称不超过 12 个字")
                icon = str(d.get("icon", "") or "🏅").strip()[:4]
                color = str(d.get("color", "") or "#07C160").strip()[:16]
                desc = str(d.get("description", "")).strip()[:60]
                sort = int(d.get("sort") if d.get("sort") is not None else b["sort"])
                self.conn.execute(
                    "UPDATE badges SET name=?, icon=?, color=?, description=?, sort=? WHERE id=?",
                    (name, icon, color, desc, sort, bid))
                self.conn.commit()
                return ok({"id": bid})
            if m == "DELETE":
                self.conn.execute("DELETE FROM user_badges WHERE badge_id=?", (bid,))
                self.conn.execute("DELETE FROM badges WHERE id=?", (bid,))
                self.conn.commit()
                return ok()
        raise ApiError(404, "接口不存在")

    def _admin_boards(self, p, m):
        if p == "/api/admin/boards" and m == "GET":
            rows = self.conn.execute(
                "SELECT b.*, (SELECT COUNT(*) FROM posts x WHERE x.board_id=b.id AND x.status=1) post_count "
                "FROM boards b ORDER BY b.sort, b.id").fetchall()
            return ok([{
                "id": b["id"], "name": b["name"], "slug": b["slug"], "icon": b["icon"],
                "color": b["color"], "description": b["description"] or "",
                "layout": b["layout"] or "list", "accessMode": b["access_mode"] or "public",
                "sort": b["sort"], "postCount": b["post_count"], "count": b["post_count"],
                "moderators": moderators_of(self.conn, b["id"]),
            } for b in rows])
        if p == "/api/admin/boards" and m == "POST":
            data = self.body or {}
            name = str(data.get("name", "")).strip()
            if not name:
                raise ApiError(400, "版块名称不能为空")
            if len(name) > 10:
                raise ApiError(400, "版块名称不超过 10 个字")
            desc = str(data.get("description", "")).strip()[:60]
            icon = str(data.get("icon", "") or "💬").strip()[:4]
            color = str(data.get("color", "") or "#07C160").strip()[:16]
            layout = str(data.get("layout", "list"))
            if layout not in ("list", "grid2", "image"):
                layout = "list"
            access_mode = str(data.get("access_mode", "public"))
            if access_mode not in ("public", "vip", "apply"):
                access_mode = "public"
            slug = str(data.get("slug", "")).strip() or ("b%d" % (now_ts() % 100000))
            if self.conn.execute("SELECT 1 FROM boards WHERE slug=?", (slug,)).fetchone():
                slug = "b%d" % int(now_ts() * 1000 % 1000000000)
            mx = self.conn.execute("SELECT COALESCE(MAX(sort),0) s FROM boards").fetchone()["s"]
            cur = self.conn.execute(
                "INSERT INTO boards(name,slug,icon,color,description,layout,sort,access_mode) VALUES(?,?,?,?,?,?,?,?)",
                (name, slug, icon, color, desc, layout, mx + 1, access_mode))
            self.conn.commit()
            return ok({"id": cur.lastrowid})
        mt = re.match(r"^/api/admin/boards/(\d+)/moderators$", p)
        if mt:
            bid = int(mt.group(1))
            if not self.conn.execute("SELECT 1 FROM boards WHERE id=?", (bid,)).fetchone():
                raise ApiError(404, "版块不存在")
            if m == "GET":
                return ok(moderators_of(self.conn, bid))
            if m == "PUT":
                data = self.body or {}
                ids = []
                for x in (data.get("userIds") or []):
                    try:
                        ids.append(int(x))
                    except (TypeError, ValueError):
                        continue
                clean = []
                for uid in dict.fromkeys(ids):
                    if uid not in clean and self.conn.execute("SELECT 1 FROM users WHERE id=?", (uid,)).fetchone():
                        clean.append(uid)
                self.conn.execute("DELETE FROM board_moderators WHERE board_id=?", (bid,))
                for uid in clean:
                    self.conn.execute(
                        "INSERT OR IGNORE INTO board_moderators(board_id,user_id,created_at) VALUES(?,?,?)",
                        (bid, uid, now_ts()))
                self.conn.commit()
                return ok(moderators_of(self.conn, bid))
        if p.startswith("/api/admin/boards/"):
            bid = int(p.rsplit("/", 1)[-1])
            if m == "GET":
                return ok(self._board_admin(bid))
            if m == "PUT":
                data = self.body or {}
                name = str(data.get("name", "")).strip()
                if not name:
                    raise ApiError(400, "版块名称不能为空")
                if len(name) > 10:
                    raise ApiError(400, "版块名称不超过 10 个字")
                desc = str(data.get("description", "")).strip()[:60]
                icon = str(data.get("icon", "") or "💬").strip()[:4]
                color = str(data.get("color", "") or "#07C160").strip()[:16]
                layout = str(data.get("layout", "list"))
                if layout not in ("list", "grid2", "image"):
                    layout = "list"
                access_mode = str(data.get("access_mode", "public"))
                if access_mode not in ("public", "vip", "apply"):
                    access_mode = "public"
                sort = int(data.get("sort") or 0)
                self.conn.execute(
                    "UPDATE boards SET name=?, icon=?, color=?, description=?, layout=?, access_mode=?, sort=? WHERE id=?",
                    (name, icon, color, desc, layout, access_mode, sort, bid))
                self.conn.commit()
                return ok(self._board_admin(bid))
            if m == "DELETE":
                used = self.conn.execute("SELECT COUNT(*) c FROM posts WHERE board_id=?", (bid,)).fetchone()["c"]
                if used:
                    raise ApiError(400, "该版块下还有 %d 个帖子，请先迁移或删除" % used)
                self.conn.execute("DELETE FROM boards WHERE id=?", (bid,))
                self.conn.commit()
                return ok()
        raise ApiError(404, "接口不存在")

    def _board_admin(self, bid):
        b = self.conn.execute(
            "SELECT b.*, (SELECT COUNT(*) FROM posts x WHERE x.board_id=b.id AND x.status=1) c "
            "FROM boards b WHERE b.id=?", (bid,)).fetchone()
        if not b:
            raise ApiError(404, "版块不存在")
        return {"id": b["id"], "name": b["name"], "slug": b["slug"], "icon": b["icon"],
                "color": b["color"], "description": b["description"] or "",
                "layout": b["layout"] or "list", "accessMode": b["access_mode"] or "public",
                "sort": b["sort"], "postCount": b["c"], "count": b["c"],
                "moderators": moderators_of(self.conn, bid)}

    # ==================== 帖子管理 ====================
    def _admin_posts(self, p, m):
        q = self.q
        if p == "/api/admin/posts" and m == "GET":
            return ok(self._post_list(q))
        if p.startswith("/api/admin/posts/"):
            try:
                pid = int(p.rsplit("/", 1)[-1])
            except ValueError:
                raise ApiError(404, "帖子不存在")
            row = self.conn.execute(POST_JOIN + " WHERE p.id=?", (pid,)).fetchone()
            if not row:
                raise ApiError(404, "帖子不存在")
            if m == "GET":
                return ok(self._post_admin(row))
            if m == "PUT":
                return ok(self._post_update(row))
            if m == "DELETE":
                self.conn.execute("DELETE FROM posts WHERE id=?", (pid,))
                self.conn.execute("DELETE FROM comments WHERE post_id=?", (pid,))
                self.conn.execute("DELETE FROM favorites WHERE post_id=?", (pid,))
                self.conn.commit()
                return ok()
        raise ApiError(404, "接口不存在")

    def _post_list(self, q):
        kw = (q.get("q", [""])[0] or "").strip()
        board = q.get("board", [""])[0]
        status = q.get("status", [""])[0]
        sort = q.get("sort", ["latest"])[0]
        page = max(1, int(q.get("page", ["1"])[0] or 1))
        size = 20
        where, args = ["1=1"], []
        if kw:
            where.append("(p.title LIKE ? OR p.content LIKE ?)")
            args += [f"%{kw}%", f"%{kw}%"]
        if board:
            where.append("p.board_id=?")
            args.append(int(board))
        if status == "deleted":
            where.append("p.status=0")
        elif status == "normal":
            where.append("p.status=1")
        w = " WHERE " + " AND ".join(where)
        order = {
            "latest": "p.is_top DESC, p.last_active DESC",
            "oldest": "p.created_at ASC",
            "hot": "(p.likes*3 + p.comments*5 + p.views) DESC",
            "comments": "p.comments DESC, p.last_active DESC",
        }.get(sort, "p.is_top DESC, p.last_active DESC")
        total = self.conn.execute("SELECT COUNT(*) c FROM posts p" + w, args).fetchone()["c"]
        rows = self.conn.execute(
            POST_JOIN + w + f" ORDER BY {order} LIMIT ? OFFSET ?",
            args + [size, (page - 1) * size]).fetchall()
        items = []
        for r in rows:
            item = self._post_admin(r)
            items.append(item)
        return {"items": items, "total": total, "page": page, "pages": max(1, (total + size - 1) // size)}

    def _post_batch(self):
        d = self.body or {}
        ids = []
        for i in (d.get("ids") or []):
            try:
                ids.append(int(i))
            except (TypeError, ValueError):
                continue
        action = str(d.get("action") or "")
        if not ids:
            raise ApiError(400, "请选择要操作的帖子")
        allowed = ("hide", "restore", "top", "untop", "essence", "unessence", "delete")
        if action not in allowed:
            raise ApiError(400, "不支持的操作")
        ph = ",".join("?" * len(ids))
        if action == "hide":
            self.conn.execute(f"UPDATE posts SET status=0, is_top=0 WHERE id IN ({ph})", ids)
        elif action == "restore":
            self.conn.execute(f"UPDATE posts SET status=1 WHERE id IN ({ph})", ids)
        elif action == "top":
            self.conn.execute(f"UPDATE posts SET is_top=1 WHERE id IN ({ph})", ids)
        elif action == "untop":
            self.conn.execute(f"UPDATE posts SET is_top=0 WHERE id IN ({ph})", ids)
        elif action == "essence":
            self.conn.execute(f"UPDATE posts SET is_essence=1 WHERE id IN ({ph})", ids)
        elif action == "unessence":
            self.conn.execute(f"UPDATE posts SET is_essence=0 WHERE id IN ({ph})", ids)
        elif action == "delete":
            self.conn.execute(f"DELETE FROM comments WHERE post_id IN ({ph})", ids)
            self.conn.execute(f"DELETE FROM favorites WHERE post_id IN ({ph})", ids)
            self.conn.execute(f"DELETE FROM likes WHERE target_type='post' AND target_id IN ({ph})", ids)
            self.conn.execute(f"DELETE FROM posts WHERE id IN ({ph})", ids)
        self.conn.commit()
        return ok({"count": len(ids)})

    def _post_admin(self, r):
        return {
            "id": r["id"], "title": r["title"],
            "summary": re.sub(r"\s+", " ", r["content"] or "")[:80],
            "content": r["content"] or "",
            "boardId": r["board_id"], "boardName": r["board_name"],
            "userId": r["user_id"], "author": r["nickname"] or "已注销",
            "isTop": bool(r["is_top"]), "isEssence": bool(r["is_essence"]),
            "status": int(r["status"] if r["status"] is not None else 1),
            "adminNote": r["admin_note"] or "",
            "views": r["views"], "likes": r["likes"], "comments": r["comments"],
            "createdAt": r["created_at"], "createdAgo": time_ago(r["created_at"]),
        }

    def _post_update(self, row):
        pid = row["id"]
        d = self.body or {}
        sets, args = [], []
        if "title" in d:
            title = str(d.get("title") or "").strip()
            if len(title) < 2:
                raise ApiError(400, "标题至少 2 个字")
            sets.append("title=?"); args.append(title[:80])
        if "content" in d:
            body = str(d.get("content") or "").strip()
            if len(body) < 2:
                raise ApiError(400, "正文至少 2 个字")
            sets.append("content=?"); args.append(body[:20000])
        if "boardId" in d and d.get("boardId") is not None:
            sets.append("board_id=?"); args.append(int(d["boardId"]))
        if "isTop" in d:
            sets.append("is_top=?"); args.append(1 if d.get("isTop") else 0)
        if "isEssence" in d:
            sets.append("is_essence=?"); args.append(1 if d.get("isEssence") else 0)
        if "status" in d:
            st = int(d.get("status") or 0)
            sets.append("status=?"); args.append(1 if st == 1 else 0)
            if st != 1:
                sets.append("is_top=?"); args.append(0)
        if "adminNote" in d:
            sets.append("admin_note=?"); args.append(str(d.get("adminNote") or "")[:200])
        if not sets:
            return {"updated": False}
        self.conn.execute("UPDATE posts SET " + ",".join(sets) + " WHERE id=?", args + [pid])
        self.conn.commit()
        row = self.conn.execute(POST_JOIN + " WHERE p.id=?", (pid,)).fetchone()
        if row:
            return {"updated": True, "post": self._post_admin(row)}
        return {"updated": True, "deleted": True}

    # ==================== 评论管理 ====================
    def _admin_comments(self, p, m):
        q = self.q
        if p == "/api/admin/comments" and m == "GET":
            kw = (q.get("q", [""])[0] or "").strip()
            page = max(1, int(q.get("page", ["1"])[0] or 1))
            size = 30
            where, args = ["1=1"], []
            if kw:
                where.append("c.content LIKE ?")
                args.append("%" + kw + "%")
            w = " WHERE " + " AND ".join(where)
            total = self.conn.execute("SELECT COUNT(*) c FROM comments c" + w, args).fetchone()["c"]
            rows = self.conn.execute(
                "SELECT c.*, u.nickname, u.avatar, p.title post_title FROM comments c "
                "LEFT JOIN users u ON u.id=c.user_id LEFT JOIN posts p ON p.id=c.post_id" + w +
                " ORDER BY c.id DESC LIMIT ? OFFSET ?", args + [size, (page - 1) * size]).fetchall()
            return ok({"items": [{
                "id": r["id"], "content": r["content"], "postId": r["post_id"],
                "postTitle": r["post_title"] or "（帖子已删除）",
                "author": r["nickname"] or "已注销", "avatar": r["avatar"] or "",
                "createdAt": r["created_at"], "createdAgo": time_ago(r["created_at"]),
                "isReply": r["parent_id"] != r["id"] and r["parent_id"] != 0,
            } for r in rows], "total": total, "page": page, "pages": max(1, (total + size - 1) // size)})
        if p.startswith("/api/admin/comments/") and m == "DELETE":
            cid = int(p.rsplit("/", 1)[-1])
            c = self.conn.execute("SELECT post_id FROM comments WHERE id=?", (cid,)).fetchone()
            if not c:
                raise ApiError(404, "评论不存在")
            # 同时清掉它下面的楼中楼回复
            kids = self.conn.execute(
                "SELECT COUNT(*) c FROM comments WHERE parent_id=? AND id<>?", (cid, cid)).fetchone()["c"]
            self.conn.execute("DELETE FROM comments WHERE id=? OR (parent_id=? AND id<>?)", (cid, cid, cid))
            self.conn.execute("UPDATE posts SET comments=MAX(comments-?,0) WHERE id=?", (1 + kids, c["post_id"]))
            self.conn.commit()
            return ok()
        raise ApiError(404, "接口不存在")

    def _comment_batch(self):
        d = self.body or {}
        ids = []
        for i in (d.get("ids") or []):
            try:
                ids.append(int(i))
            except (TypeError, ValueError):
                continue
        if not ids:
            raise ApiError(400, "请选择要删除的评论")
        ph = ",".join("?" * len(ids))
        rows = self.conn.execute(
            f"SELECT id, parent_id, post_id FROM comments WHERE id IN ({ph})", ids).fetchall()
        if not rows:
            return ok({"count": 0})
        roots = [r["id"] for r in rows if r["parent_id"] == r["id"]]
        children = []
        if roots:
            rph = ",".join("?" * len(roots))
            children = [k["id"] for k in self.conn.execute(
                f"SELECT id FROM comments WHERE parent_id IN ({rph}) AND parent_id<>id", roots).fetchall()]
        all_ids = {r["id"] for r in rows} | set(children)
        affected = {r["post_id"] for r in rows}
        aph = ",".join("?" * len(all_ids))
        self.conn.execute(f"DELETE FROM comments WHERE id IN ({aph})", list(all_ids))
        # 直接按实际剩余评论数回写计数，避免累减出错
        for pid in affected:
            n = self.conn.execute("SELECT COUNT(*) c FROM comments WHERE post_id=?", (pid,)).fetchone()["c"]
            self.conn.execute("UPDATE posts SET comments=? WHERE id=?", (n, pid))
        self.conn.commit()
        return ok({"count": len(all_ids)})

    # ==================== 用户管理 ====================
    def _admin_users(self, p, m):
        q = self.q
        if p == "/api/admin/users" and m == "GET":
            kw = (q.get("q", [""])[0] or "").strip()
            page = max(1, int(q.get("page", ["1"])[0] or 1))
            size = 20
            where, args = ["1=1"], []
            if kw:
                where.append("(nickname LIKE ? OR username LIKE ?)")
                args += [f"%{kw}%", f"%{kw}%"]
            w = " WHERE " + " AND ".join(where)
            total = self.conn.execute("SELECT COUNT(*) c FROM users" + w, args).fetchone()["c"]
            rows = self.conn.execute("SELECT * FROM users" + w + " ORDER BY id ASC LIMIT ? OFFSET ?",
                                     args + [size, (page - 1) * size]).fetchall()
            items = []
            for r in rows:
                lv = level_payload(self.conn, r["id"])
                items.append({
                    "id": r["id"], "username": r["username"], "nickname": r["nickname"],
                    "avatar": r["avatar"] or "", "role": r["role"] or "user",
                    "status": int(r["status"] if r["status"] is not None else 1),
                    "postCount": self.conn.execute("SELECT COUNT(*) c FROM posts WHERE user_id=?", (r["id"],)).fetchone()["c"],
                    "groupId": int(r["group_id"] or 0),
                    "exp": lv["exp"], "level": lv["level"], "group": lv["group"],
                    "isManualGroup": lv["isManualGroup"],
                    "badges": user_badges(self.conn, r["id"]),
                    "points": int(r["points"] or 0),
                    "vipExpire": int(r["vip_expire"] or 0),
                    "isVip": int(r["vip_expire"] or 0) > now_ts(),
                    "createdAt": r["created_at"],
                    "joinedAgo": time_ago(r["created_at"]),
                })
            return ok({"items": items, "total": total, "page": page, "pages": max(1, (total + size - 1) // size)})
        # 单独处理勋章授予：/api/admin/users/:id/badges
        mb = re.match(r"^/api/admin/users/(\d+)/badges$", p)
        if mb and m == "PUT":
            uid = int(mb.group(1))
            if not self.conn.execute("SELECT 1 FROM users WHERE id=?", (uid,)).fetchone():
                raise ApiError(404, "用户不存在")
            ids = []
            for i in (self.body.get("ids") or []):
                try:
                    ids.append(int(i))
                except (TypeError, ValueError):
                    continue
            valid = [b["id"] for b in badges_list(self.conn)]
            ids = [i for i in ids if i in valid]
            self.conn.execute("DELETE FROM user_badges WHERE user_id=?", (uid,))
            for bid in ids:
                self.conn.execute("INSERT OR IGNORE INTO user_badges(user_id,badge_id,created_at) VALUES(?,?,?)",
                                  (uid, bid, now_ts()))
            self.conn.commit()
            return ok({"badges": user_badges(self.conn, uid)})
        if p.startswith("/api/admin/users/"):
            try:
                uid = int(p.rsplit("/", 1)[-1])
            except ValueError:
                raise ApiError(404, "用户不存在")
            u = self.conn.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
            if not u:
                raise ApiError(404, "用户不存在")
            if m == "PUT":
                d = self.body or {}
                if "nickname" in d:
                    nick = str(d.get("nickname") or "").strip()
                    if not nick or len(nick) > 16:
                        raise ApiError(400, "昵称 1-16 个字")
                    self.conn.execute("UPDATE users SET nickname=? WHERE id=?", (nick, uid))
                if "bio" in d:
                    self.conn.execute("UPDATE users SET bio=? WHERE id=?", (str(d.get("bio") or "")[:100], uid))
                if "avatar" in d:
                    av = d.get("avatar")
                    if isinstance(av, str) and av.startswith("data:"):
                        try:
                            av = save_data_url(av, self.conn)
                        except (ValueError, binascii.Error):
                            av = u["avatar"] or ""
                    self.conn.execute("UPDATE users SET avatar=? WHERE id=?", (av or "", uid))
                if "password" in d and d.get("password"):
                    pwd = str(d.get("password"))
                    if len(pwd) < 6:
                        raise ApiError(400, "密码至少 6 位")
                    self.conn.execute("UPDATE users SET password=? WHERE id=?", (hash_password(pwd), uid))
                if "status" in d:
                    st = 1 if int(d.get("status") or 0) == 1 else 0
                    if st == 0 and uid == self.uid:
                        raise ApiError(400, "不能封禁自己")
                    self.conn.execute("UPDATE users SET status=? WHERE id=?", (st, uid))
                if "role" in d:
                    role = str(d.get("role") or "user")
                    if role not in ("admin", "user"):
                        role = "user"
                    if role != "admin" and uid == self.uid:
                        raise ApiError(400, "不能取消自己的管理员身份")
                    self.conn.execute("UPDATE users SET role=? WHERE id=?", (role, uid))
                if "groupId" in d:
                    gid = int(d.get("groupId") or 0)
                    if gid and not self.conn.execute("SELECT 1 FROM user_groups WHERE id=?", (gid,)).fetchone():
                        raise ApiError(400, "用户组不存在")
                    # 0 表示恢复为按经验值自动匹配
                    self.conn.execute("UPDATE users SET group_id=? WHERE id=?", (gid, uid))
                if "points" in d:
                    pts = max(0, int(d.get("points") or 0))
                    self.conn.execute("UPDATE users SET points=? WHERE id=?", (pts, uid))
                if "vipExpire" in d:
                    ve = int(d.get("vipExpire") or 0)
                    self.conn.execute("UPDATE users SET vip_expire=? WHERE id=?", (ve, uid))
                self.conn.commit()
                u = self.conn.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
                return ok({"user": {"id": u["id"], "username": u["username"], "nickname": u["nickname"],
                                    "avatar": u["avatar"] or "", "bio": u["bio"] or "",
                                    "role": u["role"] or "user",
                                    "status": int(u["status"] if u["status"] is not None else 1),
                                    "points": int(u["points"] or 0),
                                    "vipExpire": int(u["vip_expire"] or 0)}})
            if m == "DELETE":
                if uid == self.uid:
                    raise ApiError(400, "不能删除自己")
                self.conn.execute("DELETE FROM users WHERE id=?", (uid,))
                self.conn.commit()
                return ok()
        raise ApiError(404, "接口不存在")

    # ==================== 统计概览 ====================
    def _admin_stats(self, p, m):
        c = self.conn
        q = lambda s, a=(): c.execute(s, a).fetchone()[0]
        day = now_ts() - 86400
        week = now_ts() - 86400 * 7
        trend = []
        for i in range(13, -1, -1):
            start = now_ts() - 86400 * (i + 1)
            end = now_ts() - 86400 * i
            trend.append({
                "date": datetime.fromtimestamp(end).strftime("%m-%d"),
                "posts": q("SELECT COUNT(*) FROM posts WHERE created_at>? AND created_at<=? AND status=1", (start, end)),
                "comments": q("SELECT COUNT(*) FROM comments WHERE created_at>? AND created_at<=?", (start, end)),
            })
        return ok({
            "users": q("SELECT COUNT(*) FROM users"),
            "posts": q("SELECT COUNT(*) FROM posts WHERE status=1"),
            "comments": q("SELECT COUNT(*) FROM comments"),
            "boards": q("SELECT COUNT(*) FROM boards"),
            "groups": q("SELECT COUNT(*) FROM user_groups"),
            "badges": q("SELECT COUNT(*) FROM badges"),
            "grantedBadges": q("SELECT COUNT(*) FROM user_badges"),
            "newUsers7d": q("SELECT COUNT(*) FROM users WHERE created_at>?", (week,)),
            "newPosts1d": q("SELECT COUNT(*) FROM posts WHERE created_at>? AND status=1", (day,)),
            "newComments1d": q("SELECT COUNT(*) FROM comments WHERE created_at>?", (day,)),
            "banned": q("SELECT COUNT(*) FROM users WHERE status=0"),
            "deletedPosts": q("SELECT COUNT(*) FROM posts WHERE status=0"),
            "pendingReports": q("SELECT COUNT(*) FROM reports"),
            "trend": trend,
        })

    def _admin_reports(self, p, m):
        if p == "/api/admin/reports" and m == "GET":
            rows = self.conn.execute(
                "SELECT r.*, u.nickname FROM reports r LEFT JOIN users u ON u.id=r.user_id "
                "ORDER BY r.id DESC LIMIT 50").fetchall()
            return ok([{
                "id": r["id"], "type": r["target_type"], "targetId": r["target_id"],
                "reason": r["reason"], "author": r["nickname"] or "已注销",
                "createdAgo": time_ago(r["created_at"]),
            } for r in rows])
        if p.startswith("/api/admin/reports/") and m == "DELETE":
            self.conn.execute("DELETE FROM reports WHERE id=?", (int(p.rsplit("/", 1)[-1]),))
            self.conn.commit()
            return ok()
        raise ApiError(404, "接口不存在")

    # ==================== 版块访问申请审核 ====================
    def _admin_board_applications(self, p, m):
        if p == "/api/admin/board-applications" and m == "GET":
            status = self.q.get("status", [""])[0]
            sql = ("SELECT a.*, u.nickname, u.username, b.name board_name, b.slug board_slug "
                   "FROM board_applications a "
                   "LEFT JOIN users u ON u.id=a.user_id "
                   "LEFT JOIN boards b ON b.id=a.board_id ")
            params = []
            if status in ("pending", "approved", "rejected"):
                sql += "WHERE a.status=? "
                params.append(status)
            sql += "ORDER BY a.id DESC LIMIT 100"
            rows = self.conn.execute(sql, params).fetchall()
            return ok([{
                "id": r["id"], "boardId": r["board_id"], "boardName": r["board_name"],
                "boardSlug": r["board_slug"], "userId": r["user_id"],
                "nickname": r["nickname"] or "已注销", "username": r["username"] or "",
                "reason": r["reason"] or "", "status": r["status"],
                "createdAgo": time_ago(r["created_at"]),
            } for r in rows])
        mt = re.match(r"^/api/admin/board-applications/(\d+)/(approve|reject)$", p)
        if mt and m == "PUT":
            aid = int(mt.group(1))
            action = mt.group(2)
            row = self.conn.execute("SELECT * FROM board_applications WHERE id=?", (aid,)).fetchone()
            if not row:
                raise ApiError(404, "申请不存在")
            if row["status"] != "pending":
                raise ApiError(400, "该申请已处理")
            new_status = "approved" if action == "approve" else "rejected"
            self.conn.execute(
                "UPDATE board_applications SET status=?, handled_by=?, handled_at=? WHERE id=?",
                (new_status, self.uid, now_ts(), aid))
            if action == "approve":
                self.conn.execute(
                    "INSERT OR IGNORE INTO board_access(board_id,user_id,approved_by,approved_at) VALUES(?,?,?,?)",
                    (row["board_id"], row["user_id"], self.uid, now_ts()))
            self.conn.commit()
            notify(self.conn, row["user_id"], 0, "system",
                   content=f"你对版块「{self.conn.execute('SELECT name FROM boards WHERE id=?', (row['board_id'],)).fetchone()['name']}」的访问申请已{'通过' if action == 'approve' else '被拒绝'}")
            return ok({"status": new_status})
        raise ApiError(404, "接口不存在")

    # ==================== 邮件群发 ====================
    def _admin_email(self, p, m):
        if p == "/api/admin/email/recipients" and m == "GET":
            # 预览各目标分组的收件人数（仅统计有邮箱的用户）
            now = now_ts()
            stats = {
                "all": self.conn.execute("SELECT COUNT(*) c FROM users WHERE email<>''").fetchone()["c"],
                "vip": self.conn.execute("SELECT COUNT(*) c FROM users WHERE email<>'' AND vip_expire>?", (now,)).fetchone()["c"],
                "active": self.conn.execute("SELECT COUNT(*) c FROM users WHERE email<>'' AND status=1").fetchone()["c"],
            }
            return ok(stats)

        if p == "/api/admin/email/bulk" and m == "POST":
            subject = str(self.body.get("subject", "")).strip()
            content = str(self.body.get("content", ""))
            target = str(self.body.get("target", "all")).strip()
            dry_run = bool(self.body.get("dryRun"))
            if not subject:
                raise ApiError(400, "请填写邮件主题")
            if not content.strip():
                raise ApiError(400, "请填写邮件正文")
            if target not in ("all", "vip", "active", "selected"):
                target = "all"

            now = now_ts()
            if target == "all":
                rows = self.conn.execute(
                    "SELECT id, email, nickname FROM users WHERE email<>''").fetchall()
            elif target == "vip":
                rows = self.conn.execute(
                    "SELECT id, email, nickname FROM users WHERE email<>'' AND vip_expire>?", (now,)).fetchall()
            elif target == "active":
                rows = self.conn.execute(
                    "SELECT id, email, nickname FROM users WHERE email<>'' AND status=1").fetchall()
            else:
                ids = self.body.get("userIds") or []
                if not isinstance(ids, list) or not ids:
                    raise ApiError(400, "请选择要发送的用户")
                ph = ",".join("?" * len(ids))
                rows = self.conn.execute(
                    f"SELECT id, email, nickname FROM users WHERE email<>'' AND id IN ({ph})",
                    [int(x) for x in ids]).fetchall()

            recipients = [{"id": r["id"], "email": r["email"], "nickname": r["nickname"] or ""} for r in rows]
            if dry_run:
                return ok({"dryRun": True, "total": len(recipients), "recipients": recipients})

            # 真正发送时才要求 SMTP 已配置
            cfg = email_config(self.conn)
            if not cfg["enabled"]:
                raise ApiError(400, "尚未配置 SMTP 服务器，请先到「站点设置 → 邮件设置」填写 SMTP 信息")

            # 正文：含 HTML 标签则原样发送，否则把换行转 <br> 并套简单模板
            if "<" in content and ">" in content:
                body_html = content
            else:
                body_html = (f'<div style="font-family:-apple-system,\'PingFang SC\',\'Microsoft YaHei\',sans-serif;'
                             f'font-size:14px;line-height:1.8;color:#333;white-space:pre-wrap">{html.escape(content)}</div>')

            sent, failed = 0, []
            for u in recipients:
                ok_flag, err = send_email(self.conn, u["email"], subject, body_html)
                if ok_flag:
                    sent += 1
                else:
                    failed.append({"email": u["email"], "nickname": u["nickname"], "error": err})
            print(f"[email] bulk target={target} total={len(recipients)} sent={sent} failed={len(failed)}", flush=True)
            return ok({"total": len(recipients), "sent": sent, "failed": failed})

        raise ApiError(404, "接口不存在")


class ApiError(Exception):
    def __init__(self, code, msg):
        self.code = code
        self.msg = msg


# --------------------------------------------------------------------------
# HTTP Handler
# --------------------------------------------------------------------------
class Handler(BaseHTTPRequestHandler):
    server_version = "WeForum/1.0"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        if os.environ.get("WEFORUM_QUIET") != "1":
            sys.stderr.write("[%s] %s\n" % (time.strftime("%H:%M:%S"), fmt % args))

    # ---------- 静态文件 ----------
    def _send_file(self, path, cache=True):
        if not os.path.isfile(path):
            self._send_json({"ok": False, "error": "Not Found"}, 404)
            return
        ctype = mimetypes.guess_type(path)[0] or "application/octet-stream"
        with open(path, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype + ("; charset=utf-8" if ctype.startswith("text/") or "javascript" in ctype or "json" in ctype else ""))
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "public, max-age=3600" if cache else "no-cache")
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _safe_join(self, root, rel):
        rel = unquote(rel).lstrip("/")
        full = os.path.normpath(os.path.join(root, rel))
        if not full.startswith(os.path.normpath(root)):
            return None
        return full

    def _send_json(self, payload, status=200):
        if "__status" in payload:
            status = payload.pop("__status")
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self.send_header("Access-Control-Allow-Origin", "*")
        renew = getattr(self, "_renew_token", None)
        if renew:
            self.send_header("X-Renew-Token", renew)
            self.send_header("Access-Control-Expose-Headers", "X-Renew-Token")
            self._renew_token = None
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _read_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        if length > 16 * 1024 * 1024:
            raise ApiError(413, "请求体过大")
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8") or "{}")
        except (json.JSONDecodeError, UnicodeDecodeError):
            raise ApiError(400, "请求格式错误")

    def _auth(self):
        # 顺序很重要：云函数/网关经常丢弃自定义请求头（含 Authorization），
        # 所以前端的 token 走 query 参数 _t 最稳，请求头只作为本地/直连时的补充。
        parsed_q = urlparse(self.path).query
        qs = parse_qs(parsed_q)
        token = (qs.get("_t", [""])[0] or "").strip()
        if not token:
            auth = self.headers.get("Authorization") or ""
            token = auth[7:] if auth.startswith("Bearer ") else ""
        if not token:
            token = self.headers.get("X-Token") or ""
        if not token:
            token = (self.headers.get("Cookie") or "").split("wf_token=")[-1].split(";")[0].strip() \
                if "wf_token=" in (self.headers.get("Cookie") or "") else ""
        if not token:
            return None
        parsed = parse_token(token, with_exp=True)
        if not parsed:
            return None
        uid, exp = parsed
        # 剩余不足 7 天就换发新 token，避免长期活跃用户被莫名踢下线
        if exp - time.time() < 7 * 86400:
            self._renew_token = make_token(uid)
        return uid

    # ---------- 方法 ----------
    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Token")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _handle(self, method):
        parsed = urlparse(self.path)
        path = parsed.path
        if path.startswith("/api/"):
            conn = db()
            try:
                body = {}
                if method in ("POST", "PUT"):
                    body = self._read_body()
                q = parse_qs(parsed.query)
                q.pop("_t", None)   # 鉴权参数，不参与业务逻辑
                api = API(conn, method, path, q, body, self._auth(), {})
                result = api.dispatch()
                self._send_json(result)
            except ApiError as e:
                self._send_json({"ok": False, "error": e.msg, "__status": e.code})
            except Exception as e:  # noqa
                import traceback
                traceback.print_exc()
                self._send_json({"ok": False, "error": "服务器开小差了"})
            finally:
                conn.close()
            return

        if method != "GET":
            self._send_json({"ok": False, "error": "Method Not Allowed"}, 405)
            return

        if path.startswith("/uploads/"):
            full = self._safe_join(UPLOAD_DIR, path[len("/uploads/"):])
            if not full:
                self._send_json({"ok": False, "error": "Forbidden"}, 403)
                return
            self._send_file(full)
            return

        if path in ("/", ""):
            self._send_file(os.path.join(WEB_DIR, "index.html"), cache=False)
            return

        # 管理后台是独立页面（不是前台 SPA 的一部分），必须排在 SPA 兜底之前
        if path in ("/admin", "/admin/") or path.startswith("/admin/"):
            self._send_file(os.path.join(WEB_DIR, "admin.html"), cache=False)
            return

        full = self._safe_join(WEB_DIR, path)
        if full and os.path.isfile(full):
            # 前端脚本/样式不设长缓存：否则改完代码用户要等一小时才能拿到新版本
            self._send_file(full, cache=False)
            return
        # SPA 兜底
        self._send_file(os.path.join(WEB_DIR, "index.html"), cache=False)

    def do_GET(self):
        self._handle("GET")

    def do_POST(self):
        self._handle("POST")

    def do_PUT(self):
        self._handle("PUT")

    def do_DELETE(self):
        self._handle("DELETE")


def main():
    global SECRET
    os.makedirs(DATA_DIR, exist_ok=True)
    init_db()
    SECRET = get_secret()
    ThreadingHTTPServer.allow_reuse_address = True
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"Listening on http://{HOST}:{PORT}")
    print(f"""
  ┌──────────────────────────────────────────────┐
  │   微坛 WeForum 已启动                        │
  │   本地访问: http://localhost:{PORT:<5}          │
  │   演示账号: admin / admin123  (管理员)        │
  │            linda / 123456                     │
  └──────────────────────────────────────────────┘
""")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n再见 👋")
        server.shutdown()


if __name__ == "__main__":
    main()
