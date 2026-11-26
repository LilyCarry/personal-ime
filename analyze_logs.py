"""
双端输入法真实日志对比分析脚本 (PC vs Android)
输出核心指标、输入省码形态、硬件连击统计、最易犯的截断与错键规律。
"""

import json
import re
from collections import Counter, defaultdict
from pathlib import Path
from pypinyin import Style, lazy_pinyin

WIN_LOG = Path(r"C:\Users\xu762\AppData\Roaming\Rime\user_logs\win_2026-11.jsonl")
AND_LOG = Path(r"C:\Users\xu762\AppData\Roaming\Rime\user_logs\android_2026-11.jsonl")


def clean_sylls(text: str) -> list[str]:
    sylls = [s.replace("ü", "v") for s in lazy_pinyin(text, style=Style.NORMAL, v_to_u=False)]
    return ["".join(ch for ch in s if "a" <= ch <= "z") for s in sylls]


def levenshtein_ops(src: str, tgt: str):
    """简单字符级对齐统计替换/插入/删除/换序"""
    if src == tgt:
        return []
    # 检查纯换序
    if len(src) == len(tgt):
        diffs = [i for i in range(len(src)) if src[i] != tgt[i]]
        if len(diffs) == 2 and diffs[1] == diffs[0] + 1 and src[diffs[0]] == tgt[diffs[1]] and src[diffs[1]] == tgt[diffs[0]]:
            return [("swap", src[diffs[0]:diffs[0]+2] + "->" + tgt[diffs[0]:diffs[0]+2])]
        if len(diffs) == 1:
            i = diffs[0]
            return [("sub", f"{src[i]}->{tgt[i]}")]
    if len(src) == len(tgt) + 1:
        for i in range(len(src)):
            if src[:i] + src[i+1:] == tgt:
                return [("extra", f"+{src[i]}")]
    if len(src) + 1 == len(tgt):
        for i in range(len(tgt)):
            if tgt[:i] + tgt[i+1:] == src:
                return [("omit", f"-{tgt[i]}")]
    return [("multi", f"{src}->{tgt}")]


def analyze_file(path: Path, label: str):
    recs = [json.loads(l) for l in path.read_text(encoding="utf-8").splitlines() if l.strip()]
    n = len(recs)
    chars = sum(len(r["committed"]) for r in recs)
    bs_cnt = sum(1 for r in recs if r.get("backspaces", 0) > 0)
    retype_cnt = sum(1 for r in recs if "replaces_seq" in r)
    non_first = sum(1 for r in recs if r.get("selected_idx", 0) > 0)
    paged = sum(1 for r in recs if r.get("page_turns", 0) > 0)
    segmented = sum(1 for r in recs if r.get("segmented"))

    chatter_recs = [r for r in recs if r.get("chatter")]
    chatter_keys = Counter()
    for r in chatter_recs:
        for c in r["chatter"]:
            chatter_keys[c.split(":")[0]] += 1

    raw_sum, full_sum = 0, 0
    mode_cnt = Counter()
    drop_g_cnt = 0
    drop_tail_vowel_cnt = 0
    typo_ops = Counter()
    typo_examples = defaultdict(list)

    for i, r in enumerate(recs):
        tgt = r["committed"]
        raw = r["raw_input"]
        fa = r.get("first_attempt", raw)

        # 统计组词期短改错 (排除明显大退格换词)
        if r.get("backspaces", 0) > 0 and fa and fa != raw and abs(len(fa) - len(raw)) <= 2 and len(raw) >= 2:
            ops = levenshtein_ops(fa, raw)
            for kind, desc in ops:
                if kind != "multi":
                    typo_ops[(kind, desc)] += 1
                    if len(typo_examples[(kind, desc)]) < 3:
                        typo_examples[(kind, desc)].append(f"{fa}->{raw}({tgt})")

        # 统计上屏后删字重打中拼音相近的纯误触
        if "replaces_seq" in r:
            prev = None
            for j in range(i - 1, max(-1, i - 5), -1):
                if recs[j]["seq"] == r["replaces_seq"]:
                    prev = recs[j]
                    break
            if prev and prev["raw_input"] != raw and abs(len(prev["raw_input"]) - len(raw)) <= 2 and len(raw) >= 2:
                ops = levenshtein_ops(prev["raw_input"], raw)
                for kind, desc in ops:
                    if kind != "multi":
                        typo_ops[(kind, desc)] += 1
                        if len(typo_examples[(kind, desc)]) < 3:
                            typo_examples[(kind, desc)].append(f"{prev['raw_input']}({prev['committed']})->{raw}({tgt})")

        if not raw.isalpha():
            continue
        sylls = clean_sylls(tgt)
        if not sylls or any(not s for s in sylls):
            continue
        full_py = "".join(sylls)
        init_py = "".join(s[0] for s in sylls)
        raw_sum += len(raw)
        full_sum += len(full_py)

        if raw == full_py:
            mode_cnt["exact_full"] += 1
        elif raw == init_py:
            mode_cnt["pure_initials"] += 1
        elif len(raw) < len(full_py):
            mode_cnt["partial_cut"] += 1
            # 检测省掉后鼻音 g 或尾音
            if full_py.endswith("g") and not raw.endswith("g") and raw == full_py[:-1]:
                drop_g_cnt += 1
            elif len(sylls[-1]) >= 2 and full_py[:-1] == raw:
                drop_tail_vowel_cnt += 1
        else:
            mode_cnt["extra_or_diff"] += 1

    # 统计非首选原因里，哪些词最常被抢占
    non_first_pairs = Counter()
    for r in recs:
        if r.get("selected_idx", 0) > 0:
            top1 = (r.get("top_cands") or ["?"])[0]
            if top1 != r["committed"] and len(r["committed"]) <= 4:
                non_first_pairs[(r["raw_input"], top1, r["committed"])] += 1

    print(f"================ {label} ================")
    print(f"总上屏: {n} 次 | 总字符: {chars} 字 | 平均每次 {chars/max(n,1):.2f} 字")
    print(f"组词期退格率: {bs_cnt}/{n} ({bs_cnt/max(n,1)*100:.1f}%)")
    print(f"上屏后删字重打率: {retype_cnt}/{n} ({retype_cnt/max(n,1)*100:.1f}%)")
    print(f"非首选率: {non_first}/{n} ({non_first/max(n,1)*100:.1f}%) | 翻页: {paged} | 分段选词: {segmented} ({segmented/max(n,1)*100:.1f}%)")
    print(f"硬件极短连击 (<80ms): {len(chatter_recs)} 次 | 分布: {dict(chatter_keys)}")
    if full_sum:
        print(f"按键节省率: {(1 - raw_sum/full_sum)*100:.1f}% (实际敲 {raw_sum} 键 vs 标准全拼 {full_sum} 键)")
    print(f"输入形态: {dict(mode_cnt)} (其中整词砍尾 g={drop_g_cnt}, 整词砍末字母={drop_tail_vowel_cnt})")
    print("高频微操作错键 Top 12:")
    for k, cnt in typo_ops.most_common(12):
        print(f"  {k[0]:5s} {k[1]:10s} x{cnt:<2d} | e.g. {', '.join(typo_examples[k])}")
    print("高频非首选 Top 10 (Rime第1 -> 你实际选的):")
    for (raw, t1, sel), cnt in non_first_pairs.most_common(10):
        print(f"  {raw:12s} | {t1} -> {sel} (x{cnt})")
    print()


if __name__ == "__main__":
    analyze_file(WIN_LOG, "PC 小狼毫 (win_2026-11)")
    analyze_file(AND_LOG, "Android 红米K70E (android_2026-11)")
