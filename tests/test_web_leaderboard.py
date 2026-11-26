"""Unit tests for the FastAPI leaderboard backend (Issue #2)."""

from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from web.server.app import create_app


def test_health_and_empty_leaderboard(tmp_path: Path) -> None:
    db_file = tmp_path / "test_leaderboard.db"
    app = create_app(db_path=db_file, static_dir=tmp_path / "missing_static")
    client = TestClient(app)

    health_resp = client.get("/api/health")
    assert health_resp.status_code == 200
    assert health_resp.json() == {"status": "ok"}

    board_resp = client.get("/api/leaderboard")
    assert board_resp.status_code == 200
    assert board_resp.json() == {
        "total": 0,
        "leaderboard": [],
        "recent_comments": [],
    }


def test_leaderboard_ordering_limit_and_recent_comments(tmp_path: Path) -> None:
    db_file = tmp_path / "test_leaderboard.db"
    app = create_app(db_path=db_file, static_dir=tmp_path / "missing_static")
    storage = app.state.storage

    # Insert 12 records with varying scores and timestamps
    for idx in range(12):
        score = 100.0 + (idx % 5) * 10.0
        rec = storage.add_record(
            nickname=f"User{idx}",
            cpm=150.0 + idx,
            accuracy=95.0,
            score=score,
            title=f"Title{idx}",
            comment=f"Comment {idx}",
            rules=["ong=on", "in=ing"],
            created_at=f"2026-11-26T12:{idx:02d}:00Z",
        )
        assert rec["id"] > 0
        assert rec["rank"] >= 1

    # Verify limit parameter and tie-breaker ordering (score DESC, created_at ASC)
    resp = client = TestClient(app)
    limited = resp.get("/api/leaderboard?limit=5")
    assert limited.status_code == 200
    payload = limited.json()

    assert payload["total"] == 12
    assert len(payload["leaderboard"]) == 5
    scores = [item["score"] for item in payload["leaderboard"]]
    assert scores == sorted(scores, reverse=True)

    # Top items have score 140.0; earlier created_at must come first
    top_items = [item for item in payload["leaderboard"] if item["score"] == 140.0]
    assert [item["nickname"] for item in top_items] == ["User4", "User9"]

    # recent_comments must be capped at 10 and ordered by created_at DESC
    recent = payload["recent_comments"]
    assert len(recent) == 10
    assert recent[0]["nickname"] == "User11"
    assert recent[-1]["nickname"] == "User2"
    assert set(recent[0].keys()) == {
        "id",
        "nickname",
        "title",
        "comment",
        "rules",
        "created_at",
    }


def test_reset_requires_admin_token(tmp_path: Path, monkeypatch) -> None:
    db_file = tmp_path / "test_leaderboard.db"
    app = create_app(db_path=db_file, static_dir=tmp_path / "missing_static")
    app.state.storage.add_record(
        nickname="Carry",
        cpm=185.0,
        accuracy=96.5,
        score=178.5,
        title="后鼻音省电派",
        comment="Nice speed",
        rules=["ong=on"],
    )
    client = TestClient(app)

    # 503 when ADMIN_TOKEN is unset
    monkeypatch.delenv("ADMIN_TOKEN", raising=False)
    resp_unconfigured = client.post("/api/reset")
    assert resp_unconfigured.status_code == 503

    # 401 when header is missing
    monkeypatch.setenv("ADMIN_TOKEN", "secret-token-123")
    resp_missing = client.post("/api/reset")
    assert resp_missing.status_code == 401

    # 403 when header does not match
    resp_wrong = client.post("/api/reset", headers={"X-Admin-Token": "wrong"})
    assert resp_wrong.status_code == 403

    # 200 and clears records when token matches
    resp_ok = client.post("/api/reset", headers={"X-Admin-Token": "secret-token-123"})
    assert resp_ok.status_code == 200
    assert resp_ok.json() == {"ok": True, "deleted": 1}

    after_reset = client.get("/api/leaderboard")
    assert after_reset.status_code == 200
    assert after_reset.json()["total"] == 0


def test_static_fallback_and_serving(tmp_path: Path) -> None:
    # Case 1: web/static does not exist yet -> no crash, friendly JSON response
    app_no_static = create_app(
        db_path=tmp_path / "a.db",
        static_dir=tmp_path / "nonexistent_static",
    )
    client_no_static = TestClient(app_no_static)
    r_index = client_no_static.get("/")
    r_play = client_no_static.get("/play")
    assert r_index.status_code == 200
    assert r_index.json()["status"] == "pending_frontend"
    assert r_play.status_code == 200
    assert r_play.json()["status"] == "pending_frontend"

    # Case 2: web/static exists with index.html, play.html, and static asset
    static_dir = tmp_path / "static"
    static_dir.mkdir()
    (static_dir / "index.html").write_text("<h1>Display</h1>", encoding="utf-8")
    (static_dir / "play.html").write_text("<h1>Play</h1>", encoding="utf-8")
    (static_dir / "app.js").write_text("console.log('ok');", encoding="utf-8")

    app_with_static = create_app(
        db_path=tmp_path / "b.db",
        static_dir=static_dir,
    )
    client_with_static = TestClient(app_with_static)
    assert client_with_static.get("/").text == "<h1>Display</h1>"
    assert client_with_static.get("/play").text == "<h1>Play</h1>"
    assert client_with_static.get("/static/app.js").text == "console.log('ok');"


def test_cors_headers_present(tmp_path: Path) -> None:
    app = create_app(
        db_path=tmp_path / "cors.db",
        static_dir=tmp_path / "missing_static",
    )
    client = TestClient(app)
    resp = client.get("/api/health", headers={"Origin": "https://example.com"})
    assert resp.status_code == 200
    assert resp.headers.get("access-control-allow-origin") == "*"
