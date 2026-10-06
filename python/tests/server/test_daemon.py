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

import importlib

from mirage.server import daemon
from mirage.server.env import ENV_HOME, ENV_IDLE_GRACE_SECONDS


def test_the_daemon_writes_a_pid_file_and_exits_when_idle(
    monkeypatch, tmp_path
):
    monkeypatch.setenv(ENV_HOME, str(tmp_path))
    monkeypatch.setenv(ENV_IDLE_GRACE_SECONDS, "7")
    module = importlib.reload(daemon)
    assert module.app.state.pid_file == tmp_path / "daemon.pid"
    assert module.app.state.on_idle_exit is module._exit
    assert module.app.state.registry.idle_grace_seconds == 7.0
