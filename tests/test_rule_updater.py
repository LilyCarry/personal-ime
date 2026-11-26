"""Unit tests for sliding-window rule calibration (Issue #6)."""

from __future__ import annotations

import json
from pathlib import Path

from profiler.rule_updater import update_rules_from_logs


def _write_jsonl(path: Path, records: list[dict]) -> None:
    lines = [json.dumps(rec, ensure_ascii=False) for rec in records]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def test_min_samples_prevents_premature_enable(tmp_path: Path) -> None:
    log_file = tmp_path / "sample.jsonl"
    # 100% hit rate for ong=on, but only 5 samples (< min_samples=20)
    records = [
        {"target_pinyin": "zhong guo", "first_attempt": "zhon guo", "raw_input": "zhong guo"}
        for _ in range(5)
    ]
    _write_jsonl(log_file, records)

    state_file = tmp_path / "user_rules.json"
    notify_file = tmp_path / "rule_notify.txt"
    result = update_rules_from_logs(
        log_file,
        state_path=state_file,
        notify_path=notify_file,
        min_samples=20,
    )

    assert result["state"]["enabled_rules"] == []
    assert result["state"]["changes"] == {"enabled": [], "disabled": []}
    assert not notify_file.exists()


def test_hysteresis_enable_hold_and_disable(tmp_path: Path) -> None:
    log_dir = tmp_path / "user_logs"
    log_dir.mkdir()
    log_file = log_dir / "session.jsonl"
    state_file = tmp_path / "user_rules.json"
    notify_file = tmp_path / "rule_notify.txt"
    yaml_file = tmp_path / "algebra.yaml"

    # Phase 1: 4 / 20 = 20% (>= 15%) -> should enable ong=on
    phase1 = [
        {"target_pinyin": "zhong", "first_attempt": "zhon", "raw_input": "zhong"}
        for _ in range(4)
    ] + [
        {"target_pinyin": "zhong", "first_attempt": "zhong", "raw_input": "zhong"}
        for _ in range(16)
    ]
    _write_jsonl(log_file, phase1)

    res1 = update_rules_from_logs(
        log_dir,
        state_path=state_file,
        notify_path=notify_file,
        yaml_path=yaml_file,
        min_samples=20,
        enable_threshold=0.15,
        disable_threshold=0.05,
        notify_count=3,
    )
    assert res1["state"]["enabled_rules"] == ["ong=on"]
    assert res1["state"]["changes"] == {"enabled": ["ong=on"], "disabled": []}
    assert "derive/ong$/on/" in yaml_file.read_text(encoding="utf-8")
    notify_lines = notify_file.read_text(encoding="utf-8").splitlines()
    assert notify_lines[0] == "3"
    assert "已自动开启 ong=on" in notify_lines[1]

    # Phase 2: 2 / 20 = 10% (inside hysteresis band 5% < 10% < 15%) -> stay enabled, no new notify
    notify_file.unlink()
    phase2 = [
        {"target_pinyin": "dong", "raw_input": "don"} for _ in range(2)
    ] + [
        {"target_pinyin": "dong", "raw_input": "dong"} for _ in range(18)
    ]
    _write_jsonl(log_file, phase2)

    res2 = update_rules_from_logs(
        log_dir,
        state_path=state_file,
        notify_path=notify_file,
        min_samples=20,
        enable_threshold=0.15,
        disable_threshold=0.05,
    )
    assert res2["state"]["enabled_rules"] == ["ong=on"]
    assert res2["state"]["changes"] == {"enabled": [], "disabled": []}
    assert not notify_file.exists()

    # Phase 3: 1 / 25 = 4% (<= 5%) -> should disable ong=on and emit close notify
    phase3 = [
        {"target_pinyin": "dong", "raw_input": "don"}
    ] + [
        {"target_pinyin": "dong", "raw_input": "dong"} for _ in range(24)
    ]
    _write_jsonl(log_file, phase3)

    res3 = update_rules_from_logs(
        log_dir,
        state_path=state_file,
        notify_path=notify_file,
        yaml_path=yaml_file,
        min_samples=20,
        enable_threshold=0.15,
        disable_threshold=0.05,
    )
    assert res3["state"]["enabled_rules"] == []
    assert res3["state"]["changes"] == {"enabled": [], "disabled": ["ong=on"]}
    assert "speller/algebra/+: []" in yaml_file.read_text(encoding="utf-8")
    notify_lines_3 = notify_file.read_text(encoding="utf-8").splitlines()
    assert "已自动关闭 ong=on" in notify_lines_3[1]


def test_sliding_window_ignores_old_records(tmp_path: Path) -> None:
    log_file = tmp_path / "window.jsonl"
    # Older 20 records all trigger l=r; newer 20 records have 0 triggers
    old_records = [
        {"target_pinyin": "ren min", "first_attempt": "len min", "raw_input": "ren min"}
        for _ in range(20)
    ]
    new_records = [
        {"target_pinyin": "ren min", "first_attempt": "ren min", "raw_input": "ren min"}
        for _ in range(20)
    ]
    _write_jsonl(log_file, old_records + new_records)

    res = update_rules_from_logs(
        log_file,
        state_path=tmp_path / "user_rules.json",
        window_size=20,
        min_samples=20,
    )
    assert res["state"]["records_analyzed"] == 20
    assert res["state"]["enabled_rules"] == []
