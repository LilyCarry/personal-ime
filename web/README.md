# web/ — 现场互动演示与打字竞速模块

本目录用于承载目标一的交互前端与轻量后端（计划通过 PR-1 与 PR-2 落地）：

- `server/`：FastAPI 轻量服务（部署至阿里云 ECS），负责 DeepSeek API 代理、规则 JSON 校验与实时竞速排行榜。
- `static/`：
  - `/`：大屏演示页（左侧翻页展示项目原理，右侧常驻二维码与实时排行榜）。
  - `/play`：手机/PC 扫码参赛页（打字竞速、DeepSeek 趣味点评、可量化规则开关面板与 Rime 配置导出）。

详细任务拆分见 [../docs/ROADMAP.md](../docs/ROADMAP.md)。
