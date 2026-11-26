"""
真实中文输入法噪声模拟器 (Word-aware Pinyin + Phonetic Truncation + QWERTY Spatial/Timing Typos)

设计原则：
1. 词级一致性：先用 jieba 分词，按词决定「全拼 / 纯首字母 / 前重后轻半截」策略，避免每字独立随机导致的机械感。
2. 发音省力截断：优先截断后鼻音 g (ing->in)、复韵母尾音 (iang->ia, iao->ia, uo->o)，以及翘舌模糊 (zh->z)。
3. 真实 26 键物理与时序误触：
   - 相邻两键打反 (transposition: nihao -> niaho)
   - 二维 QWERTY 键盘坐标距离加权替换 (substitution: n<->m, g<->h/b, i<->o)
   - 连打吞键 (omission: xiang -> xiag, cuo -> co)
   - 蹭键/连击多打 (insertion: bao -> bgao, wo -> woo)
4. 支持后续由 Rime Lua 日志 (first_attempt / replaces_seq) 反哺校准噪声参数。
"""

from __future__ import annotations

import json
import math
import random
import re
import warnings
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable

with warnings.catch_warnings():
    warnings.simplefilter("ignore")
    import jieba
from pypinyin import Style, lazy_pinyin

# 屏蔽 jieba 启动日志噪音
jieba.setLogLevel(20)

CJK_RE = re.compile(r"[\u4e00-\u9fff]+")
TOKEN_SPLIT_RE = re.compile(r"([\u4e00-\u9fff]+|[A-Za-z0-9_.-]+)")

# 标准 QWERTY 键位二维坐标 (行错位对齐真实键盘)
QWERTY_POS: dict[str, tuple[float, float]] = {}
for r_idx, (row, offset) in enumerate([
    ("qwertyuiop", 0.0),
    ("asdfghjkl", 0.35),
    ("zxcvbnm", 0.85),
]):
    for c_idx, ch in enumerate(row):
        QWERTY_POS[ch] = (c_idx + offset, float(r_idx))


def _build_neighbor_weights() -> dict[str, list[tuple[str, float]]]:
    neighbors: dict[str, list[tuple[str, float]]] = {}
    for ch, (x1, y1) in QWERTY_POS.items():
        cands: list[tuple[str, float]] = []
        for other, (x2, y2) in QWERTY_POS.items():
            if other == ch:
                continue
            dist = math.hypot(x1 - x2, y1 - y2)
            if dist <= 1.55:
                # 距离越近权重越高 (水平邻键 dist=1.0, 斜向约 1.1~1.4)
                cands.append((other, 1.0 / (dist ** 2)))
        total = sum(w for _, w in cands)
        neighbors[ch] = [(k, w / total) for k, w in cands]
    return neighbors


QWERTY_NEIGHBORS = _build_neighbor_weights()

# 符合发音省力习惯的半截/模糊韵母映射
PHONETIC_TRUNCATIONS: list[tuple[str, list[str]]] = [
    ("iang", ["ia", "ian", "i"]),
    ("uang", ["ua", "uan", "u"]),
    ("iong", ["io", "ion", "i"]),
    ("ing", ["in", "i"]),
    ("ang", ["an", "a"]),
    ("eng", ["en", "e"]),
    ("ong", ["on", "o"]),
    ("iao", ["ia", "i"]),
    ("uai", ["ua", "u"]),
    ("uan", ["ua", "u"]),
    ("ian", ["ia", "i"]),
    ("uo", ["o", "u"]),
    ("ou", ["o"]),
    ("ao", ["a"]),
    ("ai", ["a"]),
    ("ei", ["e"]),
    ("ui", ["u"]),
    ("iu", ["i"]),
    ("ie", ["i"]),
    ("ve", ["v"]),
    ("ue", ["u"]),
]


