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
import gc
import importlib
import signal
import sys

import pytest

from mirage.server import daemon
from mirage.server.env import (
    ENV_DRAIN_SECONDS,
    ENV_HOME,
    ENV_IDLE_GRACE_SECONDS,
)


def test_the_daemon_writes_a_pid_file_and_exits_when_idle(
    monkeypatch, tmp_path
):
    monkeypatch.setenv(ENV_HOME, str(tmp_path))
    monkeypatch.setenv(ENV_IDLE_GRACE_SECONDS, "7")
    module = importlib.reload(daemon)
    assert module.app.state.pid_file == tmp_path / "daemon.pid"
    assert module.app.state.on_idle_exit is module._exit
    assert module.app.state.registry.idle_grace_seconds == 7.0


@pytest.mark.asyncio
async def test_the_daemon_tunes_the_interpreter_before_it_serves(
    monkeypatch, tmp_path
):
    monkeypatch.setenv(ENV_HOME, str(tmp_path))
    tuned = []
    young = (daemon.GC_YOUNG_THRESHOLD, *gc.get_threshold()[1:])
    monkeypatch.setattr(gc, "freeze", lambda: tuned.append("freeze"))
    monkeypatch.setattr(gc, "set_threshold", lambda *t: tuned.append(t))
    monkeypatch.setattr(sys, "setswitchinterval", tuned.append)
    module = importlib.reload(daemon)
    assert tuned == []
    async with module.app.router.lifespan_context(module.app):
        assert tuned == ["freeze", young, daemon.SWITCH_INTERVAL]
        assert module.app.state.pid_file.exists()


@pytest.mark.asyncio
async def test_a_signal_drains_before_the_servers_handler_stops_it(
    monkeypatch, tmp_path
):
    monkeypatch.setenv(ENV_HOME, str(tmp_path))
    monkeypatch.setenv(ENV_DRAIN_SECONDS, "5")
    module = importlib.reload(daemon)
    stopped = []
    installed = {}
    monkeypatch.setattr(
        signal,
        "getsignal",
        lambda signum: lambda sig, frame: stopped.append(sig),
    )
    monkeypatch.setattr(signal, "signal", installed.__setitem__)
    module._drain_on_signals(module.app)
    assert set(installed) == {signal.SIGTERM, signal.SIGINT}
    installed[signal.SIGTERM](signal.SIGTERM, None)
    installed[signal.SIGINT](signal.SIGINT, None)
    await asyncio.sleep(0)
    await module.app.state.drain_task
    assert module.app.state.registry.draining
    assert stopped == [signal.SIGTERM]


def test_without_drain_seconds_the_servers_handlers_stay(
    monkeypatch, tmp_path
):
    monkeypatch.setenv(ENV_HOME, str(tmp_path))
    monkeypatch.delenv(ENV_DRAIN_SECONDS, raising=False)
    module = importlib.reload(daemon)
    installed = {}
    monkeypatch.setattr(signal, "signal", installed.__setitem__)
    module._drain_on_signals(module.app)
    assert installed == {}
