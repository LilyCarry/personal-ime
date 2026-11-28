# NEXT_STEPS — 后续工作与上台演示执行手册

## 1. 当前项目状态

仓库主分支 `main` 已完成所有开发与真实数据实测，8 个规划 Issue（`#1`–`#8`）均已闭环：

- **规则层与互动网页（目标一）**：
  - 标准 24 条可量化拼音规则词表与 Rime `speller/algebra` 导出（`profiler/rules_schema.py`）
  - FastAPI 实时排行榜 + DeepSeek 风格点评与规则推荐后端（`web/server/`）
  - 手机/PC 扫码竞速与规则开关页 `/play`（`web/static/play.html`）
  - 9 模块大屏互动演示页 `/`（替代 PPT，右侧榜单默认隐藏、翻至 05 节自动滑出，`web/static/index.html`）
  - 滑动窗口规则校准与 Rime 候选轻提醒插件（`profiler/rule_updater.py`、`rime/lua/rule_notify.lua`）
- **端侧模型与真实评测（目标二）**：
  - 连续 3 天真实双端日志（PC 825 条 + Android 1,826 条 = 2,651 次上屏 / 5,371 字）
  - RTX 5060 本地实测报告已写入 [docs/EVALUATION.md](docs/EVALUATION.md)（29M CPU INT8 `96.1ms` vs Qwen3-0.6B LoRA + Trie 真实翻车 Top-1 `62.5%` / Top-3 `75.0%`），并已全部同步至大屏 Module 06/07/09。
- **测试状态**：仓库根目录 `pytest -q` 全量 **18 passed**。

---

## 2. 接下来必做的 4 件事（按优先级执行）

### Step 1：将 `web/` 部署到阿里云服务器上线（最关键）

1. 登录服务器并拉取最新代码：
   ```bash
   ssh aliyun
   cd /opt  # 或你常用的部署目录
   git clone https://github.com/LilyCarry/personal-ime.git
   cd personal-ime
   ```
2. 创建 Python 虚拟环境并安装服务端依赖：
   ```bash
   python3 -m venv .venv
   source .venv/bin/activate
   pip install -r web/server/requirements.txt
   ```
3. 配置环境变量（**切勿提交到 Git**）：
   ```bash
   cp web/server/.env.example web/server/.env
   # 编辑 web/server/.env，填入以下关键项：
   # DEEPSEEK_API_KEY=<你的 DeepSeek API Key>
   # ADMIN_TOKEN=<自定义清榜口令>
   # LEADERBOARD_DB_PATH=/opt/personal-ime/web/server/leaderboard.db
   ```
4. 启动服务（先用 `tmux` 或 `systemd` 常驻运行）：
   ```bash
   set -a && source web/server/.env && set +a
   uvicorn web.server.app:app --host 0.0.0.0 --port 8000
   ```
   - 确认阿里云安全组与本机防火墙已放行 `8000` 端口（或通过 Nginx 反代至 `80`/`443` 域名，域名访问体验更好且 HTTPS 下手机一键复制更稳）。

---

### Step 2：真机外网扫码联调与压测

1. 电脑浏览器打开公网大屏地址 `http://<你的域名或IP>/`，按 `→` 翻至 **05 节**（右侧二维码与榜单自动滑出）。
2. 手机关闭 Wi-Fi 改用 **4G/5G 流量**扫描右侧二维码进入 `/play`：
   - 确认手机键盘弹出英文/拼音输入，打完 3 句提交；
   - 确认返回的是**真 DeepSeek 趣味点评**（非兜底文案），且推荐规则开关可正常切换与复制 YAML；
   - 确认大屏右侧排行榜在 **2 秒内**自动刷新显示你的昵称、速度、精准度、称号与规则标签。
3. 点击大屏角落的清榜入口，输入 `ADMIN_TOKEN`，确认排行榜正常清空。
4. 顺手叫 2~3 位室友同时扫码跑一轮，验证并发与 DeepSeek 接口耗时。

---

### Step 3：准备小狼毫真机演示 + 20 秒兜底录屏

确保上台展示“不是纯网页玩具，而是真接进了 Windows 输入法”：

1. 在本地电脑的 `%APPDATA%\Rime\rime_ice.custom.yaml` 中确认已启用 `lua_filter@*ai_filter`，并把编译好的 `ime_bridge.dll` 与 `rime/lua/*.lua` 放在 `%APPDATA%\Rime\lua\`，点击小狼毫“重新部署”。
2. 启动本地 GPU 推理服务：
   ```powershell
   cd C:\Users\xu762\Documents\Github\personal-ime
   python -m model.ime_server
   ```
3. 提前用记事本录一段 **20 秒清晰短屏**保存到桌面（作为教室设备不方便切输入法时的兜底）：
   - 演示输入 `yixa` + `` ` `` -> 首选直接跳出「一下」（对比不加 `` ` `` 原生切崩出「胰腺癌」）；
   - 演示输入 `shanyxia` + `` ` `` -> 结合前文「把脏库」首选跳出「删一下」；
   - 演示输入 `wmxqcf` + `` ` `` -> 纯首字母直接出「我们先去吃饭」。

---

### Step 4：上台前检查单与 5~7 分钟展示节奏

#### 上台前 5 分钟 Checklist
- [ ] 调用 `/api/reset` 清空所有测试排行榜记录；
- [ ] 确认公网 `/`、`GET /api/health`、`DEEPSEEK_API_KEY` 余额正常；
- [ ] 浏览器打开大屏按 `F11` 全屏，确认 16:9 投影无裁切；
- [ ] 电脑开启勿扰模式（关闭微信/QQ 弹窗）。

#### 建议讲解节奏（约 6 分钟）
| 章节 | 建议时长 | 讲解重点 |
| :--- | :---: | :--- |
| **01–02（动机与商业原理）** | 1.0 min | 从微信输入法吞键/简拼很顺手引入，简述噪声信道与 L1/L2/L3，引出隐私敏感、策略固化与低定制化三大痛点。 |
| **03–04（整体闭环与开局诊断）** | 1.0 min | 点出开源 Rime 底座 + 三大闭环；简述 3 句拼音竞速 + DeepSeek 白名单量化 24 条规则。 |
| **05（全场扫码互动）** | 1.5 min | 右侧二维码自动滑出，引导全班扫码玩 `/play`；边等成绩上榜边读 1~2 条大屏轮播的同学 DeepSeek 点评，气氛拉满。 |
| **06（3 天真实数据与规则分类）** | 1.0 min | 亮出自己 3 天 2,651 条真实日志：24 条模糊音均 <7% 不乱开；按场景把同键连击/非法紧邻与复杂错拼拆开处理。 |
| **07–09（小模型 + Trie + 真实实测）** | 1.5 min | 讲清个人噪声合成 + 单字母分词 + 8105 Trie 防幻觉；在 09 节逐列揭晓 29M vs Qwen3+Trie 实测（Top-3 75%，诚实点出 `wuson` 专词待个人续训），最后播 20 秒小狼毫真机视频收尾。 |

---

## 3. 可选加分项（时间充裕时再做）

- **个人日志增量续训验证**：在现有 `checkpoints/qwen3_06b_lora/final` 基础上，混入你近 3 天脱敏后的 2,651 条真实日志（与少量 LCCC 语料防遗忘），本机 RTX 5060 或 Colab T4 GPU 续训 2~3 分钟，验证 `wuson -> 雾凇` 等个人专词从 `MISS` 变成 `TOP1`，将前后对比追加进 [docs/EVALUATION.md](docs/EVALUATION.md)。
