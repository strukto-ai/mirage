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
import functools
import importlib
import logging
import os
import signal
import threading
import time
from collections.abc import AsyncIterator, Callable, Sequence
from contextlib import asynccontextmanager
from pathlib import Path
from types import FrameType
from typing import Any, cast

from fastapi import FastAPI
from uvicorn.middleware.proxy_headers import ProxyHeadersMiddleware

from mirage.concurrency.limiter import run_blocking
from mirage.policy.base import Policy
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
    resolve_forwarded_allow_ips,
)
from mirage.server.mcp.http import register_mcp_routes
from mirage.server.metrics import register_metrics
from mirage.server.paths import (
    mirage_home,
    pid_file_path,
    state_root_path,
)
from mirage.server.rate_limit import (
    RateLimit,
    RateLimitMiddleware,
    resolve_rate_limits,
)
from mirage.server.registry import (
    OWNERS_PREFIX,
    WorkspaceRegistry,
    resolve_graceful_timeout,
    resolve_max_sessions,
    resolve_max_workspaces,
    resolve_policy_file,
)
from mirage.server.routers import (
    asks,
    documents,
    health,
    jobs,
    oauth,
    sessions,
    shell,
    ssh,
    tools,
    vfs,
    workspaces,
)
from mirage.server.rpc.http import register_rpc_routes
from mirage.server.ssh.config import SSHConfig, resolve_ssh_config
from mirage.server.ssh.constants import SERVER_MODULE
from mirage.server.ssh.errors import SSHConfigError
from mirage.server.ssh.types import SSHListener, StartSSH
from mirage.vfs.s3.config import S3Config
from mirage.workspace.record.disk import DiskRecordClient

logger = logging.getLogger(__name__)


