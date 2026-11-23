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
