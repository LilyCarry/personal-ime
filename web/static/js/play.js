(() => {
  "use strict";

  /**
   * 3 句内置竞速短文：覆盖前后鼻音、平翘舌、l/n/r、f/h、g/k、jqxy u/v 与易错换序。
   */
  const RACE_SENTENCES = [
    {
      id: "s1",
      tag: "第 1 句 · 平翘舌与后鼻音",
      text: "早上找手机充电忘了按开关",
      syllables: [
        { hanzi: "早", py: "zao" },
        { hanzi: "上", py: "shang" },
        { hanzi: "找", py: "zhao" },
        { hanzi: "手", py: "shou" },
        { hanzi: "机", py: "ji" },
        { hanzi: "充", py: "chong" },
        { hanzi: "电", py: "dian" },
        { hanzi: "忘", py: "wang" },
        { hanzi: "了", py: "le" },
        { hanzi: "按", py: "an" },
        { hanzi: "开", py: "kai" },
        { hanzi: "关", py: "guan" },
      ],
    },
    {
      id: "s2",
      tag: "第 2 句 · l/n/r 与鼻音混打",
      text: "人工智能太难了不如回宿舍躺平",
      syllables: [
        { hanzi: "人", py: "ren" },
        { hanzi: "工", py: "gong" },
        { hanzi: "智", py: "zhi" },
        { hanzi: "能", py: "neng" },
        { hanzi: "太", py: "tai" },
        { hanzi: "难", py: "nan" },
        { hanzi: "了", py: "le" },
        { hanzi: "不", py: "bu" },
        { hanzi: "如", py: "ru" },
        { hanzi: "回", py: "hui" },
        { hanzi: "宿", py: "su" },
        { hanzi: "舍", py: "she" },
        { hanzi: "躺", py: "tang" },
        { hanzi: "平", py: "ping" },
      ],
    },
    {
      id: "s3",
      tag: "第 3 句 · 前后鼻音与 u/v 容错",
      text: "今天心情不错去学校广场喝奶茶",
      syllables: [
        { hanzi: "今", py: "jin" },
        { hanzi: "天", py: "tian" },
        { hanzi: "心", py: "xin" },
        { hanzi: "情", py: "qing" },
        { hanzi: "不", py: "bu" },
        { hanzi: "错", py: "cuo" },
        { hanzi: "去", py: "qu" },
        { hanzi: "学", py: "xue" },
        { hanzi: "校", py: "xiao" },
        { hanzi: "广", py: "guang" },
        { hanzi: "场", py: "chang" },
        { hanzi: "喝", py: "he" },
        { hanzi: "奶", py: "nai" },
        { hanzi: "茶", py: "cha" },
      ],
    },
  ];

  /**
   * 与 profiler/rules_schema.py 完全对齐的 24 条标准可量化规则词表。
   */
  const RULES_CATALOG = [
    {
      id: "z=zh",
      label: "平翘舌 z / zh 互通",
      category: "声母",
      description: "允许 z 与 zh 声母互相模糊匹配，缓解平翘舌混淆。",
      algebra: ["derive/^zh/z/", "derive/^z([^h])/zh$1/"],
      examples: ["zi -> zhi", "zhao -> zao"],
    },
    {
      id: "c=ch",
      label: "平翘舌 c / ch 互通",
      category: "声母",
      description: "允许 c 与 ch 声母互相模糊匹配，缓解平翘舌混淆。",
      algebra: ["derive/^ch/c/", "derive/^c([^h])/ch$1/"],
      examples: ["ci -> chi", "chang -> cang"],
    },
    {
      id: "s=sh",
      label: "平翘舌 s / sh 互通",
      category: "声母",
      description: "允许 s 与 sh 声母互相模糊匹配，缓解平翘舌混淆。",
      algebra: ["derive/^sh/s/", "derive/^s([^h])/sh$1/"],
      examples: ["si -> shi", "shuo -> suo"],
    },
    {
      id: "l=n",
      label: "边鼻音 l / n 互通",
      category: "声母",
      description: "允许声母 l 与 n 互相派生，适配南北方言或连打易混场景。",
      algebra: ["derive/^l/n/", "derive/^n/l/"],
      examples: ["lai -> nai", "nan -> lan"],
    },
    {
      id: "l=r",
      label: "声母 l / r 互通",
      category: "声母",
      description: "允许声母 l 与 r 互相派生，兼容 l/r 混淆输入习惯。",
      algebra: ["derive/^l/r/", "derive/^r/l/"],
      examples: ["ren -> len", "lu -> ru"],
    },
    {
      id: "f=h",
      label: "声母 f / h 互通",
      category: "声母",
      description: "允许声母 f 与 h 互相派生，覆盖常见 f/h 混淆发音。",
      algebra: ["derive/^f/h/", "derive/^h/f/"],
      examples: ["fei -> hei", "hua -> fa"],
    },
    {
      id: "g=k",
      label: "声母 g / k 互通",
      category: "声母",
      description: "允许声母 g 与 k 互相派生，减少相近清浊音误触。",
      algebra: ["derive/^g/k/", "derive/^k/g/"],
      examples: ["gao -> kao", "kai -> gai"],
    },
    {
      id: "ong=on",
      label: "后鼻音省尾 ong / on",
      category: "韵母",
      description: "允许将后鼻音 ong 简写为 on，贴合快速敲击时省去末尾 g 的习惯。",
      algebra: ["derive/ong$/on/"],
      examples: ["dong -> don", "zhong -> zhon"],
    },
    {
      id: "in=ing",
      label: "前后鼻音 in / ing 互通",
      category: "韵母",
      description: "允许前鼻音 in 与后鼻音 ing 互相模糊匹配。",
      algebra: ["derive/in$/ing/", "derive/ing$/in/"],
      examples: ["jin -> jing", "ming -> min"],
    },
    {
      id: "en=eng",
      label: "前后鼻音 en / eng 互通",
      category: "韵母",
      description: "允许前鼻音 en 与后鼻音 eng 互相模糊匹配。",
      algebra: ["derive/en$/eng/", "derive/eng$/en/"],
      examples: ["fen -> feng", "cheng -> chen"],
    },
    {
      id: "an=ang",
      label: "前后鼻音 an / ang 互通",
      category: "韵母",
      description: "允许前鼻音 an 与后鼻音 ang 互相模糊匹配。",
      algebra: ["derive/an$/ang/", "derive/ang$/an/"],
      examples: ["ban -> bang", "zhang -> zhan"],
    },
    {
      id: "ian=iang",
      label: "前后鼻音 ian / iang 互通",
      category: "韵母",
      description: "允许韵母 ian 与 iang 互相模糊匹配。",
      algebra: ["derive/ian$/iang/", "derive/iang$/ian/"],
      examples: ["jian -> jiang", "xiang -> xian"],
    },
    {
      id: "uan=uang",
      label: "前后鼻音 uan / uang 互通",
      category: "韵母",
      description: "允许韵母 uan 与 uang 互相模糊匹配。",
      algebra: ["derive/uan$/uang/", "derive/uang$/uan/"],
      examples: ["huan -> huang", "guang -> guan"],
    },
    {
      id: "ong=eng",
      label: "韵母 ong / eng 互通",
      category: "韵母",
      description: "允许韵母 ong 与 eng 互相派生，兼容部分方言韵母混淆。",
      algebra: ["derive/ong$/eng/", "derive/eng$/ong/"],
      examples: ["feng -> fong", "dong -> deng"],
    },
    {
      id: "ong=un",
      label: "韵母 ong / un 互通",
      category: "韵母",
      description: "允许韵母 ong 与 un 互相派生。",
      algebra: ["derive/ong$/un/", "derive/un$/ong/"],
      examples: ["lun -> long", "zong -> zun"],
    },
    {
      id: "ue=ve",
      label: "拼写容错 ue / ve 互通",
      category: "容错",
      description: "允许 n/l 后的 ue 与 ve 互相转换（如 nue 与 nve）。",
      algebra: ["derive/^([nl])ve$/$1ue/", "derive/^([nl])ue$/$1ve/"],
      examples: ["nue -> nve", "lve -> lue"],
    },
    {
      id: "ju=jv",
      label: "拼写容错 jqxy 后 u / v 互通",
      category: "容错",
      description: "允许 j/q/x/y 后的 u 与 v 互相转换（如 qv 匹配 qu）。",
      algebra: ["derive/^([jqxy])u/$1v/", "derive/^([jqxy])v/$1u/"],
      examples: ["qv -> qu", "xue -> xve"],
    },
    {
      id: "an=na",
      label: "击键换序容错 an / na",
      category: "容错",
      description: "纠正高速连打时末尾 an 误按成 na 的邻键换序错误。",
      algebra: ["derive/([wrtypsdfghklzcbnm])an$/$1na/"],
      examples: ["dna -> dan", "bna -> ban"],
    },
    {
      id: "en=ne",
      label: "击键换序容错 en / ne",
      category: "容错",
      description: "纠正高速连打时末尾 en 误按成 ne 的邻键换序错误。",
      algebra: ["derive/([wrpsdfghklzcbnm])en$/$1ne/"],
      examples: ["rne -> ren", "mne -> men"],
    },
    {
      id: "in=ni",
      label: "击键换序容错 in / ni",
      category: "容错",
      description: "纠正高速连打时末尾 in 误按成 ni 的邻键换序错误。",
      algebra: ["derive/([qypjlxbnm])in$/$1ni/"],
      examples: ["qni -> qin", "xni -> xin"],
    },
    {
      id: "un=nu",
      label: "击键换序容错 un / nu",
      category: "容错",
      description: "纠正高速连打时末尾 un 误按成 nu 的邻键换序错误。",
      algebra: ["derive/([qrtysdghjklzxc])un$/$1nu/"],
      examples: ["qnu -> qun", "xnu -> xun"],
    },
    {
      id: "ai=ia",
      label: "韵母换序容错 ai / ia",
      category: "容错",
      description: "纠正 w/g/h/k 后 ai 误打成 ia 的换序错误。",
      algebra: ["derive/^([wghk])ai$/$1ia/"],
      examples: ["wia -> wai", "kia -> kai"],
    },
    {
      id: "ei=ie",
      label: "韵母换序容错 ei / ie",
      category: "容错",
      description: "纠正 w/f/g/h/k/z 后 ei 误打成 ie 的换序错误。",
      algebra: ["derive/([wfghkz])ei$/$1ie/"],
      examples: ["wie -> wei", "fie -> fei"],
    },
    {
      id: "zh=hz",
      label: "翘舌换序容错 zh/ch/sh",
      category: "容错",
      description: "纠正高速敲击时 zh/ch/sh 与元音之间的先后键位倒置。",
      algebra: [
        "derive/([zcs])h(a|e|i|u|ai|ei|an|en|ou|uo|ua|un|ui|uan|uai|uang|ang|eng|ong)$/h$1$2/",
        "derive/([zcs])h([aeiu])$/$1$2h/",
      ],
      examples: ["hzi -> zhi", "zih -> zhi"],
    },
  ];

  const RULES_BY_ID = Object.fromEntries(RULES_CATALOG.map((r) => [r.id, r]));

  const RULE_ALIASES = {
    "zh=z": "z=zh",
    "ch=c": "c=ch",
    "sh=s": "s=sh",
    "n=l": "l=n",
    "r=l": "l=r",
    "h=f": "f=h",
    "k=g": "g=k",
    "on=ong": "ong=on",
    "ing=in": "in=ing",
    "eng=en": "en=eng",
    "ang=an": "an=ang",
    "iang=ian": "ian=iang",
    "uang=uan": "uan=uang",
    "eng=ong": "ong=eng",
    "un=ong": "ong=un",
    "ve=ue": "ue=ve",
    "jv=ju": "ju=jv",
    "u=v": "ju=jv",
    "v=u": "ju=jv",
    "na=an": "an=na",
    "ne=en": "en=ne",
    "ni=in": "in=ni",
    "nu=un": "un=nu",
    "ia=ai": "ai=ia",
    "ie=ei": "ei=ie",
    "hz=zh": "zh=hz",
  };

  const STORAGE_NICKNAME_KEY = "personal_ime_nickname";

  const state = {
    nickname: "",
    sentenceIndex: 0,
    startedAt: 0,
    finishedAt: 0,
    timerId: null,
    backspaces: 0,
    skipNextBeforeInputDelete: false,
    isComposing: false,
    samples: [], // { text, reference_pinyin, raw_input }
    recommendedRules: [],
    ruleReasons: {},
    selectedRules: new Set(),
    currentFilter: "all",
  };

  // DOM References
  const views = {
    welcome: document.getElementById("view-welcome"),
    race: document.getElementById("view-race"),
    loading: document.getElementById("view-loading"),
    result: document.getElementById("view-result"),
  };

  const el = {
    welcomeForm: document.getElementById("welcome-form"),
    nicknameInput: document.getElementById("nickname-input"),
    nicknameError: document.getElementById("nickname-error"),
    progressLabel: document.getElementById("race-progress-label"),
    progressFill: document.getElementById("race-progress-fill"),
    timer: document.getElementById("race-timer"),
    cpm: document.getElementById("race-cpm"),
    backspaces: document.getElementById("race-backspaces"),
    sentenceTag: document.getElementById("sentence-tag"),
    playerBadge: document.getElementById("player-badge"),
    syllableGrid: document.getElementById("syllable-grid"),
    refPinyinText: document.getElementById("reference-pinyin-text"),
    charCounter: document.getElementById("char-counter"),
    pinyinInput: document.getElementById("pinyin-input"),
    imeWarning: document.getElementById("ime-warning"),
    inputHint: document.getElementById("input-hint"),
    restartRaceBtn: document.getElementById("restart-race-btn"),
    nextSentenceBtn: document.getElementById("next-sentence-btn"),
    loadingStatus: document.getElementById("loading-status"),
    resultTitle: document.getElementById("result-title"),
    resultSourceBadge: document.getElementById("result-source-badge"),
    resultRank: document.getElementById("result-rank"),
    resultScore: document.getElementById("result-score"),
    resultCpm: document.getElementById("result-cpm"),
    resultAccuracy: document.getElementById("result-accuracy"),
    resultElapsed: document.getElementById("result-elapsed"),
    resultBackspaces: document.getElementById("result-backspaces"),
    resultNickname: document.getElementById("result-nickname"),
    resultComment: document.getElementById("result-comment"),
    selectedRulesCount: document.getElementById("selected-rules-count"),
    resetRecommendedBtn: document.getElementById("reset-recommended-btn"),
    filterTabs: Array.from(document.querySelectorAll(".filter-tab")),
    rulesList: document.getElementById("rules-list"),
    rimeYamlPreview: document.querySelector("#rime-yaml-preview code"),
    copyRimeBtn: document.getElementById("copy-rime-btn"),
    downloadRimeBtn: document.getElementById("download-rime-btn"),
    copyFeedback: document.getElementById("copy-feedback"),
    playAgainBtn: document.getElementById("play-again-btn"),
  };

  function showView(name) {
    Object.entries(views).forEach(([key, node]) => {
      if (!node) return;
      if (key === name) {
        node.hidden = false;
        node.classList.add("is-active");
      } else {
        node.hidden = true;
        node.classList.remove("is-active");
      }
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function cleanAlpha(text) {
    return String(text || "")
      .toLowerCase()
      .replace(/[^a-z]/g, "");
  }

  function hasNonLatinInput(text) {
    return /[^\x00-\x7F]/.test(String(text || ""));
  }

  function normalizeRuleId(rawId) {
    if (typeof rawId !== "string") return null;
    const cleaned = rawId.trim().toLowerCase();
    if (!cleaned) return null;
    if (RULES_BY_ID[cleaned]) return cleaned;
    if (RULE_ALIASES[cleaned]) return RULE_ALIASES[cleaned];
    const normalizedSep = cleaned.replace(/\s*(?:<->|<=>|↔|->|=>|=|\/|:|_|-)\s*/g, "=");
    if (RULES_BY_ID[normalizedSep]) return normalizedSep;
    if (RULE_ALIASES[normalizedSep]) return RULE_ALIASES[normalizedSep];
    return null;
  }

  function levenshteinDistance(a, b) {
    const m = a.length;
    const n = b.length;
    if (m === 0) return n;
    if (n === 0) return m;
    let prev = new Array(n + 1);
    let curr = new Array(n + 1);
    for (let j = 0; j <= n; j += 1) prev[j] = j;
    for (let i = 1; i <= m; i += 1) {
      curr[0] = i;
      const ca = a.charCodeAt(i - 1);
      for (let j = 1; j <= n; j += 1) {
        const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
        curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      }
      const tmp = prev;
      prev = curr;
      curr = tmp;
    }
    return prev[n];
  }

  /**
   * 将用户连续输入的纯字母串与标准音节数组做轻量 DP 对齐，
   * 以便在无空格连打时仍能准确提取每个音节对应的用户实际拼写。
   */
  function alignSyllablesToInput(syllables, rawInput) {
    const tokens = String(rawInput || "")
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .map((t) => cleanAlpha(t))
      .filter(Boolean);

    if (tokens.length === syllables.length) {
      return syllables.map((ref, idx) => ({ ref, typed: tokens[idx] }));
    }

    const userStr = cleanAlpha(rawInput);
    const n = syllables.length;
    const m = userStr.length;
    const INF = 1e9;
    const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(INF));
    const back = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    dp[0][0] = 0;

    for (let i = 1; i <= n; i += 1) {
      const ref = syllables[i - 1];
      for (let j = 0; j <= m; j += 1) {
        if (dp[i - 1][j] >= INF) continue;
        // 允许 1 到 7 个字符的音节窗口（包含偶发多敲或简拼）
        const maxLen = Math.min(7, m - j);
        for (let len = 1; len <= maxLen; len += 1) {
          const seg = userStr.slice(j, j + len);
          const cost = levenshteinDistance(ref, seg);
          const nextCost = dp[i - 1][j] + cost;
          if (nextCost < dp[i][j + len]) {
            dp[i][j + len] = nextCost;
            back[i][j + len] = j;
          }
        }
      }
    }

    // 若结尾长度不足导致 dp[n][m] 不可达，退化为按比例切分
    if (dp[n][m] >= INF) {
      const totalRefLen = syllables.reduce((acc, s) => acc + s.length, 0) || 1;
      let cursor = 0;
      return syllables.map((ref, idx) => {
        const share =
          idx === n - 1
            ? m - cursor
            : Math.max(0, Math.round((ref.length / totalRefLen) * m));
        const seg = userStr.slice(cursor, cursor + share);
        cursor += share;
        return { ref, typed: seg };
      });
    }

    const aligned = new Array(n);
    let pos = m;
    for (let i = n; i >= 1; i -= 1) {
      const prevPos = back[i][pos];
      aligned[i - 1] = { ref: syllables[i - 1], typed: userStr.slice(prevPos, pos) };
      pos = prevPos;
    }
    return aligned;
  }

  /**
   * 本地确定性规则检测：根据用户实际拼写与参考拼音的差异识别命中的标准规则。
   */
  function detectRulesFromSamples(samples) {
    const hitCounts = new Map();
    const hitReasons = {};

    const mark = (ruleId, reason) => {
      hitCounts.set(ruleId, (hitCounts.get(ruleId) || 0) + 1);
      if (!hitReasons[ruleId]) {
        hitReasons[ruleId] = reason;
      }
    };

    samples.forEach((sample, sIdx) => {
      const refSyllables = RACE_SENTENCES[sIdx].syllables.map((item) => item.py);
      const pairs = alignSyllablesToInput(refSyllables, sample.raw_input);

      pairs.forEach(({ ref, typed }) => {
        if (!typed || typed === ref) return;

        // 1. 声母平翘舌
        if (ref.startsWith("zh") && typed.startsWith("z") && !typed.startsWith("zh")) {
          mark("z=zh", `将 "${ref}" 敲成了 "${typed}"`);
        } else if (!ref.startsWith("zh") && ref.startsWith("z") && typed.startsWith("zh")) {
          mark("z=zh", `将 "${ref}" 敲成了 "${typed}"`);
        }

        if (ref.startsWith("ch") && typed.startsWith("c") && !typed.startsWith("ch")) {
          mark("c=ch", `将 "${ref}" 敲成了 "${typed}"`);
        } else if (!ref.startsWith("ch") && ref.startsWith("c") && typed.startsWith("ch")) {
          mark("c=ch", `将 "${ref}" 敲成了 "${typed}"`);
        }

        if (ref.startsWith("sh") && typed.startsWith("s") && !typed.startsWith("sh")) {
          mark("s=sh", `将 "${ref}" 敲成了 "${typed}"`);
        } else if (!ref.startsWith("sh") && ref.startsWith("s") && typed.startsWith("sh")) {
          mark("s=sh", `将 "${ref}" 敲成了 "${typed}"`);
        }

        // 2. 声母 l/n, l/r, f/h, g/k
        if ((ref[0] === "l" && typed[0] === "n") || (ref[0] === "n" && typed[0] === "l")) {
          mark("l=n", `出现边鼻音 "${ref}" -> "${typed}"`);
        }
        if ((ref[0] === "l" && typed[0] === "r") || (ref[0] === "r" && typed[0] === "l")) {
          mark("l=r", `出现声母 "${ref}" -> "${typed}"`);
        }
        if ((ref[0] === "f" && typed[0] === "h") || (ref[0] === "h" && typed[0] === "f")) {
          mark("f=h", `出现声母 "${ref}" -> "${typed}"`);
        }
        if ((ref[0] === "g" && typed[0] === "k") || (ref[0] === "k" && typed[0] === "g")) {
          mark("g=k", `出现声母 "${ref}" -> "${typed}"`);
        }

        // 3. 韵母前后鼻音 & 省尾
        if (ref.endsWith("ong") && typed.endsWith("on") && !typed.endsWith("ong")) {
          mark("ong=on", `后鼻音省去末尾 g（"${ref}" -> "${typed}"）`);
        }
        if (
          (ref.endsWith("ing") && typed.endsWith("in") && !typed.endsWith("ing")) ||
          (ref.endsWith("in") && !ref.endsWith("ing") && typed.endsWith("ing"))
        ) {
          mark("in=ing", `前后鼻音混淆（"${ref}" -> "${typed}"）`);
        }
        if (
          (ref.endsWith("eng") && typed.endsWith("en") && !typed.endsWith("eng")) ||
          (ref.endsWith("en") && !ref.endsWith("eng") && typed.endsWith("eng"))
        ) {
          mark("en=eng", `前后鼻音混淆（"${ref}" -> "${typed}"）`);
        }
        if (
          (ref.endsWith("iang") && typed.endsWith("ian") && !typed.endsWith("iang")) ||
          (ref.endsWith("ian") && !ref.endsWith("iang") && typed.endsWith("iang"))
        ) {
          mark("ian=iang", `韵母混用（"${ref}" -> "${typed}"）`);
        } else if (
          (ref.endsWith("uang") && typed.endsWith("uan") && !typed.endsWith("uang")) ||
          (ref.endsWith("uan") && !ref.endsWith("uang") && typed.endsWith("uan"))
        ) {
          mark("uan=uang", `韵母混用（"${ref}" -> "${typed}"）`);
        } else if (
          (ref.endsWith("ang") && typed.endsWith("an") && !typed.endsWith("ang")) ||
          (ref.endsWith("an") && !ref.endsWith("ang") && typed.endsWith("ang"))
        ) {
          mark("an=ang", `前后鼻音混淆（"${ref}" -> "${typed}"）`);
        }
        if (
          (ref.endsWith("ong") && typed.endsWith("eng")) ||
          (ref.endsWith("eng") && typed.endsWith("ong"))
        ) {
          mark("ong=eng", `韵母 ong/eng 混用（"${ref}" -> "${typed}"）`);
        }
        if (
          (ref.endsWith("ong") && typed.endsWith("un")) ||
          (ref.endsWith("un") && typed.endsWith("ong"))
        ) {
          mark("ong=un", `韵母 ong/un 混用（"${ref}" -> "${typed}"）`);
        }

        // 4. u/v 与换序容错
        if (/^[nl][uv]e$/.test(ref) && (typed.includes("ve") || typed.includes("ue"))) {
          if (ref.replace("u", "v") === typed || ref.replace("v", "u") === typed) {
            mark("ue=ve", `ue/ve 拼写互换（"${ref}" -> "${typed}"）`);
          }
        }
        if (/^[jqxy][uv]/.test(ref) && (typed.includes("v") || typed.includes("u"))) {
          if (ref.replace("u", "v") === typed) {
            mark("ju=jv", `jqxy 后使用 v 代替 u（"${ref}" -> "${typed}"）`);
          }
        }
        if (ref.endsWith("an") && typed.endsWith("na") && ref.slice(0, -2) === typed.slice(0, -2)) {
          mark("an=na", `高速换序（"${ref}" -> "${typed}"）`);
        }
        if (ref.endsWith("en") && typed.endsWith("ne") && ref.slice(0, -2) === typed.slice(0, -2)) {
          mark("en=ne", `高速换序（"${ref}" -> "${typed}"）`);
        }
        if (ref.endsWith("in") && typed.endsWith("ni") && ref.slice(0, -2) === typed.slice(0, -2)) {
          mark("in=ni", `高速换序（"${ref}" -> "${typed}"）`);
        }
        if (ref.endsWith("un") && typed.endsWith("nu") && ref.slice(0, -2) === typed.slice(0, -2)) {
          mark("un=nu", `高速换序（"${ref}" -> "${typed}"）`);
        }
        if (ref.endsWith("ai") && typed.endsWith("ia") && ref.slice(0, -2) === typed.slice(0, -2)) {
          mark("ai=ia", `韵母换序（"${ref}" -> "${typed}"）`);
        }
        if (ref.endsWith("ei") && typed.endsWith("ie") && ref.slice(0, -2) === typed.slice(0, -2)) {
          mark("ei=ie", `韵母换序（"${ref}" -> "${typed}"）`);
        }
        if (/^[zcs]h/.test(ref) && (/^h[zcs]/.test(typed) || /^[zcs][aeiu]h$/.test(typed))) {
          mark("zh=hz", `翘舌键位倒置（"${ref}" -> "${typed}"）`);
        }
      });
    });

    const sortedRules = Array.from(hitCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([ruleId]) => ruleId);

    return { rules: sortedRules, reasons: hitReasons };
  }

  function computeMetrics() {
    const elapsedMs = Math.max(1000, state.finishedAt - state.startedAt);
    let totalTargetChars = 0;
    let totalUserChars = 0;
    let totalEditDist = 0;
    let totalMaxLen = 0;

    state.samples.forEach((sample, idx) => {
      const targetClean = RACE_SENTENCES[idx].syllables.map((s) => s.py).join("");
      const userClean = cleanAlpha(sample.raw_input);
      totalTargetChars += targetClean.length;
      totalUserChars += userClean.length;
      totalEditDist += levenshteinDistance(userClean, targetClean);
      totalMaxLen += Math.max(targetClean.length, userClean.length, 1);
    });

    const accuracy = Math.max(
      0,
      Math.min(100, Number(((1 - totalEditDist / Math.max(totalMaxLen, 1)) * 100).toFixed(1)))
    );
    const effectiveChars = Math.min(totalUserChars, Math.round(totalTargetChars * 1.15));
    const cpm = Number(((effectiveChars / elapsedMs) * 60000).toFixed(1));
    const score = Number((cpm * (accuracy / 100)).toFixed(1));

    return { elapsedMs, cpm, accuracy, score };
  }

  function buildLocalFallbackReport(metrics, localDetection) {
    const rules = localDetection.rules.slice(0, 6);
    let title = "稳健全拼派";
    if (rules.includes("ong=on") || rules.includes("in=ing") || rules.includes("an=ang")) {
      title = "后鼻音省电派";
    } else if (rules.includes("z=zh") || rules.includes("c=ch") || rules.includes("s=sh")) {
      title = "平翘舌自由人";
    } else if (rules.includes("l=n") || rules.includes("l=r")) {
      title = "声母漂移大师";
    } else if (metrics.cpm >= 210 && metrics.accuracy >= 94) {
      title = "键盘无影手";
    } else if (state.backspaces >= 10) {
      title = "精雕细琢派";
    }

    let comment = "";
    if (rules.length > 0) {
      comment = `键速 ${metrics.cpm} 键/分、精准度 ${metrics.accuracy}%，捕捉到 ${rules.slice(0, 3).join(" / ")} 等个人敲击习惯；开启下方推荐模糊音后，不必反复回删也能稳稳上屏。`;
    } else if (metrics.accuracy >= 96) {
      comment = `键速 ${metrics.cpm} 键/分且精准度高达 ${metrics.accuracy}%，标准全拼功底非常扎实！可按需微调下方容错开关提升极限连打容忍度。`;
    } else {
      comment = `键速 ${metrics.cpm} 键/分，退格 ${state.backspaces} 次；手速飞快的同时偶有邻键抢跑，建议适当开启下方容错规则兜底。`;
    }

    return {
      title,
      comment,
      rules,
      reasons: localDetection.reasons,
      source: "fallback",
    };
  }

  async function estimateLocalRank(score) {
    try {
      const resp = await fetch("/api/leaderboard?limit=200", {
        method: "GET",
        headers: { Accept: "application/json" },
      });
      if (!resp.ok) return null;
      const data = await resp.json();
      const board = Array.isArray(data.leaderboard) ? data.leaderboard : [];
      const higherCount = board.filter((item) => Number(item.score) > score).length;
      return {
        rank: higherCount + 1,
        total: Number(data.total || board.length) + 1,
      };
    } catch {
      return null;
    }
  }

  function startTimerIfNeeded() {
    if (state.startedAt > 0) return;
    state.startedAt = performance.now();
    state.timerId = window.setInterval(updateLiveTelemetry, 100);
  }

  function stopTimer() {
    if (state.timerId !== null) {
      window.clearInterval(state.timerId);
      state.timerId = null;
    }
  }

  function updateLiveTelemetry() {
    if (!state.startedAt) {
      el.timer.textContent = "0.0s";
      el.cpm.innerHTML = '0 <small>键/分</small>';
      return;
    }
    const elapsedMs = Math.max(100, performance.now() - state.startedAt);
    el.timer.textContent = `${(elapsedMs / 1000).toFixed(1)}s`;

    const finishedChars = state.samples.reduce(
      (acc, s) => acc + cleanAlpha(s.raw_input).length,
      0
    );
    const currentChars = cleanAlpha(el.pinyinInput.value).length;
    const totalTyped = finishedChars + currentChars;
    const liveCpm = elapsedMs >= 800 ? Math.round((totalTyped / elapsedMs) * 60000) : 0;
    el.cpm.innerHTML = `${liveCpm} <small>键/分</small>`;
  }

  function renderCurrentSentence() {
    const sentence = RACE_SENTENCES[state.sentenceIndex];
    const total = RACE_SENTENCES.length;
    const refPinyin = sentence.syllables.map((s) => s.py).join(" ");

    el.progressLabel.textContent = `${state.sentenceIndex + 1} / ${total}`;
    el.progressFill.style.width = `${(((state.sentenceIndex + 1) / total) * 100).toFixed(2)}%`;
    el.sentenceTag.textContent = sentence.tag;
    el.playerBadge.textContent = `选手：${state.nickname}`;
    el.refPinyinText.textContent = refPinyin;
    el.nextSentenceBtn.textContent =
      state.sentenceIndex === total - 1 ? "完成并生成诊断" : "下一句";
    el.pinyinInput.setAttribute(
      "enterkeyhint",
      state.sentenceIndex === total - 1 ? "done" : "next"
    );

    el.syllableGrid.innerHTML = "";
    sentence.syllables.forEach((item, idx) => {
      const chip = document.createElement("div");
      chip.className = "syllable-chip";
      chip.dataset.idx = String(idx);

      const pySpan = document.createElement("span");
      pySpan.className = "syllable-py";
      pySpan.textContent = item.py;

      const hzSpan = document.createElement("span");
      hzSpan.className = "syllable-hz";
      hzSpan.textContent = item.hanzi;

      chip.append(pySpan, hzSpan);
      el.syllableGrid.appendChild(chip);
    });

    el.pinyinInput.value = "";
    el.imeWarning.hidden = true;
    el.inputHint.hidden = true;
    updateSentenceProgressHighlight();
    el.pinyinInput.focus();
  }

  function updateSentenceProgressHighlight() {
    const sentence = RACE_SENTENCES[state.sentenceIndex];
    const targetCleanLen = sentence.syllables.reduce((acc, s) => acc + s.py.length, 0);
    const typedCleanLen = cleanAlpha(el.pinyinInput.value).length;

    el.charCounter.textContent = `${typedCleanLen} / ${targetCleanLen} 键`;

    let accLen = 0;
    const chips = el.syllableGrid.querySelectorAll(".syllable-chip");
    let activeMarked = false;
    chips.forEach((chip, idx) => {
      const syllLen = sentence.syllables[idx].py.length;
      const start = accLen;
      const end = accLen + syllLen;
      accLen = end;

      chip.classList.remove("is-done", "is-active");
      if (typedCleanLen >= end) {
        chip.classList.add("is-done");
      } else if (!activeMarked && typedCleanLen >= start) {
        chip.classList.add("is-active");
        activeMarked = true;
      }
    });
  }

  function beginRace(nickname) {
    stopTimer();
    state.nickname = nickname;
    state.sentenceIndex = 0;
    state.startedAt = 0;
    state.finishedAt = 0;
    state.backspaces = 0;
    state.skipNextBeforeInputDelete = false;
    state.samples = [];
    state.recommendedRules = [];
    state.ruleReasons = {};
    state.selectedRules = new Set();

    el.timer.textContent = "0.0s";
    el.cpm.innerHTML = '0 <small>键/分</small>';
    el.backspaces.textContent = "0";

    showView("race");
    renderCurrentSentence();
  }

  async function submitRace() {
    stopTimer();
    state.finishedAt = performance.now();
    showView("loading");

    const metrics = computeMetrics();
    const localDetection = detectRulesFromSamples(state.samples);

    const payload = {
      nickname: state.nickname,
      target_text: state.samples.map((s) => s.text).join(" / "),
      target_pinyin: state.samples.map((s) => s.reference_pinyin).join(" / "),
      typed_input: state.samples.map((s) => s.raw_input).join(" / "),
      duration_sec: Number(Math.max(0.1, metrics.elapsedMs / 1000).toFixed(2)),
      backspaces: state.backspaces,
      cpm: metrics.cpm,
      accuracy: metrics.accuracy,
      score: metrics.score,
      elapsed_ms: Math.round(metrics.elapsedMs),
      samples: state.samples,
      reference_pinyin: state.samples.map((s) => s.reference_pinyin).join(" / "),
      raw_input: state.samples.map((s) => s.raw_input).join(" / "),
      detected_rules: localDetection.rules,
    };

    let report = null;
    try {
      const controller = new AbortController();
      const timeoutId = window.setTimeout(() => controller.abort(), 9000);
      const resp = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      window.clearTimeout(timeoutId);

      if (resp.ok) {
        const data = await resp.json();
        const rawRules = Array.isArray(data.rules)
          ? data.rules
          : Array.isArray(data.record?.rules)
          ? data.record.rules
          : [];
        const normalizedRules = [];
        const reasons = { ...localDetection.reasons };

        rawRules.forEach((item) => {
          if (typeof item === "string") {
            const cid = normalizeRuleId(item);
            if (cid && !normalizedRules.includes(cid)) normalizedRules.push(cid);
          } else if (item && typeof item === "object") {
            const cid = normalizeRuleId(item.id || item.rule || item.rule_id);
            if (cid) {
              if (!normalizedRules.includes(cid)) normalizedRules.push(cid);
              if (item.reason) reasons[cid] = String(item.reason);
            }
          }
        });

        if (data.rule_reasons && typeof data.rule_reasons === "object") {
          Object.entries(data.rule_reasons).forEach(([k, v]) => {
            const cid = normalizeRuleId(k);
            if (cid && v) reasons[cid] = String(v);
          });
        }

        report = {
          rank: data.rank ?? data.record?.rank ?? null,
          total: data.total ?? null,
          cpm: Number(data.cpm ?? data.record?.cpm ?? metrics.cpm),
          accuracy: Number(data.accuracy ?? data.record?.accuracy ?? metrics.accuracy),
          score: Number(data.score ?? data.record?.score ?? metrics.score),
          title: String(data.title || data.record?.title || "个性化选手"),
          comment: String(data.comment || data.record?.comment || ""),
          rules: normalizedRules,
          reasons,
          source: data.fallback ? "fallback" : "deepseek",
        };
      }
    } catch {
      // 网络异常或后端接口尚未就绪时静默切入本地兜底
    }

    if (!report) {
      const fallback = buildLocalFallbackReport(metrics, localDetection);
      const rankEstimate = await estimateLocalRank(metrics.score);
      report = {
        rank: rankEstimate ? rankEstimate.rank : null,
        total: rankEstimate ? rankEstimate.total : null,
        cpm: metrics.cpm,
        accuracy: metrics.accuracy,
        score: metrics.score,
        title: fallback.title,
        comment: fallback.comment,
        rules: fallback.rules,
        reasons: fallback.reasons,
        source: "fallback",
      };
    }

    renderResult(report, metrics);
  }

  function renderResult(report, metrics) {
    state.recommendedRules = report.rules;
    state.ruleReasons = report.reasons || {};
    state.selectedRules = new Set(report.rules);

    el.resultTitle.textContent = report.title || "稳健全拼派";
    if (report.source === "fallback") {
      el.resultSourceBadge.textContent = "本地诊断兜底";
      el.resultSourceBadge.classList.add("is-fallback");
    } else {
      el.resultSourceBadge.textContent = "DeepSeek 实时点评";
      el.resultSourceBadge.classList.remove("is-fallback");
    }

    if (report.rank != null) {
      el.resultRank.textContent = report.total
        ? `#${report.rank} / ${report.total}`
        : `#${report.rank}`;
    } else {
      el.resultRank.textContent = "--";
    }

    el.resultScore.textContent = Number(report.score).toFixed(1);
    el.resultCpm.textContent = Number(report.cpm).toFixed(1);
    el.resultAccuracy.textContent = `${Number(report.accuracy).toFixed(1)}%`;
    el.resultElapsed.textContent = `总用时 ${(metrics.elapsedMs / 1000).toFixed(1)}s`;
    el.resultBackspaces.textContent = `退格 ${state.backspaces} 次`;
    el.resultNickname.textContent = `选手：${state.nickname}`;
    el.resultComment.textContent = report.comment;

    state.currentFilter = report.rules.length > 0 ? "all" : "all";
    el.filterTabs.forEach((tab) => {
      const active = tab.dataset.filter === state.currentFilter;
      tab.classList.toggle("is-active", active);
      tab.setAttribute("aria-selected", active ? "true" : "false");
    });

    renderRulesPanel();
    renderRimeYaml();
    showView("result");
  }

  function getOrderedCatalog() {
    const recSet = new Set(state.recommendedRules);
    return [...RULES_CATALOG].sort((a, b) => {
      const aRec = recSet.has(a.id) ? 0 : 1;
      const bRec = recSet.has(b.id) ? 0 : 1;
      return aRec - bRec;
    });
  }

  function renderRulesPanel() {
    el.selectedRulesCount.textContent = String(state.selectedRules.size);
    const recSet = new Set(state.recommendedRules);
    const ordered = getOrderedCatalog().filter((rule) => {
      if (state.currentFilter === "all") return true;
      if (state.currentFilter === "recommended") return recSet.has(rule.id);
      return rule.category === state.currentFilter;
    });

    el.rulesList.innerHTML = "";
    if (ordered.length === 0) {
      const empty = document.createElement("div");
      empty.className = "rule-empty";
      empty.textContent = "本次输入暂未触发该分类下的明显模糊音，可切换「全部规则」手动勾选。";
      el.rulesList.appendChild(empty);
      return;
    }

    ordered.forEach((rule) => {
      const isEnabled = state.selectedRules.has(rule.id);
      const isRec = recSet.has(rule.id);
      const reason = state.ruleReasons[rule.id];

      const labelEl = document.createElement("label");
      labelEl.className = `rule-item${isEnabled ? " is-enabled" : ""}`;

      const info = document.createElement("div");
      info.className = "rule-info";

      const head = document.createElement("div");
      head.className = "rule-head";

      const idSpan = document.createElement("span");
      idSpan.className = "rule-id";
      idSpan.textContent = rule.id;

      const catSpan = document.createElement("span");
      catSpan.className = "rule-cat";
      catSpan.textContent = rule.category;

      head.append(idSpan, catSpan);
      if (isRec) {
        const recSpan = document.createElement("span");
        recSpan.className = "rule-rec-badge";
        recSpan.textContent = "推荐";
        head.appendChild(recSpan);
      }

      const titleDiv = document.createElement("div");
      titleDiv.className = "rule-label";
      titleDiv.textContent = rule.label;

      const descP = document.createElement("p");
      descP.className = "rule-desc";
      descP.textContent = `${rule.description}（示例：${rule.examples.join("，")}）`;

      info.append(head, titleDiv, descP);

      if (reason) {
        const reasonP = document.createElement("p");
        reasonP.className = "rule-reason";
        reasonP.textContent = `触发依据：${reason}`;
        info.appendChild(reasonP);
      }

      const switchSpan = document.createElement("span");
      switchSpan.className = "switch";

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = isEnabled;
      checkbox.dataset.ruleId = rule.id;
      checkbox.setAttribute("aria-label", `${rule.id} ${rule.label}`);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) {
          state.selectedRules.add(rule.id);
          labelEl.classList.add("is-enabled");
        } else {
          state.selectedRules.delete(rule.id);
          labelEl.classList.remove("is-enabled");
        }
        el.selectedRulesCount.textContent = String(state.selectedRules.size);
        renderRimeYaml();
      });

      const slider = document.createElement("span");
      slider.className = "switch-slider";
      slider.setAttribute("aria-hidden", "true");

      switchSpan.append(checkbox, slider);
      labelEl.append(info, switchSpan);
      el.rulesList.appendChild(labelEl);
    });
  }

  /**
   * 生成与 profiler.rules_schema.export_rime_algebra 完全一致的 Rime patch YAML。
   */
  function exportRimeAlgebraYaml(selectedSet) {
    const selectedIds = RULES_CATALOG.map((r) => r.id).filter((id) => selectedSet.has(id));
    if (selectedIds.length === 0) {
      return "patch:\n  speller/algebra/+: []\n";
    }

    const lines = ["patch:", "  speller/algebra/+:"];
    const seenExpr = new Set();

    selectedIds.forEach((ruleId) => {
      const rule = RULES_BY_ID[ruleId];
      if (!rule) return;
      const ruleExprs = rule.algebra.filter((expr) => !seenExpr.has(expr));
      if (ruleExprs.length === 0) return;
      lines.push(`    # [${rule.id}] ${rule.label}`);
      ruleExprs.forEach((expr) => {
        seenExpr.add(expr);
        const escaped = expr.replace(/'/g, "''");
        lines.push(`    - '${escaped}'`);
      });
    });

    if (lines.length === 2) {
      return "patch:\n  speller/algebra/+: []\n";
    }
    return `${lines.join("\n")}\n`;
  }

  function renderRimeYaml() {
    el.rimeYamlPreview.textContent = exportRimeAlgebraYaml(state.selectedRules);
  }

  async function copyTextWithFallback(text) {
    if (navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        // fallback below
      }
    }
    const helper = document.createElement("textarea");
    helper.value = text;
    helper.setAttribute("readonly", "");
    helper.style.position = "fixed";
    helper.style.left = "-9999px";
    document.body.appendChild(helper);
    helper.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    document.body.removeChild(helper);
    return ok;
  }

  function handleNextSentence() {
    const sentence = RACE_SENTENCES[state.sentenceIndex];
    const targetCleanLen = sentence.syllables.reduce((acc, s) => acc + s.py.length, 0);
    const rawValue = el.pinyinInput.value.trim();
    const cleanLen = cleanAlpha(rawValue).length;

    if (hasNonLatinInput(rawValue) && cleanLen < Math.ceil(targetCleanLen * 0.45)) {
      el.inputHint.textContent = "请切换英文键盘输入纯拼音字母后再提交本句。";
      el.inputHint.hidden = false;
      el.pinyinInput.focus();
      return;
    }

    const minRequired = Math.max(6, Math.ceil(targetCleanLen * 0.45));
    if (cleanLen < minRequired) {
      el.inputHint.textContent = `当前仅输入 ${cleanLen} 个拼音字母，请至少完成本句大部分拼音（约 ${minRequired} 键以上）再继续。`;
      el.inputHint.hidden = false;
      el.pinyinInput.focus();
      return;
    }

    el.inputHint.hidden = true;
    startTimerIfNeeded();

    state.samples.push({
      text: sentence.text,
      reference_pinyin: sentence.syllables.map((s) => s.py).join(" "),
      raw_input: rawValue.toLowerCase(),
    });

    if (state.sentenceIndex < RACE_SENTENCES.length - 1) {
      state.sentenceIndex += 1;
      renderCurrentSentence();
    } else {
      submitRace();
    }
  }

  function incrementBackspaces() {
    state.backspaces += 1;
    el.backspaces.textContent = String(state.backspaces);
  }

  function bindEvents() {
    // 恢复上次昵称
    try {
      const saved = window.localStorage.getItem(STORAGE_NICKNAME_KEY);
      if (saved) el.nicknameInput.value = saved;
    } catch {
      // ignore storage failure
    }

    el.welcomeForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const nickname = el.nicknameInput.value.trim();
      if (!nickname) {
        el.nicknameError.textContent = "请先输入昵称再开始竞速。";
        el.nicknameError.hidden = false;
        el.nicknameInput.focus();
        return;
      }
      el.nicknameError.hidden = true;
      try {
        window.localStorage.setItem(STORAGE_NICKNAME_KEY, nickname);
      } catch {
        // ignore
      }
      beginRace(nickname);
    });

    el.pinyinInput.addEventListener("compositionstart", () => {
      state.isComposing = true;
    });

    el.pinyinInput.addEventListener("compositionend", () => {
      state.isComposing = false;
      el.imeWarning.hidden = !hasNonLatinInput(el.pinyinInput.value);
      updateSentenceProgressHighlight();
    });

    el.pinyinInput.addEventListener("beforeinput", (e) => {
      if (e.inputType === "deleteContentBackward") {
        if (state.skipNextBeforeInputDelete) {
          state.skipNextBeforeInputDelete = false;
          return;
        }
        incrementBackspaces();
      }
    });

    el.pinyinInput.addEventListener("keydown", (e) => {
      if (e.key === "Backspace") {
        incrementBackspaces();
        state.skipNextBeforeInputDelete = true;
        window.setTimeout(() => {
          state.skipNextBeforeInputDelete = false;
        }, 0);
        return;
      }
      if (e.key === "Enter" && !e.shiftKey && !state.isComposing) {
        e.preventDefault();
        handleNextSentence();
      }
    });

    el.pinyinInput.addEventListener("input", () => {
      if (el.pinyinInput.value.length > 0) {
        startTimerIfNeeded();
      }
      el.inputHint.hidden = true;
      el.imeWarning.hidden = !hasNonLatinInput(el.pinyinInput.value);
      updateSentenceProgressHighlight();
      updateLiveTelemetry();
    });

    el.nextSentenceBtn.addEventListener("click", handleNextSentence);

    el.restartRaceBtn.addEventListener("click", () => {
      beginRace(state.nickname);
    });

    el.filterTabs.forEach((tab) => {
      tab.addEventListener("click", () => {
        state.currentFilter = tab.dataset.filter || "all";
        el.filterTabs.forEach((item) => {
          const active = item === tab;
          item.classList.toggle("is-active", active);
          item.setAttribute("aria-selected", active ? "true" : "false");
        });
        renderRulesPanel();
      });
    });

    el.resetRecommendedBtn.addEventListener("click", () => {
      state.selectedRules = new Set(state.recommendedRules);
      renderRulesPanel();
      renderRimeYaml();
    });

    el.copyRimeBtn.addEventListener("click", async () => {
      const yaml = exportRimeAlgebraYaml(state.selectedRules);
      const copied = await copyTextWithFallback(yaml);
      el.copyFeedback.hidden = false;
      el.copyFeedback.textContent = copied
        ? "已复制 Rime 模糊音配置到剪贴板，可直接粘贴至 rime_ice.custom.yaml。"
        : "自动复制受限，请长按上方代码块手动全选复制。";
      window.setTimeout(() => {
        el.copyFeedback.hidden = true;
      }, 3500);
    });

    el.downloadRimeBtn.addEventListener("click", () => {
      const yaml = exportRimeAlgebraYaml(state.selectedRules);
      const blob = new Blob([yaml], { type: "text/yaml;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "rime_ice.custom.yaml";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    });

    el.playAgainBtn.addEventListener("click", () => {
      beginRace(state.nickname);
    });
  }

  bindEvents();
})();
