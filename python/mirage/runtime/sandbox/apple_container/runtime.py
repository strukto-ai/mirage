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
import json
from collections.abc import Sequence
from typing import Any

from mirage.context import get_current_session
from mirage.runtime.mixin import ProcessExecutorMixin
from mirage.runtime.sandbox.apple_container.config import AppleContainerConfig
from mirage.runtime.sandbox.apple_container.constants import (
    APPLE_CONTAINER_CLI_HINT,
    PRELUDE,
    RUNNING_STATE,
    no_container_hint,
    not_running_hint,
)
from mirage.runtime.sandbox.base import RemoteSandbox
from mirage.runtime.sandbox.cli import run_cli
from mirage.runtime.sandbox.config import SandboxConfig
from mirage.runtime.types import ProcessExecution, RunResult


class AppleContainerRuntime(RemoteSandbox, ProcessExecutorMixin):
    """Containers under Apple's `container` tool as a whole-line runtime.

    You start the containers yourself; mirage only connects to them and
    execs lines. The `container` CLI is the transport, so there is no
    SDK dependency and no XPC wiring; each line is one `container exec`
    with the merged environment, the session cwd, real stdin, and
    separated stderr.

    Each container is its own lightweight VM with its own Linux
    kernel, so, as in a smolvm guest, the line sees nothing of the
    host's filesystem except what the container was given at start
    (`--volume`). Serve the workspace inside it at the host's mount
    prefixes, the same contract every provider in this family carries.
    The image needs a POSIX sh, which every argv runs under (PRELUDE).

    A line runs in its session's container (config ``containers``,
    else ``container``), so one runtime can give every agent a VM of
    its own. Each container is probed once, on its first line.

    Args:
        captures (Sequence[str] | None): commands routed to this runtime.
        config (SandboxConfig | dict[str, Any] | None): container settings.
    """

    name = "apple_container"
    config_cls = AppleContainerConfig
    config: AppleContainerConfig

    def __init__(
        self,
        captures: Sequence[str] | None = None,
        config: SandboxConfig | dict[str, Any] | None = None,
    ) -> None:
        super().__init__(captures, config)
        self._running: set[str] = set()
        self._probe_lock = asyncio.Lock()

    async def _container(
        self, args: list[str], stdin: bytes | None = None
    ) -> tuple[bytes, bytes, int]:
        """Run one container CLI invocation.

        Args:
            args (list[str]): CLI arguments after the executable.
            stdin (bytes | None): input delivered to the guest command.
        """
        return await run_cli(
            "container", APPLE_CONTAINER_CLI_HINT, args, stdin
        )

    async def connect(self) -> None:
        """Attach nothing up front.

        Which container a line needs depends on its session, so _target
        probes each container on its first line instead.
        """

    async def _target(self) -> str:
        """The container this line's session runs in, probed once."""
        session = get_current_session()
        session_id = session.session_id if session is not None else None
        container = (
            self.config.containers.get(session_id)
            if session_id is not None
            else None
        )
        if container is None:
            container = self.config.container
        if container is None:
            raise RuntimeError(no_container_hint(session_id))
        async with self._probe_lock:
            if container not in self._running:
                await self._probe(container)
                self._running.add(container)
        return container

    async def _probe(self, container: str) -> None:
        """Refuse a container in any state that cannot take a line.

        `container exec` refuses a container that is not running as
        well; probing up front names the state and how to recover.

        Args:
            container (str): the container id to inspect.
        """
        stdout, stderr, code = await self._container(["inspect", container])
        if code != 0:
            raise RuntimeError(
                f"container inspect failed: {stderr.decode().strip()}"
            )
        try:
            state = json.loads(stdout)[0]["status"]["state"]
        except (ValueError, LookupError, TypeError) as exc:
            raise RuntimeError(
                f"container inspect returned unreadable json: {exc}"
            ) from exc
        if state != RUNNING_STATE:
            raise RuntimeError(not_running_hint(container, str(state)))

    async def exec_line(
        self, line: str, stdin: bytes | None, env: dict[str, str], cwd: str
    ) -> RunResult:
        return await self._exec_argv(("sh", "-c", line), stdin, env, cwd)

    async def run_process(self, request: ProcessExecution) -> RunResult:
        if not request.argv:
            raise ValueError("process argv must not be empty")
        return await self._exec_argv(
            request.argv,
            request.stdin,
            {**self.config.env, **request.env},
            request.cwd.virtual,
        )

    async def _exec_argv(
        self,
        argv: tuple[str, ...],
        stdin: bytes | None,
        env: dict[str, str],
        cwd: str,
    ) -> RunResult:
        container = await self._target()
        args = ["exec", "-i", "-w", "/"]
        for key, value in env.items():
            args += ["-e", f"{key}={value}"]
        args += [container, "sh", "-c", PRELUDE, "sh", cwd, *argv]
        stdout, stderr, code = await self._container(args, stdin=stdin)
        return RunResult(stdout=stdout, stderr=stderr, exit_code=code)
