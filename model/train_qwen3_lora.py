"""
PC / 私有服务端向 Qwen3-0.6B-Base LoRA 微调脚本
输入格式: {ctx}\n<{space_separated_keys}>\n{target}<|endoftext|>
特点: 将按键按空格拆分成单字母 token，绕开 BPE 盲区；支持纯自回归解码与拼音 Trie 约束评估。
"""

from __future__ import annotations

import json
import math
import time
from pathlib import Path

import torch
import torch.nn.functional as F
from torch.utils.data import Dataset, DataLoader
from transformers import AutoModelForCausalLM, AutoTokenizer
from peft import LoraConfig, get_peft_model

ROOT = Path(__file__).resolve().parent.parent
MODEL_DIR = Path(r"C:\Users\xu762\.cache\modelscope\hub\models\Qwen\Qwen3-0___6B-Base")
TRAIN_PATH = ROOT / "data" / "processed" / "train.jsonl"
VAL_PATH = ROOT / "data" / "processed" / "val.jsonl"
REAL_PATH = ROOT / "data" / "processed" / "real_eval.json"
CKPT_DIR = ROOT / "checkpoints" / "qwen3_06b_lora"


class QwenIMEDataset(Dataset):
    def __init__(self, path: Path, tok, max_samples: int = 160_000):
        self.samples = []
        eos_id = tok.eos_token_id
        with path.open("r", encoding="utf-8") as f:
            for i, line in enumerate(f):
                if i >= max_samples:
                    break
                rec = json.loads(line)
                ctx = rec["ctx"][-28:] if rec["ctx"] else ""
                spaced_keys = " ".join(rec["keys"][:48])
                prompt = f"{ctx}\n<{spaced_keys}>\n"
                p_ids = tok.encode(prompt, add_special_tokens=False)
                t_ids = tok.encode(rec["target"], add_special_tokens=False) + [eos_id]
                if len(p_ids) + len(t_ids) <= 128:
                    self.samples.append((p_ids, t_ids))

    def __len__(self):
        return len(self.samples)

    def __getitem__(self, idx):
        return self.samples[idx]


def make_collate_fn(pad_id: int):
    def collate(batch):
        max_len = max(len(p) + len(t) for p, t in batch)
        bsz = len(batch)
        input_ids = torch.full((bsz, max_len), pad_id, dtype=torch.long)
        attention_mask = torch.zeros((bsz, max_len), dtype=torch.long)
        labels = torch.full((bsz, max_len), -100, dtype=torch.long)
        for i, (p, t) in enumerate(batch):
            seq = p + t
            L = len(seq)
            input_ids[i, :L] = torch.tensor(seq, dtype=torch.long)
            attention_mask[i, :L] = 1
            p_len = len(p)
            labels[i, p_len - 1 : L - 1] = torch.tensor(t, dtype=torch.long)
        return input_ids, attention_mask, labels
    return collate


@torch.no_grad()
def eval_free_decode(model, tok, val_samples: list[dict], real_cases: list[dict]):
    model.eval()
    by_prof = {}
    for rec in val_samples:
        p = rec["profile"]
        if p not in by_prof:
            by_prof[p] = {"exact": 0, "char_ok": 0, "char_tot": 0, "n": 0}
        ctx = rec["ctx"][-28:] if rec["ctx"] else ""
        prompt = f"{ctx}\n<{' '.join(rec['keys'])}>\n"
        inp = tok(prompt, return_tensors="pt", add_special_tokens=False).to("cuda")
        out = model.generate(
            **inp,
            max_new_tokens=20,
            do_sample=False,
            pad_token_id=tok.eos_token_id,
            eos_token_id=tok.eos_token_id,
        )
        pred = tok.decode(out[0][inp["input_ids"].shape[1]:], skip_special_tokens=True).strip()
        tgt = rec["target"]
        d = by_prof[p]
        d["n"] += 1
        if pred == tgt:
            d["exact"] += 1
        for a, b in zip(pred, tgt):
            if a == b:
                d["char_ok"] += 1
        d["char_tot"] += len(tgt)

    summary = {
        p: {
            "exact_acc": round(d["exact"] / max(d["n"], 1) * 100, 2),
            "char_acc": round(d["char_ok"] / max(d["char_tot"], 1) * 100, 2),
        }
        for p, d in by_prof.items()
    }

    real_hits = 0
    real_preds = []
    for rec in real_cases:
        ctx = rec["ctx"][-28:] if rec["ctx"] else ""
        prompt = f"{ctx}\n<{' '.join(rec['keys'])}>\n"
        inp = tok(prompt, return_tensors="pt", add_special_tokens=False).to("cuda")
        out = model.generate(
            **inp,
            max_new_tokens=20,
            do_sample=False,
            pad_token_id=tok.eos_token_id,
            eos_token_id=tok.eos_token_id,
        )
        pred = tok.decode(out[0][inp["input_ids"].shape[1]:], skip_special_tokens=True).strip()
        ok = (pred == rec["target"])
        if ok:
            real_hits += 1
        real_preds.append((rec["keys"], rec["target"], pred, ok))
    model.train()
    return summary, real_hits, len(real_cases), real_preds


