"""Sliding-window Rime rule updater with hysteresis thresholding."""

from __future__ import annotations

import argparse
import json
import re
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from profiler.rules_schema import (
    RULES_CATALOG,
    export_rime_algebra,
    normalize_rules,
)

try:
    from pypinyin import Style, lazy_pinyin  # type: ignore[import-not-found]
except ImportError:
    Style = None  # type: ignore[assignment]
    lazy_pinyin = None  # type: ignore[assignment]

DEFAULT_WINDOW_SIZE = 500
DEFAULT_MIN_SAMPLES = 20
DEFAULT_ENABLE_THRESHOLD = 0.15
DEFAULT_DISABLE_THRESHOLD = 0.05
DEFAULT_NOTIFY_COUNT = 3

# (rule_id, left_pattern, right_pattern, mode)
# mode:
#   "symmetric": either side in target can be confused with the other in attempt
#   "omit_g": target has left (e.g. ong), attempt drops g to right (on)
#   "swap": target has left (e.g. an), attempt swaps to right (na)
_RULE_PATTERNS: tuple[tuple[str, str, str, str], ...] = (
    ("z=zh", "z", "zh", "initial_h"),
    ("c=ch", "c", "ch", "initial_h"),
    ("s=sh", "s", "sh", "initial_h"),
    ("l=n", "l", "n", "initial_pair"),
    ("l=r", "l", "r", "initial_pair"),
    ("f=h", "f", "h", "initial_pair"),
    ("g=k", "g", "k", "initial_pair"),
    ("ong=on", "ong", "on", "omit_g"),
    ("in=ing", "in", "ing", "final_g"),
    ("en=eng", "en", "eng", "final_g"),
    ("an=ang", "an", "ang", "final_g"),
    ("ian=iang", "ian", "iang", "final_g"),
    ("uan=uang", "uan", "uang", "final_g"),
    ("ong=eng", "ong", "eng", "symmetric"),
    ("ong=un", "ong", "un", "symmetric"),
    ("ue=ve", "ue", "ve", "symmetric"),
    ("ju=jv", "u", "v", "jqxy_uv"),
    ("an=na", "an", "na", "swap"),
    ("en=ne", "en", "ne", "swap"),
    ("in=ni", "in", "ni", "swap"),
    ("un=nu", "un", "nu", "swap"),
    ("ai=ia", "ai", "ia", "swap"),
    ("ei=ie", "ei", "ie", "swap"),
    ("zh=hz", "zh", "hz", "swap"),
)

_NON_ALPHA_RE = re.compile(r"[^a-z]+")


@dataclass(frozen=True, slots=True)
class RuleStats:
    """Observed opportunity and hit counts for a single rule."""

    samples: int
    hits: int

    @property
    def rate(self) -> float:
        if self.samples <= 0:
            return 0.0
        return self.hits / self.samples

    def to_dict(self) -> dict[str, Any]:
        return {
            "samples": self.samples,
            "hits": self.hits,
            "rate": round(self.rate, 4),
        }


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _clean_pinyin_text(raw: Any) -> str:
    if isinstance(raw, list):
        raw = " ".join(str(x) for x in raw)
    if not isinstance(raw, str):
        return ""
    return _NON_ALPHA_RE.sub(" ", raw.lower()).strip()


def _extract_target_and_attempt(record: dict[str, Any]) -> tuple[str, str]:
    """Extract normalized target pinyin and user's initial typed attempt."""
    attempt = _clean_pinyin_text(record.get("first_attempt") or record.get("raw_input") or "")
    target = _clean_pinyin_text(
        record.get("target_pinyin")
        or record.get("full_pinyin")
        or ""
    )
    if not target and record.get("committed") and lazy_pinyin is not None and Style is not None:
        sylls = lazy_pinyin(str(record["committed"]), style=Style.NORMAL, v_to_u=False)
        target = _clean_pinyin_text([s.replace("ü", "v") for s in sylls])
    if not target:
        # Fallback to raw_input as reference when comparing against first_attempt
        target = _clean_pinyin_text(record.get("raw_input") or "")
    return target, attempt


