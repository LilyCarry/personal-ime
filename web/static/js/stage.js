(() => {
  "use strict";

  /**
   * 最小纯原生 QR 编码器（Byte 模式 + ECC Level M，支持 Version 1..8，最大 152 字节），
   * 用于离线/内网大屏零依赖动态生成 /play 二维码。
   */
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
      for (let i = 255; i < 512; i += 1) {
        GF_EXP[i] = GF_EXP[i - 255];
      }
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
          for (let j = 0; j < gen.length; j += 1) {
            work[i + j] ^= gfMul(gen[j], coef);
          }
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
      for (let bit = 14; bit >= 10; bit -= 1) {
        if ((rem >> bit) & 1) rem ^= poly << (bit - 10);
      }
      return ((data << 10) | rem) ^ 0x5412;
    }

    function bchVersionInfo(version) {
      let rem = version << 12;
      const poly = 0x1f25;
      for (let bit = 17; bit >= 12; bit -= 1) {
        if ((rem >> bit) & 1) rem ^= poly << (bit - 12);
      }
      return (version << 12) | rem;
    }

    function encodeBytes(text) {
      const bytes = new TextEncoder().encode(text);
      let spec = null;
      for (let v = 1; v < VERSIONS_M.length; v += 1) {
        const cap = VERSIONS_M[v].dataCw - 2;
        if (bytes.length <= cap) {
          spec = VERSIONS_M[v];
          break;
        }
      }
      if (!spec) spec = VERSIONS_M[VERSIONS_M.length - 1];
      const payload = bytes.slice(0, spec.dataCw - 2);

      const bits = [];
      const pushBits = (val, len) => {
        for (let i = len - 1; i >= 0; i -= 1) bits.push((val >> i) & 1);
      };

      pushBits(0b0100, 4);
      pushBits(payload.length, 8);
      for (let i = 0; i < payload.length; i += 1) pushBits(payload[i], 8);

      const maxDataBits = spec.dataCw * 8;
      const termLen = Math.min(4, maxDataBits - bits.length);
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
        for (const blk of dataBlocks) {
          if (i < blk.length) finalCw.push(blk[i]);
        }
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
      for (const cw of finalCw) {
        for (let b = 7; b >= 0; b -= 1) streamBits.push((cw >> b) & 1);
      }
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
            } else {
              run = 1;
            }
          }
        }
        for (let c = 0; c < size; c += 1) {
          let run = 1;
          for (let r = 1; r < size; r += 1) {
            if (mat[r][c] === mat[r - 1][c]) {
              run += 1;
              if (run === 5) score += 3;
              else if (run > 5) score += 1;
            } else {
              run = 1;
            }
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

  const RULE_COMPILER_DEMOS = [
    {
      id: "ong=on",
      alias: "on=ong / ong->on -> ong=on",
      example: "wuson -> 雾凇 (wusong)",
      desc: "允许将后鼻音 ong 简写为 on，贴合快速敲击时省去末尾 g 的高频习惯，不影响原本 on 词条。",
      algebra: ["derive/ong$/on/"],
    },
    {
      id: "l=r",
      alias: "r=l / l<->r -> l=r",
      example: "len -> ren (认真)",
      desc: "声母 l 与 r 双向模糊派生，适配部分方言混用或高速盲打时的声母漂移。",
      algebra: ["derive/^l/r/", "derive/^r/l/"],
    },
    {
      id: "z=zh",
      alias: "zh=z / zh/z -> z=zh",
      example: "zao -> zhao / zhi -> zi",
      desc: "平翘舌声母双向互通；类似地 c=ch、s=sh 采用负向先行断言 ([^h]) 避免二次重复匹配。",
      algebra: ["derive/^zh/z/", "derive/^z([^h])/zh$1/"],
    },
    {
      id: "ju=jv",
      alias: "u=v / jv=ju -> ju=jv",
      example: "qv -> qu / xve -> xue",
      desc: "兼容部分双拼/习惯把 j/q/x/y 后的 u 敲作 v 的拼写差异。",
      algebra: ["derive/^([jqxy])u/$1v/", "derive/^([jqxy])v/$1u/"],
    },
    {
      id: "zh=hz",
      alias: "hz=zh -> zh=hz",
      example: "hzi -> zhi / zih -> zhi",
      desc: "纠正高速敲击时声母 zh/ch/sh 与紧随元音间的左右手时序倒置（如 changhs -> changsh）。",
      algebra: [
        "derive/([zcs])h(a|e|i|u|ai|ei|an|en|ou|uo|ua|un|ui|uan|uai|uang|ang|eng|ong)$/h$1$2/",
        "derive/([zcs])h([aeiu])$/$1$2h/",
      ],
    },
    {
      id: "an=na",
      alias: "na=an -> an=na",
      example: "dna -> dan / bna -> ban",
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
        "物理蹭键: e 在 QWERTY 附近或连打带入 n -> bie + n = bnie",
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
  const INTERACTIVE_SLIDE_INDEX = 4; // 第 5 页「现场互动」默认自动展开右侧榜单
  const POLL_INTERVAL_MS = 2000;
  const WALL_ROTATE_MS = 4500;

  const state = {
    currentSlide: 0,
    sidebarVisible: false, // 一开始不出现右侧榜单
    sidebarManualOverride: false,
    totalCount: 0,
    leaderboard: [],
    recentComments: [],
    spotlightIndex: 0,
    wallPaused: false,
    activeRuleDemoIdx: 0,
    activeSimDemoIdx: 0,
    compareCases: BUILTIN_COMPARE_CASES,
    compareSourceLabel: "内置实证案例 (8 组)",
    currentCaseIndex: 0,
  };

  const el = {
    stageShell: document.getElementById("stage-shell"),
    stageRight: document.getElementById("stage-right"),
    toggleSidebarBtn: document.getElementById("toggle-sidebar-btn"),
    slideCards: Array.from(document.querySelectorAll(".slide-card")),
    slideTabs: Array.from(document.querySelectorAll(".slide-tab")),
    slideCounter: document.getElementById("slide-counter"),
    slideDots: document.getElementById("slide-dots"),
    prevSlideBtn: document.getElementById("prev-slide-btn"),
    nextSlideBtn: document.getElementById("next-slide-btn"),
    fullscreenBtn: document.getElementById("fullscreen-btn"),

    // Slide 5 (live interaction wall)
    wallTotalCount: document.getElementById("wall-total-count"),
    wallToggleBtn: document.getElementById("wall-toggle-btn"),
    wallNextBtn: document.getElementById("wall-next-btn"),
    wallCarouselIndex: document.getElementById("wall-carousel-index"),
    spotlightBox: document.getElementById("spotlight-box"),
    recentFeedList: document.getElementById("recent-feed-list"),

    // Slide 4 interactive compiler
    ruleDemoTabs: document.getElementById("rule-demo-tabs"),
    compilerRuleId: document.getElementById("compiler-rule-id"),
    compilerAlias: document.getElementById("compiler-alias"),
    compilerExample: document.getElementById("compiler-example"),
    compilerDesc: document.getElementById("compiler-desc"),
    compilerYaml: document.getElementById("compiler-yaml"),

    // Slide 7 interactive noise simulator
    simTabs: document.getElementById("sim-tabs"),
    simPipelineView: document.getElementById("sim-pipeline-view"),

    // Slide 9 compare cases
    casesSourceBadge: document.getElementById("cases-source-badge"),
    casesFileInput: document.getElementById("cases-file-input"),
    caseSelector: document.getElementById("case-selector"),
    caseContext: document.getElementById("case-context"),
    caseRawKeys: document.getElementById("case-raw-keys"),
    caseBasePred: document.getElementById("case-base-pred"),
    caseUserAPred: document.getElementById("case-user-a-pred"),
    caseUserBPred: document.getElementById("case-user-b-pred"),
    caseNote: document.getElementById("case-note"),
    prevCaseBtn: document.getElementById("prev-case-btn"),
    nextCaseBtn: document.getElementById("next-case-btn"),

    // Right sidebar
    qrWrap: document.getElementById("qr-canvas-wrap"),
    playUrlLink: document.getElementById("play-url-link"),
    copyPlayUrlBtn: document.getElementById("copy-play-url-btn"),
    copyUrlFeedback: document.getElementById("copy-url-feedback"),
    lbLiveStatus: document.getElementById("lb-live-status"),
    lbTotalBadge: document.getElementById("lb-total-badge"),
    leaderboardList: document.getElementById("leaderboard-list"),

    // Reset modal
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
    return date.toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
  }

  // ---- Navigation ----
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
    state.currentSlide = target;
    el.slideCards.forEach((card, idx) => {
      const active = idx === target;
      card.hidden = !active;
      card.classList.toggle("is-active", active);
    });
    el.slideTabs.forEach((tab, idx) => {
      tab.classList.toggle("is-active", idx === target);
    });
    el.slideCounter.textContent = `${target + 1} / ${TOTAL_SLIDES}`;
    el.prevSlideBtn.disabled = target === 0;
    el.nextSlideBtn.disabled = target === TOTAL_SLIDES - 1;
    renderSlideDots();

    if (!state.sidebarManualOverride && target === INTERACTIVE_SLIDE_INDEX && !state.sidebarVisible) {
      setSidebarVisible(true);
    }
  }

  // ---- Slide 5: Interaction Wall ----
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
      p.textContent = "请使用手机扫描右侧二维码进入 /play，敲完 3 句拼音即可在大屏实时上墙并生成专属 Rime 配置。";
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

  // ---- Slide 4: Interactive Rule Compiler ----
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
    const yamlLines = [
      "patch:",
      "  speller/algebra/+:",
      `    # [${cur.id}]`,
      ...cur.algebra.map((expr) => `    - '${expr}'`),
    ];
    el.compilerYaml.textContent = yamlLines.join("\n");
  }

  // ---- Slide 7: Interactive Noise Simulator ----
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

  // ---- Slide 9: Dorm Compare Cases ----
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

  // ---- Fullscreen & Reset Modal ----
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
    el.slideTabs.forEach((tab, idx) => tab.addEventListener("click", () => goToSlide(idx)));
    el.prevSlideBtn.addEventListener("click", () => goToSlide(state.currentSlide - 1));
    el.nextSlideBtn.addEventListener("click", () => goToSlide(state.currentSlide + 1));
    el.fullscreenBtn.addEventListener("click", toggleFullscreen);
    document.addEventListener("fullscreenchange", updateFullscreenLabel);

    el.toggleSidebarBtn.addEventListener("click", () => {
      state.sidebarManualOverride = true;
      setSidebarVisible(!state.sidebarVisible);
    });

    window.addEventListener("keydown", (e) => {
      if (!el.resetModal.hidden) {
        if (e.key === "Escape") closeResetModal();
        return;
      }
      const tag = document.activeElement?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;

      if (e.key === "ArrowRight" || e.key === "PageDown") {
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
    renderRuleCompilerDemo();
    renderNoiseSimDemo();
    renderCompareCases();
    renderInteractionWall();
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