@dataclass
class NoiseConfig:
    name: str = "casual_mobile"
    # 词级输入模式概率 (全拼词, 纯首字母词, 前重后轻混打词, 逐字独立混打)
    word_full_prob: float = 0.35
    word_init_prob: float = 0.28
    word_front_heavy_prob: float = 0.25
    word_mixed_prob: float = 0.12

    # 音节层半截/模糊音概率
    half_syllable_prob: float = 0.25
    fuzzy_zh_ch_sh_prob: float = 0.15

    # 键盘误触概率 (按音节/字符触发)
    typo_swap_prob: float = 0.045       # 相邻两键打反
    typo_sub_prob: float = 0.045        # 邻键按偏 (内部键为主)
    typo_omit_prob: float = 0.040       # 快打漏中间字母
    typo_insert_prob: float = 0.025     # 蹭键或连击多敲
    allow_initial_slip: bool = False    # 是否允许首字母也按偏 (heavy_sloppy 可开)
    initial_slip_prob: float = 0.015


PROFILES: dict[str, NoiseConfig] = {
    "clean_mixed": NoiseConfig(
        name="clean_mixed",
        word_full_prob=0.35,
        word_init_prob=0.30,
        word_front_heavy_prob=0.25,
        word_mixed_prob=0.10,
        half_syllable_prob=0.25,
        fuzzy_zh_ch_sh_prob=0.10,
        typo_swap_prob=0.0,
        typo_sub_prob=0.0,
        typo_omit_prob=0.0,
        typo_insert_prob=0.0,
    ),
    "casual_mobile": NoiseConfig(
        name="casual_mobile",
    ),
    "pc_kb": NoiseConfig(
        name="pc_kb",
        word_full_prob=0.40,
        word_init_prob=0.18,
        word_front_heavy_prob=0.30,
        word_mixed_prob=0.12,
        half_syllable_prob=0.32,
        fuzzy_zh_ch_sh_prob=0.12,
        typo_swap_prob=0.04,
        typo_sub_prob=0.035,
        typo_omit_prob=0.055,
        typo_insert_prob=0.035,
        allow_initial_slip=False,
    ),
    "mobile_thumb": NoiseConfig(
        name="mobile_thumb",
        word_full_prob=0.20,
        word_init_prob=0.25,
        word_front_heavy_prob=0.38,
        word_mixed_prob=0.17,
        half_syllable_prob=0.48,
        fuzzy_zh_ch_sh_prob=0.20,
        typo_swap_prob=0.065,
        typo_sub_prob=0.065,
        typo_omit_prob=0.065,
        typo_insert_prob=0.030,
        allow_initial_slip=True,
        initial_slip_prob=0.020,
    ),
    "clean_full": NoiseConfig(
        name="clean_full",
        word_full_prob=1.0,
        word_init_prob=0.0,
        word_front_heavy_prob=0.0,
        word_mixed_prob=0.0,
        half_syllable_prob=0.0,
        fuzzy_zh_ch_sh_prob=0.0,
        typo_swap_prob=0.0,
        typo_sub_prob=0.0,
        typo_omit_prob=0.0,
        typo_insert_prob=0.0,
    ),
    "pure_initials": NoiseConfig(
        name="pure_initials",
        word_full_prob=0.0,
        word_init_prob=1.0,
        word_front_heavy_prob=0.0,
        word_mixed_prob=0.0,
        half_syllable_prob=0.0,
        fuzzy_zh_ch_sh_prob=0.15,
        typo_swap_prob=0.0,
        typo_sub_prob=0.0,
        typo_omit_prob=0.0,
        typo_insert_prob=0.0,
    ),
    "heavy_sloppy": NoiseConfig(
        name="heavy_sloppy",
        word_full_prob=0.20,
        word_init_prob=0.38,
        word_front_heavy_prob=0.27,
        word_mixed_prob=0.15,
        half_syllable_prob=0.35,
        fuzzy_zh_ch_sh_prob=0.25,
        typo_swap_prob=0.075,
        typo_sub_prob=0.075,
        typo_omit_prob=0.065,
        typo_insert_prob=0.040,
        allow_initial_slip=True,
        initial_slip_prob=0.025,
    ),
}


def _weighted_choice(rng: random.Random, items: list[tuple[str, float]]) -> str:
    r = rng.random()
    acc = 0.0
    for k, w in items:
        acc += w
        if r <= acc:
            return k
    return items[-1][0]


