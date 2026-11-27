# 功能演进路线与 Issue / PR 任务索引（ROADMAP）

本项目采用 **一 Issue 一 PR** 的任务式推进方式，所有提交需遵循 [CONTRIBUTING.md](../CONTRIBUTING.md) 中的目录边界与自动化测试规范。

---

## 总体架构关系

```text
[目标一：规则层 & 互动网页]                    [目标二：神经层 & 本地后训练]
web/ (大屏演示 + 扫码竞速 + DeepSeek)          profiler/ (日志分析 + 噪声模拟)
        │                                               │
        ▼ 生成初始离散规则 (如 ong=on, l=r)              ▼ 合成个人风格语料
rime/lua/ (规则热加载 + 无感切换 + 提醒)       model/ (Qwen3-LoRA / 29M + Trie 约束)
        │                                               │
        └───────────────► 小狼毫 Rime 管道共存 ◄─────────┘
```

---

## Issue 任务总览（可直接认领提 PR）

| Issue | 归属 | 标题 | 建议分支 | 依赖 | 状态 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| [#1](https://github.com/LilyCarry/personal-ime/issues/1) | 目标一 | 定义标准可量化拼音规则词表与 Rime algebra 导出模块 | `feat/issue-1-rules-schema` | 无 | Done (PR #9) |
| [#2](https://github.com/LilyCarry/personal-ime/issues/2) | 目标一 | 搭建 FastAPI 竞速后端与阿里云实时排行榜 API | `feat/issue-2-web-leaderboard` | 无 | Done (PR #10) |
| [#3](https://github.com/LilyCarry/personal-ime/issues/3) | 目标一 | 接入 DeepSeek 风格点评与量化规则推荐接口 (`/api/analyze`) | `feat/issue-3-deepseek-analyzer` | #1, #2 | Done (PR #11) |
| [#4](https://github.com/LilyCarry/personal-ime/issues/4) | 目标一 | 开发手机/PC 扫码打字竞速与规则配置页 (`/play`) | `feat/issue-4-web-play-page` | #2, #3 | Done (PR #12) |
| [#5](https://github.com/LilyCarry/personal-ime/issues/5) | 目标一 | 开发大屏互动演示页 (`/`, 替代 PPT) 与右侧实时排行榜 | `feat/issue-5-web-stage-page` | #2 | Done (PR #14) |
| [#6](https://github.com/LilyCarry/personal-ime/issues/6) | 目标一 | 实现基于 Rime 日志的滑动窗口规则校准与无感切换提醒 | `feat/issue-6-rime-adaptive-rules` | #1 | Done (PR #13) |
| [#7](https://github.com/LilyCarry/personal-ime/issues/7) | 目标二 | 寝室双人（本人 vs 室友）个性化 LoRA 对比微调与案例集 | `feat/issue-7-persona-compare` | 无 | Closed（由 #8 真实实测替代） |
| [#8](https://github.com/LilyCarry/personal-ime/issues/8) | 目标二 | 训练前后评测基准与消融实验报告 (`docs/EVALUATION.md`) | `docs/issue-8-eval-benchmark` | 无 | Done |

---

## 并行推进建议

- **第一批（零依赖，可立刻同时认领）**：`#1`、`#2`、`#7`、`#8`
- **第二批（`#1`、`#2` 合入后）**：`#3`、`#5`、`#6`
- **第三批（`#3` 合入后联调）**：`#4`

---

## 展示定位说明

- **现场实时体验（目标一）**：课堂直接打开大屏演示页（`/`），左侧翻页讲原理，右侧常驻二维码与实时排行榜；全班扫码进 `/play` 进行打字竞速，完赛后由 DeepSeek 生成趣味点评并推荐可量化规则（如 `ong=on`, `l=r`）。
- **寝室小范围实证（目标二）**：模型个性化依赖长期真实日志，课堂上通过寝室双人（本人 vs 室友）对比案例，直观展示“同一个错拼/简拼输入在不同人的专属模型上产生不同输出”的效果差异。
