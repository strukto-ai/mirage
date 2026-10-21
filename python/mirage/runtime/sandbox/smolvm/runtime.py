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

import json

from mirage.runtime.mixin import ProcessExecutorMixin
from mirage.runtime.sandbox.base import RemoteSandbox
from mirage.runtime.sandbox.cli import exec_args, open_cli_pipe, run_cli
from mirage.runtime.sandbox.smolvm.config import SmolvmConfig
from mirage.runtime.sandbox.smolvm.constants import (
    RUNNING_STATE,
    SMOLVM_CLI_HINT,
    not_running_hint,
)
from mirage.runtime.types import RunResult, SandboxPipe


class SmolvmRuntime(RemoteSandbox, ProcessExecutorMixin[None]):
    """A microVM the user runs as a whole-line runtime.

    You start the machine yourself; mirage only connects to it and
    execs lines. The smolvm CLI is the transport, so there is no SDK
    dependency and no daemon socket wiring; each line is one `smolvm
    machine exec` with the merged environment, the session cwd, real
    stdin, and separated stderr.

    Unlike a container, the guest runs its own kernel, so the line
    sees that kernel's filesystem and nothing of the host's except
    what the machine was given at boot (`--volume`). Serve the
    workspace inside the guest at the host's mount prefixes, the same
    contract every provider in this family carries.

    Args:
        captures (Sequence[str] | None): commands routed to this runtime.
        config (SmolvmConfig | dict[str, Any] | None): how to reach the sandbox.
    """

    name = "smolvm"
    config_cls = SmolvmConfig
    config: SmolvmConfig

    async def _smolvm(
        self, args: list[str], stdin: bytes | None = None
    ) -> tuple[bytes, bytes, int]:
        """One smolvm CLI invocation; the seam tests override."""
        return await run_cli("smolvm", SMOLVM_CLI_HINT, args, stdin)

    async def connect(self) -> None:
        """Probe the machine, refusing any state that cannot take a line.

        `machine exec` would start a stopped machine on its own, but
        this family never manages sandbox lifecycle, so a machine that
        is not already running is an error rather than a boot.
        """
        stdout, stderr, code = await self._smolvm(
            ["machine", "status", "--name", self.config.machine, "--json"]
        )
        if code != 0:
            raise RuntimeError(
                f"smolvm machine status failed: {stderr.decode().strip()}"
            )
        try:
            status = json.loads(stdout)
        except json.JSONDecodeError as exc:
            raise RuntimeError(
                f"smolvm machine status returned unreadable json: {exc}"
            ) from exc
        state = status.get("state")
        if state != RUNNING_STATE:
            raise RuntimeError(
                not_running_hint(self.config.machine, str(state))
            )

    async def _exec_argv(
        self,
        argv: tuple[str, ...],
        stdin: bytes | None,
        env: dict[str, str],
        cwd: str,
    ) -> RunResult:
        stdout, stderr, code = await self._smolvm(
            exec_args(self._head(), ("--",), env, cwd, argv), stdin=stdin
        )
        return RunResult(stdout=stdout, stderr=stderr, exit_code=code)

    async def open_pipe(self, command: str) -> SandboxPipe:
        return await open_cli_pipe(
            "smolvm",
            exec_args(self._head(), ("--",), {}, None, ("sh", "-c", command)),
        )

    def _head(self) -> tuple[str, ...]:
        return ("machine", "exec", "--name", self.config.machine, "-i")