def _detect_rule_event(rule_id: str, left: str, right: str, mode: str, target: str, attempt: str) -> tuple[bool, bool]:
    """Return (has_opportunity, is_hit) for a single record and rule."""
    if not target or not attempt:
        return False, False

    if mode == "omit_g":
        has_opp = left in target
        if not has_opp:
            return False, False
        # e.g. target has "ong", attempt has "on" without "ong"
        is_hit = (right in attempt) and (target.count(left) > attempt.count(left))
        return True, is_hit

    if mode == "final_g":
        has_opp = (left in target) or (right in target)
        if not has_opp:
            return False, False
        t_has_right = right in target
        a_has_right = right in attempt
        if t_has_right and (left in attempt) and not a_has_right:
            return True, True
        if (not t_has_right) and (left in target) and a_has_right:
            return True, True
        return True, False

    if mode == "initial_h":
        # z vs zh, c vs ch, s vs sh at syllable boundaries or string start
        has_opp = bool(re.search(rf"(?:^|\s){left}h?", target))
        if not has_opp:
            return False, False
        t_retro = len(re.findall(rf"(?:^|\s){right}", target))
        a_retro = len(re.findall(rf"(?:^|\s){right}", attempt))
        t_flat = len(re.findall(rf"(?:^|\s){left}(?!h)", target))
        a_flat = len(re.findall(rf"(?:^|\s){left}(?!h)", attempt))
        is_hit = (t_retro > a_retro and a_flat > t_flat) or (t_flat > a_flat and a_retro > t_retro)
        return True, is_hit

    if mode == "initial_pair":
        t_left = len(re.findall(rf"(?:^|\s){left}", target))
        t_right = len(re.findall(rf"(?:^|\s){right}", target))
        if t_left == 0 and t_right == 0:
            return False, False
        a_left = len(re.findall(rf"(?:^|\s){left}", attempt))
        a_right = len(re.findall(rf"(?:^|\s){right}", attempt))
        is_hit = (t_left > a_left and a_right > t_right) or (t_right > a_right and a_left > t_left)
        return True, is_hit

    if mode == "jqxy_uv":
        has_opp = bool(re.search(r"(?:^|\s)[jqxy][uv]", target))
        if not has_opp:
            return False, False
        is_hit = bool(re.search(r"(?:^|\s)[jqxy]v", attempt))
        return True, is_hit

    if mode == "swap":
        has_opp = left in target
        if not has_opp:
            return False, False
        is_hit = (right in attempt) and (attempt.count(left) < target.count(left))
        return True, is_hit

    # symmetric
    has_opp = (left in target) or (right in target)
    if not has_opp:
        return False, False
    is_hit = (left in target and right in attempt and left not in attempt) or (
        right in target and left in attempt and right not in attempt
    )
    return True, is_hit


def load_recent_records(
    log_sources: Path | str | Iterable[Path | str],
    window_size: int = DEFAULT_WINDOW_SIZE,
) -> list[dict[str, Any]]:
    """Load the most recent `window_size` JSONL records from files or directories."""
    if isinstance(log_sources, (str, Path)):
        sources = [Path(log_sources)]
    else:
        sources = [Path(p) for p in log_sources]

    files: list[Path] = []
    for src in sources:
        if src.is_dir():
            files.extend(sorted(src.glob("*.jsonl")))
        elif src.is_file():
            files.append(src)

    records: list[dict[str, Any]] = []
    for file_path in files:
        try:
            lines = file_path.read_text(encoding="utf-8").splitlines()
        except OSError:
            continue
        for line in lines:
            stripped = line.strip()
            if not stripped:
                continue
            try:
                obj = json.loads(stripped)
            except json.JSONDecodeError:
                continue
            if isinstance(obj, dict):
                records.append(obj)

    if window_size <= 0:
        return []
    return records[-window_size:]


def compute_rule_stats(records: Iterable[dict[str, Any]]) -> dict[str, RuleStats]:
    """Compute per-rule opportunity and hit counts over the given records."""
    counts: dict[str, list[int]] = {rule.id: [0, 0] for rule in RULES_CATALOG}

    for record in records:
        explicit = record.get("triggered_rules")
        if isinstance(explicit, list):
            for rule_id in normalize_rules(explicit):
                if rule_id in counts:
                    counts[rule_id][0] += 1
                    counts[rule_id][1] += 1

        target, attempt = _extract_target_and_attempt(record)
        if not target or not attempt:
            continue

        for rule_id, left, right, mode in _RULE_PATTERNS:
            has_opp, is_hit = _detect_rule_event(rule_id, left, right, mode, target, attempt)
            if has_opp:
                counts[rule_id][0] += 1
                if is_hit:
                    counts[rule_id][1] += 1

    return {
        rule_id: RuleStats(samples=pair[0], hits=pair[1])
        for rule_id, pair in counts.items()
    }


