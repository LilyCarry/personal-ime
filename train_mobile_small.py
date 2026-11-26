"""
移动端专用 ~29M 参数字级 Transformer 输入法模型训练脚本 (RMSNorm + RoPE + SwiGLU + SDPA)
输入格式: <ctx> 上文单字... <key> 按键单字母... <tgt> 目标汉字... <eos>
特点: 词表仅 ~7000~8500 (8105常用字 + a-z + 标点), INT8量化后约 ~29MB, 可离线跑在手机 CPU 上。
"""

from __future__ import annotations

import json
import math
import time
from pathlib import Path

import torch
import torch.nn as nn
import torch.nn.functional as F
from torch.utils.data import Dataset, DataLoader

ROOT = Path(r"C:\Users\xu762\Documents\Github\personal-ime")
TRAIN_PATH = ROOT / "data" / "processed" / "train.jsonl"
VAL_PATH = ROOT / "data" / "processed" / "val.jsonl"
REAL_PATH = ROOT / "data" / "processed" / "real_eval.json"
DICT_8105 = Path(r"C:\Users\xu762\AppData\Roaming\Rime\cn_dicts\8105.dict.yaml")
CKPT_DIR = ROOT / "checkpoints" / "mobile_29m"

PAD_ID, BOS_ID, EOS_ID, CTX_ID, KEY_ID, TGT_ID, UNK_ID = 0, 1, 2, 3, 4, 5, 6
SPECIAL_TOKENS = ["<pad>", "<bos>", "<eos>", "<ctx>", "<key>", "<tgt>", "<unk>"]


def build_vocab() -> dict[str, int]:
    vocab = {tok: i for i, tok in enumerate(SPECIAL_TOKENS)}
    # ASCII 字母数字与常用符号
    for ch in "abcdefghijklmnopqrstuvwxyz0123456789-_.' ":
        if ch not in vocab:
            vocab[ch] = len(vocab)
    # 常用中文与英文标点
    for ch in "，。！？、；：“”‘’（）…—,.!?;:~":
        if ch not in vocab:
            vocab[ch] = len(vocab)
    # 8105 通用规范汉字表
    if DICT_8105.exists():
        in_body = False
        with DICT_8105.open("r", encoding="utf-8") as f:
            for line in f:
                s = line.strip()
                if s == "...":
                    in_body = True
                    continue
                if not in_body or not s or s.startswith("#"):
                    continue
                ch = s.split("\t")[0]
                if len(ch) == 1 and ch not in vocab:
                    vocab[ch] = len(vocab)
    return vocab


class CharTokenizer:
    def __init__(self, vocab: dict[str, int]):
        self.vocab = vocab
        self.id_to_tok = {i: t for t, i in vocab.items()}

    def encode_chars(self, text: str) -> list[int]:
        return [self.vocab.get(ch, UNK_ID) for ch in text]

    def decode_ids(self, ids: list[int]) -> str:
        out = []
        for i in ids:
            if i in (PAD_ID, BOS_ID, EOS_ID, CTX_ID, KEY_ID, TGT_ID):
                continue
            out.append(self.id_to_tok.get(i, ""))
        return "".join(out)

    def encode_sample(self, ctx: str, keys: str, target: str | None = None, max_ctx: int = 28):
        ctx_ids = self.encode_chars(ctx[-max_ctx:]) if ctx else []
        key_ids = self.encode_chars(keys[:48])
        prefix = [CTX_ID] + ctx_ids + [KEY_ID] + key_ids + [TGT_ID]
        if target is None:
            return prefix
        tgt_ids = self.encode_chars(target) + [EOS_ID]
        return prefix, tgt_ids


class IMEDataset(Dataset):
    def __init__(self, path: Path, tok: CharTokenizer):
        self.samples = []
        with path.open("r", encoding="utf-8") as f:
            for line in f:
                rec = json.loads(line)
                prefix, tgt = tok.encode_sample(rec["ctx"], rec["keys"], rec["target"])
                if len(prefix) + len(tgt) <= 120:
                    self.samples.append((prefix, tgt))

    def __len__(self):
        return len(self.samples)

    def __getitem__(self, idx):
        return self.samples[idx]


