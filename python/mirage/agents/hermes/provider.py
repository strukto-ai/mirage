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

import logging
import threading
from collections.abc import Callable
from functools import partial
from pathlib import Path
from typing import Any

from agent.terminal_env_provider import TerminalEnvironmentProvider
from hermes_cli.plugins_context import PluginContext

from mirage.agents.hermes.constants import BACKEND, SETTING
from mirage.agents.hermes.environment import MirageEnvironment
from mirage.config import load_config
from mirage.workspace.workspace import Workspace

logger = logging.getLogger(__name__)


class MirageTerminalProvider(TerminalEnvironmentProvider):
    """hermes' ``mirage`` terminal backend.

    Builds the workspace from the YAML the plugin setting names, once
    per path, and gives each hermes task its own session in it.

    Args:
        config_path (Callable[[], str | None]): Returns the workspace
            YAML's path, read on every call so a changed setting applies.
    """

    name = BACKEND
    display_name = "Mirage"
    skip_container_guards = False
    default_cwd = "/"

    def __init__(self, config_path: Callable[[], str | None]) -> None:
        self._config_path = config_path
        self._lock = threading.Lock()
        self._workspaces: dict[Path, Workspace] = {}

    def _path(self) -> Path | None:
        value = self._config_path()
        return Path(value).expanduser().resolve() if value else None

    def is_available(self) -> bool:
        path = self._path()
        return path is not None and path.is_file()

    def check_requirements(self, config: dict[str, Any]) -> bool:
        if self.is_available():
            return True
        logger.warning(
            "the mirage backend needs plugins.entries.mirage.settings.%s "
            "set to a Mirage workspace YAML that exists (now %s)",
            SETTING,
            self._path(),
        )
        return False

    def create_environment(
        self,
        *,
        cwd: str,
        timeout: int,
        task_id: str = "default",
        **kwargs: Any,
    ) -> MirageEnvironment:
        return MirageEnvironment(
            self._workspace(), cwd=cwd, timeout=timeout, task_id=task_id
        )

    def _workspace(self) -> Workspace:
        path = self._path()
        if path is None:
            raise ValueError(
                "set plugins.entries.mirage.settings."
                f"{SETTING} to a Mirage workspace YAML"
            )
        with self._lock:
            workspace = self._workspaces.get(path)
            if workspace is None:
                workspace = Workspace(
                    **load_config(path).to_workspace_kwargs()
                )
                self._workspaces[path] = workspace
        return workspace


def register(ctx: PluginContext) -> None:
    """hermes plugin entry: register the ``mirage`` terminal backend.

    Args:
        ctx (PluginContext): The plugin context hermes passes.
    """
    ctx.register_terminal_environment_provider(
        MirageTerminalProvider(partial(ctx.get_config, SETTING))
    )
