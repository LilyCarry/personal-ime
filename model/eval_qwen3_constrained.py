"""
用「拼音 Trie + 邻键容错约束 Beam Search」评测刚训好的 Qwen3-0.6B LoRA（以及纯裸模型对比），
直接测试 16 条真实日志用例和 200 条分层验证集。
"""

import itertools
import json
import time
from collections import defaultdict
from pathlib import Path

import torch
import torch.nn.functional as F
from transformers import AutoModelForCausalLM, AutoTokenizer
from transformers.cache_utils import DynamicCache
from peft import PeftModel

ROOT = Path(__file__).resolve().parent.parent
MODEL_DIR = Path(r"C:\Users\xu762\.cache\modelscope\hub\models\Qwen\Qwen3-0___6B-Base")
LORA_DIR = ROOT / "checkpoints" / "qwen3_06b_lora" / "final"
DICT_PATH = Path(r"C:\Users\xu762\AppData\Roaming\Rime\cn_dicts\8105.dict.yaml")
VAL_PATH = ROOT / "data" / "processed" / "val.jsonl"
REAL_PATH = ROOT / "data" / "processed" / "real_eval.json"

QWERTY_NEIGHBORS = {
    'q': 'wa', 'w': 'qase', 'e': 'wsdr', 'r': 'edft', 't': 'rfgy',
    'y': 'tghu', 'u': 'yhji', 'i': 'ujko', 'o': 'iklp', 'p': 'ol',
    'a': 'qwsz', 's': 'qwedxz', 'd': 'wersfc', 'f': 'ertdgv',
    'g': 'rtyfhb', 'h': 'tyugjn', 'j': 'yuihkm', 'k': 'uiojlm',
    'l': 'iopk', 'z': 'asx', 'x': 'zsdc', 'c': 'xdfv',
    'v': 'cfgb', 'b': 'vghn', 'n': 'bhjm', 'm': 'njk',
}


def load_char_readings(path: Path):
    readings = defaultdict(list)
    seen = defaultdict(set)
    in_body = False
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            s = line.strip()
            if s == "...":
                in_body = True
                continue
            if not in_body or not s or s.startswith("#"):
                continue
            parts = s.split("\t")
            if len(parts) < 2:
                continue
            ch, py = parts[0], parts[1].strip()
            if len(ch) == 1 and py.isalpha() and py not in seen[ch]:
                seen[ch].add(py)
                readings[ch].append(py)
    return dict(readings)


class TrieNode:
    __slots__ = ("kids", "tokens")

    def __init__(self):
        self.kids = {}
        self.tokens = []


def build_token_trie(tok, char_readings):
    root = TrieNode()
    tok_text = {}
    for token_str, tid in tok.get_vocab().items():
        s = tok.convert_tokens_to_string([token_str])
        if not s or len(s) > 4:
            continue
        if all(c in char_readings for c in s):
            tok_text[tid] = s
            combos = list(itertools.islice(itertools.product(*(char_readings[c][:2] for c in s)), 8))
            for sylls in combos:
                node = root
                for sy in sylls:
                    if sy not in node.kids:
                        node.kids[sy] = TrieNode()
                    node = node.kids[sy]
                node.tokens.append(tid)
    return root, tok_text


