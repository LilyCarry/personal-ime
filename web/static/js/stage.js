(function () {
  "use strict";

  const STAGE_WIDTH = 1920;
  const STAGE_HEIGHT = 1080;
  const POLL_INTERVAL_MS = 2000;
  const INTERACTIVE_SLIDE_INDEX = 4; // Auto-open right sidebar at Slide 5

  // ---------------------------------------------------------------------------
  // Built-in Data Models
  // ---------------------------------------------------------------------------
  const WX_STEPS = [
    {
      lead: "第 1 次敲 <code class=\"keystream\">qian'd'l'kuai'q'c</code>，首推仍偏离个人原意",
      items: [
        { text: "1 钱多了快去吃", cls: "is-miss" },
        { text: "2 签到了快起床", cls: "" },
        { text: "3 签到了快去吃", cls: "" },
      ],
      note: "第一次打自造句“签到了快起床”，哪怕多敲声韵母也很容易被通用词频带偏成“钱多了快去吃”。",
    },
    {
      lead: "纠正上屏一次后，第 2 次直接省敲成 <code class=\"keystream\">qian'd'l'k'q'c</code>",
      items: [
        { text: "1 签到了快起床", cls: "is-winner" },
        { text: "2 签订了看清楚", cls: "" },
        { text: "3 签到了", cls: "" },
      ],
      note: "第 2 次把 kuai 缩成单字母 k，输入法仍根据个人上下文直接把“签到了快起床”顶回第 1 位。",
    },
  ];

  const WT_STAGES = [
    {
      title: "STEP 01 · 按键流物理坐标与残缺采样",
      sub: "把每次触击视为二维高斯概率云，不再死等完整四键全拼。",
      cards: [
        { title: "简拼/漏敲编码", body: "同时兼容声母首字母 (wmxqcf)、漏介母 (kai->kuai) 与音节换序。" },
        { title: "2D 键盘坐标距离", body: "基于 QWERTY 键心坐标计算 P(x,y | k) 似然，识别手指顺带误触旁键。" },
        { title: "端侧先验直出", body: "输入越短越不完整，噪声通道得分越依赖用户上下文语言模型打分反超。" },
      ],
    },
    {
      title: "STEP 02 · 模糊音节图与 Prefix Trie 展开",
      sub: "在同一张有向无环图 (DAG) 上并行保留标准音与易混音路径。",
      cards: [
        { title: "全拼/模糊并联", body: "自动扩展平翘舌 (zh=z)、前后鼻音 (eng=en)、n=l 等多条候选路径。" },
        { title: "音节边界无空格切分", body: "不依赖分词空格，动态规划切出每一种合法汉字读音拼接。" },
        { title: "前缀树剪枝", body: "通过汉字读音 Trie 将候选严格压缩在合法汉语拼音边界内部。" },
      ],
    },
    {
      title: "STEP 03 · 多级语言模型重排（「空间换时间」）",
      sub: "用庞大的 L1/L2 存储与计算预算换取毫秒响应——这也是商业软件臃肿与隐私担忧的根源。",
      cards: [
        { title: "L1 本地大词库 (< 5ms)", body: "百兆级别静态词库 + 热词缓存，以「空间换时间」覆盖约 80% 常规命中。" },
        { title: "L2 端侧神经 LM (10~30ms)", body: "几十 MB 量化神经网络对长句与 Top-K 候选做上下文联合打分。" },
        { title: "L3 云端 LLM 异步联想", body: "重度简拼与长上下文异步上传云端补强——隐私输入的最敏感边界。", warn: true },
      ],
    },
    {
      title: "STEP 04 · 重排输出与 Personal-IME 的破局点",
      sub: "结合上下文与按键惩罚联合打分，同时也暴露出商业闭源方案的 3 个硬伤。",
      cards: [
        { title: "公式本质", body: "W* = argmax [ log P_LM(W | Context) + log P_Key(K | W) ]。" },
        { title: "痛点：策略固化难定制", body: "通用词库无法按个人自造句与错拼偏好调整惩罚，越常用越觉得臃肿。", warn: true },
        { title: "破局：Rime + 本地闭环", body: "开源本地化：3 句规则冷启动 + 500 滑窗自切换 + 专属端侧小模型。", warn: false },
      ],
    },
  ];

  const RIME_RULES = [
    { id: "fuzzy_z_zh", label: "z = zh", line: "derive/^z([^h])/zh$1/\n    - derive/^zh/z/" },
    { id: "fuzzy_eng_en", label: "eng = en", line: "derive/([aeiou])ng$/$1n/\n    - derive/([aei])n$/$1ng/" },
    { id: "fuzzy_ong_on", label: "ong = on", line: "derive/ong$/on/" },
    { id: "fuzzy_l_n", label: "l = n", line: "derive/^l/n/\n    - derive/^n/l/" },
    { id: "drop_medial_u", label: "省介母 u", line: "derive/([gkzhcs])u([aeo])/$1$2/" },
    { id: "x_n_v", label: "ju = jv", line: "derive/^([jqxy])u/$1v/" },
  ];

  const BRIDGE_NODES = [
    {
      title: "NODE 01 · 末尾敲 ` 按需触发（rime/lua/ai_filter.lua）",
      desc: "平时 99% 常规打字完全走 Rime + 雾凇拼音原生 0ms 路线。仅当敲击串以反引号 ` 结尾且至少 1 个字母时，截取前 28 个已上屏汉字上下文，唤醒本地模型接管纠错与重度简拼。",
      badges: ["平时 0 额外延迟", "28 字符上下文窗口", "反引号 ` 即按需开关"],
    },
    {
      title: "NODE 02 · Winsock2 非阻塞 C 桥接（ime_bridge.dll）",
      desc: "小狼毫内置 Lua 缺乏原生 Socket 能力且弹出黑框会打断输入。纯 C 编写 Winsock2 客户端，禁用 Nagle 算法（TCP_NODELAY），设置 15ms 非阻塞 connect 与硬超时保护，零黑框卡死风险。",
      badges: ["Winsock2 DLL", "TCP_NODELAY", "15ms 硬超时保护"],
    },
    {
      title: "NODE 03 · 8105 汉字读音 Trie 硬约束（model/ime_server.py）",
      desc: "基于 8105 通用字表为 Qwen3 词表建立拼音前缀树，预计算所有合法汉字读音的容错惩罚边（精确 0.0 / 前缀 0.9 / 换序 2.8 / 缺介母 3.0 / 邻键或蹭键 3.2）。结合 DynamicCache 复用前缀 KV 状态。",
      badges: ["8105 汉字读音约束", "DynamicCache 前缀缓存", "单步 <= 4.5 / 整句 <= 7.0"],
    },
    {
      title: "NODE 04 · 候选首推注入与 0.1ms 无感回落",
      desc: "服务端返回 Top-K 整句直接注入 Rime 首候选并附带 [AI] 轻标记；即使本地推理服务未启动或超 15ms，C 桥接在 0.1ms 内立即静默回退至雾凇原生候选，绝对不卡键盘。",
      badges: ["首推注入", "服务未启 0.1ms 回落", "绝不阻塞打字"],
    },
  ];

  const BUILTIN_CASES = [
    {
      context: "下课了等会儿一起去",
      raw_keys: "wmxqcf",
      base_pred: "1. 我们先去吃饭  2. 为什么去采访",
      user_a_pred: "1. 我明天去吃饭（室友常约次日餐）",
      user_b_pred: "1. 我马上写代码去食堂（A/B 日常句式差异）",
      note: "全声母重度简拼 wmxqcf，通用词库几乎无法猜中；微调后直接结合室友日常高频表达排序。",
    },
    {
      context: "晚上回寝室记得",
      raw_keys: "paoshibnie",
      base_pred: "1. 跑失别（乱码切分）",
      user_a_pred: "1. 泡十遍了（蹭键 n/b 纠偏）",
      user_b_pred: "1. 泡方便面（旁键物理坐标加日常习惯）",
      note: "出现 b/n 物理邻键顺带蹭键，2D 键距惩罚结合个人习惯把真实意图拉回第 1。",
    },
    {
      context: "导员在群里催",
      raw_keys: "qiandlkqc",
      base_pred: "1. 钱多了快去吃  2. 签订了看清楚",
      user_a_pred: "1. 签到了快起床",
      user_b_pred: "1. 签到了快去传",
      note: "同学 A 常打早起签到提醒；同学 B 常交实验报告，相同省键拼写产生完全不同首推。",
    },
    {
      context: "这周进度太慢",
      raw_keys: "zzenmk",
      base_pred: "1. 怎么看",
      user_a_pred: "1. 真怎么快（zh=z + eng=en 双叠加）",
      user_b_pred: "1. 真正模块（高频写代码术语偏好）",
      note: "同时叠加平翘舌与前后鼻音习惯偏差，个性化模型不再依赖通用统计平均。",
    },
    {
      context: "先把这个",
      raw_keys: "gnsxie",
      base_pred: "1. 概念写  2. 给你写",
      user_a_pred: "1. 功能实现（软件工程高频词组）",
      user_b_pred: "1. 观念写下来",
      note: "跨学科/专业语料注入 LoRA 后，专业高频短语权重显著压过通用生活词汇。",
    },
    {
      context: "明天早上记得",
      raw_keys: "dmql",
      base_pred: "1. 打麻去了  2. 点名起了",
      user_a_pred: "1. 点名起来（寝室互喊早八）",
      user_b_pred: "1. 导明起了",
      note: "极短 4 键简拼 dmql 极度依赖个体作息与语境历史分布。",
    },
    {
      context: "这个脚本刚跑",
      raw_keys: "baoco",
      base_pred: "1. 保错  2. 抱错",
      user_a_pred: "1. 报错了（缺 u 声调语癖修正）",
      user_b_pred: "1. 报酬",
      note: "漏敲尾键且存在专业语境差异，微调小模型结合上下文精准消歧。",
    },
    {
      context: "刚才发错群了",
      raw_keys: "chhuai",
      base_pred: "1. 撤回（未命中完整 chehui）",
      user_a_pred: "1. 撤回啊（c/ch + e/u 误触修正）",
      user_b_pred: "1. 出坏了",
      note: "非标准拼音错拼 chhuai 在 8105 Trie 惩罚预算内完成高频纠偏。",
    },
  ];

  // ---------------------------------------------------------------------------
  // Pure-JS QR Code Encoder (Byte Mode, Version 1-6 Auto, ECC-M)
  // ---------------------------------------------------------------------------
  const QR_ALGO = (function () {
    const GF_EXP = new Uint8Array(512);
    const GF_LOG = new Uint8Array(256);
    let x = 1;
    for (let i = 0; i < 255; i += 1) {
      GF_EXP[i] = x;
      GF_LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (let i = 255; i < 512; i += 1) GF_EXP[i] = GF_EXP[i - 255];

    function gfMul(a, b) {
      if (a === 0 || b === 0) return 0;
      return GF_EXP[GF_LOG[a] + GF_LOG[b]];
    }

    function rsGenPoly(ecCount) {
      let poly = [1];
      for (let i = 0; i < ecCount; i += 1) {
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

    function rsCompute(data, ecCount) {
      const gen = rsGenPoly(ecCount);
      const res = new Uint8Array(data.length + ecCount);
      res.set(data, 0);
      for (let i = 0; i < data.length; i += 1) {
        const coef = res[i];
        if (coef !== 0) {
          for (let j = 0; j < gen.length; j += 1) {
            res[i + j] ^= gfMul(gen[j], coef);
          }
        }
      }
      return res.slice(data.length);
    }

    const VERSIONS = [
      { v: 1, totalCodewords: 26, dataCw: 16, ecCw: 10, align: [] },
      { v: 2, totalCodewords: 44, dataCw: 28, ecCw: 16, align: [6, 18] },
      { v: 3, totalCodewords: 70, dataCw: 44, ecCw: 26, align: [6, 22] },
      { v: 4, totalCodewords: 100, dataCw: 64, ecCw: 36, align: [6, 26] },
      { v: 5, totalCodewords: 134, dataCw: 86, ecCw: 48, align: [6, 30] },
      { v: 6, totalCodewords: 172, dataCw: 108, ecCw: 64, align: [6, 34] },
    ];

    function bchFormatInfo(mask) {
      const data = mask & 7; // ECC M = 00
      let rem = data << 10;
      const poly = 0b10100110111;
      for (let bit = 14; bit >= 10; bit -= 1) {
        if ((rem >> bit) & 1) rem ^= poly << (bit - 10);
      }
      return ((data << 10) | rem) ^ 0b101010000010010;
    }

    function encodeBytes(text) {
      const bytes = new TextEncoder().encode(text);
      const ver = VERSIONS.find((v) => v.dataCw >= bytes.length + 2) || VERSIONS[VERSIONS.length - 1];
      const size = ver.v * 4 + 17;

      const bits = [];
      function pushBits(val, len) {
        for (let i = len - 1; i >= 0; i -= 1) bits.push((val >> i) & 1);
      }
      pushBits(0b0100, 4);
      pushBits(bytes.length, 8);
      for (let i = 0; i < bytes.length; i += 1) pushBits(bytes[i], 8);
      pushBits(0, Math.min(4, ver.dataCw * 8 - bits.length));
      while (bits.length % 8 !== 0) bits.push(0);

      const cw = [];
      for (let i = 0; i < bits.length; i += 8) {
        let b = 0;
        for (let j = 0; j < 8; j += 1) b = (b << 1) | bits[i + j];
        cw.push(b);
      }
      let pad = 0;
      while (cw.length < ver.dataCw) {
        cw.push(pad % 2 === 0 ? 0xec : 0x11);
        pad += 1;
      }

      const blocks = ver.v >= 5 ? 2 : 1;
      const bLen = Math.floor(ver.dataCw / blocks);
      const ecPer = Math.floor(ver.ecCw / blocks);
      const allData = [];
      const allEc = [];
      for (let i = 0; i < blocks; i += 1) {
        const part = Uint8Array.from(cw.slice(i * bLen, (i + 1) * bLen));
        allData.push(part);
        allEc.push(rsCompute(part, ecPer));
      }
      const stream = [];
      for (let c = 0; c < bLen; c += 1) {
        for (let b = 0; b < blocks; b += 1) stream.push(allData[b][c]);
      }
      for (let c = 0; c < ecPer; c += 1) {
        for (let b = 0; b < blocks; b += 1) stream.push(allEc[b][c]);
      }

      const grid = Array.from({ length: size }, () => new Int8Array(size).fill(-1));
      const reserved = Array.from({ length: size }, () => new Uint8Array(size));

      function setFinder(r0, c0) {
        for (let dr = -1; dr <= 7; dr += 1) {
          for (let dc = -1; dc <= 7; dc += 1) {
            const r = r0 + dr;
            const c = c0 + dc;
            if (r < 0 || r >= size || c < 0 || c >= size) continue;
            reserved[r][c] = 1;
            const inBox = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
            const onBorder = dr === 0 || dr === 6 || dc === 0 || dc === 6;
            const onCore = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
            grid[r][c] = inBox && (onBorder || onCore) ? 1 : 0;
          }
        }
      }

      setFinder(0, 0);
      setFinder(0, size - 7);
      setFinder(size - 7, 0);

      for (let i = 8; i < size - 8; i += 1) {
        reserved[6][i] = 1;
        grid[6][i] = i % 2 === 0 ? 1 : 0;
        reserved[i][6] = 1;
        grid[i][6] = i % 2 === 0 ? 1 : 0;
      }

      if (ver.align.length >= 2) {
        const cPos = ver.align[1];
        for (let dr = -2; dr <= 2; dr += 1) {
          for (let dc = -2; dc <= 2; dc += 1) {
            const r = cPos + dr;
            const c = cPos + dc;
            reserved[r][c] = 1;
            grid[r][c] = Math.abs(dr) === 2 || Math.abs(dc) === 2 || (dr === 0 && dc === 0) ? 1 : 0;
          }
        }
      }

      reserved[4 * ver.v + 9][8] = 1;
      grid[4 * ver.v + 9][8] = 1;

      for (let i = 0; i <= 8; i += 1) {
        if (i !== 6) {
          reserved[8][i] = 1;
          reserved[i][8] = 1;
        }
      }
      for (let i = size - 8; i < size; i += 1) reserved[8][i] = 1;
      for (let i = size - 7; i < size; i += 1) reserved[i][8] = 1;

      let bitIdx = 0;
      let up = true;
      for (let col = size - 1; col > 0; col -= 2) {
        if (col === 6) col -= 1;
        for (let i = 0; i < size; i += 1) {
          const r = up ? size - 1 - i : i;
          for (let dc = 0; dc < 2; dc += 1) {
            const c = col - dc;
            if (reserved[r][c]) continue;
            const byteIdx = bitIdx >> 3;
            const bit = byteIdx < stream.length ? (stream[byteIdx] >> (7 - (bitIdx & 7))) & 1 : 0;
            bitIdx += 1;
            const mask = (r + c) % 2 === 0 ? 1 : 0;
            grid[r][c] = bit ^ mask;
          }
        }
        up = !up;
      }

      const fmt = bchFormatInfo(0);
      for (let i = 0; i < 15; i += 1) {
        const bit = (fmt >> i) & 1;
        if (i < 6) grid[i][8] = bit;
        else if (i < 8) grid[i + 1][8] = bit;
        else grid[size - 15 + i][8] = bit;

        if (i < 8) grid[8][size - 1 - i] = bit;
        else if (i < 9) grid[8][7] = bit;
        else grid[8][14 - i] = bit;
      }

      return grid;
    }

    function toSvg(text) {
      const m = encodeBytes(text);
      const n = m.length;
      const q = 4;
      const total = n + q * 2;
      let paths = "";
      for (let r = 0; r < n; r += 1) {
        for (let c = 0; c < n; c += 1) {
          if (m[r][c] === 1) paths += `<rect x="${c + q}" y="${r + q}" width="1" height="1" />`;
        }
      }
      return `<svg viewBox="0 0 ${total} ${total}" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges"><rect width="${total}" height="${total}" fill="#ffffff"/><g fill="#141820">${paths}</g></svg>`;
    }

    return { toSvg };
  })();

  // ---------------------------------------------------------------------------
  // State & DOM Refs
  // ---------------------------------------------------------------------------
  const state = {
    currentSlide: 0,
    sidebarVisible: false,
    selectedRules: new Set(["fuzzy_z_zh", "fuzzy_eng_en", "fuzzy_ong_on"]),
    wtStage: 2,
    bridgeNode: 0,
    bpeSingleChar: false,
    kbMode: "adjacent",
    kbTarget: "g",
    cases: BUILTIN_CASES.slice(),
    caseIdx: 0,
    revealStep: 1,
    knownRanks: new Map(),
    pollTimer: null,
    wxReplayTimer: null,
  };

  const dom = {
    shell: document.getElementById("stage-shell"),
    main: document.getElementById("stage-main"),
    stage: document.getElementById("deck-stage"),
    slides: Array.from(document.querySelectorAll(".slide")),
    hudChapter: document.getElementById("hud-chapter-name"),
    slideCounter: document.getElementById("slide-counter"),
    prevSlideBtn: document.getElementById("prev-slide-btn"),
    nextSlideBtn: document.getElementById("next-slide-btn"),
    revealAllBtn: document.getElementById("reveal-all-btn"),
    toggleSidebarBtn: document.getElementById("toggle-sidebar-btn"),
    fullscreenBtn: document.getElementById("fullscreen-btn"),
    sidebar: document.getElementById("stage-right"),
    qrContainer: document.getElementById("qr-container"),
    playUrlText: document.getElementById("play-url-text"),
    copyUrlBtn: document.getElementById("copy-url-btn"),
    copyFeedback: document.getElementById("copy-url-feedback"),
    pollBadge: document.getElementById("poll-status-badge"),
    countBadge: document.getElementById("player-count-badge"),
    commentsBar: document.getElementById("recent-comments-bar"),
    commentsTrack: document.getElementById("recent-comments-track"),
    boardEmpty: document.getElementById("leaderboard-empty"),
    boardList: document.getElementById("leaderboard-list"),
    livePlayers: document.getElementById("live-total-players"),
    liveTopScore: document.getElementById("live-top-score"),
    liveTopRule: document.getElementById("live-top-rule"),
    openResetBtn: document.getElementById("open-reset-btn"),
    resetModal: document.getElementById("reset-modal"),
    closeResetBtn: document.getElementById("close-reset-btn"),
    cancelResetBtn: document.getElementById("cancel-reset-btn"),
    resetForm: document.getElementById("reset-form"),
    adminTokenInput: document.getElementById("admin-token-input"),
    resetErrorMsg: document.getElementById("reset-error-msg"),
  };

  // ---------------------------------------------------------------------------
  // Fixed 1920x1080 Uniform Stage Scaling
  // ---------------------------------------------------------------------------
  function rescaleDeckStage() {
    const rect = dom.main.getBoundingClientRect();
    const availW = Math.max(320, rect.width);
    const availH = Math.max(240, rect.height);
    const scale = Math.min(availW / STAGE_WIDTH, availH / STAGE_HEIGHT);
    const offsetX = (availW - STAGE_WIDTH * scale) / 2;
    const offsetY = (availH - STAGE_HEIGHT * scale) / 2;
    dom.stage.style.transform = `translate3d(${offsetX.toFixed(2)}px, ${offsetY.toFixed(2)}px, 0) scale(${scale.toFixed(5)})`;
  }

  // ---------------------------------------------------------------------------
  // Sidebar Visibility & Slide Navigation
  // ---------------------------------------------------------------------------
  function setSidebarVisible(visible) {
    state.sidebarVisible = Boolean(visible);
    dom.sidebar.hidden = !state.sidebarVisible;
    dom.shell.classList.toggle("is-sidebar-hidden", !state.sidebarVisible);
    dom.toggleSidebarBtn.textContent = state.sidebarVisible ? "隐藏榜单" : "显示榜单";
    requestAnimationFrame(rescaleDeckStage);
  }

  function renderInlineDots() {
    document.querySelectorAll("[data-dots]").forEach((holder) => {
      holder.innerHTML = "";
      dom.slides.forEach((slide, idx) => {
        const dot = document.createElement("button");
        dot.type = "button";
        dot.className = "p-dot" + (idx === state.currentSlide ? " is-active" : "");
        dot.title = slide.dataset.title || `第 ${idx + 1} 页`;
        dot.addEventListener("click", () => goToSlide(idx));
        holder.appendChild(dot);
      });
    });
  }

  function goToSlide(targetIdx) {
    const idx = Math.max(0, Math.min(dom.slides.length - 1, targetIdx));
    const goingBack = idx < state.currentSlide;
    state.currentSlide = idx;

    dom.slides.forEach((slide, i) => {
      slide.classList.toggle("is-active", i === idx);
      slide.classList.toggle("anim-back", goingBack && i !== idx);
    });

    const active = dom.slides[idx];
    dom.hudChapter.textContent = active.dataset.title || `0${idx + 1}`;
    dom.slideCounter.textContent = `${idx + 1} / ${dom.slides.length}`;
    dom.prevSlideBtn.disabled = idx === 0;
    dom.nextSlideBtn.disabled = idx === dom.slides.length - 1;

    if (idx >= INTERACTIVE_SLIDE_INDEX && !state.sidebarVisible) {
      setSidebarVisible(true);
    }
    renderInlineDots();
    updateRevealAllButtonLabel();
  }

  // ---------------------------------------------------------------------------
  // Progressive Element Reveal
  // ---------------------------------------------------------------------------
  function revealElement(el) {
    if (!el) return;
    el.classList.remove("is-veiled");
    el.classList.add("is-revealed");
    updateRevealAllButtonLabel();
  }

  function revealNextInSlide() {
    const slide = dom.slides[state.currentSlide];
    const veiled = Array.from(slide.querySelectorAll("[data-step].is-veiled"));
    if (veiled.length > 0) {
      veiled.sort((a, b) => Number(a.dataset.step) - Number(b.dataset.step));
      revealElement(veiled[0]);
      return true;
    }
    if (state.currentSlide === 8 && state.revealStep < 3) {
      advanceModelReveal();
      return true;
    }
    return false;
  }

  function revealAllInSlide() {
    const slide = dom.slides[state.currentSlide];
    slide.querySelectorAll("[data-step].is-veiled").forEach(revealElement);
    if (state.currentSlide === 8) {
      state.revealStep = 3;
      applyModelRevealState();
    }
    updateRevealAllButtonLabel();
  }

  function updateRevealAllButtonLabel() {
    const slide = dom.slides[state.currentSlide];
    const hasVeil = slide.querySelectorAll("[data-step].is-veiled").length > 0;
    const hasConceal = state.currentSlide === 8 && state.revealStep < 3;
    dom.revealAllBtn.textContent = hasVeil || hasConceal ? "展开本页" : "已全展开";
  }

  // ---------------------------------------------------------------------------
  // Slide-Specific Interactive Controls
  // ---------------------------------------------------------------------------
  function initSlide1() {
    const tabs = document.querySelectorAll(".wx-step-tab");
    const box = document.getElementById("wx-step-display");
    tabs.forEach((btn) => {
      btn.addEventListener("click", () => {
        const step = Number(btn.dataset.wxStep || 0);
        tabs.forEach((b) => b.classList.toggle("is-active", b === btn));
        const item = WX_STEPS[step] || WX_STEPS[0];
        box.innerHTML = `
          <div class="demo-lead">${item.lead}</div>
          <div class="ime-strip">${item.items.map((it) => `<span class="ime-item ${it.cls}">${escapeHtml(it.text)}</span>`).join("")}</div>
          <div class="demo-note">${escapeHtml(item.note)}</div>
        `;
      });
    });

    const replayBtn = document.getElementById("wx-replay-btn");
    const keysEl = document.getElementById("wx-case1-keys");
    replayBtn.addEventListener("click", () => {
      if (state.wxReplayTimer) clearInterval(state.wxReplayTimer);
      const target = "ni'ge'c'l'l";
      let pos = 1;
      keysEl.textContent = target.slice(0, pos);
      state.wxReplayTimer = setInterval(() => {
        pos += 1;
        keysEl.textContent = target.slice(0, pos);
        if (pos >= target.length) {
          clearInterval(state.wxReplayTimer);
          state.wxReplayTimer = null;
        }
      }, 95);
    });
  }

  function renderWtStage(idx) {
    state.wtStage = idx;
    document.querySelectorAll("#wt-stage-bar .wt-node").forEach((b) => {
      b.classList.toggle("is-active", Number(b.dataset.wt) === idx);
    });
    document.querySelectorAll(".svg-stage").forEach((g) => {
      g.classList.toggle("is-active", Number(g.dataset.wtTarget) === idx);
    });
    const d = WT_STAGES[idx] || WT_STAGES[0];
    document.getElementById("wt-detail-stage").innerHTML = `
      <div class="wt-detail-head">
        <h3>${escapeHtml(d.title)}</h3>
        <span class="tag tag-dark">交互钻取 ${idx + 1} / 4</span>
      </div>
      <p class="wt-detail-sub">${escapeHtml(d.sub)}</p>
      <div class="wt-cards-3">
        ${d.cards
          .map(
            (c) => `
          <div class="wt-mini-tile ${c.warn ? "is-warn" : ""}">
            <b>${escapeHtml(c.title)}</b>
            <p>${escapeHtml(c.body)}</p>
          </div>`
          )
          .join("")}
      </div>
    `;
  }

  function initSlide2() {
    document.querySelectorAll("#wt-stage-bar .wt-node").forEach((btn) => {
      btn.addEventListener("click", () => renderWtStage(Number(btn.dataset.wt)));
    });
    document.querySelectorAll(".svg-stage").forEach((g) => {
      g.addEventListener("click", () => {
        revealElement(document.querySelector("#slide-2 [data-step='1']"));
        renderWtStage(Number(g.dataset.wtTarget));
      });
    });
    renderWtStage(2);
  }

  function initSlide4() {
    const chips = document.getElementById("rule-chip-group");
    const pre = document.getElementById("rime-yaml-preview");

    function renderYaml() {
      const selected = RIME_RULES.filter((r) => state.selectedRules.has(r.id));
      const lines = selected.length
        ? selected.map((r) => `    - ${r.line}  # ${r.id}`).join("\n")
        : "    # 请至少勾选一条个性化模糊音规则";
      pre.textContent =
        "patch:\n" +
        "  # BEGIN PERSONAL-IME AUTO RULES (白名单受控输出)\n" +
        "  speller/algebra/+:\n" +
        lines +
        "\n  # END PERSONAL-IME AUTO RULES";
    }

    RIME_RULES.forEach((rule) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "rule-chip" + (state.selectedRules.has(rule.id) ? " is-selected" : "");
      btn.textContent = rule.label;
      btn.addEventListener("click", () => {
        if (state.selectedRules.has(rule.id)) state.selectedRules.delete(rule.id);
        else state.selectedRules.add(rule.id);
        btn.classList.toggle("is-selected", state.selectedRules.has(rule.id));
        renderYaml();
      });
      chips.appendChild(btn);
    });
    renderYaml();
  }

  function initSlide6() {
    const slider = document.getElementById("hyst-slider");
    const rateVal = document.getElementById("hyst-rate-val");
    const stateBadge = document.getElementById("hyst-state-badge");
    const preview = document.getElementById("hyst-comment-preview");
    const cursorGroup = document.getElementById("hyst-cursor-group");
    const cursorDot = document.getElementById("hyst-cursor-dot");
    const presets = document.querySelectorAll(".preset-rate-btn");

    function updateRate(val) {
      const rate = Math.max(0, Math.min(30, Number(val)));
      slider.value = String(rate);
      rateVal.textContent = `当前样本触发率：${rate}%`;

      // Map 0..30% to x=60..820, matching 5% at x=190 and 15% at x=440
      let xPos;
      if (rate <= 5) xPos = 60 + (rate / 5) * 130;
      else if (rate <= 15) xPos = 190 + ((rate - 5) / 10) * 250;
      else xPos = 440 + ((rate - 15) / 15) * 380;

      const isOn = rate >= 15;
      const isOff = rate < 5;
      const dotY = isOn ? 112 : 214;
      const dotColor = isOn ? "#1D4ED8" : isOff ? "#64748B" : "#D97706";

      cursorGroup.setAttribute("transform", `translate(${xPos.toFixed(1)}, 0)`);
      cursorDot.setAttribute("cy", String(dotY));
      cursorDot.setAttribute("fill", dotColor);

      if (isOn) {
        stateBadge.textContent = "状态：自动开启 ON (>= 15%)";
        stateBadge.className = "ime-item is-winner";
        preview.textContent = "rule_notify.lua：写入 algebra 补丁并在首候选尾缀提示 [已为你自动开启 ong=on] (3 次即静默)";
      } else if (isOff) {
        stateBadge.textContent = "状态：自动休眠 OFF (< 5%)";
        stateBadge.className = "ime-item is-miss";
        preview.textContent = "触发率低于 5%，自动回收并清理对应补丁，避免脏规则污染正常输入";
      } else {
        stateBadge.textContent = "状态：迟滞防抖带 (5% ~ 15%)";
        stateBadge.className = "ime-item";
        preview.textContent = "维持此前已启用或休眠状态，避免用户换键盘或偶发波动引发反复抖动";
      }

      presets.forEach((b) => b.classList.toggle("is-active", Number(b.dataset.rate) === rate));
    }

    slider.addEventListener("input", () => updateRate(slider.value));
    presets.forEach((btn) => btn.addEventListener("click", () => updateRate(btn.dataset.rate)));
    updateRate(8);
  }

  function initSlide7() {
    const toggleBtn = document.getElementById("bpe-toggle-btn");
    const badEl = document.getElementById("bpe-mode-bad");
    const goodEl = document.getElementById("bpe-mode-good");
    toggleBtn.addEventListener("click", () => {
      state.bpeSingleChar = !state.bpeSingleChar;
      badEl.classList.toggle("is-dimmed", state.bpeSingleChar);
      goodEl.hidden = !state.bpeSingleChar;
      toggleBtn.textContent = state.bpeSingleChar ? "收起对比" : "切换至单字逐键切分";
    });

    const ROWS = [
      ["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"],
      ["a", "s", "d", "f", "g", "h", "j", "k", "l"],
      ["z", "x", "c", "v", "b", "n", "m"],
    ];
    const NEIGHBORS = {
      g: { f: "0.82", h: "0.82", t: "0.54", b: "0.49", v: "0.49" },
      n: { b: "0.82", m: "0.82", h: "0.54", j: "0.54" },
      q: { w: "0.82", a: "0.54" },
      w: { q: "0.82", e: "0.82", s: "0.54", a: "0.49" },
    };
    const ABBR_SET = new Set(["w", "m", "x", "q", "c", "f"]);

    const kbWrap = document.getElementById("qwerty-heatmap");
    const caption = document.getElementById("kb-sim-caption");
    const noteStrip = document.getElementById("kb-formula-note");
    const kbBtns = document.querySelectorAll(".kb-mode-btn");

    function renderKeyboard() {
      const target = state.kbTarget;
      const nearMap = NEIGHBORS[target] || NEIGHBORS.g;
      kbWrap.innerHTML = ROWS.map(
        (row, rIdx) =>
          `<div class="kb-row r-${rIdx + 1}">${row
            .map((ch) => {
              let cls = "kb-key";
              let sub = "&nbsp;";
              if (state.kbMode === "adjacent") {
                if (ch === target) {
                  cls += " is-target";
                  sub = "1.00";
                } else if (nearMap[ch]) {
                  cls += " is-near";
                  sub = nearMap[ch];
                }
              } else if (state.kbMode === "abbr") {
                if (ABBR_SET.has(ch)) {
                  cls += " is-abbr";
                  sub = "简拼";
                }
              } else if (state.kbMode === "jieba") {
                if (["w", "m", "x"].includes(ch)) {
                  cls += " is-target";
                  sub = "保留";
                } else if (["o", "e", "i"].includes(ch)) {
                  cls += " is-near";
                  sub = "省略";
                }
              }
              return `<button type="button" class="${cls}" data-kchar="${ch}">${ch.toUpperCase()}<small>${sub}</small></button>`;
            })
            .join("")}</div>`
      ).join("");

      kbWrap.querySelectorAll(".kb-key").forEach((kbtn) => {
        kbtn.addEventListener("click", () => {
          const k = kbtn.dataset.kchar;
          state.kbMode = "adjacent";
          state.kbTarget = NEIGHBORS[k] ? k : "g";
          kbBtns.forEach((b) => b.classList.toggle("is-active", b.dataset.kb === "adjacent"));
          renderKeyboard();
        });
      });

      if (state.kbMode === "adjacent") {
        caption.textContent = `当前聚焦键 ${target.toUpperCase()}：周围邻键按 1/dist^2 分配蹭键概率`;
        noteStrip.innerHTML = `<span class="ime-item is-winner">目标键 ${target} -> 物理旁键距离惩罚</span><span class="ime-item">复现如 paoshibnie 中的 b/n 顺带蹭键</span>`;
      } else if (state.kbMode === "abbr") {
        caption.textContent = "整句首字母简拼采样：6 字保留 6 键 (wmxqcf -> 我们先去吃饭)";
        noteStrip.innerHTML = `<span class="ime-item is-winner">21 种声韵母缩写比例直接由日志估算</span><span class="ime-item">让端侧模型吃透极端省键风格</span>`;
      } else {
        caption.textContent = "基于 jieba 词级采样：整词整段丢弃韵母（wo men xian -> w m x）";
        noteStrip.innerHTML = `<span class="ime-item is-winner">word-level 丢音节模拟，非逐字随机删键</span><span class="ime-item">贴合真实中文连拼手癖</span>`;
      }
    }

    kbBtns.forEach((b) =>
      b.addEventListener("click", () => {
        state.kbMode = b.dataset.kb;
        kbBtns.forEach((x) => x.classList.toggle("is-active", x === b));
        renderKeyboard();
      })
    );
    renderKeyboard();
  }

  function initSlide8() {
    function renderBridge(idx) {
      state.bridgeNode = idx;
      document.querySelectorAll("#bridge-node-bar .p4-node").forEach((b) => {
        b.classList.toggle("is-active", Number(b.dataset.bridge) === idx);
      });
      const item = BRIDGE_NODES[idx] || BRIDGE_NODES[0];
      document.getElementById("bridge-detail-box").innerHTML = `
        <div>
          <h3>${escapeHtml(item.title)}</h3>
          <p>${escapeHtml(item.desc)}</p>
        </div>
        <div class="badge-row">
          ${item.badges.map((b) => `<span class="tag tag-blue">${escapeHtml(b)}</span>`).join("")}
        </div>
      `;
    }

    document.querySelectorAll("#bridge-node-bar .p4-node").forEach((btn) => {
      btn.addEventListener("click", () => {
        revealElement(document.querySelector("#slide-8 [data-step='1']"));
        renderBridge(Number(btn.dataset.bridge));
      });
    });
    renderBridge(0);
  }

  function applyModelRevealState() {
    const cols = document.querySelectorAll("#case-compare-grid .cmp-col");
    cols.forEach((col, i) => {
      col.classList.toggle("is-concealed", i >= state.revealStep);
    });
    const btn = document.getElementById("reveal-models-btn");
    if (btn) {
      btn.textContent = state.revealStep >= 3 ? "已全部揭晓（重置）" : "逐个揭晓 A/B 结果";
    }
    updateRevealAllButtonLabel();
  }

  function advanceModelReveal() {
    state.revealStep = state.revealStep >= 3 ? 1 : state.revealStep + 1;
    applyModelRevealState();
  }

  function renderCase(idx) {
    state.caseIdx = (idx + state.cases.length) % state.cases.length;
    const c = state.cases[state.caseIdx];
    document.getElementById("case-context-val").textContent = c.context;
    document.getElementById("case-keys-val").textContent = c.raw_keys;
    document.getElementById("case-note-val").textContent = c.note || "";
    document.getElementById("case-base-pred").textContent = c.base_pred;
    document.getElementById("case-ua-pred").textContent = c.user_a_pred;
    document.getElementById("case-ub-pred").textContent = c.user_b_pred;

    document.querySelectorAll("#case-pills .case-tab").forEach((b, i) => {
      b.classList.toggle("is-active", i === state.caseIdx);
    });
    document.querySelectorAll("#s9-mini-strip .mini-case-card").forEach((m, i) => {
      m.classList.toggle("is-active", i === state.caseIdx);
    });
  }

  function rebuildCasePills() {
    const strip = document.getElementById("case-pills");
    const miniStrip = document.getElementById("s9-mini-strip");
    strip.innerHTML = state.cases
      .map((c, i) => `<button type="button" class="case-tab ${i === state.caseIdx ? "is-active" : ""}" data-cidx="${i}">#${i + 1} ${escapeHtml(c.raw_keys)}</button>`)
      .join("");
    miniStrip.innerHTML = state.cases
      .slice(0, 4)
      .map((c, i) => `<div class="mini-case-card ${i === state.caseIdx ? "is-active" : ""}" data-cidx="${i}"><b>${escapeHtml(c.raw_keys)}</b><span>${escapeHtml(c.context)}</span></div>`)
      .join("");

    strip.querySelectorAll(".case-tab").forEach((b) => b.addEventListener("click", () => renderCase(Number(b.dataset.cidx))));
    miniStrip.querySelectorAll(".mini-case-card").forEach((m) => m.addEventListener("click", () => renderCase(Number(m.dataset.cidx))));
    renderCase(0);
  }

  function initSlide9() {
    document.getElementById("case-prev-btn").addEventListener("click", () => renderCase(state.caseIdx - 1));
    document.getElementById("case-next-btn").addEventListener("click", () => renderCase(state.caseIdx + 1));
    document.getElementById("reveal-models-btn").addEventListener("click", advanceModelReveal);
    document.querySelectorAll("#case-compare-grid .cmp-col").forEach((col, i) => {
      col.addEventListener("click", () => {
        if (state.revealStep <= i) {
          state.revealStep = i + 1;
          applyModelRevealState();
        }
      });
    });

    const fileInput = document.getElementById("cases-file-input");
    const sourcePill = document.getElementById("cases-source-pill");
    fileInput.addEventListener("change", () => {
      const f = fileInput.files && fileInput.files[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const parsed = JSON.parse(String(reader.result));
          const list = Array.isArray(parsed) ? parsed : parsed.cases;
          if (Array.isArray(list) && list.length > 0) {
            state.cases = list;
            sourcePill.textContent = `已载入：${f.name} (${list.length} 条)`;
            rebuildCasePills();
          }
        } catch (_err) {
          sourcePill.textContent = "JSON 格式无效，保留内置对照";
        }
      };
      reader.readAsText(f, "utf-8");
    });

    const params = new URLSearchParams(window.location.search);
    const extUrl = params.get("cases");
    if (extUrl) {
      fetch(extUrl)
        .then((r) => (r.ok ? r.json() : null))
        .then((parsed) => {
          const list = Array.isArray(parsed) ? parsed : parsed && parsed.cases;
          if (Array.isArray(list) && list.length > 0) {
            state.cases = list;
            sourcePill.textContent = `外链对照集 (${list.length} 条)`;
            rebuildCasePills();
          }
        })
        .catch(() => {});
    }

    rebuildCasePills();
    applyModelRevealState();
  }

  // ---------------------------------------------------------------------------
  // Live Right Panel: QR + /api/leaderboard Polling + Slide 5 KPI Mirror + Reset
  // ---------------------------------------------------------------------------
  function initQrAndClipboard() {
    const playUrl = `${window.location.origin}/play`;
    dom.playUrlText.textContent = playUrl;
    dom.qrContainer.innerHTML = QR_ALGO.toSvg(playUrl);
    dom.copyUrlBtn.addEventListener("click", () => {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard
          .writeText(playUrl)
          .then(() => {
            dom.copyFeedback.textContent = "已复制链接";
          })
          .catch(() => {
            dom.copyFeedback.textContent = playUrl;
          });
      }
    });
  }

  function renderLeaderboard(payload) {
    const entries = Array.isArray(payload.leaderboard) ? payload.leaderboard : [];
    const comments = Array.isArray(payload.recent_comments) ? payload.recent_comments : [];
    const totalCount = Number.isFinite(payload.total)
      ? payload.total
      : Number.isFinite(payload.total_count)
      ? payload.total_count
      : entries.length;

    dom.countBadge.textContent = `${totalCount} 人完赛`;
    dom.pollBadge.textContent = "2s 同步中";
    dom.pollBadge.classList.remove("is-error");

    // Mirror real-time KPI onto Slide 5
    if (dom.livePlayers) dom.livePlayers.textContent = String(totalCount);
    if (dom.liveTopScore) {
      const topScore = entries.length ? Number(entries[0].score ?? entries[0].composite_score ?? 0) : 0;
      dom.liveTopScore.textContent = topScore.toFixed(1);
    }
    if (dom.liveTopRule) {
      const counts = new Map();
      entries.forEach((row) => {
        const list = row.rules || row.detected_rules || [];
        list.forEach((r) => counts.set(r, (counts.get(r) || 0) + 1));
      });
      let bestRule = "--";
      let bestCnt = 0;
      counts.forEach((cnt, r) => {
        if (cnt > bestCnt) {
          bestCnt = cnt;
          bestRule = r;
        }
      });
      dom.liveTopRule.textContent = bestRule;
    }

    if (comments.length > 0) {
      dom.commentsBar.hidden = false;
      dom.commentsTrack.innerHTML = comments
        .map((c) => {
          const text = c.comment || c.style_label || c.title || "";
          return `<span class="comment-chip"><strong>${escapeHtml(c.nickname)}</strong>：${escapeHtml(text)}</span>`;
        })
        .join("");
    } else {
      dom.commentsBar.hidden = true;
    }

    if (entries.length === 0) {
      dom.boardEmpty.hidden = false;
      dom.boardList.hidden = true;
      dom.boardList.innerHTML = "";
      state.knownRanks.clear();
      return;
    }

    dom.boardEmpty.hidden = true;
    dom.boardList.hidden = false;

    const nextKnown = new Map();
    const html = entries
      .map((entry, idx) => {
        const rank = idx + 1;
        const id = entry.id || `${entry.nickname}-${idx}`;
        const prev = state.knownRanks.get(id);
        const isNew = prev === undefined || prev !== rank;
        nextKnown.set(id, rank);

        const rankClass = rank <= 3 ? ` rank-${rank}` : "";
        const ruleList = entry.rules || entry.detected_rules || [];
        const tags = ruleList
          .slice(0, 3)
          .map((t) => `<span class="lb-rule-tag">${escapeHtml(t)}</span>`)
          .join("");
        const scoreVal = Number(entry.score ?? entry.composite_score ?? 0).toFixed(1);
        const titleLabel = entry.title || entry.style_label || "";
        return `
          <li class="lb-row${rankClass}${isNew && state.knownRanks.size > 0 ? " is-new" : ""}">
            <div class="lb-rank">${rank}</div>
            <div>
              <div class="lb-name-line">
                <span class="lb-nick">${escapeHtml(entry.nickname || "匿名")}</span>
                <span class="lb-style">${escapeHtml(titleLabel)}</span>
              </div>
              <div class="lb-tags">${tags}</div>
            </div>
            <div class="lb-score-col">
              <div class="lb-score">${scoreVal} 分</div>
              <div class="lb-sub">${Math.round(entry.cpm || 0)} 键/分 · ${Number(entry.accuracy || 0).toFixed(1)}%</div>
            </div>
          </li>
        `;
      })
      .join("");
    state.knownRanks = nextKnown;
    dom.boardList.innerHTML = html;
  }

  function pollLeaderboard() {
    fetch("/api/leaderboard?limit=30")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(renderLeaderboard)
      .catch(() => {
        dom.pollBadge.textContent = "等待重连";
        dom.pollBadge.classList.add("is-error");
      });
  }

  function initResetModal() {
    function openModal() {
      dom.resetModal.hidden = false;
      dom.resetErrorMsg.hidden = true;
      dom.adminTokenInput.value = "";
      setTimeout(() => dom.adminTokenInput.focus(), 40);
    }
    function closeModal() {
      dom.resetModal.hidden = true;
    }

    dom.openResetBtn.addEventListener("click", openModal);
    dom.closeResetBtn.addEventListener("click", closeModal);
    dom.cancelResetBtn.addEventListener("click", closeModal);
    dom.resetModal.addEventListener("click", (e) => {
      if (e.target === dom.resetModal) closeModal();
    });

    dom.resetForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const token = dom.adminTokenInput.value.trim();
      fetch("/api/reset", {
        method: "POST",
        headers: { "X-Admin-Token": token },
      })
        .then(async (r) => {
          if (!r.ok) {
            const err = await r.json().catch(() => ({}));
            throw new Error(err.detail || `清空失败 (${r.status})`);
          }
          return r.json();
        })
        .then(() => {
          closeModal();
          pollLeaderboard();
        })
        .catch((err) => {
          dom.resetErrorMsg.textContent = err.message;
          dom.resetErrorMsg.hidden = false;
        });
    });
  }

  // ---------------------------------------------------------------------------
  // Utilities & Global Listeners
  // ---------------------------------------------------------------------------
  function escapeHtml(s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function initGlobalEvents() {
    window.addEventListener("resize", rescaleDeckStage);

    dom.prevSlideBtn.addEventListener("click", () => goToSlide(state.currentSlide - 1));
    dom.nextSlideBtn.addEventListener("click", () => goToSlide(state.currentSlide + 1));
    dom.revealAllBtn.addEventListener("click", revealAllInSlide);
    dom.toggleSidebarBtn.addEventListener("click", () => setSidebarVisible(!state.sidebarVisible));

    dom.fullscreenBtn.addEventListener("click", () => {
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(() => {});
      } else {
        document.exitFullscreen().catch(() => {});
      }
    });

    document.querySelectorAll("[data-goto]").forEach((btn) => {
      btn.addEventListener("click", () => goToSlide(Number(btn.dataset.goto)));
    });

    document.querySelectorAll("[data-step]").forEach((node) => {
      node.addEventListener("click", () => {
        if (node.classList.contains("is-veiled")) revealElement(node);
      });
    });

    document.addEventListener("keydown", (e) => {
      if (!dom.resetModal.hidden) {
        if (e.key === "Escape") dom.resetModal.hidden = true;
        return;
      }
      if (["INPUT", "TEXTAREA"].includes(document.activeElement && document.activeElement.tagName)) return;

      if (e.key === "ArrowRight" || e.key === "PageDown") {
        e.preventDefault();
        goToSlide(state.currentSlide + 1);
      } else if (e.key === "ArrowLeft" || e.key === "PageUp") {
        e.preventDefault();
        goToSlide(state.currentSlide - 1);
      } else if (e.key === " ") {
        e.preventDefault();
        if (!revealNextInSlide()) goToSlide(state.currentSlide + 1);
      } else if (e.key === "b" || e.key === "B") {
        setSidebarVisible(!state.sidebarVisible);
      } else if (e.key === "f" || e.key === "F") {
        dom.fullscreenBtn.click();
      }
    });
  }

  // Boot
  initSlide1();
  initSlide2();
  initSlide4();
  initSlide6();
  initSlide7();
  initSlide8();
  initSlide9();
  initQrAndClipboard();
  initResetModal();
  initGlobalEvents();

  goToSlide(0);
  rescaleDeckStage();
  pollLeaderboard();
  state.pollTimer = setInterval(pollLeaderboard, POLL_INTERVAL_MS);
})();