def _truncate_syllable(sy: str, rng: random.Random, cfg: NoiseConfig) -> str:
    if len(sy) <= 1:
        return sy
    out = sy
    # 翘舌音省力简写 zh/ch/sh -> z/c/s
    if out[:2] in ("zh", "ch", "sh") and rng.random() < cfg.fuzzy_zh_ch_sh_prob:
        out = out[0] + out[2:]
    if len(out) <= 2:
        return out[0] if rng.random() < 0.5 else out
    for suffix, replacements in PHONETIC_TRUNCATIONS:
        if out.endswith(suffix) and len(out) > len(suffix):
            rep = rng.choice(replacements)
            return out[: -len(suffix)] + rep
    # 兜底：截掉尾部 1~len-1
    cut = rng.randint(1, len(out) - 1)
    return out[:cut]


def _apply_typos_to_chunk(chunk: str, rng: random.Random, cfg: NoiseConfig) -> tuple[str, list[str]]:
    """对单个词或音节串注入真实物理/时序错键。"""
    if len(chunk) <= 2:
        # 极短纯简拼 (如 sd / xz) 通常不破坏单字母结构，仅极低概率触发蹭键
        if len(chunk) == 2 and rng.random() < cfg.typo_insert_prob * 0.4:
            nb = QWERTY_NEIGHBORS.get(chunk[1])
            if nb:
                return chunk + _weighted_choice(rng, nb), ["graze"]
        return chunk, []
    tags: list[str] = []
    chars = list(chunk)

    # 1. 相邻交换 (主要在长度 >= 4 的连续敲击段发生)
    if len(chars) >= 4 and rng.random() < cfg.typo_swap_prob:
        start_min = 0 if cfg.allow_initial_slip else 1
        if len(chars) - 2 >= start_min:
            idx = rng.randint(start_min, len(chars) - 2)
            if chars[idx] != chars[idx + 1]:
                chars[idx], chars[idx + 1] = chars[idx + 1], chars[idx]
                tags.append("swap")

    # 2. 吞键漏打 (保留首字母，仅吞内部字母)
    if len(chars) >= 3 and rng.random() < cfg.typo_omit_prob:
        idx = rng.randint(1, len(chars) - 1)
        chars.pop(idx)
        tags.append("omit")

    # 3. 空间邻键偏按
    if len(chars) >= 2 and rng.random() < cfg.typo_sub_prob:
        idx = rng.randint(1, len(chars) - 1)
        nb = QWERTY_NEIGHBORS.get(chars[idx])
        if nb:
            chars[idx] = _weighted_choice(rng, nb)
            tags.append("sub")
    elif cfg.allow_initial_slip and rng.random() < cfg.initial_slip_prob:
        nb = QWERTY_NEIGHBORS.get(chars[0])
        if nb:
            chars[0] = _weighted_choice(rng, nb)
            tags.append("init_sub")

    # 4. 蹭键或连击多敲
    if len(chars) >= 1 and rng.random() < cfg.typo_insert_prob:
        idx = rng.randint(0, len(chars) - 1)
        if rng.random() < 0.5:
            # 连击重复
            chars.insert(idx + 1, chars[idx])
            tags.append("dup")
        else:
            nb = QWERTY_NEIGHBORS.get(chars[idx])
            if nb:
                chars.insert(idx + 1, _weighted_choice(rng, nb))
                tags.append("graze")

    return "".join(chars), tags