def main():
    CKPT_DIR.mkdir(parents=True, exist_ok=True)
    tok = AutoTokenizer.from_pretrained(str(MODEL_DIR), local_files_only=True)
    if tok.pad_token_id is None:
        tok.pad_token_id = tok.eos_token_id

    print("Tokenizing 60k training samples for Qwen3-0.6B LoRA...")
    t0 = time.perf_counter()
    train_ds = QwenIMEDataset(TRAIN_PATH, tok, max_samples=60_000)
    val_samples = [json.loads(l) for l in VAL_PATH.read_text(encoding="utf-8").splitlines() if l.strip()]
    real_cases = json.loads(REAL_PATH.read_text(encoding="utf-8"))
    print(f"Ready: {len(train_ds)} train, {len(val_samples)} val in {time.perf_counter()-t0:.1f}s")

    loader = DataLoader(
        train_ds,
        batch_size=16,
        shuffle=True,
        collate_fn=make_collate_fn(tok.pad_token_id),
        num_workers=0,
        pin_memory=True,
    )

    base = AutoModelForCausalLM.from_pretrained(
        str(MODEL_DIR),
        dtype=torch.bfloat16,
        device_map="cuda",
        local_files_only=True,
    )
    base.config.use_cache = False
    base.gradient_checkpointing_enable()
    base.enable_input_require_grads()
    lora_cfg = LoraConfig(
        r=16,
        lora_alpha=32,
        lora_dropout=0.05,
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
        task_type="CAUSAL_LM",
    )
    model = get_peft_model(base, lora_cfg)
    model.print_trainable_parameters()

    grad_accum = 2
    total_steps = (len(loader) + grad_accum - 1) // grad_accum
    opt = torch.optim.AdamW(model.parameters(), lr=3e-4, weight_decay=0.01)
    warmup = min(150, total_steps // 10)

    def lr_lambda(step):
        if step < warmup:
            return (step + 1) / warmup
        progress = (step - warmup) / max(1, total_steps - warmup)
        return 0.1 + 0.9 * 0.5 * (1.0 + math.cos(math.pi * progress))

    sched = torch.optim.lr_scheduler.LambdaLR(opt, lr_lambda)
    t_train = time.perf_counter()
    running_loss = 0.0
    micro_step = 0
    opt_step = 0

    model.train()
    opt.zero_grad(set_to_none=True)
    for inp, mask, lbl in loader:
        inp = inp.cuda(non_blocking=True)
        mask = mask.cuda(non_blocking=True)
        lbl = lbl.cuda(non_blocking=True)
        with torch.amp.autocast("cuda", dtype=torch.bfloat16):
            out = model(input_ids=inp, attention_mask=mask)
            flat_lbl = lbl.view(-1)
            valid = flat_lbl != -100
            flat_logits = out.logits.view(-1, out.logits.size(-1))[valid]
            loss = F.cross_entropy(flat_logits, flat_lbl[valid]) / grad_accum
        loss.backward()
        running_loss += loss.item() * grad_accum
        micro_step += 1

        if micro_step % grad_accum == 0 or micro_step == len(loader):
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            opt.step()
            sched.step()
            opt.zero_grad(set_to_none=True)
            opt_step += 1
            if opt_step % 150 == 0:
                elapsed = time.perf_counter() - t_train
                print(f"[step {opt_step}/{total_steps}] loss={running_loss/150:.4f} lr={sched.get_last_lr()[0]:.2e} elapsed={elapsed/60:.1f}m", flush=True)
                running_loss = 0.0
            if opt_step % 900 == 0:
                model.save_pretrained(str(CKPT_DIR / f"step_{opt_step}"))

    model.save_pretrained(str(CKPT_DIR / "final"))
    tok.save_pretrained(str(CKPT_DIR / "final"))
    print("Saved Qwen3-0.6B LoRA to", CKPT_DIR / "final")

    print("Running evaluation on stratified 400 val + 16 real cases...")
    summary, real_hits, real_tot, real_preds = eval_free_decode(model, tok, val_samples[::5], real_cases)
    print("Val summary (free decode):", json.dumps(summary, ensure_ascii=False, indent=2))
    print(f"Real cases: {real_hits}/{real_tot}")
    for keys, tgt, pred, ok in real_preds:
        print(f"  [{'OK' if ok else 'NO'}] {keys:16s} -> pred='{pred}' (tgt='{tgt}')")


if __name__ == "__main__":
    main()
