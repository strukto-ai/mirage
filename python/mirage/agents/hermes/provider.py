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
import logging
import threading
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from functools import partial
from pathlib import Path
from typing import Any

from agent.terminal_env_provider import TerminalEnvironmentProvider
from hermes_cli.plugins_context import PluginContext

from mirage.agents.hermes.ask import make_ask
from mirage.agents.hermes.constants import (
    ASK_TIMEOUT,
    ASK_TOKEN,
    ASK_URL,
    BACKEND,
    SETTING,
)
from mirage.agents.hermes.environment import MirageEnvironment
from mirage.policy import AskHandler
from mirage.server.workspace_config import build_workspace_from_config
from mirage.workspace.workspace import Workspace

logger = logging.getLogger(__name__)


class MirageTerminalProvider(TerminalEnvironmentProvider):
    """hermes' ``mirage`` terminal backend.

    Builds the workspace from the YAML the plugin setting names, once
    per path, and gives each hermes task its own session in it. When an
    ask endpoint is set, the profile's ``ask`` rules are answered by it
    and hermes' own dangerous-command guard stands down: one line gets
    one card.

    Args:
        config_path (Callable[[], str | None]): Returns the workspace
            YAML's path, read on every call so a changed setting applies.
        ask_for (Callable[[], AskHandler | None] | None): Returns the
            handler the ``ask_url`` setting describes, read on every
            workspace build so a changed setting applies; None means the
            profile's asks have nobody to answer them.
    """

    name = BACKEND
    display_name = "Mirage"
    default_cwd = "/"

    @property
    def skip_container_guards(self) -> bool:
        """Whether hermes' own guard stands down: yes when we ask."""
        return self._ask_for() is not None

    def __init__(
        self,
        config_path: Callable[[], str | None],
        ask_for: Callable[[], AskHandler | None] | None = None,
    ) -> None:
        self._config_path = config_path
        self._ask_for = ask_for or _no_ask
        self._lock = threading.Lock()
        self._workspaces: dict[Path, Workspace] = {}
        # 一条终端后端共用一个 MirageEnvironment：mount_type mirage 的机器只认一个会话的视图，
        # Hermes 的 prompt 探测和真正的回合却是两个 task id，各自建环境会互相顶掉。
        self._environments: dict[Path, MirageEnvironment] = {}
        self._loop: asyncio.AbstractEventLoop | None = None
        self._thread: threading.Thread | None = None
        self._closed = False
        # Registered after the thread pools' own hook, so it runs first.
        threading._register_atexit(self.close)  # type: ignore[attr-defined]

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
        workspace = self._workspace()
        path = self._path()
        with self._lock:
            environment = self._environments.get(path) if path else None
            if environment is None:
                environment = MirageEnvironment(
                    workspace, cwd=cwd, timeout=timeout, task_id=task_id
                )
                # 会话要活到进程退出，不能因为 Hermes 结束某一次回合就被关掉；
                # 真正的关闭在 provider.close()。
                environment._original_cleanup = environment.cleanup  # type: ignore[attr-defined]
                environment.cleanup = _noop  # type: ignore[method-assign]
                if path:
                    self._environments[path] = environment
        return environment

    def _owner(self) -> asyncio.AbstractEventLoop:
        if self._loop is None:
            self._loop = asyncio.new_event_loop()
            self._loop.set_default_executor(
                ThreadPoolExecutor(thread_name_prefix="mirage-hermes")
            )
            self._thread = threading.Thread(
                target=self._loop.run_forever,
                name="mirage-hermes",
                daemon=True,
            )
            self._thread.start()
        return self._loop

    def _workspace(self) -> Workspace:
        path = self._path()
        if path is None:
            raise ValueError(
                "set plugins.entries.mirage.settings."
                f"{SETTING} to a Mirage workspace YAML"
            )
        with self._lock:
            if self._closed:
                raise RuntimeError("the mirage backend has shut down")
            workspace = self._workspaces.get(path)
            if workspace is None:
                workspace = asyncio.run_coroutine_threadsafe(
                    build_owned_workspace(path, on_ask=self._ask_for()),
                    self._owner(),
                ).result()
                self._workspaces[path] = workspace
        return workspace

    def close(self) -> None:
        """Close every workspace this provider built, then its loop. hermes
        calls none between tasks, so this runs once, when the process exits,
        and the provider builds no workspace after it."""
        with self._lock:
            self._closed = True
            loop, thread = self._loop, self._thread
            if loop is None or thread is None:
                return
            for environment in self._environments.values():
                try:
                    environment._original_cleanup()  # type: ignore[attr-defined]
                except Exception as exc:
                    logger.warning("closing a mirage environment failed: %r", exc)
            self._environments.clear()
            for workspace in self._workspaces.values():
                try:
                    asyncio.run_coroutine_threadsafe(
                        workspace.close(), loop
                    ).result()
                except Exception as exc:
                    logger.warning(
                        "closing a mirage workspace failed: %r",
                        exc,
                        exc_info=True,
                    )
            self._workspaces.clear()
            loop.call_soon_threadsafe(loop.stop)
            thread.join()
            loop.close()
            self._loop = self._thread = None


def _no_ask() -> None:
    return None


def _noop() -> None:
    """占位：共用环境的 cleanup 由 provider.close() 调用原文那次。"""
    return None


async def build_owned_workspace(
    path: Path, on_ask: AskHandler | None = None
) -> Workspace:
    """Build the workspace a YAML describes and make the running loop its
    owner, so hermes' threads run its lines there.

    Args:
        path (Path): The workspace YAML.
        on_ask (AskHandler | None): Who answers the profile's ``ask``
            rules; None leaves them pending.
    """
    workspace = await build_workspace_from_config(path, on_ask=on_ask)
    workspace._sync_bridge.observe()
    return workspace


def register(ctx: PluginContext) -> None:
    """hermes plugin entry: register the ``mirage`` terminal backend.

    Args:
        ctx (PluginContext): The plugin context hermes passes.
    """
    ctx.register_terminal_environment_provider(
        MirageTerminalProvider(
            partial(ctx.get_config, SETTING),
            lambda: make_ask(
                ctx.get_config(ASK_URL),
                ctx.get_config(ASK_TOKEN),
                ctx.get_config(ASK_TIMEOUT),
            ),
        )
    )
