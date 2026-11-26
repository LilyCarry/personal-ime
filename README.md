# personal-ime

端侧个性化中文输入法实验项目：融合**可量化的键盘规则自适应（冷启动诊断 + 无感切换）**、**现场互动打字竞速网页（替代 PPT + DeepSeek 风格点评 + 阿里云实时排行榜）**，以及**基于个人习惯的端侧小模型后训练（Qwen3-0.6B LoRA / 29M 字级 Transformer）**，最终接入 Windows 小狼毫（Rime / Weasel）。

## 目录架构

```text
personal-ime/
├── README.md                         # 项目总览与快速入口
├── docs/
│   └── ROADMAP.md                    # 双目标规划与 PR 任务清单（按功能分支推进）
├── profiler/                         # [目标一核心] 日志分析、习惯画像与噪声参数化
│   ├── analyze_logs.py               # 双端（Win/Android）击键日志分析
│   └── noise_simulator.py            # 词级省码 + 发音截断 + QWERTY 物理/时序误触模拟
├── web/                              # [目标一展示/冷启动] 现场互动大屏 + 手机打字竞速 + DeepSeek 分析
│   └── README.md                     # 网页架构与接口约定
├── model/                            # [目标二核心] 数据集构建、小模型后训练、评估与本地推理
│   ├── build_dataset.py              # 结合噪声模拟器与通用语料构建训练/验证集
│   ├── train_mobile_small.py         # ~29M 移动端字级 Transformer 训练
│   ├── eval_mobile.py                # 29M 模型评估
│   ├── train_qwen3_lora.py           # Qwen3-0.6B-Base 单字母分词 LoRA 后训练
│   ├── eval_qwen3_constrained.py     # 拼音 Trie 容错约束 Beam Search 评估
│   └── ime_server.py                 # 本地 GPU 推理服务（TCP 127.0.0.1:18765）
└── rime/                             # 小狼毫（Rime / Weasel）插件端
    ├── rime_ice.custom.yaml          # 雾凇拼音插件挂载配置
    ├── bridge/
    │   └── ime_bridge.c              # Lua <-> 本地 TCP 推理服务 C 桥接库
    └── lua/
        ├── ime_logger.lua            # 击键/退格/重打/硬件连击采集插件
        ├── ai_filter.lua             # 本地 AI 候选注入 Filter
        ├── recent_proc.lua           # 短期上下文记忆处理器
        ├── recent_filter.lua         # 短期记忆召回 Filter
        ├── recent_store.lua          # 短期记忆存储与模糊匹配核心
        └── char_py.lua               # 单字拼音映射表
```

## 两大独立目标

完整功能拆分与 PR 推进计划见 [docs/ROADMAP.md](docs/ROADMAP.md)：

1. **目标一：硬编码规则引擎 + 互动打字竞速网页**
   - 网页端替代传统 PPT：左侧交互式演示卡片 + 右侧阿里云实时竞速排行榜；
   - 扫码进行打字竞速（速度 + 精准度），结果直接交由 DeepSeek 生成趣味打字点评，并输出可量化的离散规则集合（如 `ong=on`、`l=r`、`in=ing`、`z=zh`）；
   - Rime 插件端支持后期日常使用中基于日志持续校准这些规则选项，实现无感切换并给予轻量提醒。
2. **目标二：基于个人习惯的端侧预测模型**
   - 从个人击键习惯出发，通过噪声模拟与本地周期性后训练（PC 端周末空闲跑 Qwen3-0.6B LoRA / 端侧 29M 字级 Transformer），结合拼音 Trie 容错约束解码，提供上下文级纠错与预测。

## 快速运行（在仓库根目录执行）

```powershell
# 1. 分析 Rime 击键日志
python -m profiler.analyze_logs

# 2. 构建个性化噪声训练集
python -m model.build_dataset

# 3. 模型训练与评估
python -m model.train_qwen3_lora
python -m model.eval_qwen3_constrained
python -m model.train_mobile_small
python -m model.eval_mobile

# 4. 启动本地实时推理服务（供小狼毫 ai_filter.lua 调用）
python -m model.ime_server
```

### 编译 Rime C 桥接库（Windows）

```powershell
gcc -shared -O2 rime/bridge/ime_bridge.c "C:\Program Files\Rime\weasel-0.17.4\rime.dll" -lws2_32 -o ime_bridge.dll
```
