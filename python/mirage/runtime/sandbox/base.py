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
from collections.abc import Sequence
from typing import Any, ClassVar

from mirage.runtime.base import RunArgs, RunResult, Runtime
from mirage.runtime.route.types import RouteScript
from mirage.runtime.sandbox.config import SandboxConfig


class RemoteSandbox(Runtime):
    """A runtime that runs whole lines inside a sandbox the user runs.

    Mirage never creates, provisions, or deletes sandboxes: you bring
    your own (a running container, a live Daytona or E2B sandbox) and
    the provider config says how to reach it. The sandbox is also
    yours to provision: serve the workspace inside it yourself (run
    ``mirage workspace create`` in the image entrypoint or by hand)
    with mounts at the same prefixes as the host workspace, so the
    session cwd and every path in a line resolve unchanged. Mirage
    only connects and execs lines. Subclasses adapt one provider by
    implementing connect() and exec_line(); routing, captures, and
    per-line scripts are inherited.

    Args:
        captures (Sequence[str]): commands that place a whole line
            here; ("*",) claims every line.
        config (SandboxConfig | dict[str, Any] | None): how to reach
            the sandbox, coerced through the provider's own config
            class (config_cls), so a field the provider does not have
            fails loud; the dict form is a yaml entry's ``config``
            block.
        script (RouteScript | None): per-line admission script, the
            same contract as any runtime.
    """

    runs_lines = True
    captures: tuple[str, ...] = ("*", )
    # Each provider's config class; coerce() makes unknown fields
    # fail loud, so providers need no per-field rejection code.
    config_cls: ClassVar[type[SandboxConfig]] = SandboxConfig

    def __init__(self,
                 captures: Sequence[str] = ("*", ),
                 config: SandboxConfig | dict[str, Any] | None = None,
                 script: RouteScript | None = None) -> None:
        self.captures = tuple(captures)
        self.config = self.config_cls.coerce(config)
        self.script = script
        # Connect-once latch: the first captured line connects; later
        # lines just execute. A failed connect leaves it unset so the
        # next line retries.
        self._connected = False
        self._connect_lock = asyncio.Lock()

    async def run(self, args: RunArgs) -> RunResult:
        raise NotImplementedError(
            f"runtime {self.name!r} runs whole lines in a remote sandbox, "
            f"not single interpreter stages")

    async def run_line(self, line: str, stdin: bytes | None,
                       env: dict[str, str], cwd: str) -> RunResult:
        """Run one raw line in the sandbox, connecting once.

        The line, cwd, and paths pass through verbatim: the sandbox is
        expected to serve the workspace at the same prefixes as the
        host, so nothing is rewritten. The session environment merges
        over the config environment.

        Args:
            line (str): the raw typed line.
            stdin (bytes | None): bytes piped into the line.
            env (dict[str, str]): the session environment.
            cwd (str): the session working directory.
        """
        async with self._connect_lock:
            if not self._connected:
                await self.connect()
                self._connected = True
        merged = {**self.config.env, **env}
        return await self.exec_line(line, stdin, merged, cwd)

    async def connect(self) -> None:
        """Attach to the user's live sandbox, failing loud if absent."""
        raise NotImplementedError

    async def exec_line(self, line: str, stdin: bytes | None,
                        env: dict[str, str], cwd: str) -> RunResult:
        """Execute one shell line inside the sandbox.

        Args:
            line (str): the raw shell line.
            stdin (bytes | None): bytes piped into the line.
            env (dict[str, str]): the merged environment.
            cwd (str): the working directory, passed through verbatim.
        """
        raise NotImplementedError
