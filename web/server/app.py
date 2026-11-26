"""FastAPI application for the personal-ime live typing race leaderboard."""

from __future__ import annotations

import os
import secrets
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Header, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from web.server.storage import LeaderboardStorage

DEFAULT_STATIC_DIR = Path(__file__).resolve().parents[1] / "static"


def _parse_cors_origins() -> list[str]:
    raw = os.getenv("CORS_ORIGINS", "*").strip()
    if not raw or raw == "*":
        return ["*"]
    return [origin.strip() for origin in raw.split(",") if origin.strip()]


def create_app(
    *,
    db_path: str | Path | None = None,
    static_dir: str | Path | None = None,
) -> FastAPI:
    """Create and configure the FastAPI leaderboard application."""
    app = FastAPI(
        title="Personal-IME Leaderboard API",
        version="0.1.0",
        description="Realtime typing race leaderboard and static hosting backend.",
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=_parse_cors_origins(),
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    storage = LeaderboardStorage(db_path=db_path)
    resolved_static = Path(static_dir) if static_dir is not None else DEFAULT_STATIC_DIR
    app.state.storage = storage
    app.state.static_dir = resolved_static

    @app.get("/api/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/api/leaderboard")
    def get_leaderboard(
        limit: int = Query(default=30, ge=1, le=200),
    ) -> dict[str, Any]:
        return storage.get_leaderboard(limit=limit, recent_limit=10)

    @app.post("/api/reset")
    def reset_leaderboard(
        x_admin_token: str | None = Header(default=None, alias="X-Admin-Token"),
    ) -> dict[str, Any]:
        expected_token = os.getenv("ADMIN_TOKEN", "").strip()
        if not expected_token:
            raise HTTPException(
                status_code=503,
                detail="ADMIN_TOKEN is not configured on the server.",
            )
        if not x_admin_token:
            raise HTTPException(
                status_code=401,
                detail="Missing X-Admin-Token header.",
            )
        if not secrets.compare_digest(x_admin_token, expected_token):
            raise HTTPException(
                status_code=403,
                detail="Invalid admin token.",
            )
        deleted = storage.reset()
        return {"ok": True, "deleted": deleted}

    def _serve_static_page(filename: str, route: str) -> Any:
        if not resolved_static.is_dir():
            return JSONResponse(
                status_code=200,
                content={
                    "status": "pending_frontend",
                    "message": "web/static directory is not present yet.",
                    "route": route,
                },
            )
        target = resolved_static / filename
        if not target.is_file():
            return JSONResponse(
                status_code=404,
                content={
                    "detail": f"{filename} not found in web/static.",
                    "route": route,
                },
            )
        return FileResponse(target)

    @app.get("/")
    def serve_index() -> Any:
        return _serve_static_page("index.html", "/")

    @app.get("/play")
    def serve_play() -> Any:
        return _serve_static_page("play.html", "/play")

    if resolved_static.is_dir():
        app.mount(
            "/static",
            StaticFiles(directory=str(resolved_static)),
            name="static",
        )

    return app


app = create_app()
