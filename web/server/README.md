# web/server — FastAPI 竞速后端与实时排行榜服务

为课堂现场互动打字竞速提供轻量级 FastAPI 后端，负责维护 SQLite 实时排行榜、最近点评轮播以及 `web/static` 静态页面托管。

## 目录结构

- `app.py`：FastAPI 应用入口（CORS、静态目录兼容挂载、核心 API 路由）
- `storage.py`：SQLite 持久化封装（`LeaderboardStorage`，预留 `add_record` 供评分接口调用）
- `requirements.txt`：后端运行与测试依赖
- `.env.example`：环境变量配置示例

## 环境变量

复制 `.env.example` 为 `.env` 或在启动前导出环境变量：

| 变量名 | 说明 | 默认值 |
| --- | --- | --- |
| `ADMIN_TOKEN` | `POST /api/reset` 清榜口令（必填，未配置时接口返回 503） | 无 |
| `LEADERBOARD_DB_PATH` | SQLite 数据库文件路径 | `web/server/leaderboard.db` |
| `CORS_ORIGINS` | 允许跨域的 Origin 列表，多个以英文逗号分隔 | `*` |

## 启动方式

### 本地开发

在仓库根目录执行：

```bash
pip install -r web/server/requirements.txt
export ADMIN_TOKEN="your-secret-token"
uvicorn web.server.app:app --reload --host 127.0.0.1 --port 8000
```

### 阿里云 ECS 部署

在仓库根目录执行（建议配合 `systemd` / `supervisor` 或后台进程守护）：

```bash
export ADMIN_TOKEN="your-strong-production-token"
export LEADERBOARD_DB_PATH="/var/lib/personal-ime/leaderboard.db"
uvicorn web.server.app:app --host 0.0.0.0 --port 8000 --workers 1
```

## API 接口契约

### 1. 健康检查

- `GET /api/health`
- 响应 `200 OK`：

```json
{"status": "ok"}
```

### 2. 获取实时排行榜与最近点评轮播

- `GET /api/leaderboard?limit=30`（`limit` 范围 `1..200`，默认 `30`）
- `leaderboard` 按 `score DESC, created_at ASC` 排序。
- `recent_comments` 按 `created_at DESC` 取最近 10 条。
- 响应 `200 OK`：

```json
{
  "total": 12,
  "leaderboard": [
    {
      "id": 1,
      "nickname": "Carry",
      "cpm": 185.0,
      "accuracy": 96.5,
      "score": 178.5,
      "title": "后鼻音省电派",
      "comment": "...",
      "rules": ["ong=on", "in=ing"],
      "created_at": "2026-11-26T12:00:00Z"
    }
  ],
  "recent_comments": [
    {
      "id": 1,
      "nickname": "Carry",
      "title": "后鼻音省电派",
      "comment": "...",
      "rules": ["ong=on", "in=ing"],
      "created_at": "2026-11-26T12:00:00Z"
    }
  ]
}
```

### 3. 清空排行榜

- `POST /api/reset`
- 请求头：`X-Admin-Token: <ADMIN_TOKEN>`
- 状态码：
  - `200 OK`：`{"ok": true, "deleted": 12}`
  - `401 Unauthorized`：缺少 `X-Admin-Token` 请求头
  - `403 Forbidden`：口令不匹配
  - `503 Service Unavailable`：服务端未配置 `ADMIN_TOKEN`

### 4. 静态页面托管

- `GET /`：指向 `web/static/index.html`（大屏演示页）
- `GET /play`：指向 `web/static/play.html`（扫码参赛页）
- `GET /static/...`：挂载 `web/static` 静态资源目录
- 若 `web/static` 尚未创建，服务可正常启动，访问 `/` 与 `/play` 返回友好的 JSON 提示。

### 5. 供上游接口调用的写入方法（`storage.py`）

`app.state.storage.add_record(...)` 签名如下，返回包含 `id` 与当前 `rank` 的完整记录字典：

```python
record = app.state.storage.add_record(
    nickname="Carry",
    cpm=185.0,
    accuracy=96.5,
    score=178.5,
    title="后鼻音省电派",
    comment="...",
    rules=["ong=on", "in=ing"],
)
```

## 运行单元测试

在仓库根目录执行：

```bash
pytest tests/test_web_leaderboard.py -q
```