def build_typo_variants(syllables):
    variants = defaultdict(list)
    for sy in syllables:
        variants[sy].append((sy, 0.0))
        for k in range(1, len(sy)):
            variants[sy[:k]].append((sy, 1.0))
        if len(sy) >= 2:
            # 缺介母/尾字母
            for i in range(1, len(sy)):
                dropped = sy[:i] + sy[i + 1 :]
                if len(dropped) >= 2:
                    variants[dropped].append((sy, 3.2))
            # 相邻换序 (如 changhs -> changsh, kaui -> kuai)
            for i in range(len(sy) - 1):
                if sy[i] != sy[i + 1]:
                    swapped = sy[:i] + sy[i + 1] + sy[i] + sy[i + 2 :]
                    variants[swapped].append((sy, 3.0))
            # 邻键替按 (如 wishi -> woshi)
            for i in range(1, len(sy)):
                for nb in QWERTY_NEIGHBORS.get(sy[i], ""):
                    sub = sy[:i] + nb + sy[i + 1 :]
                    variants[sub].append((sy, 3.4))
            # 多敲蹭键 (如 paoshibnie -> bie多n)
            for i in range(1, len(sy)):
                for nb in QWERTY_NEIGHBORS.get(sy[i], ""):
                    ins = sy[: i + 1] + nb + sy[i + 1 :]
                    variants[ins].append((sy, 3.5))
                ins_before = sy[:i] + sy[i - 1] + sy[i:]
                variants[ins_before].append((sy, 3.5))
        # 首字母为邻键替换 (如 wishi -> woshi 的 i/o 在第2位已经覆盖; 处理首字母按偏)
        for nb in QWERTY_NEIGHBORS.get(sy[0], ""):
            if len(sy) >= 2:
                variants[nb + sy[1:]].append((sy, 4.0))

    # 额外支持跨音节缩写上的 2 字母换序 (如 changhs -> ch + s)
    dedup = {}
    for typed, items in variants.items():
        best = {}
        for sy, pen in items:
            if sy not in best or pen < best[sy]:
                best[sy] = pen
        dedup[typed] = best
    return dedup


def match_tokens_at(keys: str, pos: int, root: TrieNode, typed_map: dict):
    results = {}
    n = len(keys)

    def dfs(node: TrieNode, cur: int, acc_pen: float):
        if cur > pos and node.tokens:
            for tid in node.tokens:
                prev = results.get(tid)
                if prev is None or (cur, -acc_pen) > (prev[0], -prev[1]):
                    results[tid] = (cur, acc_pen)
        if cur >= n or not node.kids:
            return
        max_len = min(8, n - cur)
        for L in range(1, max_len + 1):
            chunk = keys[cur : cur + L]
            cands = typed_map.get(chunk)
            if not cands:
                continue
            for sy, pen in cands.items():
                child = node.kids.get(sy)
                if child is not None and acc_pen + pen <= 5.5:
                    dfs(child, cur + L, acc_pen + pen)

    dfs(root, pos, 0.0)
    return [(tid, ep, pen) for tid, (ep, pen) in results.items()]


