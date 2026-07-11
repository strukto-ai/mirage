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

from mirage.cli.client import DaemonClient
from mirage.cli.settings import DaemonSettings
from mirage.server.env import ENV_HOME


def test_spawn_daemon_uses_mirage_home_for_log_and_token(
        tmp_path, monkeypatch):
    monkeypatch.setenv(ENV_HOME, str(tmp_path))
    monkeypatch.delenv("MIRAGE_AUTH_MODE", raising=False)
    spawned = []
    monkeypatch.setattr("mirage.cli.client.subprocess.Popen",
                        lambda *args, **kwargs: spawned.append(kwargs))
    with DaemonClient(DaemonSettings()) as client:
        client._spawn_daemon()
    assert spawned, "daemon process must be spawned"
    assert (tmp_path / "daemon.log").exists()
    assert (tmp_path / "auth_token").exists()
    assert client.settings.auth_token
