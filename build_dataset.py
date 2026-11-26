"""
从 LCCC 中文对话语料批量生成 (prev_context, noisy_pinyin, target) 训练与验证集，
并整理用户今天真实采集到的翻车用例作为 real_eval.json 回归基准。
"""

from __future__ import annotations

import gzip
import json
import multiprocessing as mp
import random
import re
import time
from pathlib import Path

from noise_simulator import PROFILES, corrupt_text

ROOT = Path(r"C:\Users\xu762\Documents\Github\personal-ime")
TRAIN_SRC = ROOT / "data" / "raw" / "lccc_train_slice.jsonl"
TEST_SRC = ROOT / "data" / "raw" / "lccc_base_test.jsonl.gz"
OUT_DIR = ROOT / "data" / "processed"

CJK_CHAR_RE = re.compile(r"[\u4e00-\u9fff]")
VALID_TARGET_RE = re.compile(r"^[\u4e00-\u9fff]{2,14}$")
PUNCT_SPLIT_RE = re.compile(r"(?<=[，。！？；,.!?;…])")

# 清理 LCCC 分词空格：中文与中文/标点之间去空格
SPACE_AROUND_CJK_RE = re.compile(r"(?<=[\u4e00-\u9fff，。！？、；：“”‘’（）…—,.!?;:])\s+|\s+(?=[\u4e00-\u9fff，。！？、；：“”‘’（）…—,.!?;:])")


def clean_turn(text: str) -> str:
    text = SPACE_AROUND_CJK_RE.sub("", text.strip())
    text = re.sub(r"\s+", " ", text).strip()
    return text


def extract_pairs_from_dialogue(turns: list[str], rng: random.Random) -> list[tuple[str, str]]:
    cleaned = [clean_turn(t) for t in turns if t and t.strip()]
    cleaned = [t for t in cleaned if len(CJK_CHAR_RE.findall(t)) >= 2]
    if not cleaned:
        return []

    pairs: list[tuple[str, str]] = []
    history = ""
    for turn in cleaned:
        # 按标点切子句，也支持整句随机切一段 2~12 字作为打字目标
        clauses = [c for c in PUNCT_SPLIT_RE.split(turn) if c]
        for clause in clauses:
            pure = re.sub(r"[，。！？、；：“”‘’（）…—,.!?;:\s]+$", "", clause)
            if VALID_TARGET_RE.fullmatch(pure):
                ctx = "" if rng.random() < 0.22 else history[-32:]
                pairs.append((ctx, pure))
                # 如果较长（>=6字），额外随机切一次后半段，模拟用户在句中接续输入
                if len(pure) >= 6 and rng.random() < 0.45:
                    cut = rng.randint(2, len(pure) - 2)
                    sub_ctx = (history + pure[:cut])[-32:]
                    sub_tgt = pure[cut:]
                    if 2 <= len(sub_tgt) <= 12:
                        pairs.append((sub_ctx, sub_tgt))
            history = (history + clause)[-64:]
        history = (history + "。")[-64:]
    return pairs


def _worker_process(args):
    lines, seed, target_per_worker = args
    rng = random.Random(seed)
    profile_names = ["clean_full", "pc_kb", "mobile_thumb", "pure_initials"]
    profile_weights = [0.20, 0.30, 0.35, 0.15]

    out = []
    for raw_line in lines:
        try:
            turns = json.loads(raw_line)
        except Exception:
            continue
        pairs = extract_pairs_from_dialogue(turns, rng)
        for ctx, tgt in pairs:
            prof = rng.choices(profile_names, weights=profile_weights, k=1)[0]
            keys, tags = corrupt_text(tgt, PROFILES[prof], rng)
            if not keys or not keys.isascii() or len(keys) > 64:
                continue
            out.append(json.dumps({
                "ctx": ctx,
                "keys": keys,
                "target": tgt,
                "profile": prof,
            }, ensure_ascii=False))
            if len(out) >= target_per_worker:
                return out
    return out


