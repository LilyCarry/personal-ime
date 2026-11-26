# 项目文件规范与 PR 审阅指南（CONTRIBUTING）

本项目采用 **Issue 认领 -> 功能分支开发 -> PR 自动化自测与审阅 -> 合并主分支** 的任务式协作流程。所有规范均围绕**“清晰解耦、零文件冲突、方便 Reviewer 一键拉取验证”**设计。

---

## 1. 项目目录与文件规范

```text
personal-ime/
├── README.md                  # 项目总览与运行入口
├── CONTRIBUTING.md            # 本规范文档
├── docs/                      # 设计文档、路线图、评测报告、脱敏对比案例 JSON
├── profiler/                  # [目标一] 日志分析、规则词表定义、噪声模拟、滑动窗口校准
├── web/
│   ├── server/                # [目标一] FastAPI 后端（排行榜 + DeepSeek 代理）
│   └── static/                # [目标一] 前端静态页面（大屏演示 / 与 扫码竞速 /play）
├── model/                     # [目标二] 数据构建、训练、评测、本地推理服务
├── rime/
│   ├── bridge/                # C 桥接库源码（不提交 .dll）
│   └── lua/                   # Rime Lua 插件源码
└── tests/                     # 自动化单元测试与接口冒烟测试（pytest）
```

### 硬性文件规范
1. **禁止提交的文件**（已在 `.gitignore` 中排除，严禁强制 `git add -f`）：
   - 模型权重（`checkpoints/`, `*.pt`, `*.safetensors`, `*.bin`）
   - 原始/合成语料与真实个人打字日志（`data/`, `user_logs/`, `*.jsonl`）
   - 编译产物（`*.dll`, `*.exe`, `*.o`）
   - 任何明文密钥、`.env`、API Key、SSH 私钥（必须通过环境变量读取，并提供 `.env.example`）
2. **路径规范**：
   - Python 代码严禁硬编码个人绝对路径（如 `C:\Users\xxx\...`），统一基于 `Path(__file__).resolve()` 推导项目根目录，或通过环境变量 / CLI 参数传入。
   - 新增模块必须放到对应业务目录，禁止在仓库根目录堆积新脚本。
3. **代码风格**：
   - Python：优先使用 Python 3.10+ 类型注解、标准库 `pathlib`，所有模块支持从仓库根目录以 `python -m <pkg>.<mod>` 方式运行。
   - 前端：保持轻量原生 HTML/CSS/JS（不引入重型构建链），确保直接由 FastAPI `StaticFiles` 或浏览器即可加载。
   - 编码：统一 UTF-8（无 BOM），文档与代码中不使用无意义的 Emoji。

---

## 2. 分支与 Commit 规范

- **分支命名**：从最新 `main` 切出，格式为 `<type>/issue-<编号>-<简短英文>`
  - 示例：`feat/issue-1-rules-schema`、`feat/issue-2-web-leaderboard`、`docs/issue-8-eval-report`
- **Commit 信息**：遵循 Conventional Commits
  - `feat(<scope>): ...` / `fix(<scope>): ...` / `docs(<scope>): ...` / `refactor(<scope>): ...` / `test(<scope>): ...`

---

## 3. PR 规范（面向自动化验证与快速审阅）

为了方便 Reviewer 拉取分支后在 1~2 分钟内完成自动化测试与验收，每个 PR 必须满足以下要求：

1. **一 Issue 一 PR，控制改动边界**：
   - PR 标题格式：`[Issue #<编号>] <简明中文或英文摘要>`
   - 正文必须包含 `Closes #<编号>`，且只修改本 Issue 声明的目录范围，不顺手修改无关文件。
2. **必须附带可执行的自动化测试**（Reviewer 会直接运行）：
   - **Python 算法/工具类 PR（`profiler/`、`model/`）**：必须在 `tests/` 下提供对应的 `pytest` 用例（不依赖真实个人日志或 GPU，使用内置小样本/Mock 即可跑通）。
   - **后端 API 类 PR（`web/server/`）**：必须提供基于 FastAPI `TestClient` 的 `pytest` 接口测试（外部 DeepSeek API 调用须支持 Mock 测试，确保无 Key 环境下测试也能绿灯通过）。
   - **前端页面类 PR（`web/static/`）**：PR 描述中必须写清本地启动命令、可访问 URL、核心交互验证步骤，并确保浏览器 Console 无 JS 报错。
   - **Rime Lua 插件类 PR（`rime/lua/`）**：必须说明部署路径、触发条件、预期候选行为，以及异常/降级时不影响原生打字的验证方式。
3. **PR 自检命令（提交前本地必跑）**：
   ```powershell
   # 1. 语法检查
   python -m compileall -q profiler model web tests

   # 2. 运行测试套件
   pytest -q

   # 3. 检查是否误包含大文件或敏感信息
   git status --short
   ```

---

## 4. Reviewer 审阅检查清单

审阅 PR 时将按以下 5 项逐一核验，全部通过即合入 `main`：
1. **范围合规**：仅触及目标 Issue 指定模块，无无关改动。
2. **安全合规**：无硬编码密钥、绝对路径、个人日志或大文件。
3. **测试通过**：拉取分支后执行 `pytest -q` 与 PR 提供的验证命令全部通过。
4. **接口对齐**：涉及规则词表（如 `ong=on`, `l=r`）或 API Schema 时，与上下游约定完全一致。
5. **降级兜底**：外部依赖（DeepSeek API / 本地推理服务 / 规则文件缺失）异常时能平滑降级不崩溃。
