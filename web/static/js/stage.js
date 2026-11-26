(() => {
  "use strict";

  const QREncoder = (() => {
    const GF_EXP = new Uint8Array(512);
    const GF_LOG = new Uint8Array(256);
    {
      let x = 1;
      for (let i = 0; i < 255; i += 1) {
        GF_EXP[i] = x;
        GF_LOG[x] = i;
        x <<= 1;
        if (x & 0x100) x ^= 0x11d;
      }
      for (let i = 255; i < 512; i += 1) GF_EXP[i] = GF_EXP[i - 255];
    }
    function gfMul(a, b) {
      if (a === 0 || b === 0) return 0;
      return GF_EXP[GF_LOG[a] + GF_LOG[b]];
    }
    function rsGeneratorPoly(degree) {
      let poly = [1];
      for (let i = 0; i < degree; i += 1) {
        const next = new Array(poly.length + 1).fill(0);
        const factor = GF_EXP[i];
        for (let j = 0; j < poly.length; j += 1) {
          next[j] ^= poly[j];
          next[j + 1] ^= gfMul(poly[j], factor);
        }
        poly = next;
      }
      return poly;
    }
    function rsComputeEc(data, ecCount) {
      const gen = rsGeneratorPoly(ecCount);
      const work = new Uint8Array(data.length + ecCount);
      work.set(data);
      for (let i = 0; i < data.length; i += 1) {
        const coef = work[i];
        if (coef !== 0) {
          for (let j = 0; j < gen.length; j += 1) work[i + j] ^= gfMul(gen[j], coef);
        }
      }
      return work.slice(data.length);
    }
    const VERSIONS_M = [
      null,
      { v: 1, size: 21, dataCw: 16, ecPerBlock: 10, blocks: [16], align: [] },
      { v: 2, size: 25, dataCw: 28, ecPerBlock: 16, blocks: [28], align: [6, 18] },
      { v: 3, size: 29, dataCw: 44, ecPerBlock: 26, blocks: [44], align: [6, 22] },
      { v: 4, size: 33, dataCw: 64, ecPerBlock: 18, blocks: [32, 32], align: [6, 26] },
      { v: 5, size: 37, dataCw: 86, ecPerBlock: 24, blocks: [43, 43], align: [6, 30] },
      { v: 6, size: 41, dataCw: 108, ecPerBlock: 16, blocks: [27, 27, 27, 27], align: [6, 34] },
      { v: 7, size: 45, dataCw: 124, ecPerBlock: 18, blocks: [31, 31, 31, 31], align: [6, 22, 38] },
      { v: 8, size: 49, dataCw: 154, ecPerBlock: 22, blocks: [38, 38, 39, 39], align: [6, 24, 42] },
    ];
    function bchFormatInfo(maskId) {
      const data = maskId & 0x07;
      let rem = data << 10;
      const poly = 0x537;
      for (let bit = 14; bit >= 10; bit -= 1) if ((rem >> bit) & 1) rem ^= poly << (bit - 10);
      return ((data << 10) | rem) ^ 0x5412;
    }
    function bchVersionInfo(version) {
      let rem = version << 12;
      const poly = 0x1f25;
      for (let bit = 17; bit >= 12; bit -= 1) if ((rem >> bit) & 1) rem ^= poly << (bit - 12);
      return (version << 12) | rem;
    }
    function encodeBytes(text) {
      const bytes = new TextEncoder().encode(text);
      let spec = VERSIONS_M[VERSIONS_M.length - 1];
      for (let v = 1; v < VERSIONS_M.length; v += 1) {
        if (bytes.length <= VERSIONS_M[v].dataCw - 2) {
          spec = VERSIONS_M[v];
          break;
        }
      }
      const payload = bytes.slice(0, spec.dataCw - 2);
      const bits = [];
      const pushBits = (val, len) => {
        for (let i = len - 1; i >= 0; i -= 1) bits.push((val >> i) & 1);
      };
      pushBits(0b0100, 4);
      pushBits(payload.length, 8);
      for (let i = 0; i < payload.length; i += 1) pushBits(payload[i], 8);
      const termLen = Math.min(4, spec.dataCw * 8 - bits.length);
      for (let i = 0; i < termLen; i += 1) bits.push(0);
      while (bits.length % 8 !== 0) bits.push(0);
      const dataCw = [];
      for (let i = 0; i < bits.length; i += 8) {
        let byte = 0;
        for (let b = 0; b < 8; b += 1) byte = (byte << 1) | bits[i + b];
        dataCw.push(byte);
      }
      const padBytes = [0xec, 0x11];
      let padIdx = 0;
      while (dataCw.length < spec.dataCw) {
        dataCw.push(padBytes[padIdx % 2]);
        padIdx += 1;
      }
      const dataBlocks = [];
      const ecBlocks = [];
      let offset = 0;
      for (const blkLen of spec.blocks) {
        const chunk = dataCw.slice(offset, offset + blkLen);
        offset += blkLen;
        dataBlocks.push(chunk);
        ecBlocks.push(rsComputeEc(chunk, spec.ecPerBlock));
      }
      const finalCw = [];
      const maxBlockLen = Math.max(...spec.blocks);
      for (let i = 0; i < maxBlockLen; i += 1) {
        for (const blk of dataBlocks) if (i < blk.length) finalCw.push(blk[i]);
      }
      for (let i = 0; i < spec.ecPerBlock; i += 1) {
        for (const ecBlk of ecBlocks) finalCw.push(ecBlk[i]);
      }
      const size = spec.size;
      const grid = Array.from({ length: size }, () => new Int8Array(size).fill(-1));
      const reserved = Array.from({ length: size }, () => new Uint8Array(size));
      const setMod = (r, c, val, isFunc) => {
        grid[r][c] = val ? 1 : 0;
        if (isFunc) reserved[r][c] = 1;
      };
      const drawFinder = (r0, c0) => {
        for (let dr = -1; dr <= 7; dr += 1) {
          for (let dc = -1; dc <= 7; dc += 1) {
            const r = r0 + dr;
            const c = c0 + dc;
            if (r < 0 || r >= size || c < 0 || c >= size) continue;
            const inOuter = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
            const onBorder = dr === 0 || dr === 6 || dc === 0 || dc === 6;
            const inCore = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
            setMod(r, c, inOuter && (onBorder || inCore), true);
          }
        }
      };
      drawFinder(0, 0);
      drawFinder(0, size - 7);
      drawFinder(size - 7, 0);
      for (const cr of spec.align) {
        for (const cc of spec.align) {
          if (reserved[cr][cc]) continue;
          for (let dr = -2; dr <= 2; dr += 1) {
            for (let dc = -2; dc <= 2; dc += 1) {
              const onEdge = Math.abs(dr) === 2 || Math.abs(dc) === 2;
              setMod(cr + dr, cc + dc, onEdge || (dr === 0 && dc === 0), true);
            }
          }
        }
      }
      for (let i = 8; i < size - 8; i += 1) {
        if (!reserved[6][i]) setMod(6, i, i % 2 === 0, true);
        if (!reserved[i][6]) setMod(i, 6, i % 2 === 0, true);
      }
      setMod(size - 8, 8, 1, true);
      for (let i = 0; i < 9; i += 1) {
        if (!reserved[8][i]) reserved[8][i] = 1;
        if (!reserved[i][8]) reserved[i][8] = 1;
      }
      for (let i = 0; i < 8; i += 1) {
        reserved[8][size - 1 - i] = 1;
        reserved[size - 1 - i][8] = 1;
      }
      if (spec.v >= 7) {
        const verBits = bchVersionInfo(spec.v);
        for (let i = 0; i < 18; i += 1) {
          const bit = (verBits >> i) & 1;
          const r = Math.floor(i / 3);
          const c = size - 11 + (i % 3);
          setMod(r, c, bit, true);
          setMod(c, r, bit, true);
        }
      }
      const streamBits = [];
      for (const cw of finalCw) for (let b = 7; b >= 0; b -= 1) streamBits.push((cw >> b) & 1);
      let bitIdx = 0;
      let dir = -1;
      for (let col = size - 1; col > 0; col -= 2) {
        if (col === 6) col -= 1;
        for (let step = 0; step < size; step += 1) {
          const row = dir === -1 ? size - 1 - step : step;
          for (let dx = 0; dx < 2; dx += 1) {
            const c = col - dx;
            if (!reserved[row][c]) {
              grid[row][c] = bitIdx < streamBits.length ? streamBits[bitIdx] : 0;
              bitIdx += 1;
            }
          }
        }
        dir = -dir;
      }
      const maskFns = [
        (r, c) => (r + c) % 2 === 0,
        (r) => r % 2 === 0,
        (_r, c) => c % 3 === 0,
        (r, c) => (r + c) % 3 === 0,
        (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
        (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
        (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
        (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
      ];
      function applyFormat(mat, maskId) {
        const fmt = bchFormatInfo(maskId);
        for (let i = 0; i < 15; i += 1) {
          const bit = (fmt >> i) & 1;
          if (i < 6) mat[i][8] = bit;
          else if (i < 8) mat[i + 1][8] = bit;
          else if (i === 8) mat[8][7] = bit;
          else mat[8][14 - i] = bit;
          if (i < 8) mat[8][size - 1 - i] = bit;
          else mat[size - 15 + i][8] = bit;
        }
      }
      function calcPenalty(mat) {
        let score = 0;
        for (let r = 0; r < size; r += 1) {
          let run = 1;
          for (let c = 1; c < size; c += 1) {
            if (mat[r][c] === mat[r][c - 1]) {
              run += 1;
              if (run === 5) score += 3;
              else if (run > 5) score += 1;
            } else run = 1;
          }
        }
        for (let c = 0; c < size; c += 1) {
          let run = 1;
          for (let r = 1; r < size; r += 1) {
            if (mat[r][c] === mat[r - 1][c]) {
              run += 1;
              if (run === 5) score += 3;
              else if (run > 5) score += 1;
            } else run = 1;
          }
        }
        for (let r = 0; r < size - 1; r += 1) {
          for (let c = 0; c < size - 1; c += 1) {
            const v = mat[r][c];
            if (v === mat[r][c + 1] && v === mat[r + 1][c] && v === mat[r + 1][c + 1]) score += 3;
          }
        }
        return score;
      }
      let bestMat = null;
      let bestPenalty = Infinity;
      for (let m = 0; m < 8; m += 1) {
        const mat = grid.map((row) => Int8Array.from(row));
        const fn = maskFns[m];
        for (let r = 0; r < size; r += 1) {
          for (let c = 0; c < size; c += 1) {
            if (!reserved[r][c] && fn(r, c)) mat[r][c] ^= 1;
          }
        }
        applyFormat(mat, m);
        const pen = calcPenalty(mat);
        if (pen < bestPenalty) {
          bestPenalty = pen;
          bestMat = mat;
        }
      }
      return bestMat;
    }
    function createSvg(text) {
      const mat = encodeBytes(text);
      const size = mat.length;
      const quiet = 4;
      const full = size + quiet * 2;
      const ns = "http://www.w3.org/2000/svg";
      const svg = document.createElementNS(ns, "svg");
      svg.setAttribute("viewBox", `0 0 ${full} ${full}`);
      svg.setAttribute("role", "img");
      svg.setAttribute("aria-label", `扫码进入 ${text}`);
      svg.setAttribute("shape-rendering", "crispEdges");
      const bg = document.createElementNS(ns, "rect");
      bg.setAttribute("width", String(full));
      bg.setAttribute("height", String(full));
      bg.setAttribute("fill", "#ffffff");
      svg.appendChild(bg);
      let pathData = "";
      for (let r = 0; r < size; r += 1) {
        for (let c = 0; c < size; c += 1) {
          if (mat[r][c] === 1) pathData += `M${c + quiet},${r + quiet}h1v1h-1z`;
        }
      }
      const path = document.createElementNS(ns, "path");
      path.setAttribute("d", pathData);
      path.setAttribute("fill", "#18181b");
      svg.appendChild(path);
      return svg;
    }
    return { createSvg };
  })();

  const WX_STEP_DATA = [
    {
      badge: "第 1 次打自造句（效果不如意）",
      keys: "qian'd'l'kuai'q'c",
      cands: ["1 钱多了快去吃", "2 钱到了快去吃", "3 前端", "4 签到"],
      top1Miss: true,
      note: "即使敲出完整 kuai，通用统计依然优先给出「钱多了快去吃」。",
    },
    {
      badge: "纠正上屏一次后，第 2 次打省掉 kuai -> k",
      keys: "qian'd'l'k'q'c",
      cands: ["1 签到了快起床", "2 签订了看清楚", "3 签到了", "4 前端"],
      top1Miss: false,
      note: "第二次打即使省成单字母 k，也能结合上下文直接记住「签到了快起床」。",
    },
  ];

  const WETYPE_STAGES = [
    {
      title: "STEP 01 · 残缺 / 吞键按键流与 2D 物理坐标采集",
      desc: "输入流往往存在吞键、平翘舌混淆或高速换序，系统同时记录每个键的 2D QWERTY 坐标偏移与按键间隔。",
      cards: [
        { cls: "", head: "xiag", body: "吞键漏打：高速连打漏掉后鼻音 n" },
        { cls: "", head: "senm / qian'd'l'k'q'c", body: "平翘舌混淆 / 尾音截断与重度简拼" },
        { cls: "", head: "niaho", body: "高速连打：左右手相邻键时序换序" },
      ],
    },
    {
      title: "STEP 02 · 模糊拼音格（Fuzzy Lattice）联合容错搜索",
      desc: "不做死板的硬音节切分，而是边扫按键边在 WFST / 容错 Trie 上并行展开多个候选路径。",
      cards: [
        { cls: "is-good", head: "路径 A：xiag -> xiang", body: "补 n · 对应 想 / 项 / 像（上下文强匹配，保留）" },
        { cls: "is-bad", head: "路径 B：xiag -> xia + g", body: "强行割裂：下个 / 夏哥（语义极低，被 Beam Search 剪枝）" },
        { cls: "", head: "路径 C：邻键 g -> f / h", body: "2D 键距加权替换，在容错 Trie 上保留 Top-K 路径" },
      ],
    },
    {
      title: "STEP 03 · 多级语言模型打分与「空间换时间」重排",
      desc: "用三级流水线平衡响应速度与长句命中率——这也正是商业输入法内存重、难定制、有联网顾虑的根源。",
      cards: [
        { cls: "", head: "L1 本地极速词典 (< 5ms)", body: "庞大静态通用词库 + 热词缓存，靠「空间换时间」命中约 80% 常规输入" },
        { cls: "", head: "L2 端侧轻量神经模型 (10~30ms)", body: "几十 MB 量化 RNN / Transformer，结合上下文做 Top-K 重排" },
        { cls: "is-warn", head: "L3 云端大模型补强 (异步联网)", body: "重度错拼或长句简拼时，异步上传上下文至云端拉取联想候选" },
      ],
    },
    {
      title: "STEP 04 · 候选重排输出与三大局限反思",
      desc: "只要语言模型概率足够高，就能抵消拼写惩罚把「想吃什么」顶到第一；但对个人来说依然存在三大局限：",
      cards: [
        { cls: "is-bad", head: "1. 隐私高度敏感", body: "L3 云端上下文联想与遥测存在数据出境与泄露顾虑" },
        { cls: "is-warn", head: "2. 呆板空间换时间", body: "庞大静态通用词库面向平均人，无法按个人习惯精细裁剪" },
        { cls: "", head: "3. 深度定制化低", body: "无法显式查看个人声韵母分布，也不能用专属语料本地训练小模型" },
      ],
    },
  ];

  const BRIDGE_NODES = [
    {
      title: "NODE 01 · 小狼毫 Lua 拦截器（rime/lua/ai_filter.lua）",
      desc: "平时打字 0ms 零阻塞，完全由雾凇拼音原生出词；只有当你在输入末尾刻意敲入单引号 '（例如 yixa' / wmxqcf'）时，才截取最近 28 字上文触发本地 AI。",
      tags: ["平时 0ms 零延迟", "单引号 ' 按需触发", "60s 跨场景自动清空上文"],
    },
    {
      title: "NODE 02 · C 桥接动态库（rime/bridge/ime_bridge.c）",
      desc: "Lua 原生不支持无黑框 TCP；我们用 Winsock2 手写极简 C DLL，设置非阻塞 15ms 连接超时与 TCP_NODELAY，直接与 127.0.0.1:18765 亚毫秒通信。",
      tags: ["gcc -shared 编译", "15ms 非阻塞超时", "TCP_NODELAY 零黑框"],
    },
    {
      title: "NODE 03 · 拼音 Trie 容错 Beam Search（model/ime_server.py）",
      desc: "用 8105 通用字表读音将 Qwen3 词表建为拼音 Trie，并预生成变体惩罚：精确 0.0 / 前缀缩写 0.9 / 换序 2.8 / 缺介母 3.0 / 邻键或蹭键 3.2。配合 DynamicCache 复用前缀 KV。",
      tags: ["8105 汉字读音 Trie", "单步代价 <= 4.5", "整句惩罚 <= 7.0"],
    },
    {
      title: "NODE 04 · 候选置顶与零副作用兜底",
      desc: "AI 返回的 Top-1 / Top-2 带 [AI] 标注置顶，同时保留雾凇原生候选并自动去重；若本地 GPU 推理服务未启动，0.1ms 直接静默透传原生候选。",
      tags: ["[AI] Top-1/2 置顶", "去重保留雾凇候选", "服务未启 0.1ms 回落"],
    },
  ];

  const RULE_COMPILER_DEMOS = [
    {
      id: "ong=on",
      alias: "on=ong -> ong=on",
      example: "wuson -> 雾凇",
      desc: "允许将后鼻音 ong 简写为 on，贴合快速敲击时省去末尾 g 的高频习惯，不影响原本 on 词条。",
      algebra: ["derive/ong$/on/"],
    },
    {
      id: "l=r",
      alias: "r=l -> l=r",
      example: "len -> ren (认真)",
      desc: "声母 l 与 r 双向模糊派生，适配部分方言混用或高速盲打时的声母漂移。",
      algebra: ["derive/^l/r/", "derive/^r/l/"],
    },
    {
      id: "z=zh",
      alias: "zh=z -> z=zh",
      example: "zao -> zhao",
      desc: "平翘舌声母双向互通；类似地 c=ch、s=sh 采用负向先行断言 ([^h]) 避免二次重复匹配。",
      algebra: ["derive/^zh/z/", "derive/^z([^h])/zh$1/"],
    },
    {
      id: "ju=jv",
      alias: "u=v -> ju=jv",
      example: "qv -> qu",
      desc: "兼容部分双拼/习惯把 j/q/x/y 后的 u 敲作 v 的拼写差异。",
      algebra: ["derive/^([jqxy])u/$1v/", "derive/^([jqxy])v/$1u/"],
    },
    {
      id: "zh=hz",
      alias: "hz=zh -> zh=hz",
      example: "hzi -> zhi",
      desc: "纠正高速敲击时声母 zh/ch/sh 与紧随元音间的左右手时序倒置。",
      algebra: [
        "derive/([zcs])h(a|e|i|u|ai|ei|an|en|ou|uo|ua|un|ui|uan|uai|uang|ang|eng|ong)$/h$1$2/",
        "derive/([zcs])h([aeiu])$/$1$2h/",
      ],
    },
    {
      id: "an=na",
      alias: "na=an -> an=na",
      example: "dna -> dan",
      desc: "针对连打时末尾 an 误抢按成 na 的邻键时序换序，限定声母前置避免误伤正常 na 音节。",
      algebra: ["derive/([wrtypsdfghklzcbnm])an$/$1na/"],
    },
  ];

  const NOISE_SIM_DEMOS = [
    {
      label: "我明天去吃饭",
      steps: [
        "目标汉字: 我 明天 去 吃饭",
        "标准拼音: wo | ming tian | qu | chi fan",
        "词级策略: jieba 分词后按纯首字母/前重后轻采样 -> w m t q c f",
        "最终输入: <w m t q c f>  (或省略后鼻尾 wmxqcf)",
      ],
    },
    {
      label: "跑识别 (蹭键)",
      steps: [
        "目标汉字: 跑 识别",
        "标准拼音: pao | shi bie",
        "物理蹭键: 连打带入邻键 n -> bie + n = bnie",
        "最终输入: <p a o s h i b n i e>  (real_eval win_seq9)",
      ],
    },
    {
      label: "我是 (邻键)",
      steps: [
        "目标汉字: 我 是",
        "标准拼音: wo | shi",
        "二维坐标: o=(8,0), i=(7,0), dist=1.0 -> 最高邻键采样权重",
        "最终输入: <w i s h i>  (real_eval android_seq15)",
      ],
    },
    {
      label: "过几天 (截断)",
      steps: [
        "目标汉字: 过 几天",
        "标准拼音: guo | ji tian",
        "发音截断: tian 截断为 t (前重后轻词尾衰减)",
        "最终输入: <g u o j i t>  (real_eval win_seq48)",
      ],
    },
  ];

  const BUILTIN_COMPARE_CASES = [
    {
      context: "快到饭点了，",
      raw_keys: "wmxqcf",
      base_pred: ["我们去吃饭", "外卖小哥", "问明天出发"],
      user_a_pred: ["我明天去吃饭", "我们下去吃饭", "我先去吃饭"],
      user_b_pred: ["我们下楼吃饭", "外卖先点炒粉", "我们一起吃饭"],
      note: "6 位声母简拼下，通用底座偏向高频常规词；本人模型优先召回校园约饭常用句式，室友模型倾向点外卖/下楼场景。",
    },
    {
      context: "下周数据结构实验",
      raw_keys: "daimazhon",
      base_pred: ["代码肿", "大妈众", "代马中"],
      user_a_pred: ["代码中", "代码重", "代码终端"],
      user_b_pred: ["代码总", "代码种", "大马中"],
      note: "本人高频省去后鼻音尾键 g（zhon -> zhong），本人模型结合「实验」上下文将「代码中」排在首位。",
    },
    {
      context: "今天高数老师",
      raw_keys: "lenzhen",
      base_pred: ["冷战", "勒紧", "论战"],
      user_a_pred: ["愣着", "人真", "冷着"],
      user_b_pred: ["认真", "认准", "人正"],
      note: "室友存在典型 l/r 声母混敲习惯（ren -> len），室友专属模型在老师语境下直接恢复「认真」。",
    },
    {
      context: "晚上回寝室",
      raw_keys: "dazan",
      base_pred: ["打算", "打砸", "大赞"],
      user_a_pred: ["打代码", "大早上", "打战"],
      user_b_pred: ["打游戏", "打赞", "大招"],
      note: "面对邻键蹭错或韵母偏差，不同用户长期词频偏置决定了候选词的上下文排序倾向。",
    },
    {
      context: "刚把模型权重",
      raw_keys: "bsaobcun",
      base_pred: ["不扫不出", "白手不存", "帮我保存"],
      user_a_pred: ["保存", "报错", "保错"],
      user_b_pred: ["不保存", "包存", "报错"],
      note: "高速敲击出现连击多键（bao -> bsao）与换序，拼音 Trie 邻键容错结合开发语境恢复「保存」。",
    },
    {
      context: "顺手把空调",
      raw_keys: "gugandiao",
      base_pred: ["孤单掉", "骨干掉", "古怪掉"],
      user_a_pred: ["关掉", "改掉", "关了"],
      user_b_pred: ["关掉", "挂掉", "关上"],
      note: "机械连击或重复起手键（guan -> gugan）场景，本地 LoRA 结合动作宾语「空调」准确收敛到「关掉」。",
    },
    {
      context: "去图书馆",
      raw_keys: "zixisi",
      base_pred: ["自私", "仔细思", "子嗣"],
      user_a_pred: ["自习室", "自习", "仔细"],
      user_b_pred: ["自习室", "找位置", "自私"],
      note: "平翘舌混淆（shi -> si）下，通用底座易落入非语境同音词，个性化模型结合校园地点稳稳命中「自习室」。",
    },
    {
      context: "明天早上",
      raw_keys: "bnaqu",
      base_pred: ["帮那去", "搬去", "把那去"],
      user_a_pred: ["班区", "办去", "早八去"],
      user_b_pred: ["搬去", "不去", "帮拿去"],
      note: "典型 an/na 邻键时序倒置（ban -> bna），经过各自错误分布微调后均能跳过错序直接还原意图。",
    },
  ];

  const TOTAL_SLIDES = 9;
  const INTERACTIVE_SLIDE_INDEX = 4; // 第 5 页自动呼出右侧榜单
  const POLL_INTERVAL_MS = 2000;
  const WALL_ROTATE_MS = 4500;

  const state = {
    currentSlide: 0,
    sidebarVisible: false,
    sidebarManualOverride: false,
    totalCount: 0,
    leaderboard: [],
    recentComments: [],
    spotlightIndex: 0,
    wallPaused: false,
    wxStepIdx: 0,
    wtStageIdx: 0,
    bridgeStageIdx: 0,
    bpeShowGood: false,
    activeRuleDemoIdx: 0,
    activeSimDemoIdx: 0,
    compareCases: BUILTIN_COMPARE_CASES,
    compareSourceLabel: "内置实证案例 (8 组)",
    currentCaseIndex: 0,
    revealStep: 1, // 第 9 页初始只显示通用底座，点击或按 Space 逐步揭晓本人与室友模型
  };

  const el = {
    stageShell: document.getElementById("stage-shell"),
    stageRight: document.getElementById("stage-right"),
    hudChapterName: document.getElementById("hud-chapter-name"),
    revealAllBtn: document.getElementById("reveal-all-btn"),
    toggleSidebarBtn: document.getElementById("toggle-sidebar-btn"),
    slideCards: Array.from(document.querySelectorAll(".slide-card")),
    slideCounter: document.getElementById("slide-counter"),
    slideDots: document.getElementById("slide-dots"),
    prevSlideBtn: document.getElementById("prev-slide-btn"),
    nextSlideBtn: document.getElementById("next-slide-btn"),
    fullscreenBtn: document.getElementById("fullscreen-btn"),

    wxDemo1Keys: document.getElementById("wx-demo1-keys"),
    replayWx1Btn: document.getElementById("replay-wx1-btn"),
    wxStepTabs: Array.from(document.querySelectorAll(".wx-step-tab")),
    wxStepDisplay: document.getElementById("wx-step-display"),

    wtNodes: Array.from(document.querySelectorAll("#wt-stage-bar .wt-node")),
    wtDetailStage: document.getElementById("wt-detail-stage"),

    ruleDemoTabs: document.getElementById("rule-demo-tabs"),
    compilerRuleId: document.getElementById("compiler-rule-id"),
    compilerAlias: document.getElementById("compiler-alias"),
    compilerExample: document.getElementById("compiler-example"),
    compilerDesc: document.getElementById("compiler-desc"),
    compilerYaml: document.getElementById("compiler-yaml"),

    wallTotalCount: document.getElementById("wall-total-count"),
    wallToggleBtn: document.getElementById("wall-toggle-btn"),
    wallNextBtn: document.getElementById("wall-next-btn"),
    wallCarouselIndex: document.getElementById("wall-carousel-index"),
    spotlightBox: document.getElementById("spotlight-box"),
    recentFeedList: document.getElementById("recent-feed-list"),

    hystSlider: document.getElementById("hyst-slider"),
    hystRateVal: document.getElementById("hyst-rate-val"),
    hystStateBadge: document.getElementById("hyst-state-badge"),
    hystSimOutput: document.getElementById("hyst-sim-output"),
    hystPresetBtns: Array.from(document.querySelectorAll("[data-rate]")),
    svgNodeOff: document.getElementById("svg-node-off"),
    svgNodeMid: document.getElementById("svg-node-mid"),
    svgNodeOn: document.getElementById("svg-node-on"),

    simTabs: document.getElementById("sim-tabs"),
    simPipelineView: document.getElementById("sim-pipeline-view"),
    bpeToggleBtn: document.getElementById("bpe-toggle-btn"),
    bpeModeBad: document.getElementById("bpe-mode-bad"),
    bpeModeGood: document.getElementById("bpe-mode-good"),

    bridgeNodes: Array.from(document.querySelectorAll("#bridge-node-bar .wt-node")),
    bridgeDetailBox: document.getElementById("bridge-detail-box"),

    casesSourceBadge: document.getElementById("cases-source-badge"),
    casesFileInput: document.getElementById("cases-file-input"),
    revealModelsBtn: document.getElementById("reveal-models-btn"),
    caseSelector: document.getElementById("case-selector"),
    caseContext: document.getElementById("case-context"),
    caseRawKeys: document.getElementById("case-raw-keys"),
    caseBasePred: document.getElementById("case-base-pred"),
    caseUserAPred: document.getElementById("case-user-a-pred"),
    caseUserBPred: document.getElementById("case-user-b-pred"),
    colBase: document.getElementById("col-base"),
    colUserA: document.getElementById("col-user-a"),
    colUserB: document.getElementById("col-user-b"),
    caseNote: document.getElementById("case-note"),
    prevCaseBtn: document.getElementById("prev-case-btn"),
    nextCaseBtn: document.getElementById("next-case-btn"),

    qrWrap: document.getElementById("qr-canvas-wrap"),
    playUrlLink: document.getElementById("play-url-link"),
    copyPlayUrlBtn: document.getElementById("copy-play-url-btn"),
    copyUrlFeedback: document.getElementById("copy-url-feedback"),
    lbLiveStatus: document.getElementById("lb-live-status"),
    lbTotalBadge: document.getElementById("lb-total-badge"),
    leaderboardList: document.getElementById("leaderboard-list"),

    resetTriggerBtn: document.getElementById("reset-trigger-btn"),
    resetModal: document.getElementById("reset-modal"),
    resetCloseBtn: document.getElementById("reset-close-btn"),
    resetCancelBtn: document.getElementById("reset-cancel-btn"),
    resetForm: document.getElementById("reset-form"),
    resetTokenInput: document.getElementById("reset-token-input"),
    resetFeedback: document.getElementById("reset-feedback"),
  };

  function setSidebarVisible(visible) {
    state.sidebarVisible = Boolean(visible);
    el.stageRight.hidden = !state.sidebarVisible;
    el.stageShell.classList.toggle("is-sidebar-hidden", !state.sidebarVisible);
    el.toggleSidebarBtn.classList.toggle("is-active", state.sidebarVisible);
    el.toggleSidebarBtn.textContent = state.sidebarVisible ? "隐藏榜单" : "显示榜单";
  }

  function resolvePlayUrl() {
    const origin = window.location.origin;
    if (!origin || origin === "null" || window.location.protocol === "file:") {
      return "http://127.0.0.1:8000/play";
    }
    return `${origin}/play`;
  }

  function renderQrCode() {
    const playUrl = resolvePlayUrl();
    el.qrWrap.innerHTML = "";
    el.qrWrap.appendChild(QREncoder.createSvg(playUrl));
    el.playUrlLink.href = playUrl;
    el.playUrlLink.textContent = playUrl;
  }

  function buildRuleChip(ruleText, accent = false) {
    const chip = document.createElement("span");
    chip.className = `rule-chip${accent ? " is-accent" : ""}`;
    chip.textContent = String(ruleText);
    return chip;
  }

  function formatShortTime(isoStr) {
    if (!isoStr) return "";
    const date = new Date(isoStr);
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  }

  // ---- Progressive Reveal Engine (click veiled cards or press Space) ----
  function revealElement(node) {
    if (!node || !node.classList.contains("is-veiled")) return false;
    node.classList.remove("is-veiled");
    node.classList.add("is-revealed");
    return true;
  }

  function revealNextInCurrentSlide() {
    const card = el.slideCards[state.currentSlide];
    if (!card) return;

    // 1. Check veiled blocks
    const nextVeiled = card.querySelector(".is-veiled");
    if (nextVeiled) {
      revealElement(nextVeiled);
      return;
    }
    // 2. Slide 2 or Slide 8 stage steps
    if (state.currentSlide === 1 && state.wtStageIdx < WETYPE_STAGES.length - 1) {
      state.wtStageIdx += 1;
      renderWtStage();
      return;
    }
    if (state.currentSlide === 7 && state.bridgeStageIdx < BRIDGE_NODES.length - 1) {
      state.bridgeStageIdx += 1;
      renderBridgeStage();
      return;
    }
    // 3. Slide 9 concealed models
    if (state.currentSlide === 8 && state.revealStep < 3) {
      state.revealStep += 1;
      applyRevealState();
    }
  }

  function revealAllInCurrentSlide() {
    const card = el.slideCards[state.currentSlide];
    if (!card) return;
    card.querySelectorAll(".is-veiled").forEach((node) => revealElement(node));
    if (state.currentSlide === 8) {
      state.revealStep = 3;
      applyRevealState();
    }
  }

  function renderSlideDots() {
    el.slideDots.innerHTML = "";
    for (let i = 0; i < TOTAL_SLIDES; i += 1) {
      const dot = document.createElement("button");
      dot.type = "button";
      dot.className = `slide-dot${i === state.currentSlide ? " is-active" : ""}`;
      dot.setAttribute("aria-label", `切换到第 ${i + 1} 页`);
      dot.addEventListener("click", () => goToSlide(i));
      el.slideDots.appendChild(dot);
    }
  }

  function goToSlide(index) {
    const target = Math.max(0, Math.min(TOTAL_SLIDES - 1, index));
    const forward = target >= state.currentSlide;
    state.currentSlide = target;

    el.slideCards.forEach((card, idx) => {
      const active = idx === target;
      card.hidden = !active;
      card.classList.remove("is-active", "anim-forward", "anim-back");
      if (active) card.classList.add("is-active", forward ? "anim-forward" : "anim-back");
    });

    const activeCard = el.slideCards[target];
    if (activeCard && el.hudChapterName) {
      el.hudChapterName.textContent = activeCard.dataset.chapter || "";
    }

    el.slideCounter.textContent = `${target + 1} / ${TOTAL_SLIDES}`;
    el.prevSlideBtn.disabled = target === 0;
    el.nextSlideBtn.disabled = target === TOTAL_SLIDES - 1;
    renderSlideDots();

    if (!state.sidebarManualOverride && target === INTERACTIVE_SLIDE_INDEX && !state.sidebarVisible) {
      setSidebarVisible(true);
    }
  }

  // ---- Slide 1 ----
  function renderWxStep() {
    const data = WX_STEP_DATA[state.wxStepIdx];
    el.wxStepTabs.forEach((btn, idx) => btn.classList.toggle("is-active", idx === state.wxStepIdx));
    el.wxStepDisplay.innerHTML = "";

    const badge = document.createElement("div");
    badge.className = "micro-note";
    badge.textContent = data.badge;

    const inputLine = document.createElement("div");
    inputLine.className = "wx-input-row";
    const keysEl = document.createElement("code");
    keysEl.className = "mono wx-keys";
    keysEl.textContent = data.keys;
    inputLine.appendChild(keysEl);

    const bar = document.createElement("div");
    bar.className = "wx-bar";
    data.cands.forEach((text, i) => {
      const span = document.createElement("span");
      span.className = `wx-cand${i === 0 ? (data.top1Miss ? " is-miss" : " is-top1") : ""}`;
      span.textContent = text;
      bar.appendChild(span);
    });

    const note = document.createElement("p");
    note.className = "micro-note";
    note.textContent = data.note;
    el.wxStepDisplay.append(badge, inputLine, bar, note);
  }

  let replayTimer = null;
  function replayWxKeystrokes() {
    if (replayTimer) window.clearInterval(replayTimer);
    const full = "ni'ge'c'l'l";
    let idx = 1;
    el.wxDemo1Keys.textContent = full.slice(0, idx);
    replayTimer = window.setInterval(() => {
      idx += 1;
      el.wxDemo1Keys.textContent = full.slice(0, idx);
      if (idx >= full.length) {
        window.clearInterval(replayTimer);
        replayTimer = null;
      }
    }, 95);
  }

  // ---- Slide 2 ----
  function renderWtStage() {
    el.wtNodes.forEach((node, idx) => {
      node.classList.toggle("is-active", idx === state.wtStageIdx);
      node.classList.toggle("is-dimmed", idx > state.wtStageIdx);
    });
    const cur = WETYPE_STAGES[state.wtStageIdx];
    el.wtDetailStage.innerHTML = "";

    const title = document.createElement("h3");
    title.textContent = cur.title;

    const desc = document.createElement("p");
    desc.className = "wt-detail-desc";
    desc.textContent = cur.desc;

    const grid = document.createElement("div");
    grid.className = "wt-detail-grid";
    cur.cards.forEach((c) => {
      const card = document.createElement("div");
      card.className = `wt-mini-card${c.cls ? ` ${c.cls}` : ""}`;
      const strong = document.createElement("strong");
      strong.textContent = c.head;
      const p = document.createElement("p");
      p.textContent = c.body;
      card.append(strong, p);
      grid.appendChild(card);
    });

    el.wtDetailStage.append(title, desc, grid);
  }

  // ---- Slide 4 ----
  function renderRuleCompilerDemo() {
    el.ruleDemoTabs.innerHTML = "";
    RULE_COMPILER_DEMOS.forEach((item, idx) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `rule-demo-btn${idx === state.activeRuleDemoIdx ? " is-active" : ""}`;
      btn.textContent = item.id;
      btn.addEventListener("click", () => {
        state.activeRuleDemoIdx = idx;
        renderRuleCompilerDemo();
      });
      el.ruleDemoTabs.appendChild(btn);
    });

    const cur = RULE_COMPILER_DEMOS[state.activeRuleDemoIdx];
    el.compilerRuleId.textContent = cur.id;
    el.compilerAlias.textContent = cur.alias;
    el.compilerExample.textContent = cur.example;
    el.compilerDesc.textContent = cur.desc;
    el.compilerYaml.textContent = [
      "patch:",
      "  speller/algebra/+:",
      `    # [${cur.id}]`,
      ...cur.algebra.map((expr) => `    - '${expr}'`),
    ].join("\n");
  }

  // ---- Slide 5 ----
  function renderInteractionWall() {
    const items = state.recentComments;
    el.wallTotalCount.textContent = String(state.totalCount);

    if (!items || items.length === 0) {
      el.wallCarouselIndex.textContent = "0 / 0";
      el.spotlightBox.innerHTML = "";
      const empty = document.createElement("div");
      empty.className = "spotlight-empty";
      const strong = document.createElement("strong");
      strong.textContent = "等待第一位同学扫码完赛...";
      const p = document.createElement("p");
      p.textContent = "请扫描右侧二维码进入 /play，敲完 3 句拼音即可在大屏实时上墙并生成专属 Rime 配置。";
      empty.append(strong, p);
      el.spotlightBox.appendChild(empty);

      el.recentFeedList.innerHTML = "";
      const feedEmpty = document.createElement("div");
      feedEmpty.className = "lb-empty";
      feedEmpty.textContent = "暂无提交点评";
      el.recentFeedList.appendChild(feedEmpty);
      return;
    }

    if (state.spotlightIndex >= items.length) state.spotlightIndex = 0;
    const activeItem = items[state.spotlightIndex];
    el.wallCarouselIndex.textContent = `${state.spotlightIndex + 1} / ${items.length}`;

    el.spotlightBox.innerHTML = "";
    const topDiv = document.createElement("div");
    topDiv.className = "spotlight-top";
    const idWrap = document.createElement("div");
    const nickDiv = document.createElement("div");
    nickDiv.className = "spotlight-nick";
    nickDiv.textContent = activeItem.nickname || "Anonymous";
    const titleBadge = document.createElement("span");
    titleBadge.className = "spotlight-title-badge";
    titleBadge.textContent = activeItem.title || "节奏输入派";
    idWrap.append(nickDiv, titleBadge);

    const timeSpan = document.createElement("span");
    timeSpan.className = "spotlight-time mono";
    timeSpan.textContent = formatShortTime(activeItem.created_at);
    topDiv.append(idWrap, timeSpan);

    const commentBox = document.createElement("blockquote");
    commentBox.className = "spotlight-comment";
    commentBox.textContent = activeItem.comment || "已完成 3 句拼音竞速，风格档案已生成。";

    const rulesRow = document.createElement("div");
    rulesRow.className = "spotlight-rules";
    const rulesLabel = document.createElement("span");
    rulesLabel.className = "spotlight-rules-label";
    rulesLabel.textContent = "识别规则标签：";
    rulesRow.appendChild(rulesLabel);
    const rules = Array.isArray(activeItem.rules) ? activeItem.rules : [];
    if (rules.length > 0) {
      rules.forEach((rule) => rulesRow.appendChild(buildRuleChip(rule, true)));
    } else {
      const cleanChip = document.createElement("span");
      cleanChip.className = "rule-chip is-muted";
      cleanChip.textContent = "标准全拼无明显偏置";
      rulesRow.appendChild(cleanChip);
    }
    el.spotlightBox.append(topDiv, commentBox, rulesRow);

    el.recentFeedList.innerHTML = "";
    items.forEach((item, idx) => {
      const card = document.createElement("div");
      card.className = `feed-item${idx === state.spotlightIndex ? " is-selected" : ""}`;
      card.addEventListener("click", () => {
        state.spotlightIndex = idx;
        renderInteractionWall();
      });

      const head = document.createElement("div");
      head.className = "feed-item-head";
      const nick = document.createElement("span");
      nick.className = "feed-item-nick";
      nick.textContent = item.nickname || "Anonymous";
      const title = document.createElement("span");
      title.className = "feed-item-title";
      title.textContent = item.title || "节奏输入派";
      head.append(nick, title);

      const comment = document.createElement("p");
      comment.className = "feed-item-comment";
      comment.textContent = item.comment || "";

      const rulesDiv = document.createElement("div");
      rulesDiv.className = "feed-item-rules";
      const itemRules = Array.isArray(item.rules) ? item.rules : [];
      if (itemRules.length > 0) {
        itemRules.slice(0, 4).forEach((r) => rulesDiv.appendChild(buildRuleChip(r, false)));
      } else {
        const emptyChip = document.createElement("span");
        emptyChip.className = "rule-chip is-muted";
        emptyChip.textContent = "全拼稳健";
        rulesDiv.appendChild(emptyChip);
      }
      card.append(head, comment, rulesDiv);
      el.recentFeedList.appendChild(card);
    });
  }

  // ---- Slide 6 ----
  function updateHystSimulation(rateVal) {
    const rate = Number(rateVal);
    el.hystRateVal.textContent = `${rate}%`;
    el.hystSlider.value = String(rate);

    el.svgNodeOff.setAttribute("stroke-width", "1.5");
    el.svgNodeMid.setAttribute("stroke-width", "1.5");
    el.svgNodeOn.setAttribute("stroke-width", "1.5");

    if (rate >= 15) {
      el.svgNodeOn.setAttribute("stroke-width", "4");
      el.hystStateBadge.textContent = "状态：触发开启 (>=15%)";
      el.hystStateBadge.className = "tag-pill is-blue";
      el.hystSimOutput.textContent = "rule_notify.lua 首候选轻提示：[已为你自动开启 ong=on]（剩余 3 次即静默）";
    } else if (rate < 5) {
      el.svgNodeOff.setAttribute("stroke-width", "4");
      el.hystStateBadge.textContent = "状态：自动降权关闭 (<5%)";
      el.hystStateBadge.className = "tag-pill is-red";
      el.hystSimOutput.textContent = "rule_updater.py：命中率过低，从受控补丁区移除 ong=on，避免词库污染";
    } else {
      el.svgNodeMid.setAttribute("stroke-width", "4");
      el.hystStateBadge.textContent = "状态：迟滞缓冲带 (5%~15%)";
      el.hystStateBadge.className = "tag-pill";
      el.hystSimOutput.textContent = "Rime 候选注释预览：处于迟滞缓冲带，维持原启用/休眠状态，零反复横跳";
    }
  }

  // ---- Slide 7 ----
  function renderNoiseSimDemo() {
    el.simTabs.innerHTML = "";
    NOISE_SIM_DEMOS.forEach((item, idx) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `sim-btn${idx === state.activeSimDemoIdx ? " is-active" : ""}`;
      btn.textContent = item.label;
      btn.addEventListener("click", () => {
        state.activeSimDemoIdx = idx;
        renderNoiseSimDemo();
      });
      el.simTabs.appendChild(btn);
    });

    const cur = NOISE_SIM_DEMOS[state.activeSimDemoIdx];
    el.simPipelineView.innerHTML = "";
    cur.steps.forEach((line) => {
      const div = document.createElement("div");
      div.textContent = line;
      el.simPipelineView.appendChild(div);
    });
  }

  function renderBpeToggle() {
    el.bpeModeBad.hidden = state.bpeShowGood;
    el.bpeModeGood.hidden = !state.bpeShowGood;
    el.bpeToggleBtn.textContent = state.bpeShowGood ? "切回 BPE 盲区对比" : "切换为单字母分词";
  }

  // ---- Slide 8 ----
  function renderBridgeStage() {
    el.bridgeNodes.forEach((node, idx) => {
      node.classList.toggle("is-active", idx === state.bridgeStageIdx);
      node.classList.toggle("is-dimmed", idx > state.bridgeStageIdx);
    });
    const cur = BRIDGE_NODES[state.bridgeStageIdx];
    el.bridgeDetailBox.innerHTML = "";

    const title = document.createElement("h3");
    title.textContent = cur.title;

    const desc = document.createElement("p");
    desc.className = "wt-detail-desc";
    desc.textContent = cur.desc;

    const tags = document.createElement("div");
    tags.className = "noise-chips";
    cur.tags.forEach((t) => {
      const span = document.createElement("span");
      span.className = "tag-pill is-blue";
      span.textContent = t;
      tags.appendChild(span);
    });

    el.bridgeDetailBox.append(title, desc, tags);
  }

  // ---- Slide 9 ----
  function normalizePredList(pred) {
    if (Array.isArray(pred)) {
      return pred.slice(0, 3).map((item) => {
        if (typeof item === "string") return { text: item, score: null };
        if (item && typeof item === "object") {
          return {
            text: String(item.text || item.cand || item.pred || ""),
            score: item.score != null ? String(item.score) : null,
          };
        }
        return { text: String(item), score: null };
      });
    }
    if (typeof pred === "string" && pred.trim()) return [{ text: pred.trim(), score: null }];
    return [{ text: "--", score: null }];
  }

  function renderPredColumn(container, pred) {
    container.innerHTML = "";
    normalizePredList(pred).forEach((item, idx) => {
      const row = document.createElement("div");
      row.className = `pred-item${idx === 0 ? " is-top1" : ""}`;
      const textSpan = document.createElement("span");
      textSpan.textContent = item.text;
      const rankSpan = document.createElement("span");
      rankSpan.className = "pred-rank";
      rankSpan.textContent = item.score ? `Top-${idx + 1} · ${item.score}` : `Top-${idx + 1}`;
      row.append(textSpan, rankSpan);
      container.appendChild(row);
    });
  }

  function applyRevealState() {
    el.colBase.classList.toggle("is-concealed", state.revealStep < 1);
    el.colUserA.classList.toggle("is-concealed", state.revealStep < 2);
    el.colUserB.classList.toggle("is-concealed", state.revealStep < 3);
    el.revealModelsBtn.textContent =
      state.revealStep >= 3 ? "重放逐步对比" : `揭晓下一模型 (${state.revealStep}/3)`;
  }

  function renderCompareCases() {
    const cases = state.compareCases;
    if (!cases.length) return;
    if (state.currentCaseIndex >= cases.length) state.currentCaseIndex = 0;

    el.casesSourceBadge.textContent = state.compareSourceLabel;
    el.caseSelector.innerHTML = "";
    cases.forEach((item, idx) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `case-btn${idx === state.currentCaseIndex ? " is-active" : ""}`;
      btn.textContent = `#${idx + 1} ${item.raw_keys || ""}`;
      btn.addEventListener("click", () => {
        state.currentCaseIndex = idx;
        renderCompareCases();
      });
      el.caseSelector.appendChild(btn);
    });

    const current = cases[state.currentCaseIndex];
    el.caseContext.textContent = current.context || "（无前置语境）";
    el.caseRawKeys.textContent = current.raw_keys || "--";
    el.caseNote.textContent = current.note || "暂无补充说明";
    renderPredColumn(el.caseBasePred, current.base_pred);
    renderPredColumn(el.caseUserAPred, current.user_a_pred);
    renderPredColumn(el.caseUserBPred, current.user_b_pred);
    applyRevealState();
  }

  function parseCasesPayload(raw) {
    const list = Array.isArray(raw) ? raw : Array.isArray(raw?.cases) ? raw.cases : null;
    if (!list || list.length === 0) return null;
    const valid = list.filter(
      (item) =>
        item &&
        typeof item === "object" &&
        "raw_keys" in item &&
        "base_pred" in item &&
        "user_a_pred" in item &&
        "user_b_pred" in item
    );
    return valid.length > 0 ? valid : null;
  }

  async function loadExternalCasesIfSpecified() {
    const params = new URLSearchParams(window.location.search);
    const customUrl = params.get("cases");
    if (!customUrl) return;
    try {
      const resp = await fetch(customUrl, { headers: { Accept: "application/json" } });
      if (!resp.ok) return;
      const parsed = parseCasesPayload(await resp.json());
      if (parsed) {
        state.compareCases = parsed;
        state.compareSourceLabel = `已加载外部 JSON (${parsed.length} 组)`;
        state.currentCaseIndex = 0;
        renderCompareCases();
      }
    } catch {
      // keep builtin cases
    }
  }

  // ---- Right Sidebar: Leaderboard ----
  function renderLeaderboard() {
    el.lbTotalBadge.textContent = `${state.totalCount} 人完赛`;
    el.leaderboardList.innerHTML = "";

    if (!state.leaderboard || state.leaderboard.length === 0) {
      const empty = document.createElement("div");
      empty.className = "lb-empty";
      empty.textContent = "排行榜虚位以待，手机扫码右上角即可成为第一位上榜选手。";
      el.leaderboardList.appendChild(empty);
      return;
    }

    state.leaderboard.forEach((row, idx) => {
      const rank = idx + 1;
      const rowEl = document.createElement("div");
      rowEl.className = `lb-row${rank <= 3 ? ` is-top-${rank}` : ""}`;

      const rankBadge = document.createElement("span");
      rankBadge.className = "lb-rank";
      rankBadge.textContent = String(rank);

      const mainDiv = document.createElement("div");
      mainDiv.className = "lb-main";

      const nameLine = document.createElement("div");
      nameLine.className = "lb-name-line";
      const nickSpan = document.createElement("span");
      nickSpan.className = "lb-nickname";
      nickSpan.textContent = row.nickname || "Anonymous";
      const titleSpan = document.createElement("span");
      titleSpan.className = "lb-title-pill";
      titleSpan.textContent = row.title || "节奏输入派";
      nameLine.append(nickSpan, titleSpan);

      const rulesDiv = document.createElement("div");
      rulesDiv.className = "lb-rules";
      const rules = Array.isArray(row.rules) ? row.rules : [];
      if (rules.length > 0) {
        rules.slice(0, 3).forEach((r) => rulesDiv.appendChild(buildRuleChip(r, false)));
      } else {
        const cleanTag = document.createElement("span");
        cleanTag.className = "rule-chip is-muted";
        cleanTag.textContent = "标准全拼";
        rulesDiv.appendChild(cleanTag);
      }
      mainDiv.append(nameLine, rulesDiv);

      const metricsDiv = document.createElement("div");
      metricsDiv.className = "lb-metrics mono";
      const scoreSpan = document.createElement("span");
      scoreSpan.className = "lb-score";
      scoreSpan.textContent = `${Number(row.score || 0).toFixed(1)} 分`;
      const subSpan = document.createElement("span");
      subSpan.className = "lb-submetrics";
      subSpan.textContent = `${Number(row.cpm || 0).toFixed(0)} 键/分 · ${Number(row.accuracy || 0).toFixed(1)}%`;
      metricsDiv.append(scoreSpan, subSpan);

      rowEl.append(rankBadge, mainDiv, metricsDiv);
      el.leaderboardList.appendChild(rowEl);
    });
  }

  function setLiveStatus(ok, message) {
    el.lbLiveStatus.classList.toggle("is-error", !ok);
    el.lbLiveStatus.innerHTML = "";
    const dot = document.createElement("span");
    dot.className = "live-dot";
    dot.setAttribute("aria-hidden", "true");
    el.lbLiveStatus.append(dot, document.createTextNode(message));
  }

  async function fetchLeaderboard() {
    try {
      const resp = await fetch("/api/leaderboard?limit=30", {
        method: "GET",
        headers: { Accept: "application/json" },
      });
      if (!resp.ok) {
        setLiveStatus(false, "同步重试中");
        return;
      }
      const data = await resp.json();
      const prevTopId = state.recentComments[0]?.id;
      state.totalCount = Number(data.total || 0);
      state.leaderboard = Array.isArray(data.leaderboard) ? data.leaderboard : [];
      state.recentComments = Array.isArray(data.recent_comments) ? data.recent_comments : [];
      if (state.recentComments[0]?.id && state.recentComments[0].id !== prevTopId) {
        state.spotlightIndex = 0;
      }
      setLiveStatus(true, "2s 同步中");
      renderLeaderboard();
      renderInteractionWall();
    } catch {
      setLiveStatus(false, "连接重试中");
    }
  }

  function updateFullscreenLabel() {
    el.fullscreenBtn.textContent = document.fullscreenElement ? "退出全屏" : "全屏";
  }

  async function toggleFullscreen() {
    try {
      if (!document.fullscreenElement) await document.documentElement.requestFullscreen();
      else await document.exitFullscreen();
    } catch {
      // ignore
    }
    updateFullscreenLabel();
  }

  function openResetModal() {
    el.resetModal.hidden = false;
    el.resetTokenInput.value = "";
    el.resetFeedback.hidden = true;
    el.resetFeedback.classList.remove("is-ok");
    el.resetTokenInput.focus();
  }

  function closeResetModal() {
    el.resetModal.hidden = true;
  }

  async function handleResetSubmit(event) {
    event.preventDefault();
    const token = el.resetTokenInput.value.trim();
    if (!token) {
      el.resetFeedback.hidden = false;
      el.resetFeedback.classList.remove("is-ok");
      el.resetFeedback.textContent = "请输入管理员口令。";
      return;
    }
    try {
      const resp = await fetch("/api/reset", {
        method: "POST",
        headers: { "X-Admin-Token": token },
      });
      const data = await resp.json().catch(() => ({}));
      if (resp.ok) {
        el.resetFeedback.hidden = false;
        el.resetFeedback.classList.add("is-ok");
        el.resetFeedback.textContent = `已清空 ${Number(data.deleted || 0)} 条排行榜记录。`;
        await fetchLeaderboard();
        window.setTimeout(closeResetModal, 900);
        return;
      }
      el.resetFeedback.hidden = false;
      el.resetFeedback.classList.remove("is-ok");
      el.resetFeedback.textContent = data.detail || `清榜失败 (HTTP ${resp.status})`;
    } catch {
      el.resetFeedback.hidden = false;
      el.resetFeedback.classList.remove("is-ok");
      el.resetFeedback.textContent = "无法连接后端 /api/reset 接口。";
    }
  }

  async function copyPlayUrl() {
    const url = resolvePlayUrl();
    let ok = false;
    if (navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(url);
        ok = true;
      } catch {
        ok = false;
      }
    }
    if (!ok) {
      const helper = document.createElement("textarea");
      helper.value = url;
      helper.setAttribute("readonly", "");
      helper.style.position = "fixed";
      helper.style.left = "-9999px";
      document.body.appendChild(helper);
      helper.select();
      try {
        ok = document.execCommand("copy");
      } catch {
        ok = false;
      }
      document.body.removeChild(helper);
    }
    el.copyUrlFeedback.hidden = false;
    el.copyUrlFeedback.textContent = ok ? "已复制参赛链接" : "请手动复制左侧链接";
    window.setTimeout(() => {
      el.copyUrlFeedback.hidden = true;
    }, 2200);
  }

  function bindEvents() {
    // 点击任何未揭晓的遮罩块，平滑揭晓
    document.querySelectorAll("[data-step]").forEach((node) => {
      node.addEventListener("click", () => {
        revealElement(node);
      });
    });

    el.revealAllBtn.addEventListener("click", revealAllInCurrentSlide);

    // 问题导向线索链接跳转
    document.querySelectorAll("[data-goto]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const target = Number(btn.dataset.goto);
        if (!Number.isNaN(target)) goToSlide(target);
      });
    });

    el.prevSlideBtn.addEventListener("click", () => goToSlide(state.currentSlide - 1));
    el.nextSlideBtn.addEventListener("click", () => goToSlide(state.currentSlide + 1));
    el.fullscreenBtn.addEventListener("click", toggleFullscreen);
    document.addEventListener("fullscreenchange", updateFullscreenLabel);

    el.toggleSidebarBtn.addEventListener("click", () => {
      state.sidebarManualOverride = true;
      setSidebarVisible(!state.sidebarVisible);
    });

    el.replayWx1Btn.addEventListener("click", (e) => {
      e.stopPropagation();
      replayWxKeystrokes();
    });
    el.wxStepTabs.forEach((btn, idx) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        state.wxStepIdx = idx;
        renderWxStep();
      });
    });

    el.wtNodes.forEach((node, idx) => {
      node.addEventListener("click", () => {
        state.wtStageIdx = idx;
        renderWtStage();
      });
    });

    el.hystSlider.addEventListener("input", (e) => updateHystSimulation(e.target.value));
    el.hystPresetBtns.forEach((btn) => {
      btn.addEventListener("click", () => updateHystSimulation(btn.dataset.rate));
    });

    el.bpeToggleBtn.addEventListener("click", () => {
      state.bpeShowGood = !state.bpeShowGood;
      renderBpeToggle();
    });

    el.bridgeNodes.forEach((node, idx) => {
      node.addEventListener("click", () => {
        state.bridgeStageIdx = idx;
        renderBridgeStage();
      });
    });

    el.revealModelsBtn.addEventListener("click", () => {
      state.revealStep = state.revealStep >= 3 ? 1 : state.revealStep + 1;
      applyRevealState();
    });

    // Slide 9 click concealed model column directly to reveal
    [el.colUserA, el.colUserB].forEach((col, offset) => {
      col.addEventListener("click", () => {
        const needed = offset + 2;
        if (state.revealStep < needed) {
          state.revealStep = needed;
          applyRevealState();
        }
      });
    });

    window.addEventListener("keydown", (e) => {
      if (!el.resetModal.hidden) {
        if (e.key === "Escape") closeResetModal();
        return;
      }
      const tag = document.activeElement?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;

      if (e.key === " ") {
        e.preventDefault();
        revealNextInCurrentSlide();
      } else if (e.key === "ArrowRight" || e.key === "PageDown") {
        e.preventDefault();
        goToSlide(state.currentSlide + 1);
      } else if (e.key === "ArrowLeft" || e.key === "PageUp") {
        e.preventDefault();
        goToSlide(state.currentSlide - 1);
      } else if (e.key >= "1" && e.key <= String(TOTAL_SLIDES)) {
        goToSlide(Number(e.key) - 1);
      } else if (e.key === "b" || e.key === "B") {
        state.sidebarManualOverride = true;
        setSidebarVisible(!state.sidebarVisible);
      } else if (e.key === "f" || e.key === "F") {
        toggleFullscreen();
      }
    });

    el.wallToggleBtn.addEventListener("click", () => {
      state.wallPaused = !state.wallPaused;
      el.wallToggleBtn.textContent = state.wallPaused ? "恢复轮播" : "暂停轮播";
    });
    el.wallNextBtn.addEventListener("click", () => {
      if (state.recentComments.length > 0) {
        state.spotlightIndex = (state.spotlightIndex + 1) % state.recentComments.length;
        renderInteractionWall();
      }
    });

    el.prevCaseBtn.addEventListener("click", () => {
      const len = state.compareCases.length;
      state.currentCaseIndex = (state.currentCaseIndex - 1 + len) % len;
      renderCompareCases();
    });
    el.nextCaseBtn.addEventListener("click", () => {
      const len = state.compareCases.length;
      state.currentCaseIndex = (state.currentCaseIndex + 1) % len;
      renderCompareCases();
    });
    el.casesFileInput.addEventListener("change", async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        const parsed = parseCasesPayload(JSON.parse(await file.text()));
        if (parsed) {
          state.compareCases = parsed;
          state.compareSourceLabel = `${file.name} (${parsed.length} 组)`;
          state.currentCaseIndex = 0;
          renderCompareCases();
        }
      } catch {
        // ignore invalid file
      } finally {
        el.casesFileInput.value = "";
      }
    });

    el.copyPlayUrlBtn.addEventListener("click", copyPlayUrl);
    el.resetTriggerBtn.addEventListener("click", openResetModal);
    el.resetCloseBtn.addEventListener("click", closeResetModal);
    el.resetCancelBtn.addEventListener("click", closeResetModal);
    el.resetModal.addEventListener("click", (e) => {
      if (e.target === el.resetModal) closeResetModal();
    });
    el.resetForm.addEventListener("submit", handleResetSubmit);
  }

  function init() {
    setSidebarVisible(false);
    renderQrCode();
    goToSlide(0);
    renderWxStep();
    renderWtStage();
    renderRuleCompilerDemo();
    renderInteractionWall();
    updateHystSimulation(10);
    renderNoiseSimDemo();
    renderBpeToggle();
    renderBridgeStage();
    renderCompareCases();
    bindEvents();

    loadExternalCasesIfSpecified();
    fetchLeaderboard();

    window.setInterval(fetchLeaderboard, POLL_INTERVAL_MS);
    window.setInterval(() => {
      if (!state.wallPaused && state.recentComments.length > 1) {
        state.spotlightIndex = (state.spotlightIndex + 1) % state.recentComments.length;
        renderInteractionWall();
      }
    }, WALL_ROTATE_MS);
  }

  init();
})();