def load_enabled_rules(state_path: Path | None) -> list[str]:
    """Load currently enabled canonical rule IDs from `user_rules.json`."""
    if state_path is None or not state_path.is_file():
        return []
    try:
        data = json.loads(state_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    if not isinstance(data, dict):
        return []
    raw_enabled = data.get("enabled_rules", [])
    if not isinstance(raw_enabled, list):
        return []
    return normalize_rules(raw_enabled)


def build_notify_message(enabled: list[str], disabled: list[str]) -> str:
    """Format a compact single-line notification banner for Rime candidate comments."""
    parts: list[str] = []
    if enabled:
        parts.append("已自动开启 " + "/".join(enabled))
    if disabled:
        parts.append("已自动关闭 " + "/".join(disabled))
    if not parts:
        return ""
    return "[" + "；".join(parts) + "]"


def update_rules_from_records(
    records: list[dict[str, Any]],
    *,
    state_path: Path | None = None,
    notify_path: Path | None = None,
    yaml_path: Path | None = None,
    min_samples: int = DEFAULT_MIN_SAMPLES,
    enable_threshold: float = DEFAULT_ENABLE_THRESHOLD,
    disable_threshold: float = DEFAULT_DISABLE_THRESHOLD,
    notify_count: int = DEFAULT_NOTIFY_COUNT,
) -> dict[str, Any]:
    """Run hysteresis rule calibration on `records` and persist state/notify/YAML."""
    current_enabled = set(load_enabled_rules(state_path))
    stats = compute_rule_stats(records)

    next_enabled: list[str] = []
    newly_enabled: list[str] = []
    newly_disabled: list[str] = []

    for rule in RULES_CATALOG:
        rule_id = rule.id
        rule_stat = stats[rule_id]
        was_enabled = rule_id in current_enabled

        if rule_stat.samples < min_samples:
            if was_enabled:
                next_enabled.append(rule_id)
            continue

        if not was_enabled and rule_stat.rate >= enable_threshold:
            next_enabled.append(rule_id)
            newly_enabled.append(rule_id)
        elif was_enabled and rule_stat.rate <= disable_threshold:
            newly_disabled.append(rule_id)
        elif was_enabled:
            next_enabled.append(rule_id)

    rime_yaml = export_rime_algebra(next_enabled)
    state_payload: dict[str, Any] = {
        "enabled_rules": next_enabled,
        "updated_at": _utc_now_iso(),
        "records_analyzed": len(records),
        "thresholds": {
            "min_samples": min_samples,
            "enable_threshold": enable_threshold,
            "disable_threshold": disable_threshold,
        },
        "changes": {
            "enabled": newly_enabled,
            "disabled": newly_disabled,
        },
        "stats": {
            rule_id: stat.to_dict()
            for rule_id, stat in stats.items()
            if stat.samples > 0
        },
    }

    if state_path is not None:
        state_path.parent.mkdir(parents=True, exist_ok=True)
        state_path.write_text(
            json.dumps(state_payload, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )

    notify_msg = build_notify_message(newly_enabled, newly_disabled)
    if notify_path is not None and notify_msg:
        notify_path.parent.mkdir(parents=True, exist_ok=True)
        notify_path.write_text(f"{max(1, int(notify_count))}\n{notify_msg}\n", encoding="utf-8")

    if yaml_path is not None:
        yaml_path.parent.mkdir(parents=True, exist_ok=True)
        yaml_path.write_text(rime_yaml, encoding="utf-8")

    return {
        "state": state_payload,
        "rime_yaml": rime_yaml,
        "notify_message": notify_msg,
    }


def update_rules_from_logs(
    log_sources: Path | str | Iterable[Path | str],
    *,
    state_path: Path | None = None,
    notify_path: Path | None = None,
    yaml_path: Path | None = None,
    window_size: int = DEFAULT_WINDOW_SIZE,
    min_samples: int = DEFAULT_MIN_SAMPLES,
    enable_threshold: float = DEFAULT_ENABLE_THRESHOLD,
    disable_threshold: float = DEFAULT_DISABLE_THRESHOLD,
    notify_count: int = DEFAULT_NOTIFY_COUNT,
) -> dict[str, Any]:
    """Load recent JSONL logs and update adaptive rules."""
    records = load_recent_records(log_sources, window_size=window_size)
    return update_rules_from_records(
        records,
        state_path=state_path,
        notify_path=notify_path,
        yaml_path=yaml_path,
        min_samples=min_samples,
        enable_threshold=enable_threshold,
        disable_threshold=disable_threshold,
        notify_count=notify_count,
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Update adaptive Rime pinyin rules from JSONL logs.")
    parser.add_argument("--logs", required=True, help="Path to user_logs directory or a .jsonl file.")
    parser.add_argument("--state", default="user_rules.json", help="Output path for user_rules.json.")
    parser.add_argument("--notify", default="rule_notify.txt", help="Output path for rule_notify.txt.")
    parser.add_argument("--yaml-out", default="", help="Optional output path for Rime algebra YAML patch.")
    parser.add_argument("--window", type=int, default=DEFAULT_WINDOW_SIZE, help="Sliding window size.")
    parser.add_argument("--min-samples", type=int, default=DEFAULT_MIN_SAMPLES, help="Minimum samples to toggle.")
    parser.add_argument("--enable-threshold", type=float, default=DEFAULT_ENABLE_THRESHOLD, help="Enable rate threshold.")
    parser.add_argument("--disable-threshold", type=float, default=DEFAULT_DISABLE_THRESHOLD, help="Disable rate threshold.")
    parser.add_argument("--notify-count", type=int, default=DEFAULT_NOTIFY_COUNT, help="Commits to display notify banner.")
    args = parser.parse_args()

    result = update_rules_from_logs(
        Path(args.logs),
        state_path=Path(args.state),
        notify_path=Path(args.notify),
        yaml_path=Path(args.yaml_out) if args.yaml_out else None,
        window_size=args.window,
        min_samples=args.min_samples,
        enable_threshold=args.enable_threshold,
        disable_threshold=args.disable_threshold,
        notify_count=args.notify_count,
    )
    print(json.dumps(result["state"]["changes"], ensure_ascii=False))


if __name__ == "__main__":
    main()