def _write_pid_file(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(str(os.getpid()))


def _remove_pid_file(path: Path) -> None:
    try:
        path.unlink(missing_ok=True)
    except OSError:
        logger.debug("could not remove pid file %s", path)


async def _watch_exit(
    exit_event: asyncio.Event, on_exit: Callable[[], None]
) -> None:
    """Call ``on_exit`` once ``exit_event`` is set: the idle timer fired
    or ``POST /v1/shutdown`` asked.

    Args:
        exit_event (asyncio.Event): the app's exit event.
        on_exit (Callable[[], None]): what stopping the app means to
            whoever runs it.
    """
    try:
        await exit_event.wait()
    except asyncio.CancelledError:
        return
    logger.info("exit event tripped")
    on_exit()


def _load_ssh_starter() -> StartSSH:
    module_path, attr = SERVER_MODULE.split(":")
    try:
        module = importlib.import_module(module_path)
    except ModuleNotFoundError as exc:
        raise SSHConfigError(
            "ssh_port is set but the SSH server needs asyncssh; install "
            "the ssh extra (pip install 'mirage-ai[ssh]')"
        ) from exc
    return cast(StartSSH, getattr(module, attr))


async def _start_ssh(app: FastAPI) -> SSHListener | None:
    """Open the SSH endpoint when one is configured.

    A configured entry point that cannot open (the port is taken, asyncssh is
    missing) fails the daemon's start rather than leaving it up without
    the entry point its config asked for.

    Args:
        app (FastAPI): the daemon app.

    Returns:
        SSHListener | None: the running listener, or None when SSH is
            off.
    """
    config: SSHConfig = app.state.ssh_config
    if config.port is None:
        return None
    start = _load_ssh_starter()
    return await start(app.state.registry, config)


def _drain_on_signals(
    app: FastAPI,
) -> dict[signal.Signals, Callable[[int, FrameType | None], Any]]:
    """Have SIGTERM and SIGINT drain the app before the server's own
    handlers stop it, when ``graceful_timeout`` is set: running lines get
    that long to finish while new workspaces are refused and
    ``/v1/ready`` answers 503, then the server stops as it would have.
    Whatever runs the app (uvicorn, a gunicorn worker, hypercorn) has
    installed its handlers by the time the lifespan starts. A handler is
    process-wide and only the main thread may set one, so nothing is
    wrapped without a timeout or off the main thread.

    Args:
        app (FastAPI): the app.

    Returns:
        dict[signal.Signals, Callable[[int, FrameType | None], Any]]: the
            handlers it wrapped, to put back as the app stops.
    """
    app.state.drain_task = None
    if (
        app.state.graceful_timeout <= 0
        or threading.current_thread() is not threading.main_thread()
    ):
        return {}
    loop = asyncio.get_running_loop()
    wrapped = {}
    for signum in (signal.SIGTERM, signal.SIGINT):
        stop = signal.getsignal(signum)
        if callable(stop):
            wrapped[signum] = stop
            signal.signal(
                signum, functools.partial(_on_signal, app, loop, stop)
            )
    return wrapped


def _on_signal(
    app: FastAPI,
    loop: asyncio.AbstractEventLoop,
    stop: Callable[[int, FrameType | None], Any],
    signum: int,
    frame: FrameType | None,
) -> None:
    """Start the drain on the app's loop; a signal handler may only hand
    work to it.

    Args:
        app (FastAPI): the app.
        loop (asyncio.AbstractEventLoop): the app's loop.
        stop (Callable[[int, FrameType | None], Any]): the handler the
            server installed.
        signum (int): the signal.
        frame (FrameType | None): the interrupted frame.
    """
    loop.call_soon_threadsafe(_start_drain, app, stop, signum)


def _start_drain(
    app: FastAPI, stop: Callable[[int, FrameType | None], Any], signum: int
) -> None:
    """Drain once; a signal that arrives while it runs changes nothing.

    Args:
        app (FastAPI): the app.
        stop (Callable[[int, FrameType | None], Any]): the handler the
            server installed.
        signum (int): the signal.
    """
    if app.state.drain_task is None:
        app.state.drain_task = asyncio.ensure_future(
            _drain_then_stop(app, stop, signum)
        )


async def _drain_then_stop(
    app: FastAPI, stop: Callable[[int, FrameType | None], Any], signum: int
) -> None:
    """Drain the app, then hand the signal to the server's handler.

    Args:
        app (FastAPI): the app.
        stop (Callable[[int, FrameType | None], Any]): the handler the
            server installed.
        signum (int): the signal.
    """
    try:
        await app.state.registry.drain(app.state.graceful_timeout)
    finally:
        stop(signum, None)


@asynccontextmanager
async def _lifespan(app: FastAPI) -> AsyncIterator[None]:
    listener = await _start_ssh(app)
    app.state.ssh = listener
    if app.state.pid_file is not None:
        await run_blocking(_write_pid_file, app.state.pid_file)
    on_exit = app.state.on_idle_exit
    exit_task = (
        asyncio.create_task(_watch_exit(app.state.exit_event, on_exit))
        if on_exit is not None
        else None
    )
    wrapped = _drain_on_signals(app)
    try:
        yield
    finally:
        for signum, stop in wrapped.items():
            signal.signal(signum, stop)
        if exit_task is not None:
            exit_task.cancel()
        if listener is not None:
            listener.close()
            await listener.wait_closed()
        if app.state.graceful_timeout > 0:
            await app.state.registry.drain(app.state.graceful_timeout)
        try:
            await app.state.mcp.close()
            await app.state.jobs.close()
        finally:
            await app.state.registry.close_all()
            if app.state.pid_file is not None:
                await run_blocking(_remove_pid_file, app.state.pid_file)


def build_app(
    idle_grace_seconds: float = 30.0,
    exit_event: asyncio.Event | None = None,
    on_idle_exit: Callable[[], None] | None = None,
    allowed_hosts: list[str] | None = None,
    auth_config: AuthConfig | None = None,
    snapshot_store: S3Config | None = None,
    state_root: str | Path | None = None,
    pid_file: str | Path | None = None,
    ssh_config: SSHConfig | None = None,
    max_workspaces: int | None = None,
    policies: Sequence[Policy] = (),
    policy_file: str | Path | None = None,
    rate_limits: Sequence[RateLimit] | None = None,
    forwarded_allow_ips: Sequence[str] | None = None,
    max_sessions: int | None = None,
    graceful_timeout: float | None = None,
) -> FastAPI:
    """Construct the Mirage server's FastAPI app.

    The app serves until whoever runs it stops it: it neither exits on
    its own nor writes a PID file unless asked to, which is what the
    daemon entry (``mirage.server.daemon:app``) does. The workspace
    registry is created eagerly so the app is usable even without ASGI
    lifespan events firing (e.g. inside an ``httpx.ASGITransport`` test
    client).

    Args:
        idle_grace_seconds (float): seconds to wait after the last
            workspace is removed before signalling shutdown.
        exit_event (asyncio.Event | None): event the registry trips
            when the idle timer fires, and ``POST /v1/shutdown`` sets.
            Defaults to a fresh event.
        on_idle_exit (Callable[[], None] | None): called once the exit
            event is set. None (default) keeps the app serving; the
            daemon passes one that stops its process.
        allowed_hosts (list[str] | None): host allowlist for the
            ``Host`` header. ``None`` (default) reads
            ``$MIRAGE_ALLOWED_HOSTS`` (CSV) or falls back to
            loopback-only (``127.0.0.1``, ``localhost``, ``::1``).
            Pass ``["*"]`` to skip the Host comparison (only safe
            behind a trusted reverse proxy). Browser requests from
            another origin are refused either way.
        auth_config (AuthConfig | None): bearer/JWT auth config.
            ``None`` (default) resolves from ``MIRAGE_AUTH_MODE`` env
            and the mode-specific ``MIRAGE_*`` env vars.
        snapshot_store (S3Config | None): the S3-like store a snapshot
            request may name a key in. ``None`` (default) has none: a
            snapshot then only goes back to the caller, as the server
            never writes one to its own disk.
        state_root (str | Path | None): live-state root for the disk
            store the daemon defaults workspaces to. ``None`` (default)
            uses ``$MIRAGE_HOME/state``.
        pid_file (str | Path | None): a file to hold the process id
            while the app runs. ``None`` (default) writes none; the
            daemon passes ``$MIRAGE_HOME/daemon.pid``.
        ssh_config (SSHConfig | None): the SSH endpoint, opened with the
            app's lifespan. ``None`` (default) resolves it from the
            ``MIRAGE_SSH_*`` env vars and the ``ssh_*`` config keys; it
            stays shut unless a port is set.
        max_workspaces (int | None): the most workspaces the app holds
            at once; past it a create, clone or load answers 503.
            ``None`` (default) reads ``$MIRAGE_MAX_WORKSPACES`` or the
            ``max_workspaces`` config key, else sets no cap.
        policies (Sequence[Policy]): the server's own policies: each
            answers ``pre_workspace`` before a create, clone or load
            builds anything, and is registered on every workspace the
            app builds, so a tenant cannot lift it.
        policy_file (str | Path | None): a file of policy programs that
            answer the same way. ``None`` (default) reads
            ``$MIRAGE_POLICY_FILE`` or the ``policy_file`` config key,
            else runs none.
        rate_limits (Sequence[RateLimit] | None): limits on the requests
            the app answers, each keyed on the client address, the
            account, the workspace, a header or a function of the
            request; past one a request answers 429. ``None`` (default)
            reads ``$MIRAGE_RATE_LIMITS`` or the ``rate_limits`` config
            key, else sets none.
        forwarded_allow_ips (Sequence[str] | None): the proxies whose
            ``X-Forwarded-For`` names the client, addresses or networks,
            ``*`` for any. ``None`` (default) reads
            ``$MIRAGE_FORWARDED_ALLOW_IPS`` or the ``forwarded_allow_ips``
            config key, else believes none.
        max_sessions (int | None): the most sessions each workspace
            holds; past it a new session answers 429. ``None`` (default)
            reads ``$MIRAGE_MAX_SESSIONS`` or the ``max_sessions`` config
            key, else sets no cap.
        graceful_timeout (float | None): how long a shutdown (SIGTERM,
            SIGINT, or the lifespan ending) lets running lines finish,
            holding new ones and refusing new workspaces, before it
            cancels the rest. ``None`` (default) reads
            ``$MIRAGE_GRACEFUL_TIMEOUT`` or the ``graceful_timeout`` config key,
            else 0, which drains nothing.

    Returns:
        FastAPI: configured app with all routers mounted.
    """
    validate_daemon_table(read_daemon_table(mirage_home()))
    app = FastAPI(title="Mirage daemon", version="0.1", lifespan=_lifespan)
    hosts = resolve_allowed_hosts(allowed_hosts)
    app.add_middleware(HostHeaderMiddleware, allowed_hosts=hosts)
    limits = resolve_rate_limits(rate_limits)
    app.add_middleware(RateLimitMiddleware, rate_limits=limits, signed_in=True)
    auth = auth_config if auth_config is not None else resolve_auth_config()
    if auth.mode == AuthMode.LOCAL and auth.local_token is None:
        logger.warning(
            "daemon starting without bearer auth; anyone who can reach "
            "it can drive it. Set MIRAGE_AUTH_TOKEN or use a non-local "
            "MIRAGE_AUTH_MODE to enforce authentication."
        )
    app.add_middleware(AuthMiddleware, config=auth)
    app.add_middleware(RateLimitMiddleware, rate_limits=limits)
    proxies = resolve_forwarded_allow_ips(forwarded_allow_ips)
    if proxies:
        app.add_middleware(ProxyHeadersMiddleware, trusted_hosts=proxies)
    app.state.allowed_hosts = hosts
    app.state.auth_config = auth
    app.state.started_at = time.time()
    app.state.exit_event = exit_event or asyncio.Event()
    app.state.on_idle_exit = on_idle_exit
    app.state.state_root = state_root_path(state_root)
    app.state.registry = WorkspaceRegistry(
        idle_grace_seconds=idle_grace_seconds,
        exit_event=app.state.exit_event,
        accounts_required=auth.mode == AuthMode.JWT,
        owners=DiskRecordClient(str(app.state.state_root), OWNERS_PREFIX),
        max_workspaces=resolve_max_workspaces(max_workspaces),
        policies=policies,
        programs=resolve_policy_file(policy_file),
        max_sessions=resolve_max_sessions(max_sessions),
    )
    app.state.graceful_timeout = resolve_graceful_timeout(graceful_timeout)
    app.state.jobs = app.state.registry.jobs
    register_metrics(app.state.registry)
    app.state.pid_file = (
        pid_file_path(pid_file) if pid_file is not None else None
    )
    app.state.snapshot_store = snapshot_store
    app.state.ssh_config = (
        ssh_config if ssh_config is not None else resolve_ssh_config()
    )
    app.state.ssh = None
    app.include_router(workspaces.router)
    app.include_router(documents.router)
    app.include_router(sessions.router)
    app.include_router(asks.router)
    app.include_router(shell.router)
    app.include_router(ssh.router)
    app.include_router(tools.router)
    app.include_router(vfs.router)
    app.include_router(jobs.router)
    app.include_router(health.router)
    app.include_router(oauth.router)
    app.state.mcp = register_mcp_routes(
        app, app.state.registry, app.state.jobs
    )
    register_rpc_routes(app, app.state.registry, app.state.jobs, app.state.mcp)
    return app