def main():
    t0 = time.perf_counter()
    char_readings = load_char_readings(DICT_PATH)
    tok = AutoTokenizer.from_pretrained(str(MODEL_DIR), local_files_only=True)
    base = AutoModelForCausalLM.from_pretrained(
        str(MODEL_DIR), dtype=torch.bfloat16, device_map="cuda", local_files_only=True
    )
    model = PeftModel.from_pretrained(base, str(LORA_DIR))
    model = model.merge_and_unload()
    model.eval()
    root, tok_text = build_token_trie(tok, char_readings)
    all_sylls = {sy for rs in char_readings.values() for sy in rs}
    typed_map = build_typo_variants(all_sylls)
    print(f"Loaded merged Qwen3-0.6B LoRA + Trie in {time.perf_counter()-t0:.2f}s")

    @torch.no_grad()
    def decode_constrained(ctx: str, keys: str, beam_width: int = 8, progress_bonus: float = 4.2):
        t_s = time.perf_counter()
        ctx_trim = ctx[-28:] if ctx else ""
        prompt = f"{ctx_trim}\n<{' '.join(keys)}>\n"
        inp_ids = tok(prompt, return_tensors="pt", add_special_tokens=False).input_ids.to("cuda")
        out = model(input_ids=inp_ids, use_cache=True)
        init_logp = F.log_softmax(out.logits[0, -1, :].float(), dim=-1)
        init_cache = out.past_key_values

        n_keys = len(keys)
        first_cands = match_tokens_at(keys, 0, root, typed_map)
        if not first_cands:
            return [], 0.0

        scored = []
        for tid, ep, pen in first_cands:
            lp = init_logp[tid].item()
            scored.append((lp + progress_bonus * ep - pen, lp, ep, [tid], tok_text[tid], pen))
        scored.sort(key=lambda x: x[0], reverse=True)
        beams = scored[:beam_width]

        completed, active = [], []
        for b in beams:
            (completed if b[2] == n_keys else active).append(b)

        if active:
            cur_cache = DynamicCache()
            for layer_idx in range(len(init_cache.layers)):
                k = init_cache.layers[layer_idx].keys.repeat(len(active), 1, 1, 1)
                v = init_cache.layers[layer_idx].values.repeat(len(active), 1, 1, 1)
                cur_cache.update(k, v, layer_idx)
            last_ids = torch.tensor([[b[3][-1]] for b in active], device="cuda", dtype=torch.long)

            step = 0
            while active and step < 16:
                step += 1
                out = model(input_ids=last_ids, past_key_values=cur_cache, use_cache=True)
                cur_cache = out.past_key_values
                batch_logp = F.log_softmax(out.logits[:, -1, :].float(), dim=-1)

                next_cands = []
                for b_idx, (sc, lm_sc, pos, tids, txt, tot_pen) in enumerate(active):
                    row_logp = batch_logp[b_idx]
                    for tid, ep, pen in match_tokens_at(keys, pos, root, typed_map):
                        if tot_pen + pen > 8.0:
                            continue
                        t_lp = row_logp[tid].item()
                        new_lm = lm_sc + t_lp
                        new_sc = new_lm + progress_bonus * ep - (tot_pen + pen)
                        next_cands.append((new_sc, new_lm, ep, tids + [tid], txt + tok_text[tid], tot_pen + pen, b_idx))

                if not next_cands:
                    break
                next_cands.sort(key=lambda x: x[0], reverse=True)
                top = next_cands[:beam_width]
                new_active, keep_idx = [], []
                for sc, lm_sc, ep, tids, txt, tot_pen, b_idx in top:
                    if ep == n_keys:
                        completed.append((sc, lm_sc, ep, tids, txt, tot_pen))
                    else:
                        new_active.append((sc, lm_sc, ep, tids, txt, tot_pen))
                        keep_idx.append(b_idx)
                active = new_active
                if active:
                    cur_cache.batch_select_indices(torch.tensor(keep_idx, device="cuda", dtype=torch.long))
                    last_ids = torch.tensor([[b[3][-1]] for b in active], device="cuda", dtype=torch.long)

        torch.cuda.synchronize()
        ms = (time.perf_counter() - t_s) * 1000
        completed.sort(key=lambda x: x[0], reverse=True)
        uniq, seen_t = [], set()
        for b in completed:
            if b[4] not in seen_t:
                seen_t.add(b[4])
                uniq.append((b[4], round(b[0], 2)))
        return uniq[:3], ms

    real_cases = json.loads(REAL_PATH.read_text(encoding="utf-8"))
    # Warmup
    decode_constrained("你好", "cesh")

    top1_hits = 0
    top3_hits = 0
    latencies = []
    print("\n=== Qwen3-0.6B LoRA + Pinyin-Trie Constrained Beam Search (16 Real Cases) ===")
    for rec in real_cases:
        cands, ms = decode_constrained(rec["ctx"], rec["keys"])
        latencies.append(ms)
        texts = [t for t, _ in cands]
        t1 = len(texts) > 0 and texts[0] == rec["target"]
        t3 = rec["target"] in texts
        if t1:
            top1_hits += 1
        if t3:
            top3_hits += 1
        tag = "TOP1" if t1 else ("TOP3" if t3 else "MISS")
        print(f"  [{tag:4s}] {rec['keys']:12s} -> {' | '.join(texts):24s} (tgt={rec['target']}) [{ms:.0f}ms]")
    print(f"Real Top-1: {top1_hits}/{len(real_cases)} | Top-3: {top3_hits}/{len(real_cases)} | avg={sum(latencies)/len(latencies):.0f}ms")

    val_samples = [json.loads(l) for l in VAL_PATH.read_text(encoding="utf-8").splitlines() if l.strip()][::10]
    by_prof = defaultdict(lambda: {"t1": 0, "t3": 0, "n": 0})
    for rec in val_samples:
        cands, _ = decode_constrained(rec["ctx"], rec["keys"])
        texts = [t for t, _ in cands]
        d = by_prof[rec["profile"]]
        d["n"] += 1
        if texts and texts[0] == rec["target"]:
            d["t1"] += 1
        if rec["target"] in texts:
            d["t3"] += 1
    print("\n=== Val 200 Stratified (Constrained Beam Search) ===")
    for p, d in by_prof.items():
        print(f"  {p:14s}: Top-1={d['t1']/d['n']*100:.1f}% | Top-3={d['t3']/d['n']*100:.1f}%")


if __name__ == "__main__":
    main()