def collate_fn(batch):
    max_len = max(len(p) + len(t) for p, t in batch)
    bsz = len(batch)
    input_ids = torch.full((bsz, max_len), PAD_ID, dtype=torch.long)
    labels = torch.full((bsz, max_len), -100, dtype=torch.long)
    for i, (p, t) in enumerate(batch):
        seq = p + t
        L = len(seq)
        input_ids[i, :L] = torch.tensor(seq, dtype=torch.long)
        # 自回归 next-token prediction: 只对 <tgt> 之后的目标汉字 + <eos> 计算交叉熵
        p_len = len(p)
        labels[i, p_len - 1 : L - 1] = torch.tensor(t, dtype=torch.long)
    return input_ids, labels


class RMSNorm(nn.Module):
    def __init__(self, dim: int, eps: float = 1e-6):
        super().__init__()
        self.weight = nn.Parameter(torch.ones(dim))
        self.eps = eps

    def forward(self, x):
        return x * torch.rsqrt(x.pow(2).mean(-1, keepdim=True) + self.eps) * self.weight


def precompute_rope(dim: int, max_seq: int = 256, theta: float = 10000.0):
    freqs = 1.0 / (theta ** (torch.arange(0, dim, 2).float() / dim))
    t = torch.arange(max_seq).float()
    freqs = torch.outer(t, freqs)
    return torch.cos(freqs), torch.sin(freqs)


def apply_rope(x, cos, sin):
    # x: (B, H, T, D)
    T = x.size(2)
    c = cos[:T].unsqueeze(0).unsqueeze(0)
    s = sin[:T].unsqueeze(0).unsqueeze(0)
    x1, x2 = x[..., ::2], x[..., 1::2]
    out = torch.stack((-x2, x1), dim=-1).flatten(-2)
    # Interleaved rotation
    rx1 = x1 * c - x2 * s
    rx2 = x1 * s + x2 * c
    return torch.stack((rx1, rx2), dim=-1).flatten(-2)


class CausalSelfAttention(nn.Module):
    def __init__(self, d_model: int, n_heads: int):
        super().__init__()
        self.n_heads = n_heads
        self.head_dim = d_model // n_heads
        self.qkv = nn.Linear(d_model, 3 * d_model, bias=False)
        self.proj = nn.Linear(d_model, d_model, bias=False)

    def forward(self, x, cos, sin, kv_cache=None):
        B, T, C = x.shape
        q, k, v = self.qkv(x).chunk(3, dim=-1)
        q = q.view(B, T, self.n_heads, self.head_dim).transpose(1, 2)
        k = k.view(B, T, self.n_heads, self.head_dim).transpose(1, 2)
        v = v.view(B, T, self.n_heads, self.head_dim).transpose(1, 2)

        if kv_cache is not None:
            past_k, past_v = kv_cache
            offset = past_k.size(2)
            c_slice = cos[offset : offset + T].unsqueeze(0).unsqueeze(0)
            s_slice = sin[offset : offset + T].unsqueeze(0).unsqueeze(0)
            q1, q2 = q[..., ::2], q[..., 1::2]
            k1, k2 = k[..., ::2], k[..., 1::2]
            q = torch.stack((q1 * c_slice - q2 * s_slice, q1 * s_slice + q2 * c_slice), dim=-1).flatten(-2)
            k = torch.stack((k1 * c_slice - k2 * s_slice, k1 * s_slice + k2 * c_slice), dim=-1).flatten(-2)
            k = torch.cat([past_k, k], dim=2)
            v = torch.cat([past_v, v], dim=2)
            new_cache = (k, v)
            is_causal = (T > 1)
        else:
            q = apply_rope(q, cos, sin)
            k = apply_rope(k, cos, sin)
            new_cache = (k, v)
            is_causal = True

        attn_out = F.scaled_dot_product_attention(q, k, v, is_causal=is_causal)
        attn_out = attn_out.transpose(1, 2).contiguous().view(B, T, C)
        return self.proj(attn_out), new_cache


class SwiGLU(nn.Module):
    def __init__(self, d_model: int, d_ff: int):
        super().__init__()
        self.w1 = nn.Linear(d_model, d_ff, bias=False)
        self.w2 = nn.Linear(d_ff, d_model, bias=False)
        self.w3 = nn.Linear(d_model, d_ff, bias=False)

    def forward(self, x):
        return self.w2(F.silu(self.w1(x)) * self.w3(x))