def corrupt_text(
    text: str,
    cfg: NoiseConfig | None = None,
    rng: random.Random | None = None,
) -> tuple[str, list[str]]:
    """
    将一段中文（可混杂英文单词）合成为符合真人敲击习惯的噪声拼音串。
    返回: (noisy_keys, tags)
    """
    cfg = cfg or PROFILES["casual_mobile"]
    rng = rng or random.Random()
    out_parts: list[str] = []
    tags_all: list[str] = []

    for seg in TOKEN_SPLIT_RE.findall(text):
        if not CJK_RE.fullmatch(seg):
            # 英文/数字原样保留（英文统一小写模拟日常不切大小写）
            if seg.isalpha():
                out_parts.append(seg.lower())
                tags_all.append("en")
            else:
                out_parts.append(seg)
            continue

        # 中文段按词切分，模拟词内习惯一致性
        for word in jieba.cut(seg, cut_all=False):
            sylls = [s.replace("ü", "v") for s in lazy_pinyin(word, style=Style.NORMAL, v_to_u=False)]
            sylls = [re.sub(r"[^a-z]", "", s) for s in sylls]
            sylls = [s for s in sylls if s]
            if not sylls:
                continue

            r = rng.random()
            p1 = cfg.word_full_prob
            p2 = p1 + cfg.word_init_prob
            p3 = p2 + cfg.word_front_heavy_prob

            word_chunks: list[str] = []
            if r < p1:
                # 全拼词（偶发半截音节）
                for s in sylls:
                    if rng.random() < cfg.half_syllable_prob * 0.4:
                        word_chunks.append(_truncate_syllable(s, rng, cfg))
                        tags_all.append("half")
                    else:
                        word_chunks.append(s)
                tags_all.append("word_full")
            elif r < p2:
                # 纯首字母词（如 图书馆 -> tsg）
                for s in sylls:
                    if s[:2] in ("zh", "ch", "sh") and rng.random() < 0.25:
                        word_chunks.append(s[:2])
                    else:
                        word_chunks.append(s[0])
                tags_all.append("word_init")
            elif r < p3 and len(sylls) >= 2:
                # 前重后轻（如 图书馆 -> tushug / 实验报告 -> shiyanbg）
                split_idx = rng.randint(1, len(sylls) - 1)
                for idx, s in enumerate(sylls):
                    if idx < split_idx:
                        if rng.random() < cfg.half_syllable_prob * 0.5:
                            word_chunks.append(_truncate_syllable(s, rng, cfg))
                        else:
                            word_chunks.append(s)
                    else:
                        word_chunks.append(s[0] if rng.random() < 0.7 else _truncate_syllable(s, rng, cfg))
                tags_all.append("word_front_heavy")
            else:
                # 逐字混打
                for s in sylls:
                    mode = rng.random()
                    if mode < 0.35:
                        word_chunks.append(s)
                    elif mode < 0.70:
                        word_chunks.append(s[0])
                    else:
                        word_chunks.append(_truncate_syllable(s, rng, cfg))
                tags_all.append("word_mixed")

            # 在词组级注入键盘物理/时序错键
            raw_word_keys = "".join(word_chunks)
            noisy_word_keys, typo_tags = _apply_typos_to_chunk(raw_word_keys, rng, cfg)
            out_parts.append(noisy_word_keys)
            tags_all.extend(typo_tags)

    return "".join(out_parts), sorted(set(tags_all))


def calibrate_from_logs(log_paths: Iterable[Path]) -> dict:
    """
    读取 Rime Lua 采集的 JSONL 日志，统计真实的退格/改错/简拼比例，
    供后续迭代调整 NoiseConfig 权重。
    """
    total = 0
    had_bs = 0
    retyped = 0
    selected_non_first = 0
    typo_pairs: list[tuple[str, str, str]] = []

    for path in log_paths:
        if not path.exists():
            continue
        with path.open("r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    continue
                total += 1
                if rec.get("backspaces", 0) > 0:
                    had_bs += 1
                    if rec.get("first_attempt") and rec["first_attempt"] != rec.get("raw_input"):
                        typo_pairs.append((rec["first_attempt"], rec.get("raw_input", ""), rec.get("committed", "")))
                if "replaces_seq" in rec:
                    retyped += 1
                if rec.get("selected_idx", 0) > 0:
                    selected_non_first += 1

    return {
        "total_commits": total,
        "backspace_rate": round(had_bs / max(total, 1), 4),
        "retype_after_commit_rate": round(retyped / max(total, 1), 4),
        "non_first_candidate_rate": round(selected_non_first / max(total, 1), 4),
        "sample_typo_pairs": typo_pairs[:10],
    }


if __name__ == "__main__":
    samples = [
        "我们现在去吃饭",
        "实验报告写完了吗",
        "代码写完了提交到git",
        "下午三点去图书馆自习",
        "今天天气真不错",
        "系统好像卡死了重启一下",
        "明天早八别忘了带校园卡",
    ]
    rng = random.Random(42)
    for profile_name in ("clean_mixed", "casual_mobile", "heavy_sloppy"):
        cfg = PROFILES[profile_name]
        print(f"\n=== Profile: {profile_name} ===")
        for s in samples:
            keys, tags = corrupt_text(s, cfg, rng)
            print(f"  {s:16s} -> {keys:24s} {tags}")