def build_train(max_samples: int = 450_000):
    t0 = time.perf_counter()
    with TRAIN_SRC.open("r", encoding="utf-8") as f:
        all_lines = f.readlines()
    rng = random.Random(2026)
    rng.shuffle(all_lines)

    n_workers = min(8, max(2, mp.cpu_count() - 2))
    chunk_size = (len(all_lines) + n_workers - 1) // n_workers
    per_worker = (max_samples + n_workers - 1) // n_workers
    tasks = [
        (all_lines[i * chunk_size : (i + 1) * chunk_size], 1000 + i, per_worker)
        for i in range(n_workers)
    ]

    print(f"Generating up to {max_samples} training samples across {n_workers} workers...")
    out_path = OUT_DIR / "train.jsonl"
    total = 0
    with mp.Pool(n_workers) as pool, out_path.open("w", encoding="utf-8") as fo:
        for res in pool.imap_unordered(_worker_process, tasks):
            for line in res:
                if total >= max_samples:
                    break
                fo.write(line + "\n")
                total += 1
    print(f"Wrote {total} train samples to {out_path} in {time.perf_counter() - t0:.1f}s")


def build_val(per_profile: int = 500):
    rng = random.Random(9999)
    with gzip.open(TEST_SRC, "rt", encoding="utf-8") as f:
        dialogues = [json.loads(line) for line in f]
    all_pairs = []
    for d in dialogues:
        all_pairs.extend(extract_pairs_from_dialogue(d, rng))
    rng.shuffle(all_pairs)

    profiles = ["clean_full", "pc_kb", "mobile_thumb", "pure_initials"]
    out_path = OUT_DIR / "val.jsonl"
    idx = 0
    written = 0
    with out_path.open("w", encoding="utf-8") as fo:
        for prof in profiles:
            cnt = 0
            while cnt < per_profile and idx < len(all_pairs):
                ctx, tgt = all_pairs[idx]
                idx += 1
                keys, _ = corrupt_text(tgt, PROFILES[prof], rng)
                if not keys or not keys.isascii() or len(keys) > 64:
                    continue
                fo.write(json.dumps({
                    "ctx": ctx,
                    "keys": keys,
                    "target": tgt,
                    "profile": prof,
                }, ensure_ascii=False) + "\n")
                cnt += 1
                written += 1
    print(f"Wrote {written} val samples to {out_path}")


def build_real_eval():
    """整理今天实际采到的 win + android 真实翻车测试集。"""
    cases = [
        {"ctx": "然后把日志完善", "keys": "yixa", "target": "一下", "source": "win_seq34_omitted_i"},
        {"ctx": "你可以先分析我的打字数据来看看我平常比较容易犯什么", "keys": "cowu", "target": "错误", "source": "win_seq29_omitted_u"},
        {"ctx": "那个", "keys": "paoshibnie", "target": "跑识别", "source": "win_seq9_graze_n"},
        {"ctx": "主要是我的键盘现在也有点小问题。你看他有时候会", "keys": "lianda", "target": "连打", "source": "win_seq46_ctx_rank"},
        {"ctx": "键盘我过几天", "keys": "huanyixia", "target": "换一下", "source": "win_seq50_ctx_rank"},
        {"ctx": "键盘我", "keys": "guojit", "target": "过几天", "source": "win_seq48_cut"},
        {"ctx": "感觉我", "keys": "zijd", "target": "自己的", "source": "win_seq5_cut"},
        {"ctx": "你可以先把没啥用的脏库", "keys": "shanyxia", "target": "删一下", "source": "win_seq73_omitted_i"},
        {"ctx": "所以可能", "keys": "zheyik", "target": "这一块", "source": "win_seq60_ctx_rank"},
        {"ctx": "你好我", "keys": "changhs", "target": "尝试", "source": "android_seq8_swap_hs"},
        {"ctx": "你好我是", "keys": "wishi", "target": "我是", "source": "android_seq15_thumb_o_to_i"},
        {"ctx": "你好我尝试使用雾凇输入法", "keys": "wanyxi", "target": "玩一下", "source": "android_seq12_omitted_i"},
        {"ctx": "你好我是徐凯睿", "keys": "wuson", "target": "雾凇", "source": "android_seq10_drop_g"},
        {"ctx": "刚下课好饿，", "keys": "wmxqcf", "target": "我们先去吃饭", "source": "synthetic_initials"},
        {"ctx": "", "keys": "jttqzhbc", "target": "今天天气真不错", "source": "synthetic_initials"},
        {"ctx": "下午三点去", "keys": "tsgzx", "target": "图书馆自习", "source": "synthetic_initials"},
    ]
    out_path = OUT_DIR / "real_eval.json"
    out_path.write_text(json.dumps(cases, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Wrote {len(cases)} real regression cases to {out_path}")


if __name__ == "__main__":
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    build_real_eval()
    build_val(per_profile=500)
    build_train(max_samples=450_000)
