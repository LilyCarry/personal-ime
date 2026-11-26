"""
本地 GPU 输入法推理服务 (TCP 127.0.0.1:18765)
加载微调后的 Qwen3-0.6B LoRA + 拼音 Trie 容错约束 Beam Search，
供 Windows 小狼毫 via ime_bridge.dll 实时调用。
"""

from __future__ import annotations

import itertools
import json
import socket
import threading
import time
from collections import defaultdict
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F
from peft import PeftModel
from transformers import AutoModelForCausalLM, AutoTokenizer
from transformers.cache_utils import DynamicCache

ROOT = Path(__file__).resolve().parent.parent
MODEL_DIR = Path(r"C:\Users\xu762\.cache\modelscope\hub\models\Qwen\Qwen3-0___6B-Base")
LORA_DIR = ROOT / "checkpoints" / "qwen3_06b_lora" / "final"
DICT_PATH = Path(r"C:\Users\xu762\AppData\Roaming\Rime\cn_dicts\8105.dict.yaml")

HOST = "127.0.0.1"
PORT = 18765

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
            variants[sy[:k]].append((sy, 0.9))
        # 缺介母/尾字母 (如 yixa -> yixia, cowu -> cuowu)
        if len(sy) >= 3:
            for i in range(1, len(sy)):
                dropped = sy[:i] + sy[i + 1 :]
                if len(dropped) >= 2:
                    variants[dropped].append((sy, 3.0))
        # 音节内部相邻换序 (如 kaui -> kuai)
        if len(sy) >= 2:
            for i in range(len(sy) - 1):
                if sy[i] != sy[i + 1]:
                    swapped = sy[:i] + sy[i + 1] + sy[i] + sy[i + 2 :]
                    variants[swapped].append((sy, 2.8))
            # 邻键替按 (如 wishi -> woshi)
            for i in range(len(sy)):
                for nb in QWERTY_NEIGHBORS.get(sy[i], ""):
                    sub = sy[:i] + nb + sy[i + 1 :]
                    variants[sub].append((sy, 3.2 if i > 0 else 3.8))
            # 多敲蹭键 (从索引 0 后就开始允许，覆盖 paoshibnie -> bie多n)
            for i in range(len(sy)):
                for nb in QWERTY_NEIGHBORS.get(sy[i], ""):
                    ins = sy[: i + 1] + nb + sy[i + 1 :]
                    variants[ins].append((sy, 3.2))
                variants[sy[: i + 1] + sy[i] + sy[i + 1 :]].append((sy, 3.2))

    # 额外支持常见翘舌首字母缩写打反 (hs->sh, hz->zh, hc->ch)
    for sy in syllables:
        if sy.startswith(("sh", "zh", "ch")):
            variants[sy[1] + sy[0]].append((sy, 3.0))

    dedup = {}
    for typed, items in variants.items():
        best = {}
        for sy, pen in items:
            if sy not in best or pen < best[sy]:
                best[sy] = pen
        dedup[typed] = best
    return dedup


