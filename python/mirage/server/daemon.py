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
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

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
