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
import gc
import os
import signal
import sys
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from types import FrameType
from typing import Any

from fastapi import FastAPI

from mirage.server.app import build_app
from mirage.server.env import ENV_IDLE_GRACE_SECONDS
from mirage.server.paths import pid_file_path

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


def _drain_on_signals(served: FastAPI) -> None:
    """Have SIGTERM and SIGINT drain the app before the server's own
    handlers stop it, when ``drain_seconds`` is set: running lines get
    that long to finish while new workspaces are refused and
    ``/v1/ready`` answers 503, then the server stops as it would have.
    A signal handler is process-wide, so only the daemon, a process
    mirage owns, installs one.

    Args:
        served (FastAPI): the daemon app.
    """
    served.state.drain_task = None
    if served.state.drain_seconds <= 0:
        return
    loop = asyncio.get_running_loop()
    for signum in (signal.SIGTERM, signal.SIGINT):
        stop = signal.getsignal(signum)
        if callable(stop):
            signal.signal(
                signum, functools.partial(_on_signal, served, loop, stop)
            )


def _on_signal(
    served: FastAPI,
    loop: asyncio.AbstractEventLoop,
    stop: Callable[[int, FrameType | None], Any],
    signum: int,
    frame: FrameType | None,
) -> None:
    """Start the drain on the app's loop; a signal handler may only hand
    work to it.

    Args:
        served (FastAPI): the daemon app.
        loop (asyncio.AbstractEventLoop): the app's loop.
        stop (Callable[[int, FrameType | None], Any]): the handler the
            server installed.
        signum (int): the signal.
        frame (FrameType | None): the interrupted frame.
    """
    loop.call_soon_threadsafe(_start_drain, served, stop, signum)


def _start_drain(
    served: FastAPI, stop: Callable[[int, FrameType | None], Any], signum: int
) -> None:
    """Drain once; a signal that arrives while it runs changes nothing.

    Args:
        served (FastAPI): the daemon app.
        stop (Callable[[int, FrameType | None], Any]): the handler the
            server installed.
        signum (int): the signal.
    """
    if served.state.drain_task is None:
        served.state.drain_task = asyncio.ensure_future(
            _drain_then_stop(served, stop, signum)
        )


async def _drain_then_stop(
    served: FastAPI, stop: Callable[[int, FrameType | None], Any], signum: int
) -> None:
    """Drain the app, then hand the signal to the server's handler.

    Args:
        served (FastAPI): the daemon app.
        stop (Callable[[int, FrameType | None], Any]): the handler the
            server installed.
        signum (int): the signal.
    """
    try:
        await served.state.registry.drain(served.state.drain_seconds)
    finally:
        stop(signum, None)


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
        _drain_on_signals(served)
        yield


app.router.lifespan_context = _lifespan
