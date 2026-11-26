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
from collections.abc import Callable, Mapping
from concurrent.futures import Future, ThreadPoolExecutor
from functools import partial
from pathlib import Path
from typing import Any

from agent.secret_scope import current_secret_scope_home, get_secret
from agent.terminal_env_provider import TerminalEnvironmentProvider
from hermes_cli.plugins import PluginContext

from mirage.agents.hermes.constants import (
    BACKEND,
    SESSION_PREFIX,
    SETTING,
    SOURCE,
)
from mirage.agents.hermes.credentials import (
    SCOPE,
    HermesSecrets,
    HermesSourceConfig,
    fetch_hermes,
    missing_error,
    through_hermes,
)
from mirage.agents.hermes.environment import MirageEnvironment
from mirage.config import WorkspaceConfig, load_config
from mirage.secrets.registry import register_secrets
from mirage.server.workspace_config import build_workspace_from_config
from mirage.workspace.workspace import Workspace

logger = logging.getLogger(__name__)

WorkspaceKey = tuple[Path, tuple[tuple[str, str], ...]]


class MirageTerminalProvider(TerminalEnvironmentProvider):
    """hermes' ``mirage`` terminal backend.

    Builds the workspace from the YAML the plugin setting names, once
    per path and set of keys, and gives each hermes task its own session
    in it. Every key comes from hermes' active profile: ``${NAME}`` and
    ``{from: env, key: NAME}`` read ``get_secret(NAME)`` on hermes'
    thread, and a YAML that would reach a key any other way is refused.
    A workspace closes once no profile uses its keys any more and no
    task holds a session in it.

    Args:
        config_path (Callable[[], str | None]): Returns the workspace
            YAML's path, read on every call so a changed setting applies.
    """

    name = BACKEND
    display_name = "Mirage"
    skip_container_guards = False
    default_cwd = "/"

    def __init__(self, config_path: Callable[[], str | None]) -> None:
        register_secrets(SOURCE, HermesSourceConfig, fetch_hermes)
        self._config_path = config_path
        self._lock = threading.Lock()
        self._workspaces: dict[WorkspaceKey, Future[Workspace]] = {}
        self._serving: dict[str | None, WorkspaceKey] = {}
        self._entering: dict[WorkspaceKey, int] = {}
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
        key, built, values = self._workspace()
        try:
            return MirageEnvironment(
                built.result(),
                cwd=cwd,
                timeout=timeout,
                task_id=task_id,
                secrets=values,
            )
        finally:
            with self._lock:
                self._entering[key] -= 1
                if not self._entering[key]:
                    del self._entering[key]
                if failed(built) and self._workspaces.get(key) is built:
                    del self._workspaces[key]

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

    def _workspace(
        self,
    ) -> tuple[WorkspaceKey, Future[Workspace], dict[str, str]]:
        path = self._path()
        if path is None:
            raise ValueError(
                "set plugins.entries.mirage.settings."
                f"{SETTING} to a Mirage workspace YAML"
            )
        secrets = HermesSecrets(get_secret)
        try:
            loaded = load_config(path, env=secrets)
        except ValueError as exc:
            if secrets.missing:
                raise missing_error(secrets.missing) from exc
            raise
        config = through_hermes(loaded, secrets)
        values = dict(secrets)
        # Keyed by the values too, so profiles with different keys never share one.
        key = (path, tuple(sorted(values.items())))
        with self._lock:
            if self._closed:
                raise RuntimeError("the mirage backend has shut down")
            self._serving[current_secret_scope_home()] = key
            self._retire()
            built = self._workspaces.get(key)
            if built is None and config.kernel_mounts():
                if any(other == path for other, _ in self._workspaces):
                    raise ValueError(
                        f"{path} mounts a FUSE folder another Hermes profile, "
                        "or this one before a key changed, already serves; "
                        "give each profile its own workspace YAML"
                    )
            if built is None:
                # Awaited off the lock, so a slow build holds up no other task.
                built = asyncio.run_coroutine_threadsafe(
                    build_owned_workspace(config, values), self._owner()
                )
                self._workspaces[key] = built
            self._entering[key] = self._entering.get(key, 0) + 1
        return key, built, values

    def _retire(self) -> None:
        serving = set(self._serving.values())
        for key, built in list(self._workspaces.items()):
            if key in serving or key in self._entering or not built.done():
                continue
            if in_use(built.result()):
                continue
            del self._workspaces[key]
            self._shut(built)

    def _shut(self, built: Future[Workspace]) -> None:
        if self._loop is None or failed(built):
            return
        try:
            asyncio.run_coroutine_threadsafe(
                built.result().close(), self._loop
            ).result()
        except Exception as exc:
            logger.warning(
                "closing a mirage workspace failed: %r", exc, exc_info=True
            )

    def close(self) -> None:
        """Close every workspace this provider built, then its loop. hermes
        calls none between tasks, so this runs once, when the process exits,
        and the provider builds no workspace after it."""
        with self._lock:
            self._closed = True
            loop, thread = self._loop, self._thread
            if loop is None or thread is None:
                return
            for built in self._workspaces.values():
                self._shut(built)
            self._workspaces.clear()
            loop.call_soon_threadsafe(loop.stop)
            thread.join()
            loop.close()
            self._loop = self._thread = None


def failed(built: Future[Workspace]) -> bool:
    """Whether a workspace's build ended without one.

    Args:
        built (Future[Workspace]): The build.
    """
    return built.done() and (
        built.cancelled() or built.exception() is not None
    )


def in_use(workspace: Workspace) -> bool:
    """Whether a hermes task still holds a session in a workspace.

    Args:
        workspace (Workspace): The workspace.
    """
    return any(
        session.session_id.startswith(SESSION_PREFIX)
        for session in workspace.list_sessions()
    )


async def build_owned_workspace(
    config: WorkspaceConfig, secrets: Mapping[str, str]
) -> Workspace:
    """Build the workspace a config describes and make the running loop
    its owner, so hermes' threads run its lines there.

    Args:
        config (WorkspaceConfig): The workspace YAML, read through hermes.
        secrets (Mapping[str, str]): The values hermes gave for it, which
            its ``hermes`` pointers read.
    """
    SCOPE.set(secrets)
    workspace = await build_workspace_from_config(config)
    workspace._sync_bridge.observe()
    return workspace


def register(ctx: PluginContext) -> None:
    """hermes plugin entry: register the ``mirage`` terminal backend.

    Args:
        ctx (PluginContext): The plugin context hermes passes.
    """
    ctx.register_terminal_environment_provider(
        MirageTerminalProvider(partial(ctx.get_config, SETTING))
    )