class IMEInferenceEngine:
    def __init__(self):
        t0 = time.perf_counter()
        print("Loading Qwen3-0.6B LoRA + Pinyin Trie...")
        self.char_readings = load_char_readings(DICT_PATH)
        self.tok = AutoTokenizer.from_pretrained(str(MODEL_DIR), local_files_only=True)
        base = AutoModelForCausalLM.from_pretrained(
            str(MODEL_DIR), dtype=torch.bfloat16, device_map="cuda", local_files_only=True
        )
        peft_model = PeftModel.from_pretrained(base, str(LORA_DIR))
        self.model = peft_model.merge_and_unload()
        self.model.eval()
        self.root, self.tok_text = build_token_trie(self.tok, self.char_readings)
        all_sylls = {sy for rs in self.char_readings.values() for sy in rs}
        self.typed_map = build_typo_variants(all_sylls)
        self.lock = threading.Lock()
        self.resp_cache: dict[tuple[str, str], list[str]] = {}
        print(f"Engine ready in {time.perf_counter()-t0:.2f}s")
        # Warmup CUDA kernels
        self.predict("你好", "wmxqcf")

    def _match_at(self, keys: str, pos: int, memo: dict):
        if pos in memo:
            return memo[pos]
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
                cands = self.typed_map.get(chunk)
                if not cands:
                    continue
                for sy, pen in cands.items():
                    child = node.kids.get(sy)
                    if child is not None and acc_pen + pen <= 4.5:
                        dfs(child, cur + L, acc_pen + pen)

        dfs(self.root, pos, 0.0)
        res = [(tid, ep, pen) for tid, (ep, pen) in results.items()]
        memo[pos] = res
        return res

    @torch.no_grad()
    def predict(self, ctx: str, keys: str, beam_width: int = 2, progress_bonus: float = 4.2) -> tuple[list[str], float]:
        keys = keys.lower().strip()
        if not keys or not keys.isalpha() or len(keys) > 36:
            return [], 0.0
        ctx_trim = ctx[-28:] if ctx else ""
        ck = (ctx_trim, keys)
        if ck in self.resp_cache:
            return self.resp_cache[ck], 0.1

        with self.lock:
            t_s = time.perf_counter()
            memo: dict[int, list] = {}
            first_cands = self._match_at(keys, 0, memo)
            if not first_cands:
                return [], 0.0

            prompt = f"{ctx_trim}\n<{' '.join(keys)}>\n"
            inp_ids = self.tok(prompt, return_tensors="pt", add_special_tokens=False).input_ids.to("cuda")
            out = self.model(input_ids=inp_ids, use_cache=True)
            init_logp = F.log_softmax(out.logits[0, -1, :].float(), dim=-1).cpu().numpy()
            init_cache = out.past_key_values

            n_keys = len(keys)
            scored = []
            for tid, ep, pen in first_cands:
                lp = float(init_logp[tid])
                scored.append((lp + progress_bonus * ep - pen, lp, ep, [tid], self.tok_text[tid], pen))
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
                while active and step < 14:
                    step += 1
                    out = self.model(input_ids=last_ids, past_key_values=cur_cache, use_cache=True)
                    cur_cache = out.past_key_values
                    batch_logp = F.log_softmax(out.logits[:, -1, :].float(), dim=-1).cpu().numpy()

                    next_cands = []
                    for b_idx, (sc, lm_sc, pos, tids, txt, tot_pen) in enumerate(active):
                        row_logp = batch_logp[b_idx]
                        for tid, ep, pen in self._match_at(keys, pos, memo):
                            if tot_pen + pen > 7.0:
                                continue
                            t_lp = float(row_logp[tid])
                            new_lm = lm_sc + t_lp
                            new_sc = new_lm + progress_bonus * ep - (tot_pen + pen)
                            next_cands.append((new_sc, new_lm, ep, tids + [tid], txt + self.tok_text[tid], tot_pen + pen, b_idx))

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
                    uniq.append(b[4])
                if len(uniq) >= 3:
                    break
            if len(self.resp_cache) > 512:
                self.resp_cache.clear()
            self.resp_cache[ck] = uniq
            return uniq, ms


def handle_client(conn: socket.socket, engine: IMEInferenceEngine):
    try:
        data = b""
        while True:
            chunk = conn.recv(4096)
            if not chunk:
                break
            data += chunk
            if b"\n" in data:
                break
        line = data.decode("utf-8", errors="ignore").strip()
        if not line:
            return
        req = json.loads(line)
        cands, ms = engine.predict(req.get("ctx", ""), req.get("keys", ""))
        resp = json.dumps({"cands": cands, "ms": round(ms, 1)}, ensure_ascii=False) + "\n"
        conn.sendall(resp.encode("utf-8"))
    except Exception as e:
        try:
            conn.sendall((json.dumps({"cands": [], "err": str(e)}) + "\n").encode("utf-8"))
        except Exception:
            pass
    finally:
        conn.close()


def main():
    engine = IMEInferenceEngine()
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind((HOST, PORT))
    srv.listen(16)
    print(f"Personal IME inference server listening on {HOST}:{PORT} ...")
    while True:
        conn, _ = srv.accept()
        threading.Thread(target=handle_client, args=(conn, engine), daemon=True).start()


if __name__ == "__main__":
    main()
