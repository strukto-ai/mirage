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

import sys

import pytest

from mirage.server.daemon_config import DaemonConfigError
from mirage.server.env import ENV_WORKER_TYPE, ENV_WORKERS
from mirage.server.workers.config import resolve_worker_type, resolve_workers
from mirage.server.workers.types import WorkerType


def test_resolve_workers_reads_the_env_then_config_else_one(
    monkeypatch, tmp_path
):
    monkeypatch.setenv("MIRAGE_HOME", str(tmp_path))
    monkeypatch.delenv(ENV_WORKERS, raising=False)
    assert resolve_workers() == 1
    (tmp_path / "config.toml").write_text("[daemon]\nworkers = 4\n")
    assert resolve_workers() == 4
    monkeypatch.setenv(ENV_WORKERS, "2")
    assert resolve_workers() == 2
    assert resolve_workers(8) == 8
    monkeypatch.setenv(ENV_WORKERS, "0")
    with pytest.raises(DaemonConfigError, match="workers"):
        resolve_workers()


def test_resolve_worker_type_reads_the_env_then_config_else_by_the_gil(
    monkeypatch, tmp_path
):
    monkeypatch.setenv("MIRAGE_HOME", str(tmp_path))
    monkeypatch.delenv(ENV_WORKER_TYPE, raising=False)
    monkeypatch.setattr(sys, "_is_gil_enabled", lambda: True, raising=False)
    assert resolve_worker_type() == WorkerType.PROCESS
    monkeypatch.setattr(sys, "_is_gil_enabled", lambda: False, raising=False)
    assert resolve_worker_type() == WorkerType.THREAD
    (tmp_path / "config.toml").write_text(
        '[daemon]\nworker_type = "process"\n'
    )
    assert resolve_worker_type() == WorkerType.PROCESS
    monkeypatch.setenv(ENV_WORKER_TYPE, "thread")
    assert resolve_worker_type() == WorkerType.THREAD
    with pytest.raises(DaemonConfigError, match="worker_type"):
        resolve_worker_type("cpu")
