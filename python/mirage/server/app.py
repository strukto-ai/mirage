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
import importlib
import logging
import os
import signal
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI

from mirage.concurrency.limiter import run_blocking
from mirage.server.auth import (
    AuthConfig,
    AuthMiddleware,
    AuthMode,
    resolve_auth_config,
)
from mirage.server.daemon_config import (
    read_daemon_table,
    validate_daemon_table,
)
from mirage.server.host_validation import (
    HostHeaderMiddleware,
    resolve_allowed_hosts,
)
from mirage.server.jobs import JobTable
from mirage.server.mcp.http import register_mcp_routes
from mirage.server.paths import (
    mirage_home,
    pid_file_path,
    snapshot_root_path,
    state_root_path,
    version_root_path,
)
from mirage.server.registry import WorkspaceRegistry
from mirage.server.routers import (
    asks,
    documents,
    health,
    jobs,
    sessions,
    shell,
    tools,
    versions,
    workspaces,
)
from mirage.server.ssh.config import SSHConfig, resolve_ssh_config
from mirage.server.ssh.constants import SERVER_MODULE
from mirage.server.ssh.errors import SSHConfigError
from mirage.server.ssh.types import SSHListener, StartSSH
from mirage.server.version.backend import LocalBackend

logger = logging.getLogger(__name__)


def _write_pid_file(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(str(os.getpid()))


def _remove_pid_file(path: Path) -> None:
    try:
        path.unlink(missing_ok=True)
    except OSError:
        logger.debug("could not remove pid file %s", path)


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


def _load_ssh_starter() -> StartSSH:
    module_path, attr = SERVER_MODULE.split(":")
    try:
        module = importlib.import_module(module_path)
    except ModuleNotFoundError as exc:
        raise SSHConfigError(
            "ssh_port is set but the SSH server needs asyncssh; install "
            "the ssh extra (pip install 'mirage-ai[ssh]')"
        ) from exc
    return getattr(module, attr)


async def _start_ssh(app: FastAPI) -> SSHListener | None:
    """Open the SSH door when one is configured.

    A configured door that cannot open (the port is taken, asyncssh is
    missing) fails the daemon's start rather than leaving it up without
    the door its config asked for.

    Args:
        app (FastAPI): the daemon app.

    Returns:
        SSHListener | None: the running listener, or None when SSH is
            off.
    """
    config: SSHConfig | None = app.state.ssh_config
    if config is None:
        return None
    start = _load_ssh_starter()
    return await start(app.state.registry, config, app.state.mcp)


@asynccontextmanager
async def _lifespan(app: FastAPI):
    ssh = await _start_ssh(app)
    app.state.ssh = ssh
    await run_blocking(_write_pid_file, app.state.pid_file)
    exit_task = asyncio.create_task(_watch_exit(app.state.exit_event))
    try:
        yield
    finally:
        exit_task.cancel()
        if ssh is not None:
            ssh.close()
            await ssh.wait_closed()
        try:
            await app.state.mcp.close()
            await app.state.jobs.close()
        finally:
            await app.state.registry.close_all()
            await run_blocking(_remove_pid_file, app.state.pid_file)


def build_app(
    idle_grace_seconds: float = 30.0,
    exit_event: asyncio.Event | None = None,
    allowed_hosts: list[str] | None = None,
    auth_config: AuthConfig | None = None,
    version_root: str | Path | None = None,
    snapshot_root: str | Path | None = None,
    state_root: str | Path | None = None,
    pid_file: str | Path | None = None,
    ssh_config: SSHConfig | None = None,
) -> FastAPI:
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
        version_root (str | Path | None): git repos root. ``None``
            (default) uses ``$MIRAGE_HOME/repos`` (or ``~/.mirage/repos``).
        snapshot_root (str | Path | None): snapshot root. ``None``
            (default) uses ``$MIRAGE_HOME/snapshots``.
        state_root (str | Path | None): live-state root for the disk
            store the daemon defaults workspaces to. ``None`` (default)
            uses ``$MIRAGE_HOME/state``.
        pid_file (str | Path | None): daemon pid file path. ``None``
            (default) uses ``$MIRAGE_HOME/daemon.pid`` (or
            ``~/.mirage/daemon.pid``).
        ssh_config (SSHConfig | None): the SSH door, opened with the
            app's lifespan. ``None`` (default) resolves it from the
            ``MIRAGE_SSH_*`` env vars and the ``ssh_*`` config keys; it
            stays shut unless a port is set.

    Returns:
        FastAPI: configured app with all routers mounted.
    """
    validate_daemon_table(read_daemon_table(mirage_home()))
    app = FastAPI(title="Mirage daemon", version="0.1", lifespan=_lifespan)
    hosts = resolve_allowed_hosts(allowed_hosts)
    if "*" not in hosts:
        app.add_middleware(HostHeaderMiddleware, allowed_hosts=hosts)
    auth = auth_config if auth_config is not None else resolve_auth_config()
    if auth.mode == AuthMode.LOCAL and auth.local_token is None:
        logger.warning(
            "daemon starting without bearer auth; anyone who can reach "
            "it can drive it. Set MIRAGE_AUTH_TOKEN or use a non-local "
            "MIRAGE_AUTH_MODE to enforce authentication."
        )
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
    app.state.pid_file = pid_file_path(pid_file)
    app.state.version_backend = LocalBackend(version_root_path(version_root))
    app.state.snapshot_root = snapshot_root_path(snapshot_root)
    app.state.state_root = state_root_path(state_root)
    app.state.ssh_config = (
        ssh_config if ssh_config is not None else resolve_ssh_config()
    )
    app.state.ssh = None
    app.include_router(workspaces.router)
    app.include_router(documents.router)
    app.include_router(versions.router)
    app.include_router(sessions.router)
    app.include_router(asks.router)
    app.include_router(shell.router)
    app.include_router(tools.router)
    app.include_router(jobs.router)
    app.include_router(health.router)
    app.state.mcp = register_mcp_routes(
        app, app.state.registry, app.state.jobs
    )
    return app
