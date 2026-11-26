(function () {
  "use strict";

  const STAGE_WIDTH = 1920;
  const STAGE_HEIGHT = 1080;
  const POLL_INTERVAL_MS = 2000;
  const INTERACTIVE_MOD_INDEX = 4; // Auto-open right sidebar at Module 05

  // ---------------------------------------------------------------------------
  // Content Data
  // ---------------------------------------------------------------------------
  const WX_STEPS = [
    {
      keys: "qian'd'l'kuai'q'c",
      cands: [
        { rank: 1, text: "钱多了快去吃", note: "第 1 次打全仍偏离", cls: "is-miss" },
        { rank: 2, text: "签到了快起床", note: "屈居第 2", cls: "" },
        { rank: 3, text: "签到了快去吃", note: "", cls: "" },
      ],
      caption:
        "对自造句第一次打效果往往不如意；一旦纠正上屏，第二次即便省敲成 qian'd'l'k'q'c 也能靠上下文预测推到第一。",
    },
    {
      keys: "qian'd'l'k'q'c",
      cands: [
        { rank: 1, text: "签到了快起床", note: "省掉 uai 仍直接跃迁首选", cls: "is-winner anim-rank-pop" },
        { rank: 2, text: "签订了看清楚", note: "", cls: "" },
        { rank: 3, text: "签到了", note: "", cls: "" },
      ],
      caption:
        "纠正上屏一次后，第 2 次直接省敲成 single-letter k，仍依据个人上下文把「签到了快起床」推回第 1 位。",
    },
  ];

  const WT_STAGES = [
    [
      { title: "简拼 / 漏敲兼容", body: "同时兼容首字母简拼 (wmxqcf)、漏介母 (kai->kuai) 与音节换序。" },
      { title: "2D 键盘坐标分布", body: "以二维高斯 P(x,y|k) 度量物理点击位置，容错手指误触旁键。" },
      { title: "上下文先验反超", body: "输入越省键、物理残缺越多，越依赖个人历史语境概率翻盘。" },
    ],
    [
      { title: "模糊路径并联", body: "在同一张有向无环图 (DAG) 中并行展开标准音与易混音路径。" },
      { title: "无空格音节切分", body: "不依赖分词空格，动态规划切出每一种合法汉字读音序列。" },
      { title: "前缀 Trie 收敛", body: "用汉字读音 Trie 裁掉非法字母组合，收束计算图宽度。" },
    ],
    [
      { title: "L1 本地大词库 (< 5ms)", body: "百兆静态大词库「空间换时间」，命中约 80% 常规高频输入。" },
      { title: "L2 端侧神经 LM (10~30ms)", body: "几十 MB 量化神经网络结合上下文对 Top-K 做语义联合重排。" },
      { title: "L3 云端大模型补强", body: "重度简拼与长上下文异步上传云端补全——输入隐私最敏感的边界。", warn: true },
    ],
    [
      { title: "公式统一本质", body: "W* = argmax [ log P_LM(W|Ctx) + log P_Key(K|W) ]。" },
      { title: "策略固化与体积代价", body: "通用大词库占用沉重，也无法面向单个人的冷门造句长期私密定制。", warn: true },
      { title: "Personal-IME 破局", body: "全本地开源闭环：3 句规则冷启动 + 500 滑窗自切换 + 端侧小模型。" },
    ],
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
      desc: "平时 99% 常规打字完全走 Rime + 雾凇原生 0ms 路线。只有敲击串以反引号 ` 结尾且至少 1 个字母时，提取前 28 个已上屏汉字上下文，唤醒本地小模型。",
      badges: ["平时 0 额外延迟", "28 字符上下文窗口", "反引号 ` 按需唤醒"],
    },
    {
      title: "NODE 02 · Winsock2 非阻塞 C 桥接（ime_bridge.dll）",
      desc: "纯 C 编写 Winsock2 客户端，禁用 Nagle 算法（TCP_NODELAY），设置 15ms 非阻塞 connect 与硬超时保护，零黑框弹出且绝不卡顿。",
      badges: ["Winsock2 DLL", "TCP_NODELAY", "15ms 硬超时保护"],
    },
    {
      title: "NODE 03 · 8105 汉字读音 Trie 硬约束（model/ime_server.py）",
      desc: "按 8105 字表对 Qwen3 词表建前缀树，精确 0.0 / 前缀 0.9 / 换序 2.8 / 缺介母 3.0 / 邻键蹭键 3.2，配合 DynamicCache 复用前缀 KV。",
      badges: ["8105 汉字读音硬锁", "DynamicCache 前缀缓存", "单步 <= 4.5 / 整句 <= 7.0"],
    },
    {
      title: "NODE 04 · 首推注入与 0.1ms 无感回落",
      desc: "服务端 Top-K 结果直接注入首选并附带 [AI] 轻标注；若服务未启或超时，C 桥接在 0.1ms 内静默回落雾凇原生候选。",
      badges: ["首选直接注入", "0.1ms 无感回落", "绝不卡死输入法"],
    },
  ];

  const BUILTIN_CASES = [
    {
      context: "下课了等会儿一起去",
      raw_keys: "wmxqcf",
      base_pred: "1. 我们先去吃饭  2. 为什么去采访",
      user_a_pred: "1. 我明天去吃饭（室友常约次日餐）",
      user_b_pred: "1. 我马上写代码去食堂（A/B 习惯差异）",
      note: "全声母重度简拼 wmxqcf，通用词库几乎无法猜中；微调后直接结合室友日常高频表达排序。",
    },
    {
      context: "晚上回寝室记得",
      raw_keys: "paoshibnie",
      base_pred: "1. 跑失别（乱码切分）",
      user_a_pred: "1. 泡十遍了（蹭键 b/n 纠偏）",
      user_b_pred: "1. 泡方便面（旁键物理坐标加日常习惯）",
      note: "出现 b/n 物理邻键顺带蹭键，2D 键距惩罚结合个人习惯把真实意图拉回第 1。",
    },
    {
      context: "导员在群里催",
      raw_keys: "qiandlkqc",
      base_pred: "1. 钱多了快去吃  2. 签订了看清楚",
      user_a_pred: "1. 签到了快起床",
      user_b_pred: "1. 签到了快去传",
      note: "同学 A 常打早起签到提醒；同学 B 常交实验报告，相同省键输入分化出完全不同首选。",
    },
    {
      context: "这周进度太慢",
      raw_keys: "zzenmk",
      base_pred: "1. 怎么看",
      user_a_pred: "1. 真怎么快（zh=z + eng=en 双叠加）",
      user_b_pred: "1. 真正模块（高频写代码术语偏好）",
      note: "同时叠加平翘舌与前后鼻音习惯偏差。",
    },
    {
      context: "先把这个",
      raw_keys: "gnsxie",
      base_pred: "1. 概念写  2. 给你写",
      user_a_pred: "1. 功能实现（专业高频短语）",
      user_b_pred: "1. 观念写下来",
      note: "跨专业语料微调后，专业词组显著压过通用生活词。",
    },
    {
      context: "明天早上记得",
      raw_keys: "dmql",
      base_pred: "1. 打麻去了  2. 点名起了",
      user_a_pred: "1. 点名起来（寝室互喊早八）",
      user_b_pred: "1. 导明起了",
      note: "极短 4 键简拼 dmql 极度依赖个体作息分布。",
    },
    {
      context: "这个脚本刚跑",
      raw_keys: "baoco",
      base_pred: "1. 保错  2. 抱错",
      user_a_pred: "1. 报错了（缺 u 声调语癖修正）",
      user_b_pred: "1. 报酬",
      note: "漏敲尾键叠加专业上下文消歧。",
    },
    {
      context: "刚才发错群了",
      raw_keys: "chhuai",
      base_pred: "1. 撤回（未命中完整 chehui）",
      user_a_pred: "1. 撤回啊（c/ch + e/u 误触修正）",
      user_b_pred: "1. 出坏了",
      note: "非标准错拼在 8105 Trie 惩罚预算内实现纠偏。",
    },
  ];

  // ---------------------------------------------------------------------------
  // Pure-JS QR Encoder
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

    const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : GF_EXP[GF_LOG[a] + GF_LOG[b]]);

    function rsCompute(data, ecCount) {
      let poly = [1];
      for (let i = 0; i < ecCount; i += 1) {
        const next = new Array(poly.length + 1).fill(0);
        for (let j = 0; j < poly.length; j += 1) {
          next[j] ^= poly[j];
          next[j + 1] ^= gfMul(poly[j], GF_EXP[i]);
        }
        poly = next;
      }
      const res = new Uint8Array(data.length + ecCount);
      res.set(data, 0);
      for (let i = 0; i < data.length; i += 1) {
        const c = res[i];
        if (c !== 0) for (let j = 0; j < poly.length; j += 1) res[i + j] ^= gfMul(poly[j], c);
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
      const data = mask & 7;
      let rem = data << 10;
      const poly = 0b10100110111;
      for (let b = 14; b >= 10; b -= 1) if ((rem >> b) & 1) rem ^= poly << (b - 10);
      return ((data << 10) | rem) ^ 0b101010000010010;
    }

    function encodeBytes(text) {
      const bytes = new TextEncoder().encode(text);
      const ver = VERSIONS.find((v) => v.dataCw >= bytes.length + 2) || VERSIONS[VERSIONS.length - 1];
      const size = ver.v * 4 + 17;
      const bits = [];
      const push = (val, len) => {
        for (let i = len - 1; i >= 0; i -= 1) bits.push((val >> i) & 1);
      };
      push(0b0100, 4);
      push(bytes.length, 8);
      for (let i = 0; i < bytes.length; i += 1) push(bytes[i], 8);
      push(0, Math.min(4, ver.dataCw * 8 - bits.length));
      while (bits.length % 8 !== 0) bits.push(0);

      const cw = [];
      for (let i = 0; i < bits.length; i += 8) {
        let b = 0;
        for (let j = 0; j < 8; j += 1) b = (b << 1) | bits[i + j];
        cw.push(b);
      }
      for (let p = 0; cw.length < ver.dataCw; p += 1) cw.push(p % 2 === 0 ? 0xec : 0x11);

      const blocks = ver.v >= 5 ? 2 : 1;
      const bLen = Math.floor(ver.dataCw / blocks);
      const ecPer = Math.floor(ver.ecCw / blocks);
      const dBlocks = [];
      const eBlocks = [];
      for (let i = 0; i < blocks; i += 1) {
        const part = Uint8Array.from(cw.slice(i * bLen, (i + 1) * bLen));
        dBlocks.push(part);
        eBlocks.push(rsCompute(part, ecPer));
      }
      const stream = [];
      for (let c = 0; c < bLen; c += 1) for (let b = 0; b < blocks; b += 1) stream.push(dBlocks[b][c]);
      for (let c = 0; c < ecPer; c += 1) for (let b = 0; b < blocks; b += 1) stream.push(eBlocks[b][c]);

      const grid = Array.from({ length: size }, () => new Int8Array(size).fill(-1));
      const res = Array.from({ length: size }, () => new Uint8Array(size));
      const setFinder = (r0, c0) => {
        for (let dr = -1; dr <= 7; dr += 1) {
          for (let dc = -1; dc <= 7; dc += 1) {
            const r = r0 + dr;
            const c = c0 + dc;
            if (r < 0 || r >= size || c < 0 || c >= size) continue;
            res[r][c] = 1;
            const box = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
            const edge = dr === 0 || dr === 6 || dc === 0 || dc === 6;
            const core = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
            grid[r][c] = box && (edge || core) ? 1 : 0;
          }
        }
      };
      setFinder(0, 0);
      setFinder(0, size - 7);
      setFinder(size - 7, 0);

      for (let i = 8; i < size - 8; i += 1) {
        res[6][i] = res[i][6] = 1;
        grid[6][i] = grid[i][6] = i % 2 === 0 ? 1 : 0;
      }
      if (ver.align.length >= 2) {
        const cp = ver.align[1];
        for (let dr = -2; dr <= 2; dr += 1) {
          for (let dc = -2; dc <= 2; dc += 1) {
            res[cp + dr][cp + dc] = 1;
            grid[cp + dr][cp + dc] = Math.abs(dr) === 2 || Math.abs(dc) === 2 || (!dr && !dc) ? 1 : 0;
          }
        }
      }
      res[4 * ver.v + 9][8] = 1;
      grid[4 * ver.v + 9][8] = 1;
      for (let i = 0; i <= 8; i += 1) if (i !== 6) res[8][i] = res[i][8] = 1;
      for (let i = size - 8; i < size; i += 1) res[8][i] = 1;
      for (let i = size - 7; i < size; i += 1) res[i][8] = 1;

      let bitIdx = 0;
      let up = true;
      for (let col = size - 1; col > 0; col -= 2) {
        if (col === 6) col -= 1;
        for (let i = 0; i < size; i += 1) {
          const r = up ? size - 1 - i : i;
          for (let dc = 0; dc < 2; dc += 1) {
            const c = col - dc;
            if (res[r][c]) continue;
            const bIdx = bitIdx >> 3;
            const bit = bIdx < stream.length ? (stream[bIdx] >> (7 - (bitIdx & 7))) & 1 : 0;
            bitIdx += 1;
            grid[r][c] = bit ^ ((r + c) % 2 === 0 ? 1 : 0);
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
      const t = n + q * 2;
      let paths = "";
      for (let r = 0; r < n; r += 1) {
        for (let c = 0; c < n; c += 1) {
          if (m[r][c] === 1) paths += `<rect x="${c + q}" y="${r + q}" width="1" height="1" />`;
        }
      }
      return `<svg viewBox="0 0 ${t} ${t}" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges"><rect width="${t}" height="${t}" fill="#ffffff"/><g fill="#141820">${paths}</g></svg>`;
    }

    return { toSvg };
  })();

  // ---------------------------------------------------------------------------
  // State & DOM
  // ---------------------------------------------------------------------------
  const state = {
    currentMod: 0,
    sidebarVisible: false,
    jumpStack: [],
    selectedRules: new Set(["fuzzy_z_zh", "fuzzy_eng_en", "fuzzy_ong_on"]),
    bpeSingleChar: false,
    kbMode: "adjacent",
    kbTarget: "g",
    cases: BUILTIN_CASES.slice(),
    caseIdx: 0,
    revealStep: 1,
    knownRanks: new Map(),
    pollTimer: null,
    hystAutoTimer: null,
    typingTimer: null,
  };

  const dom = {
    shell: document.getElementById("stage-shell"),
    main: document.getElementById("stage-main"),
    stage: document.getElementById("deck-stage"),
    modules: Array.from(document.querySelectorAll(".module")),
    hudChapter: document.getElementById("hud-chapter-name"),
    hudLoopTag: document.getElementById("hud-loop-tag"),
    toggleMapBtn: document.getElementById("toggle-map-btn"),
    mapOverlay: document.getElementById("loop-map-overlay"),
    closeMapBtn: document.getElementById("close-map-btn"),
    topoNodes: Array.from(document.querySelectorAll(".topo-node")),
    jumpBackBtn: document.getElementById("jump-back-btn"),
    jumpBackLabel: document.getElementById("jump-back-label"),
    prevBtn: document.getElementById("prev-slide-btn"),
    nextBtn: document.getElementById("next-slide-btn"),
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
  // Fixed 1920x1080 Uniform Scaling & Depth-of-Field Module Navigation
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

  function setSidebarVisible(visible) {
    state.sidebarVisible = Boolean(visible);
    dom.sidebar.hidden = !state.sidebarVisible;
    dom.shell.classList.toggle("is-sidebar-hidden", !state.sidebarVisible);
    dom.toggleSidebarBtn.textContent = state.sidebarVisible ? "隐藏榜单" : "显示榜单";
    requestAnimationFrame(rescaleDeckStage);
  }

  function refreshJumpBackButton() {
    if (state.jumpStack.length === 0) {
      dom.jumpBackBtn.hidden = true;
      return;
    }
    const top = state.jumpStack[state.jumpStack.length - 1];
    dom.jumpBackLabel.textContent = top.note || `返回：${top.title}`;
    dom.jumpBackBtn.hidden = false;
  }

  function navigateToModule(targetIdx, { direction = "auto", recordJump = false, returnNote = "" } = {}) {
    const idx = Math.max(0, Math.min(dom.modules.length - 1, targetIdx));
    if (idx === state.currentMod) return;

    const prevIdx = state.currentMod;
    if (recordJump) {
      const origin = dom.modules[prevIdx];
      state.jumpStack.push({
        modIdx: prevIdx,
        title: (origin && origin.dataset.title) || `0${prevIdx + 1}`,
        note: returnNote,
      });
      refreshJumpBackButton();
    }

    const forward = direction === "forward" || (direction === "auto" && idx > prevIdx);
    state.currentMod = idx;

    dom.modules.forEach((mod, i) => {
      mod.classList.remove("is-leaving-forward", "is-leaving-back", "is-active");
      if (i === prevIdx) {
        mod.classList.add(forward ? "is-leaving-forward" : "is-leaving-back");
      } else if (i === idx) {
        mod.classList.add("is-active");
      }
    });

    const active = dom.modules[idx];
    dom.hudChapter.textContent = active.dataset.title || `0${idx + 1}`;
    dom.hudLoopTag.textContent = active.dataset.loop || "";
    dom.topoNodes.forEach((n) => n.classList.toggle("is-current", Number(n.dataset.topo) === idx));

    dom.prevBtn.disabled = idx === 0;
    dom.nextBtn.disabled = idx === dom.modules.length - 1;

    if (idx >= INTERACTIVE_MOD_INDEX && !state.sidebarVisible) {
      setSidebarVisible(true);
    }
    updateRevealButtonLabel();
  }

  function popJumpBack() {
    if (state.jumpStack.length === 0) return false;
    const prev = state.jumpStack.pop();
    refreshJumpBackButton();
    navigateToModule(prev.modIdx, { direction: "back", recordJump: false });
    return true;
  }

  function setMapOverlayVisible(open) {
    dom.mapOverlay.hidden = !open;
  }

  // ---------------------------------------------------------------------------
  // Progressive Reveal
  // ---------------------------------------------------------------------------
  function revealElement(node) {
    if (!node) return;
    node.classList.remove("is-veiled");
    node.classList.add("is-revealed");
    updateRevealButtonLabel();
  }

  function revealNextInCurrent() {
    const mod = dom.modules[state.currentMod];
    if (!mod) return false;
    const veiled = Array.from(mod.querySelectorAll("[data-step].is-veiled"));
    if (veiled.length > 0) {
      veiled.sort((a, b) => Number(a.dataset.step) - Number(b.dataset.step));
      revealElement(veiled[0]);
      return true;
    }
    if (state.currentMod === 8 && state.revealStep < 3) {
      advanceModelReveal();
      return true;
    }
    return false;
  }

  function revealAllInCurrent() {
    const mod = dom.modules[state.currentMod];
    if (!mod) return;
    mod.querySelectorAll("[data-step].is-veiled").forEach(revealElement);
    if (state.currentMod === 8) {
      state.revealStep = 3;
      applyModelRevealState();
    }
    updateRevealButtonLabel();
  }

  function updateRevealButtonLabel() {
    const mod = dom.modules[state.currentMod];
    if (!mod) return;
    const hasVeiled = mod.querySelectorAll("[data-step].is-veiled").length > 0;
    const hasConceal = state.currentMod === 8 && state.revealStep < 3;
    dom.revealAllBtn.textContent = hasVeiled || hasConceal ? "展开本节" : "已全展开";
  }

  // ---------------------------------------------------------------------------
  // Interactive Module Demos & Animations
  // ---------------------------------------------------------------------------
  function animateTyping(el, targetText) {
    if (state.typingTimer) clearInterval(state.typingTimer);
    let i = 1;
    el.textContent = targetText.slice(0, i);
    state.typingTimer = setInterval(() => {
      i += 1;
      el.textContent = targetText.slice(0, i);
      if (i >= targetText.length) {
        clearInterval(state.typingTimer);
        state.typingTimer = null;
      }
    }, 65);
  }

  function initMod1() {
    document.getElementById("wx-replay-case1").addEventListener("click", () => {
      animateTyping(document.getElementById("wx-case1-keys"), "ni'ge'c'l'l");
    });

    const tabs = document.querySelectorAll(".wx-step-tab[data-wx-step]");
    const keysEl = document.getElementById("wx-case2-keys");
    const board = document.getElementById("wx-case2-board");
    const cap = document.getElementById("wx-case2-caption");

    function renderStep2(step, withAnim) {
      const item = WX_STEPS[step] || WX_STEPS[0];
      tabs.forEach((b) => b.classList.toggle("is-active", Number(b.dataset.wxStep) === step));
      if (withAnim) animateTyping(keysEl, item.keys);
      else keysEl.textContent = item.keys;
      board.innerHTML = item.cands
        .map(
          (c) =>
            `<div class="ime-cand ${c.cls}"><b>${c.rank}</b><span>${escapeHtml(c.text)}</span>${
              c.note ? `<em>${escapeHtml(c.note)}</em>` : ""
            }</div>`
        )
        .join("");
      cap.textContent = item.caption;
    }

    tabs.forEach((b) => b.addEventListener("click", () => renderStep2(Number(b.dataset.wxStep || 0), true)));
    document.getElementById("wx-morph-btn").addEventListener("click", () => {
      renderStep2(0, false);
      setTimeout(() => renderStep2(1, true), 480);
    });
  }

  function initMod2() {
    const strip = document.getElementById("wt-detail-strip");
    const svgWrap = document.getElementById("wt-svg-wrap");

    function selectWt(idx) {
      document.querySelectorAll(".wt-g").forEach((g) => g.classList.toggle("is-active", Number(g.dataset.wt) === idx));
      const items = WT_STAGES[idx] || WT_STAGES[0];
      strip.innerHTML = items
        .map((c) => `<div class="wt-card-mini ${c.warn ? "is-warn" : ""}"><b>${escapeHtml(c.title)}</b><p>${escapeHtml(c.body)}</p></div>`)
        .join("");
    }

    document.querySelectorAll(".wt-g").forEach((g) => g.addEventListener("click", () => selectWt(Number(g.dataset.wt))));
    document.querySelectorAll(".wt-probe-btn").forEach((b) =>
      b.addEventListener("click", () => {
        document.querySelectorAll(".wt-probe-btn").forEach((x) => x.classList.toggle("is-active", x === b));
        const hard = b.dataset.probe === "hard";
        svgWrap.classList.toggle("probe-normal", !hard);
        svgWrap.classList.toggle("probe-hard", hard);
        selectWt(hard ? 2 : 0);
      })
    );
    selectWt(2);
  }

  function initMod4() {
    const chips = document.getElementById("rule-chip-group");
    const pre = document.getElementById("rime-yaml-preview");

    function renderYaml() {
      const sel = RIME_RULES.filter((r) => state.selectedRules.has(r.id));
      const lines = sel.length ? sel.map((r) => `    - ${r.line}  # ${r.id}`).join("\n") : "    # 请至少勾选一条模糊音规则";
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

    document.getElementById("dp-play-btn").addEventListener("click", () => {
      let step = 0;
      const tick = () => {
        document.querySelectorAll("[data-dp]").forEach((el) => el.classList.toggle("is-pulse", Number(el.dataset.dp) === step));
        step += 1;
        if (step <= 3) setTimeout(tick, 340);
        else setTimeout(() => document.querySelectorAll("[data-dp]").forEach((el) => el.classList.remove("is-pulse")), 420);
      };
      tick();
    });
  }

  function initMod6() {
    const slider = document.getElementById("hyst-slider");
    const rateVal = document.getElementById("hyst-rate-val");
    const badge = document.getElementById("hyst-state-badge");
    const notifyText = document.getElementById("hyst-notify-text");
    const cursorGroup = document.getElementById("hyst-cursor-group");
    const cursorDot = document.getElementById("hyst-cursor-dot");
    const presets = document.querySelectorAll(".preset-rate-btn");

    let simulatedOn = false;

    function applyRate(val, notifyCountdown) {
      const rate = Math.max(0, Math.min(30, Number(val)));
      slider.value = String(rate);
      rateVal.textContent = `触发率：${rate}%`;

      if (rate >= 15) simulatedOn = true;
      else if (rate < 5) simulatedOn = false;

      let xPos;
      if (rate <= 5) xPos = 52 + (rate / 5) * 128;
      else if (rate <= 15) xPos = 180 + ((rate - 5) / 10) * 250;
      else xPos = 430 + ((rate - 15) / 15) * 350;

      const dotY = simulatedOn ? 98 : 194;
      const dotColor = simulatedOn ? "#1D4ED8" : rate < 5 ? "#64748B" : "#D97706";
      cursorGroup.setAttribute("transform", `translate(${xPos.toFixed(1)}, 0)`);
      cursorDot.setAttribute("cy", String(dotY));
      cursorDot.setAttribute("fill", dotColor);

      if (rate >= 15) {
        badge.textContent = "状态：开启 ON (>= 15%)";
        badge.className = "ime-cand is-winner";
        notifyText.textContent =
          notifyCountdown !== undefined
            ? `[已开启 ong=on] · 轻提示倒计时 ${notifyCountdown}/3`
            : "写入 algebra 补丁并在首候选轻提示 3 次即静默";
      } else if (rate < 5) {
        badge.textContent = "状态：休眠 OFF (< 5%)";
        badge.className = "ime-cand is-miss";
        notifyText.textContent = "低于 5% 自动降权回收补丁，保持候选栏干净";
      } else {
        badge.textContent = simulatedOn ? "状态：迟滞维持 ON (5%~15%)" : "状态：迟滞缓冲 OFF (5%~15%)";
        badge.className = "ime-cand";
        notifyText.textContent = simulatedOn
          ? "虽暂时回落到 5%~15%，因迟滞保护继续维持开启不反复横跳"
          : "未破 15% 暂不开启，避免偶发错敲污染词库";
      }
      presets.forEach((b) => b.classList.toggle("is-active", Number(b.dataset.rate) === rate));
    }

    slider.addEventListener("input", () => applyRate(slider.value));
    presets.forEach((b) => b.addEventListener("click", () => applyRate(b.dataset.rate)));
    document.getElementById("hyst-autoplay-btn").addEventListener("click", () => {
      if (state.hystAutoTimer) {
        clearInterval(state.hystAutoTimer);
        state.hystAutoTimer = null;
      }
      const seq = [
        [3, undefined],
        [10, undefined],
        [22, 3],
        [22, 2],
        [22, 1],
        [9, undefined],
        [3, undefined],
      ];
      let idx = 0;
      applyRate(seq[0][0], seq[0][1]);
      state.hystAutoTimer = setInterval(() => {
        idx += 1;
        if (idx >= seq.length) {
          clearInterval(state.hystAutoTimer);
          state.hystAutoTimer = null;
          return;
        }
        applyRate(seq[idx][0], seq[idx][1]);
      }, 650);
    });
    applyRate(8);
  }

  function initMod7() {
    document.getElementById("noise-cascade-btn").addEventListener("click", () => {
      let step = 0;
      const cards = document.querySelectorAll(".nc-step");
      const timer = setInterval(() => {
        cards.forEach((c, i) => c.classList.toggle("is-lit", i <= step));
        step += 1;
        if (step >= cards.length) clearInterval(timer);
      }, 340);
    });

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
      w: { q: "0.82", e: "0.82", s: "0.54", a: "0.49" },
      q: { w: "0.82", a: "0.54" },
    };
    const ABBR = new Set(["w", "m", "x", "q", "c", "f"]);
    const kbWrap = document.getElementById("qwerty-heatmap");
    const cap = document.getElementById("kb-sim-caption");
    const note = document.getElementById("kb-formula-note");
    const kbBtns = document.querySelectorAll(".kb-mode-btn");

    function renderKb() {
      const target = state.kbTarget;
      const near = NEIGHBORS[target] || NEIGHBORS.g;
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
                } else if (near[ch]) {
                  cls += " is-near";
                  sub = near[ch];
                }
              } else if (state.kbMode === "abbr" && ABBR.has(ch)) {
                cls += " is-abbr";
                sub = "简拼";
              } else if (state.kbMode === "jieba") {
                if (["w", "m", "x"].includes(ch)) {
                  cls += " is-target";
                  sub = "保留";
                } else if (["o", "e", "i"].includes(ch)) {
                  cls += " is-near";
                  sub = "省略";
                }
              }
              return `<button type="button" class="${cls}" data-k="${ch}">${ch.toUpperCase()}<small>${sub}</small></button>`;
            })
            .join("")}</div>`
      ).join("");

      kbWrap.querySelectorAll(".kb-key").forEach((k) =>
        k.addEventListener("click", () => {
          state.kbMode = "adjacent";
          state.kbTarget = NEIGHBORS[k.dataset.k] ? k.dataset.k : "g";
          kbBtns.forEach((b) => b.classList.toggle("is-active", b.dataset.kb === "adjacent"));
          renderKb();
        })
      );

      if (state.kbMode === "adjacent") {
        cap.textContent = `物理邻键波纹：聚焦键 ${target.toUpperCase()}（1/dist^2 邻键权重）`;
        note.innerHTML = `<div class="ime-cand is-winner">目标键 ${target} -> 物理旁键距离惩罚（复现 paoshibnie 蹭键）</div>`;
      } else if (state.kbMode === "abbr") {
        cap.textContent = "整句首字母简拼采样：wmxqcf -> 我们先去吃饭";
        note.innerHTML = `<div class="ime-cand is-winner">21 种声韵母缩写率由脱敏日志直接估算</div>`;
      } else {
        cap.textContent = "jieba 词级丢韵母采样";
        note.innerHTML = `<div class="ime-cand is-winner">以词为单位丢音节，贴合真实连续输入手癖</div>`;
      }
    }

    kbBtns.forEach((b) =>
      b.addEventListener("click", () => {
        state.kbMode = b.dataset.kb;
        kbBtns.forEach((x) => x.classList.toggle("is-active", x === b));
        renderKb();
      })
    );
    renderKb();
  }

  function initMod8() {
    function selectBridge(idx) {
      document.querySelectorAll("#bridge-node-bar .p4-node").forEach((b) => b.classList.toggle("is-active", Number(b.dataset.bridge) === idx));
      const item = BRIDGE_NODES[idx] || BRIDGE_NODES[0];
      document.getElementById("bridge-detail-box").innerHTML = `
        <div>
          <h3>${escapeHtml(item.title)}</h3>
          <p>${escapeHtml(item.desc)}</p>
        </div>
        <div class="badge-row">${item.badges.map((b) => `<span class="tag tag-blue">${escapeHtml(b)}</span>`).join("")}</div>
      `;
    }
    document.querySelectorAll("#bridge-node-bar .p4-node").forEach((b) =>
      b.addEventListener("click", () => {
        revealElement(document.querySelector("#mod-8 [data-step='1']"));
        selectBridge(Number(b.dataset.bridge));
      })
    );
    selectBridge(0);

    const svg = document.getElementById("trie-svg");
    const status = document.getElementById("trie-pulse-status");
    document.getElementById("trie-anim-btn").addEventListener("click", () => {
      revealElement(document.querySelector("#mod-8 [data-step='1']"));
      svg.classList.toggle("is-pulsing");
      const pulsing = svg.classList.contains("is-pulsing");
      status.textContent = pulsing
        ? "剪枝激活：超预算幻觉路径已切断，kuai(+4.2*ep) 直通 DynamicCache"
        : "只保留预算内读音，超阈值路径瞬间剪枝";
    });
  }

  function applyModelRevealState() {
    document.querySelectorAll("#case-compare-grid .cmp-col").forEach((col, i) => {
      col.classList.toggle("is-concealed", i >= state.revealStep);
    });
    const btn = document.getElementById("reveal-models-btn");
    if (btn) btn.textContent = state.revealStep >= 3 ? "已全部揭晓（重置）" : "逐个揭晓 A/B 结果";
    updateRevealButtonLabel();
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
    document.querySelectorAll("#case-pills .case-tab").forEach((b, i) => b.classList.toggle("is-active", i === state.caseIdx));
  }

  function rebuildCasePills() {
    const strip = document.getElementById("case-pills");
    strip.innerHTML = state.cases
      .map((c, i) => `<button type="button" class="case-tab ${i === state.caseIdx ? "is-active" : ""}" data-cidx="${i}">#${i + 1} ${escapeHtml(c.raw_keys)}</button>`)
      .join("");
    strip.querySelectorAll(".case-tab").forEach((b) => b.addEventListener("click", () => renderCase(Number(b.dataset.cidx))));
    renderCase(0);
  }

  function initMod9() {
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

    const input = document.getElementById("cases-file-input");
    const pill = document.getElementById("cases-source-pill");
    input.addEventListener("change", () => {
      const f = input.files && input.files[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const parsed = JSON.parse(String(reader.result));
          const list = Array.isArray(parsed) ? parsed : parsed.cases;
          if (Array.isArray(list) && list.length > 0) {
            state.cases = list;
            pill.textContent = `已载入：${f.name} (${list.length} 条)`;
            rebuildCasePills();
          }
        } catch (_err) {
          pill.textContent = "JSON 格式无效";
        }
      };
      reader.readAsText(f, "utf-8");
    });

    const ext = new URLSearchParams(window.location.search).get("cases");
    if (ext) {
      fetch(ext)
        .then((r) => (r.ok ? r.json() : null))
        .then((parsed) => {
          const list = Array.isArray(parsed) ? parsed : parsed && parsed.cases;
          if (Array.isArray(list) && list.length > 0) {
            state.cases = list;
            pill.textContent = `外链对照集 (${list.length} 条)`;
            rebuildCasePills();
          }
        })
        .catch(() => {});
    }

    rebuildCasePills();
    applyModelRevealState();
  }

  // ---------------------------------------------------------------------------
  // Live Right Panel (QR + /api/leaderboard + Reset)
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
    const open = () => {
      dom.resetModal.hidden = false;
      dom.resetErrorMsg.hidden = true;
      dom.adminTokenInput.value = "";
      setTimeout(() => dom.adminTokenInput.focus(), 40);
    };
    const close = () => {
      dom.resetModal.hidden = true;
    };
    dom.openResetBtn.addEventListener("click", open);
    dom.closeResetBtn.addEventListener("click", close);
    dom.cancelResetBtn.addEventListener("click", close);
    dom.resetModal.addEventListener("click", (e) => {
      if (e.target === dom.resetModal) close();
    });

    dom.resetForm.addEventListener("submit", (e) => {
      e.preventDefault();
      fetch("/api/reset", {
        method: "POST",
        headers: { "X-Admin-Token": dom.adminTokenInput.value.trim() },
      })
        .then(async (r) => {
          if (!r.ok) {
            const err = await r.json().catch(() => ({}));
            throw new Error(err.detail || `清空失败 (${r.status})`);
          }
          return r.json();
        })
        .then(() => {
          close();
          pollLeaderboard();
        })
        .catch((err) => {
          dom.resetErrorMsg.textContent = err.message;
          dom.resetErrorMsg.hidden = false;
        });
    });
  }

  function escapeHtml(s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function initEvents() {
    window.addEventListener("resize", rescaleDeckStage);

    dom.prevBtn.addEventListener("click", () => navigateToModule(state.currentMod - 1, { direction: "back" }));
    dom.nextBtn.addEventListener("click", () => navigateToModule(state.currentMod + 1, { direction: "forward" }));
    dom.revealAllBtn.addEventListener("click", revealAllInCurrent);
    dom.toggleSidebarBtn.addEventListener("click", () => setSidebarVisible(!state.sidebarVisible));
    dom.jumpBackBtn.addEventListener("click", popJumpBack);

    dom.toggleMapBtn.addEventListener("click", () => setMapOverlayVisible(dom.mapOverlay.hidden));
    dom.closeMapBtn.addEventListener("click", () => setMapOverlayVisible(false));
    dom.mapOverlay.addEventListener("click", (e) => {
      if (e.target === dom.mapOverlay) setMapOverlayVisible(false);
    });
    dom.topoNodes.forEach((n) =>
      n.addEventListener("click", () => {
        const target = Number(n.dataset.topo || 0);
        setMapOverlayVisible(false);
        navigateToModule(target, {
          recordJump: target !== state.currentMod,
          returnNote: `返回：${dom.modules[state.currentMod].dataset.title}`,
        });
      })
    );

    dom.fullscreenBtn.addEventListener("click", () => {
      if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => {});
      else document.exitFullscreen().catch(() => {});
    });

    document.querySelectorAll("[data-jump]").forEach((btn) =>
      btn.addEventListener("click", () => {
        navigateToModule(Number(btn.dataset.jump || 0), {
          direction: "forward",
          recordJump: true,
          returnNote: btn.dataset.jumpNote || `返回：${dom.modules[state.currentMod].dataset.title}`,
        });
      })
    );

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
      if (!dom.mapOverlay.hidden) {
        if (e.key === "Escape" || e.key === "m" || e.key === "M") {
          e.preventDefault();
          setMapOverlayVisible(false);
        }
        return;
      }
      if (["INPUT", "TEXTAREA"].includes(document.activeElement && document.activeElement.tagName)) return;

      if (e.key === "Escape" || e.key === "Backspace") {
        if (popJumpBack()) {
          e.preventDefault();
          return;
        }
      }
      if (e.key === "m" || e.key === "M") {
        e.preventDefault();
        setMapOverlayVisible(true);
      } else if (e.key === "ArrowRight" || e.key === "PageDown") {
        e.preventDefault();
        navigateToModule(state.currentMod + 1, { direction: "forward" });
      } else if (e.key === "ArrowLeft" || e.key === "PageUp") {
        e.preventDefault();
        navigateToModule(state.currentMod - 1, { direction: "back" });
      } else if (e.key === " ") {
        e.preventDefault();
        if (!revealNextInCurrent()) navigateToModule(state.currentMod + 1, { direction: "forward" });
      } else if (e.key === "b" || e.key === "B") {
        setSidebarVisible(!state.sidebarVisible);
      } else if (e.key === "f" || e.key === "F") {
        dom.fullscreenBtn.click();
      }
    });
  }

  // Boot
  initMod1();
  initMod2();
  initMod4();
  initMod6();
  initMod7();
  initMod8();
  initMod9();
  initQrAndClipboard();
  initResetModal();
  initEvents();

  dom.topoNodes.forEach((n) => n.classList.toggle("is-current", Number(n.dataset.topo) === 0));
  updateRevealButtonLabel();
  rescaleDeckStage();
  pollLeaderboard();
  state.pollTimer = setInterval(pollLeaderboard, POLL_INTERVAL_MS);
})();