class Block(nn.Module):
    def __init__(self, d_model: int, n_heads: int, d_ff: int):
        super().__init__()
        self.norm1 = RMSNorm(d_model)
        self.attn = CausalSelfAttention(d_model, n_heads)
        self.norm2 = RMSNorm(d_model)
        self.mlp = SwiGLU(d_model, d_ff)

    def forward(self, x, cos, sin, kv_cache=None):
        h, new_cache = self.attn(self.norm1(x), cos, sin, kv_cache)
        x = x + h
        x = x + self.mlp(self.norm2(x))
        return x, new_cache


class TinyIMEModel(nn.Module):
    def __init__(self, vocab_size: int, d_model: int = 512, n_layers: int = 8, n_heads: int = 8, d_ff: int = 1408):
        super().__init__()
        self.embed = nn.Embedding(vocab_size, d_model)
        self.blocks = nn.ModuleList([Block(d_model, n_heads, d_ff) for _ in range(n_layers)])
        self.norm = RMSNorm(d_model)
        self.head = nn.Linear(d_model, vocab_size, bias=False)
        self.head.weight = self.embed.weight  # weight tying
        cos, sin = precompute_rope(d_model // n_heads, max_seq=256)
        self.register_buffer("cos", cos, persistent=False)
        self.register_buffer("sin", sin, persistent=False)

    def forward(self, input_ids, past_kvs=None):
        x = self.embed(input_ids)
        new_kvs = [] if past_kvs is not None or not self.training else None
        for i, blk in enumerate(self.blocks):
            cache_i = past_kvs[i] if past_kvs is not None else None
            x, nc = blk(x, self.cos, self.sin, cache_i)
            if new_kvs is not None:
                new_kvs.append(nc)
        logits = self.head(self.norm(x))
        return logits, new_kvs

    @torch.no_grad()
    def greedy_decode(self, prefix_ids: list[int], max_new: int = 16) -> list[int]:
        device = self.embed.weight.device
        generated = []
        cur = torch.tensor([prefix_ids], dtype=torch.long, device=device)
        past = None
        for _ in range(max_new):
            h = self.embed(cur)
            next_past = []
            for i, blk in enumerate(self.blocks):
                c_i = past[i] if past is not None else None
                h, nc = blk(h, self.cos, self.sin, c_i)
                next_past.append(nc)
            past = next_past
            next_id = self.head(self.norm(h[:, -1, :])).argmax(dim=-1).item()
            if next_id == EOS_ID:
                break
            generated.append(next_id)
            cur = torch.tensor([[next_id]], dtype=torch.long, device=device)
        return generated


def evaluate(model: TinyIMEModel, tok: CharTokenizer, val_samples: list[dict], real_cases: list[dict]):
    model.eval()
    by_prof = {}
    for rec in val_samples:
        p = rec["profile"]
        if p not in by_prof:
            by_prof[p] = {"exact": 0, "char_ok": 0, "char_tot": 0, "n": 0}
        prefix = tok.encode_sample(rec["ctx"], rec["keys"])
        with torch.amp.autocast("cuda", dtype=torch.bfloat16):
            pred_ids = model.greedy_decode(prefix, max_new=18)
        pred = tok.decode_ids(pred_ids)
        tgt = rec["target"]
        d = by_prof[p]
        d["n"] += 1
        if pred == tgt:
            d["exact"] += 1
        for a, b in zip(pred, tgt):
            if a == b:
                d["char_ok"] += 1
        d["char_tot"] += len(tgt)

    summary = {}
    for p, d in by_prof.items():
        summary[p] = {
            "exact_acc": round(d["exact"] / max(d["n"], 1) * 100, 2),
            "char_acc": round(d["char_ok"] / max(d["char_tot"], 1) * 100, 2),
        }

    real_hits = 0
    real_preds = []
    for rec in real_cases:
        prefix = tok.encode_sample(rec["ctx"], rec["keys"])
        with torch.amp.autocast("cuda", dtype=torch.bfloat16):
            pred_ids = model.greedy_decode(prefix, max_new=18)
        pred = tok.decode_ids(pred_ids)
        ok = (pred == rec["target"])
        if ok:
            real_hits += 1
        real_preds.append((rec["keys"], rec["target"], pred, ok))
    model.train()
    return summary, real_hits, len(real_cases), real_preds


def main():
    CKPT_DIR.mkdir(parents=True, exist_ok=True)
    vocab = build_vocab()
    (CKPT_DIR / "vocab.json").write_text(json.dumps(vocab, ensure_ascii=False), encoding="utf-8")
    tok = CharTokenizer(vocab)
    print(f"Vocab size: {len(vocab)}")

    print("Loading datasets...")
    t0 = time.perf_counter()
    train_ds = IMEDataset(TRAIN_PATH, tok)
    val_samples = [json.loads(l) for l in VAL_PATH.read_text(encoding="utf-8").splitlines() if l.strip()]
    real_cases = json.loads(REAL_PATH.read_text(encoding="utf-8"))
    print(f"Loaded {len(train_ds)} train, {len(val_samples)} val, {len(real_cases)} real in {time.perf_counter()-t0:.1f}s")

    loader = DataLoader(train_ds, batch_size=192, shuffle=True, collate_fn=collate_fn, num_workers=0, pin_memory=True)

    model = TinyIMEModel(len(vocab), d_model=512, n_layers=8, n_heads=8, d_ff=1408).cuda()
    n_params = sum(p.numel() for p in model.parameters()) / 1e6
    print(f"Model params: {n_params:.2f}M")

    epochs = 3
    total_steps = epochs * len(loader)
    opt = torch.optim.AdamW(model.parameters(), lr=6e-4, weight_decay=0.05, betas=(0.9, 0.95))
    warmup = min(400, total_steps // 10)

    def lr_lambda(step):
        if step < warmup:
            return (step + 1) / warmup
        progress = (step - warmup) / max(1, total_steps - warmup)
        return 0.08 + 0.92 * 0.5 * (1.0 + math.cos(math.pi * progress))

    sched = torch.optim.lr_scheduler.LambdaLR(opt, lr_lambda)
    best_score = -1.0
    step = 0
    t_train = time.perf_counter()

    for ep in range(1, epochs + 1):
        model.train()
        running_loss = 0.0
        for b_idx, (inp, lbl) in enumerate(loader):
            inp = inp.cuda(non_blocking=True)
            lbl = lbl.cuda(non_blocking=True)
            opt.zero_grad(set_to_none=True)
            with torch.amp.autocast("cuda", dtype=torch.bfloat16):
                logits, _ = model(inp)
                loss = F.cross_entropy(logits.view(-1, logits.size(-1)), lbl.view(-1), ignore_index=-100)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            opt.step()
            sched.step()
            running_loss += loss.item()
            step += 1
            if step % 500 == 0:
                elapsed = time.perf_counter() - t_train
                print(f"[ep {ep}/{epochs} step {step}/{total_steps}] loss={running_loss/500:.4f} lr={sched.get_last_lr()[0]:.2e} elapsed={elapsed/60:.1f}m", flush=True)
                running_loss = 0.0

        # Eval end of epoch (stratified across all 4 profiles)
        t_ev = time.perf_counter()
        summary, real_hits, real_tot, real_preds = evaluate(model, tok, val_samples[::3], real_cases)
        avg_exact = sum(v["exact_acc"] for v in summary.values()) / len(summary)
        print(f"=== Epoch {ep} Eval ({time.perf_counter()-t_ev:.1f}s) | Real={real_hits}/{real_tot} | Val={summary} ===", flush=True)
        for keys, tgt, pred, ok in real_preds[:8]:
            print(f"  [{'OK' if ok else 'NO'}] {keys:14s} -> pred='{pred}' (tgt='{tgt}')", flush=True)
        if avg_exact > best_score:
            best_score = avg_exact
            torch.save({"model": model.state_dict(), "config": {"vocab_size": len(vocab), "d_model": 512, "n_layers": 8, "n_heads": 8, "d_ff": 1408}}, CKPT_DIR / "best.pt")
            print(f"Saved new best checkpoint (avg_exact={avg_exact:.2f}%)", flush=True)

    # Full 2000-sample final eval
    ckpt = torch.load(CKPT_DIR / "best.pt", map_location="cuda")
    model.load_state_dict(ckpt["model"])
    summary, real_hits, real_tot, real_preds = evaluate(model, tok, val_samples, real_cases)
    print("\n=== FINAL FULL VAL (2000 samples) + REAL REGRESSION ===")
    print("Val summary:", json.dumps(summary, ensure_ascii=False, indent=2))
    print(f"Real cases: {real_hits}/{real_tot}")
    for keys, tgt, pred, ok in real_preds:
        print(f"  [{'OK' if ok else 'NO'}] {keys:16s} -> pred='{pred}' (tgt='{tgt}')")


if __name__ == "__main__":
    main()
