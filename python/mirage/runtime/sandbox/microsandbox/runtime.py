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
from mirage.runtime.sandbox.cli import run_cli
from mirage.runtime.sandbox.microsandbox.config import MicrosandboxConfig
from mirage.runtime.sandbox.microsandbox.constants import (
    MICROSANDBOX_CLI_HINT,
    RUNNING_STATE,
    not_running_hint,
)
from mirage.runtime.types import ProcessExecution, RunResult


class MicrosandboxRuntime(RemoteSandbox, ProcessExecutorMixin):
    """Run programs in an existing Microsandbox guest through the msb CLI.

    The user starts the sandbox and serves its workspace at the same
    paths inside the guest. Mirage forwards commands, stdin, environment,
    and cwd without managing the sandbox's lifecycle.

    Args:
        captures (Sequence[str] | None): commands routed to this runtime.
        config (MicrosandboxConfig | dict[str, Any] | None): the sandbox to reach.
    """

    name = "microsandbox"
    config_cls = MicrosandboxConfig
    config: MicrosandboxConfig

    async def _microsandbox(
        self, args: list[str], stdin: bytes | None = None
    ) -> tuple[bytes, bytes, int]:
        """Run one msb CLI invocation."""
        return await run_cli("msb", MICROSANDBOX_CLI_HINT, args, stdin)

    async def connect(self) -> None:
        """Require a running sandbox before executing any commands."""
        stdout, stderr, code = await self._microsandbox(
            ["inspect", self.config.sandbox, "--format", "json"]
        )
        if code != 0:
            raise RuntimeError(
                f"msb inspect failed: {stderr.decode().strip()}"
            )
        try:
            status = json.loads(stdout)
        except json.JSONDecodeError as exc:
            raise RuntimeError(
                f"msb inspect returned unreadable json: {exc}"
            ) from exc
        if not isinstance(status, dict):
            raise RuntimeError("msb inspect returned an invalid status object")
        state = status.get("status")
        if state != RUNNING_STATE:
            raise RuntimeError(
                not_running_hint(self.config.sandbox, str(state))
            )

    async def exec_line(
        self, line: str, stdin: bytes | None, env: dict[str, str], cwd: str
    ) -> RunResult:
        return await self._exec_argv(("sh", "-c", line), stdin, env, cwd)

    async def run_process(self, request: ProcessExecution) -> RunResult:
        await self._ensure_connected()
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
        args = ["exec", self.config.sandbox, "--quiet", "--no-tty", "-w", cwd]
        for key, value in env.items():
            args += ["-e", f"{key}={value}"]
        # `--` ends the flags: the command is a trailing var arg, so a
        # line starting with a dash would otherwise parse as one.
        args += ["--", *argv]
        stdout, stderr, code = await self._microsandbox(args, stdin=stdin)
        return RunResult(stdout=stdout, stderr=stderr, exit_code=code)
