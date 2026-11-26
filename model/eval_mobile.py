import json
import sys
import time
from pathlib import Path
import torch

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from model.train_mobile_small import TinyIMEModel, CharTokenizer, evaluate, CKPT_DIR, VAL_PATH, REAL_PATH

vocab = json.loads((CKPT_DIR / "vocab.json").read_text(encoding="utf-8"))
tok = CharTokenizer(vocab)
ckpt = torch.load(CKPT_DIR / "best.pt", map_location="cuda")
cfg = ckpt["config"]
model = TinyIMEModel(**cfg).cuda()
model.load_state_dict(ckpt["model"])
model.eval()

val_samples = [json.loads(l) for l in VAL_PATH.read_text(encoding="utf-8").splitlines() if l.strip()]
real_cases = json.loads(REAL_PATH.read_text(encoding="utf-8"))

t0 = time.perf_counter()
summary, real_hits, real_tot, real_preds = evaluate(model, tok, val_samples, real_cases)
print(f"Eval 2000 samples in {time.perf_counter()-t0:.1f}s")
print("Val summary:", json.dumps(summary, ensure_ascii=False, indent=2))
print(f"Real cases: {real_hits}/{real_tot}")
for keys, tgt, pred, ok in real_preds:
    tag = "OK" if ok else "NO"
    print(f"  [{tag}] {keys:16s} -> pred={pred!r} (tgt={tgt!r})")

# Latency check: CUDA bf16 vs CPU FP32 vs CPU INT8 dynamic quantized
model_cpu = TinyIMEModel(**cfg).cpu().eval()
model_cpu.load_state_dict(ckpt["model"])
model_int8 = torch.ao.quantization.quantize_dynamic(model_cpu, {torch.nn.Linear}, dtype=torch.qint8)

prefix = tok.encode_sample("刚下课好饿，", "wmxqcf")
for _ in range(3):
    with torch.amp.autocast("cuda", dtype=torch.bfloat16):
        model.greedy_decode(prefix, 8)
    model_cpu.greedy_decode(prefix, 8)
    model_int8.greedy_decode(prefix, 8)

torch.cuda.synchronize()
ts_gpu = []
for _ in range(20):
    t1 = time.perf_counter()
    with torch.amp.autocast("cuda", dtype=torch.bfloat16):
        model.greedy_decode(prefix, 8)
    torch.cuda.synchronize()
    ts_gpu.append((time.perf_counter() - t1) * 1000)

ts_cpu = []
for _ in range(10):
    t1 = time.perf_counter()
    model_cpu.greedy_decode(prefix, 8)
    ts_cpu.append((time.perf_counter() - t1) * 1000)

ts_int8 = []
for _ in range(10):
    t1 = time.perf_counter()
    model_int8.greedy_decode(prefix, 8)
    ts_int8.append((time.perf_counter() - t1) * 1000)

print(
    f"Latency (6-char decode): GPU={sum(ts_gpu)/len(ts_gpu):.1f}ms | "
    f"CPU FP32={sum(ts_cpu)/len(ts_cpu):.1f}ms | CPU INT8={sum(ts_int8)/len(ts_int8):.1f}ms"
)
