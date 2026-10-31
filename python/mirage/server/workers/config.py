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

import os
import sys
from typing import Any

from mirage.server.daemon_config import DaemonConfigError, read_daemon_table
from mirage.server.env import (
    ENV_WORKER_TYPE,
    ENV_WORKERS,
)
from mirage.server.paths import mirage_home
from mirage.server.workers.types import WorkerType


def resolve_workers(workers: int | None = None) -> int:
    """How many workers the daemon runs: ``workers`` when given, else
    ``$MIRAGE_WORKERS``, else the ``workers`` key in config.toml's
    ``[daemon]`` table, else 1, a daemon that holds every workspace
    itself. Mirrors TypeScript's ``resolveWorkers``.

    Args:
        workers (int | None): the count the caller set.

    Raises:
        DaemonConfigError: the count is not a positive whole number.
    """
    value: Any = workers
    if value is None:
        value = os.environ.get(ENV_WORKERS) or read_daemon_table(
            mirage_home()
        ).get("workers")
        if value is None or value == "":
            return 1
    try:
        count = int(value) if not isinstance(value, (bool, float)) else 0
    except ValueError:
        count = 0
    if count < 1:
        raise DaemonConfigError(
            f"workers must be a positive whole number, got {value!r}"
        )
    return count


def resolve_worker_type(worker_type: str | None = None) -> WorkerType:
    """What the workers are: ``worker_type`` when given, else
    ``$MIRAGE_WORKER_TYPE``, else the ``worker_type`` key in config.toml's
    ``[daemon]`` table, else threads on an interpreter without the GIL
    (3.14t) and processes on one with it, whose threads would take turns.
    Mirrors TypeScript's ``resolveWorkerType``.

    Args:
        worker_type (str | None): the type the caller set.

    Raises:
        DaemonConfigError: the type is neither process nor thread.
    """
    value: Any = worker_type
    if value is None:
        value = os.environ.get(ENV_WORKER_TYPE) or read_daemon_table(
            mirage_home()
        ).get("worker_type")
        if value is None or value == "":
            gil = getattr(sys, "_is_gil_enabled", lambda: True)()
            return WorkerType.PROCESS if gil else WorkerType.THREAD
    try:
        return WorkerType(value)
    except ValueError:
        raise DaemonConfigError(
            f"worker_type must be process or thread, got {value!r}"
        ) from None
