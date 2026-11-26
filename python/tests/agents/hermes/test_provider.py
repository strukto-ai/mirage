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

import subprocess
import sys
import threading

import pytest

pytest.importorskip("agent.terminal_env_provider")

from mirage.agents.hermes import MirageTerminalProvider, register
from mirage.agents.hermes.ask import HttpAsk

import pytest

pytest.importorskip("agent.terminal_env_provider")

from mirage.agents.hermes import MirageTerminalProvider, register

WORKSPACE_YAML = """
processes: workspace
mounts:
  /tmp: {vfs: ram, mode: write}
  /data: {vfs: ram, mode: write}
"""


class FakeContext:
    def __init__(self, settings: dict[str, str]) -> None:
        self.settings = settings
        self.providers: list[MirageTerminalProvider] = []

    def get_config(self, key: str, default: str | None = None) -> str | None:
        return self.settings.get(key, default)

    def register_terminal_environment_provider(
        self, provider: MirageTerminalProvider
    ) -> None:
        self.providers.append(provider)


@pytest.fixture
def config(tmp_path):
    path = tmp_path / "workspace.yaml"
    path.write_text(WORKSPACE_YAML)
    return path


def test_register_reads_the_plugin_setting(config):
    ctx = FakeContext({"config": str(config)})
    register(ctx)
    [provider] = ctx.providers
    assert provider.name == "mirage"
    assert provider.is_available()


def test_unset_or_missing_config_is_unavailable(tmp_path):
    assert not MirageTerminalProvider(lambda: None).is_available()
    missing = MirageTerminalProvider(lambda: str(tmp_path / "none.yaml"))
    assert not missing.is_available()
    assert not missing.check_requirements({})


def test_hermes_approvals_stay_on(config):
    provider = MirageTerminalProvider(lambda: str(config))
    assert provider.skip_container_guards is False
    assert provider.is_remote is True


def test_an_ask_endpoint_stands_hermes_guards_down(config):
    asks = HttpAsk("http://127.0.0.1:9/ask")
    provider = MirageTerminalProvider(lambda: str(config), lambda: asks)
    assert provider.skip_container_guards is True


def test_register_wires_the_ask_setting(config):
    ctx = FakeContext(
        {"config": str(config), "ask_url": "http://127.0.0.1:9/ask"}
    )
    register(ctx)
    [provider] = ctx.providers
    assert provider.skip_container_guards is True


def test_every_task_shares_one_environment(config):
    """mount_type mirage 的机器只认一个会话视图，所有 task id 必须拿到同一个环境。"""
    provider = MirageTerminalProvider(lambda: str(config))
    first = provider.create_environment(cwd="/", timeout=30, task_id="prompt-backend-probe")
    second = provider.create_environment(cwd="/", timeout=30, task_id="real-turn")
    try:
        assert first is second
    finally:
        provider.close()


def test_tasks_share_one_workspace(config):
    provider = MirageTerminalProvider(lambda: str(config))
    first = provider.create_environment(cwd="/", timeout=30, task_id="a")
    second = provider.create_environment(cwd="/", timeout=30, task_id="b")
    try:
        assert first.execute("echo hi > /data/a.txt")["returncode"] == 0
        assert second.execute("cat /data/a.txt")["output"].strip() == "hi"
    finally:
        first.cleanup()
        second.cleanup()
        provider.close()


def test_secret_pointers_in_the_yaml_resolve(tmp_path, monkeypatch):
    root = tmp_path / "root"
    root.mkdir()
    (root / "hello.txt").write_text("hi\n")
    monkeypatch.setenv("MIRAGE_HERMES_TEST_ROOT", str(root))
    config = tmp_path / "workspace.yaml"
    config.write_text(
        WORKSPACE_YAML
        + "  /disk:\n    vfs: disk\n"
        + "    config: {root: {from: env, key: MIRAGE_HERMES_TEST_ROOT}}\n"
    )
    provider = MirageTerminalProvider(lambda: str(config))
    environment = provider.create_environment(cwd="/", timeout=30, task_id="s")
    try:
        result = environment.execute("cat /disk/hello.txt")
        assert result["output"].strip() == "hi", result
    finally:
        environment.cleanup()
        provider.close()


def loop_threads() -> set[threading.Thread]:
    return {t for t in threading.enumerate() if t.name == "mirage-hermes"}


def test_close_shuts_the_workspace_and_its_loop(config):
    before = loop_threads()
    provider = MirageTerminalProvider(lambda: str(config))
    environment = provider.create_environment(cwd="/", timeout=30, task_id="c")
    provider.close()
    assert environment.execute("echo hi")["returncode"] != 0
    environment.cleanup()
    assert loop_threads() <= before
    with pytest.raises(RuntimeError, match="shut down"):
        provider.create_environment(cwd="/", timeout=30, task_id="d")
    assert loop_threads() <= before


EXIT_SCRIPT = """
import logging, sys
logging.basicConfig(level=logging.WARNING, stream=sys.stderr)
from mirage.agents.hermes import MirageTerminalProvider
provider = MirageTerminalProvider(lambda: sys.argv[1])
environment = provider.create_environment(cwd="/", timeout=30, task_id="x")
print(environment.execute("echo hi")["output"].strip())
"""


def test_exit_closes_the_workspace_while_thread_pools_still_run(config):
    result = subprocess.run(
        [sys.executable, "-c", EXIT_SCRIPT, str(config)],
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "hi"
    assert "closing a mirage workspace failed" not in result.stderr
