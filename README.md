# personal-ime

端侧个性化中文输入法实验项目：结合真实击键日志采集、用户习惯画像、键盘级规则纠错与本地小模型后训练（LoRA / 29M 字级 Transformer），数据全程留存本地，接入 Windows 小狼毫（Rime / Weasel）实时使用。

## 仓库结构

```text
personal-ime/
├── README.md                    # 项目总览与使用说明
├── docs/
│   └── ROADMAP.md               # 两大独立演进目标规划（规则引擎 vs 个人预测模型）
├── analyze_logs.py              # 双端（Win/Android）真实击键日志分析与错键统计
├── noise_simulator.py           # 词级拼音省码 + 发音截断 + QWERTY 物理/时序误触模拟器
├── build_dataset.py             # 结合噪声模拟器与通用语料构建训练/验证集
├── train_mobile_small.py        # ~29M 移动端字级 Transformer 训练脚本
├── eval_mobile.py               # 29M 字级模型评估脚本
├── train_qwen3_lora.py          # Qwen3-0.6B-Base 单字母分词 LoRA 后训练脚本
├── eval_qwen3_constrained.py    # 拼音 Trie 容错约束 Beam Search 评估脚本
├── ime_server.py                # 本地 GPU 推理服务（TCP 127.0.0.1:18765）
├── bridge/
│   └── ime_bridge.c             # Windows Rime Lua <-> 本地推理服务 C/TCP 桥接库
└── rime/
    ├── rime_ice.custom.yaml     # 小狼毫（雾凇拼音）插件挂载配置
    └── lua/
        ├── ime_logger.lua       # 击键/退格/重打/硬件连击采集插件
        ├── ai_filter.lua        # 本地 AI 候选注入 Filter（经 ime_bridge.dll）
        ├── recent_proc.lua      # 短期上下文记忆队列处理器
        ├── recent_filter.lua    # 短期记忆极速召回 Filter
        ├── recent_store.lua     # 短期记忆存储与模糊匹配核心
        └── char_py.lua          # 单字拼音映射表
```

## 接下来两大独立目标

本项目后续拆分为两个可独立开发、独立验证、也可联动配合的方向，详见 [docs/ROADMAP.md](docs/ROADMAP.md)：

1. **硬编码/可解释规则引擎**：初次通过短文打字识别用户风格并推荐配置，日常使用中根据击键特征无感切换规则（切换时给予轻量提醒），并支持用户在设置中手动调整声韵母替换与容错规则。
2. **个人习惯预测模型**：基于用户击键习惯与 Transformer 后训练（PC 端周末空闲跑 Qwen3-0.6B LoRA / 端侧 29M 字级模型），结合拼音 Trie 容错约束解码，解决依赖上下文语义的复杂纠错与预测。

## 快速上手（现有 Demo）

### 1. 编译 Rime C 桥接库（Windows）

```powershell
gcc -shared -O2 bridge/ime_bridge.c "C:\Program Files\Rime\weasel-0.17.4\rime.dll" -lws2_32 -o ime_bridge.dll
```

将生成的 `ime_bridge.dll` 与 `rime/lua/*.lua` 复制到 `%APPDATA%\Rime\lua\`，`rime/rime_ice.custom.yaml` 复制到 `%APPDATA%\Rime\`，重新部署小狼毫即可。

### 2. 分析日志与构建数据

```powershell
python analyze_logs.py
python build_dataset.py
```

### 3. 训练与启动本地推理服务

```powershell
# 路线 A：Qwen3-0.6B LoRA 后训练
python train_qwen3_lora.py
python eval_qwen3_constrained.py

# 路线 B：29M 轻量字级 Transformer
python train_mobile_small.py
python eval_mobile.py

# 启动本地实时推理服务（供小狼毫 ai_filter.lua 调用）
python ime_server.py
```
