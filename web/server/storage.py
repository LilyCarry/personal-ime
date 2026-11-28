"""SQLite persistence layer for the typing race leaderboard."""

from __future__ import annotations

import json
import os
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

DEFAULT_DB_PATH = Path(__file__).resolve().parent / "leaderboard.db"


def _utc_now_iso() -> str:
    """Return current UTC timestamp formatted as ISO-8601 with Z suffix."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def resolve_db_path(db_path: str | Path | None = None) -> Path:
    """Resolve database path from explicit argument, env var, or default."""
    if db_path is not None:
        return Path(db_path)
    env_path = os.getenv("LEADERBOARD_DB_PATH", "").strip()
    if env_path:
        return Path(env_path)
    return DEFAULT_DB_PATH


class LeaderboardStorage:
    """Thread-safe SQLite storage for typing race scores and comments."""

    def __init__(self, db_path: str | Path | None = None) -> None:
        self.db_path = resolve_db_path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._cache: dict[tuple[int, int], dict[str, Any]] = {}
        self.init_db()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, timeout=10.0)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL;")
        conn.execute("PRAGMA synchronous=NORMAL;")
        conn.execute("PRAGMA busy_timeout=10000;")
        return conn

    def init_db(self) -> None:
        """Create the leaderboard table and indexes if they do not exist."""
        with self._connect() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS leaderboard_records (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    nickname TEXT NOT NULL,
                    cpm REAL NOT NULL,
                    accuracy REAL NOT NULL,
                    score REAL NOT NULL,
                    title TEXT NOT NULL DEFAULT '',
                    comment TEXT NOT NULL DEFAULT '',
                    rules TEXT NOT NULL DEFAULT '[]',
                    created_at TEXT NOT NULL
                )
                """
            )
            conn.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_leaderboard_rank
                ON leaderboard_records (score DESC, created_at ASC, id ASC)
                """
            )
            conn.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_leaderboard_recent
                ON leaderboard_records (created_at DESC, id DESC)
                """
            )

    @staticmethod
    def _row_to_record(row: sqlite3.Row) -> dict[str, Any]:
        try:
            rules = json.loads(row["rules"])
            if not isinstance(rules, list):
                rules = []
        except (TypeError, json.JSONDecodeError):
            rules = []
        return {
            "id": int(row["id"]),
            "nickname": str(row["nickname"]),
            "cpm": float(row["cpm"]),
            "accuracy": float(row["accuracy"]),
            "score": float(row["score"]),
            "title": str(row["title"]),
            "comment": str(row["comment"]),
            "rules": [str(item) for item in rules],
            "created_at": str(row["created_at"]),
        }

    def add_record(
        self,
        *,
        nickname: str,
        cpm: float,
        accuracy: float,
        score: float,
        title: str = "",
        comment: str = "",
        rules: list[str] | None = None,
        created_at: str | None = None,
    ) -> dict[str, Any]:
        """Insert a race record and return the stored record with its 1-based rank."""
        clean_rules = [str(item) for item in (rules or [])]
        timestamp = created_at or _utc_now_iso()
        with self._connect() as conn:
            cursor = conn.execute(
                """
                INSERT INTO leaderboard_records (
                    nickname, cpm, accuracy, score, title, comment, rules, created_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    nickname.strip() or "Anonymous",
                    float(cpm),
                    float(accuracy),
                    float(score),
                    title,
                    comment,
                    json.dumps(clean_rules, ensure_ascii=False),
                    timestamp,
                ),
            )
            record_id = int(cursor.lastrowid)
            row = conn.execute(
                "SELECT * FROM leaderboard_records WHERE id = ?",
                (record_id,),
            ).fetchone()
            rank_row = conn.execute(
                """
                SELECT COUNT(*) + 1 AS rank
                FROM leaderboard_records
                WHERE score > ?
                   OR (score = ? AND created_at < ?)
                   OR (score = ? AND created_at = ? AND id < ?)
                """,
                (
                    float(score),
                    float(score),
                    timestamp,
                    float(score),
                    timestamp,
                    record_id,
                ),
            ).fetchone()
        record = self._row_to_record(row)
        record["rank"] = int(rank_row["rank"]) if rank_row else 1
        with self._lock:
            self._cache.clear()
        return record

    def get_leaderboard(
        self,
        *,
        limit: int = 30,
        recent_limit: int = 10,
    ) -> dict[str, Any]:
        """Return total count, ranked leaderboard, and recent comment carousel."""
        safe_limit = max(1, min(int(limit), 200))
        safe_recent = max(1, min(int(recent_limit), 50))
        cache_key = (safe_limit, safe_recent)
        with self._lock:
            cached = self._cache.get(cache_key)
            if cached is not None:
                return cached
        with self._connect() as conn:
            total_row = conn.execute(
                "SELECT COUNT(*) AS total FROM leaderboard_records"
            ).fetchone()
            board_rows = conn.execute(
                """
                SELECT *
                FROM leaderboard_records
                ORDER BY score DESC, created_at ASC, id ASC
                LIMIT ?
                """,
                (safe_limit,),
            ).fetchall()
            recent_rows = conn.execute(
                """
                SELECT id, nickname, title, comment, rules, created_at
                FROM leaderboard_records
                ORDER BY created_at DESC, id DESC
                LIMIT ?
                """,
                (safe_recent,),
            ).fetchall()

        leaderboard = [self._row_to_record(row) for row in board_rows]
        recent_comments = []
        for row in recent_rows:
            try:
                parsed_rules = json.loads(row["rules"])
                if not isinstance(parsed_rules, list):
                    parsed_rules = []
            except (TypeError, json.JSONDecodeError):
                parsed_rules = []
            recent_comments.append(
                {
                    "id": int(row["id"]),
                    "nickname": str(row["nickname"]),
                    "title": str(row["title"]),
                    "comment": str(row["comment"]),
                    "rules": [str(item) for item in parsed_rules],
                    "created_at": str(row["created_at"]),
                }
            )
        result = {
            "total": int(total_row["total"]) if total_row else 0,
            "leaderboard": leaderboard,
            "recent_comments": recent_comments,
        }
        with self._lock:
            if len(self._cache) >= 16:
                self._cache.clear()
            self._cache[cache_key] = result
        return result

    def reset(self) -> int:
        """Delete all leaderboard records and return the number of deleted rows."""
        with self._connect() as conn:
            cursor = conn.execute("DELETE FROM leaderboard_records")
            deleted = int(cursor.rowcount)
        with self._lock:
            self._cache.clear()
        return deleted
