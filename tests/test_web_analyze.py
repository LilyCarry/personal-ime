"""Unit tests for DeepSeek analysis endpoint (/api/analyze) and rules catalog."""

from __future__ import annotations

import json
from pathlib import Path

import httpx
from fastapi.testclient import TestClient

from profiler.rules_schema import VALID_RULE_IDS
from web.server.app import create_app


def test_rules_catalog_endpoint(tmp_path: Path) -> None:
    app = create_app(db_path=tmp_path / "catalog.db", static_dir=tmp_path / "no_static")
    client = TestClient(app)

    resp = client.get("/api/rules/catalog")
    assert resp.status_code == 200
    catalog = resp.json()
    assert isinstance(catalog, list)
    assert len(catalog) == len(VALID_RULE_IDS)
    assert all("id" in item and "algebra" in item for item in catalog)


def test_analyze_with_mock_deepseek_filters_invalid_rules_and_writes_leaderboard(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setenv("DEEPSEEK_API_KEY", "test-fake-key")

    def fake_request(endpoint, headers, body, timeout_sec):  # noqa: ANN001
        content = {
            "title": "后鼻音省电侠",
            "comment": "手速飞快而且很懂省键，把后鼻音和平翘舌顺手优化一下就起飞了。",
            "rules": [
                {"id": "ong=on", "reason": "经常把 ong 省打成 on"},
                {"id": "zh=z", "reason": "别名规则应归一化为 z=zh"},
                {"id": "hallucinated_rule_xyz", "reason": "非法规则必须被拦截"},
            ],
        }
        return {
            "choices": [
                {"message": {"content": json.dumps(content, ensure_ascii=False)}}
            ]
        }

    monkeypatch.setattr(
        "web.server.deepseek_client._request_deepseek_json",
        fake_request,
    )

    app = create_app(db_path=tmp_path / "analyze.db", static_dir=tmp_path / "no_static")
    client = TestClient(app)

    resp = client.post(
        "/api/analyze",
        json={
            "nickname": "Carry",
            "target_text": "中国人民银行",
            "target_pinyin": "zhong guo ren min yin hang",
            "typed_input": "zhon guo ren min ying hang",
            "duration_sec": 3.0,
            "backspaces": 2,
            "cpm": 180.0,
            "accuracy": 95.0,
        },
    )
    assert resp.status_code == 200
    data = resp.json()

    assert data["fallback"] is False
    assert data["rank"] == 1
    assert data["record"]["nickname"] == "Carry"
    assert data["record"]["score"] == 171.0
    assert data["record"]["title"] == "后鼻音省电侠"
    assert data["record"]["rules"] == ["ong=on", "z=zh"]
    assert "hallucinated_rule_xyz" not in data["record"]["rules"]
    assert set(data["rule_reasons"].keys()) == {"ong=on", "z=zh"}
    assert "speller/algebra/+:" in data["rime_yaml"]
    assert "derive/ong$/on/" in data["rime_yaml"]

    # Verify the record was persisted to the leaderboard
    board = client.get("/api/leaderboard").json()
    assert board["total"] == 1
    assert board["leaderboard"][0]["nickname"] == "Carry"


def test_analyze_fallback_without_api_key(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)

    app = create_app(db_path=tmp_path / "nokey.db", static_dir=tmp_path / "no_static")
    client = TestClient(app)

    resp = client.post(
        "/api/analyze",
        json={
            "nickname": "StudentA",
            "target_text": "今天天气真好",
            "target_pinyin": "jin tian tian qi zhen hao",
            "typed_input": "jing tian tian qi zen hao",
            "duration_sec": 4.0,
            "backspaces": 3,
        },
    )
    assert resp.status_code == 200
    data = resp.json()

    assert data["fallback"] is True
    assert data["rank"] == 1
    assert data["record"]["cpm"] > 0
    assert 0.0 <= data["record"]["accuracy"] <= 100.0
    assert all(rule_id in VALID_RULE_IDS for rule_id in data["record"]["rules"])
    assert "speller/algebra/+:" in data["rime_yaml"]


def test_analyze_fallback_on_timeout_and_invalid_json(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("DEEPSEEK_API_KEY", "test-fake-key")

    def fake_timeout(endpoint, headers, body, timeout_sec):  # noqa: ANN001
        raise httpx.ReadTimeout("timeout", request=httpx.Request("POST", endpoint))

    monkeypatch.setattr(
        "web.server.deepseek_client._request_deepseek_json",
        fake_timeout,
    )

    app = create_app(db_path=tmp_path / "timeout.db", static_dir=tmp_path / "no_static")
    client = TestClient(app)

    resp_timeout = client.post(
        "/api/analyze",
        json={
            "nickname": "TimeoutUser",
            "target_text": "东风吹战鼓擂",
            "target_pinyin": "dong feng chui zhan gu lei",
            "typed_input": "don feng chui zhan gu lei",
            "duration_sec": 5.0,
            "cpm": 210.0,
            "accuracy": 97.0,
        },
    )
    assert resp_timeout.status_code == 200
    payload_timeout = resp_timeout.json()
    assert payload_timeout["fallback"] is True
    assert payload_timeout["rank"] == 1
    assert "ong=on" in payload_timeout["record"]["rules"]

    # Also verify malformed JSON from DeepSeek falls back cleanly
    def fake_bad_json(endpoint, headers, body, timeout_sec):  # noqa: ANN001
        return {"choices": [{"message": {"content": "{not-valid-json"}}]}

    monkeypatch.setattr(
        "web.server.deepseek_client._request_deepseek_json",
        fake_bad_json,
    )
    resp_bad = client.post(
        "/api/analyze",
        json={
            "nickname": "BadJsonUser",
            "target_text": "测试",
            "typed_input": "ce shi",
            "duration_sec": 2.0,
            "cpm": 120.0,
            "accuracy": 120.0,  # should be clamped to 100.0
        },
    )
    assert resp_bad.status_code == 200
    payload_bad = resp_bad.json()
    assert payload_bad["fallback"] is True
    assert payload_bad["record"]["accuracy"] == 100.0
    assert payload_bad["rank"] == 2
