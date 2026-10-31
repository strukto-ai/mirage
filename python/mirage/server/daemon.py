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

import gc
import os
import signal
import sys
import threading
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI

from mirage.server.app import build_app
from mirage.server.daemon_config import DaemonConfigError
from mirage.server.env import ENV_IDLE_GRACE_SECONDS, ENV_WORKER_SOCKET
from mirage.server.host_validation import (
    resolve_allowed_hosts,
    resolve_forwarded_allow_ips,
)
from mirage.server.paths import pid_file_path
from mirage.server.registry import (
    resolve_graceful_timeout,
    resolve_max_workspaces,
)
from mirage.server.ssh.config import resolve_ssh_config
from mirage.server.workers.config import resolve_worker_type, resolve_workers
from mirage.server.workers.pool import WorkerPool
from mirage.server.workers.proxy import build_worker_proxy

GC_YOUNG_THRESHOLD = 10_000
SWITCH_INTERVAL = 0.001

_idle_grace = float(os.environ.get(ENV_IDLE_GRACE_SECONDS, "30"))


def _exit() -> None:
    os.kill(os.getpid(), signal.SIGTERM)


def _tune_interpreter() -> None:
    """Keep collections and the GIL off the daemon's response times.

    The daemon runs each workspace on a thread and loop of its own beside
    the HTTP loop, all under one GIL. A full collection scans every
    tracked object, most of which the imports made, and stops every
    thread while it does: collected once and frozen, those objects leave
    the scan. A larger young threshold runs the young collection less
    often, and a shorter switch interval hands the GIL to a waiting loop
    sooner, so one workspace's CPU-bound line stalls the others less.
    Each setting is process-wide, so only the daemon, a process mirage
    owns, makes them; an app that embeds ``build_app`` keeps its own.
    """
    gc.collect()
    gc.freeze()
    gc.set_threshold(GC_YOUNG_THRESHOLD, *gc.get_threshold()[1:])
    sys.setswitchinterval(SWITCH_INTERVAL)


def _watch_daemon() -> None:
    """Stop this worker once its stdin closes: the daemon is gone."""
    sys.stdin.buffer.read()
    _exit()


def _workers_proxy() -> Any:
    """The daemon's server, sending each workspace's requests to one of
    ``workers`` workers. The daemon's SSH port is one server's, so it is
    not taken with workers yet; each worker counts its own rate limits."""
    if resolve_ssh_config().port is not None:
        raise DaemonConfigError("ssh_port does not combine with workers yet")
    allowed_hosts = resolve_allowed_hosts(None)
    host = next((h for h in allowed_hosts if "*" not in h), "localhost")
    pool = WorkerPool(
        count=_workers,
        worker_type=resolve_worker_type(),
        env=dict(os.environ),
        host=host,
        graceful_timeout=resolve_graceful_timeout(),
    )
    return build_worker_proxy(
        pool,
        max_workspaces=resolve_max_workspaces(),
        proxies=resolve_forwarded_allow_ips(),
        allowed_hosts=allowed_hosts,
        idle_grace_seconds=_idle_grace,
        exit=_exit,
        pid_file=pid_file_path(),
    )


_worker_socket = os.environ.get(ENV_WORKER_SOCKET)
_workers = 1 if _worker_socket else resolve_workers()
app: Any

if _workers > 1:
    app = _workers_proxy()
else:
    if _worker_socket:
        # A process worker: as many workspaces as the daemon sends it, the
        # daemon keeping the cap, idle exit and pid file.
        threading.Thread(target=_watch_daemon, daemon=True).start()
        app = build_app(max_workspaces=sys.maxsize)
    else:
        app = build_app(
            idle_grace_seconds=_idle_grace,
            on_idle_exit=_exit,
            pid_file=pid_file_path(),
        )
    _serve = app.router.lifespan_context

    @asynccontextmanager
    async def _lifespan(served: FastAPI) -> AsyncIterator[None]:
        """The app's lifespan, entered once the interpreter is tuned.

        Args:
            served (FastAPI): the daemon app.
        """
        _tune_interpreter()
        async with _serve(served):
            yield

    app.router.lifespan_context = _lifespan
