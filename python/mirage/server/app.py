# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import asyncio
import logging
import os
import signal
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI

from mirage.server.auth import (AuthConfig, AuthMiddleware, AuthMode,
                                resolve_auth_config)
from mirage.server.host_validation import (HostHeaderMiddleware,
                                           resolve_allowed_hosts)
from mirage.server.jobs import JobTable
from mirage.server.registry import WorkspaceRegistry
from mirage.server.routers import execute, health, jobs, sessions, workspaces

logger = logging.getLogger(__name__)


def _pid_file_path() -> Path:
    return Path.home() / ".mirage" / "daemon.pid"


def _write_pid_file() -> None:
    p = _pid_file_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(str(os.getpid()))


def _remove_pid_file() -> None:
    try:
        _pid_file_path().unlink(missing_ok=True)
    except OSError:
        logger.debug("could not remove pid file %s", _pid_file_path())


async def _watch_exit(exit_event: asyncio.Event) -> None:
    """Send SIGTERM to self when ``exit_event`` is set.

    Lets uvicorn handle its own graceful shutdown sequence.
    """
    try:
        await exit_event.wait()
    except asyncio.CancelledError:
        return
    logger.info("exit event tripped; sending SIGTERM to self")
    os.kill(os.getpid(), signal.SIGTERM)


@asynccontextmanager
async def _lifespan(app: FastAPI):
    _write_pid_file()
    exit_task = asyncio.create_task(_watch_exit(app.state.exit_event))
    try:
        yield
    finally:
        exit_task.cancel()
        await app.state.registry.close_all()
        _remove_pid_file()


def build_app(idle_grace_seconds: float = 30.0,
              exit_event: asyncio.Event | None = None,
              allowed_hosts: list[str] | None = None,
              auth_config: AuthConfig | None = None) -> FastAPI:
    """Construct a daemon FastAPI app.

    The workspace registry is created eagerly so the app is usable
    even without ASGI lifespan events firing (e.g. inside an
    ``httpx.ASGITransport`` test client).

    Args:
        idle_grace_seconds (float): seconds to wait after the last
            workspace is removed before signalling shutdown.
        exit_event (asyncio.Event | None): event the registry trips
            when the idle timer fires. The runner of this app should
            await it and shut uvicorn down. Defaults to a fresh event.
        allowed_hosts (list[str] | None): host allowlist for the
            ``Host`` header. ``None`` (default) reads
            ``$MIRAGE_ALLOWED_HOSTS`` (CSV) or falls back to
            loopback-only (``127.0.0.1``, ``localhost``, ``::1``).
            Pass ``["*"]`` to disable enforcement (only safe behind
            a trusted reverse proxy).
        auth_config (AuthConfig | None): bearer/JWT auth config.
            ``None`` (default) resolves from ``MIRAGE_AUTH_MODE`` env
            and the mode-specific ``MIRAGE_*`` env vars.

    Returns:
        FastAPI: configured app with all routers mounted.
    """
    app = FastAPI(title="Mirage daemon", version="0.1", lifespan=_lifespan)
    hosts = resolve_allowed_hosts(allowed_hosts)
    if "*" not in hosts:
        app.add_middleware(HostHeaderMiddleware, allowed_hosts=hosts)
    auth = auth_config if auth_config is not None else resolve_auth_config()
    if auth.mode == AuthMode.LOCAL and auth.local_token is None:
        logger.warning(
            "daemon starting without bearer auth; anyone who can reach "
            "it can drive it. Set MIRAGE_AUTH_TOKEN or use a non-local "
            "MIRAGE_AUTH_MODE to enforce authentication.")
    app.add_middleware(AuthMiddleware, config=auth)
    app.state.allowed_hosts = hosts
    app.state.auth_config = auth
    app.state.started_at = time.time()
    app.state.exit_event = exit_event or asyncio.Event()
    app.state.registry = WorkspaceRegistry(
        idle_grace_seconds=idle_grace_seconds,
        exit_event=app.state.exit_event,
    )
    app.state.jobs = JobTable()
    app.include_router(workspaces.router)
    app.include_router(sessions.router)
    app.include_router(execute.router)
    app.include_router(jobs.router)
    app.include_router(health.router)
    return app
