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

import errno
import os
import shutil
import sys
from collections.abc import Awaitable, Callable, Sequence
from typing import Any, ClassVar

from mirage.errors.fs import fs_strerror
from mirage.io.types import ByteSource
from mirage.runtime.binding import RuntimeContext
from mirage.runtime.config import RuntimeConfig, resolve_home
from mirage.runtime.mixin import StreamingProcessMixin
from mirage.runtime.python.base import PythonRuntime
from mirage.runtime.python.execution import prepare_source
from mirage.runtime.python.flags import init_argv
from mirage.runtime.python.local.config import LocalConfig
from mirage.runtime.sandbox.cli import (
    Children,
    close_children,
    cwd_refusal,
    run_cli,
)
from mirage.runtime.types import (
    ProcessExecution,
    RunArgs,
    RunResult,
    RuntimeReach,
    StreamExecution,
)
from mirage.shell.bytes import encode_text

LOCAL_HOME_ENV = "MIRAGE_LOCAL_HOME"


def _unrunnable(name: str, path: str) -> RunResult | None:
    """Why a program named by a path cannot run, in the shell's words and
    exit code; None when it can.

    Args:
        name (str): the program as typed.
        path (str): that path joined to the cwd.
    """
    if not os.path.exists(path):
        return _not_run(f"{name}: No such file or directory\n", 127)
    if os.path.isdir(path):
        return _not_run(f"{name}: Is a directory\n", 126)
    if not os.access(path, os.X_OK):
        return _not_run(f"{name}: Permission denied\n", 126)
    return None


def _not_run(message: str, exit_code: int) -> RunResult:
    """A program that never started: its message and exit code.

    Args:
        message (str): what the program would have said on stderr.
        exit_code (int): 127 when it was not found, 126 when it could
            not run.
    """
    return RunResult(
        stdout=b"", stderr=encode_text(message), exit_code=exit_code
    )


class LocalRuntime(PythonRuntime, StreamingProcessMixin):
    """Run Python code, and any other captured program, on the host.

    Each python3 run spawns `<interpreter> -c <code>`. Any other name
    the captures send here (a named program, or EXTERNAL_COMMANDS) runs
    as its argv, found on the host PATH, with no shell, in the session
    cwd. Either way the program sees the host filesystem, not the
    workspace mounts. Its environment is the session's and the config
    `env`, nothing of mirage's own, as a sandlock child gets.
    Cancelling the run kills the subprocess, so a limit timeout
    reclaims it.

    The interpreter defaults to the one running mirage; point the
    config `home` (the yaml entry's ``config`` block ends up here) or
    the MIRAGE_LOCAL_HOME environment variable at another binary, e.g.
    a project venv whose packages the code needs.
    """

    name = "local"
    # Spawns the host interpreter: a real process with the user's own
    # filesystem and network, entry points the workspace gate never sees.
    # This is the base default; declared here so the claim is explicit
    # at the one builtin runtime that voids a world's sandbox claim.
    reach: RuntimeReach = "process"

    config_cls: ClassVar[type[RuntimeConfig]] = LocalConfig
    config: LocalConfig

    def __init__(
        self,
        captures: Sequence[str] | None = None,
        config: LocalConfig | dict[str, Any] | None = None,
    ) -> None:
        super().__init__(captures, config)
        chosen = resolve_home(self.config, LOCAL_HOME_ENV)
        if chosen:
            resolved = shutil.which(chosen)
            if resolved is None:
                raise FileNotFoundError(
                    f"local python interpreter not found: {chosen!r} "
                    "(from the runtime entry's config `home` or "
                    f"{LOCAL_HOME_ENV})"
                )
            # Absolute: the program's env has no host PATH to resolve a
            # name found through an empty or `.` entry against.
            self._python = os.path.abspath(resolved)
        else:
            self._python = sys.executable
        self._children: Children = {}

    async def version(self, env: dict[str, str]) -> RunResult:
        # Session loader variables can execute code before --version is read.
        return await self._spawn(self._python, ["--version"], {})

    async def run(
        self, args: RunArgs, context: RuntimeContext | None = None
    ) -> RunResult:
        # Honoring the init switches is just handing them back to the
        # real interpreter, which is why this tier gets them exactly
        # right (sys.flags included) where an in-process engine cannot.
        return await self._spawn(
            self._python,
            [*init_argv(args.flags), "-c", prepare_source(args), *args.args],
            args.env,
            args.stdin,
        )

    async def run_process(self, request: ProcessExecution) -> RunResult:
        return await self._run_process(request)

    async def run_stream(self, request: StreamExecution) -> RunResult:
        return await self._run_process(request)

    async def _run_process(
        self, request: ProcessExecution | StreamExecution
    ) -> RunResult:
        name = request.argv[0]
        cwd = request.cwd.virtual
        refusal = cwd_refusal(name, cwd)
        if refusal is not None:
            return refusal
        if os.path.dirname(name):
            # A name with a directory in it is a path from the cwd, as in
            # the shell. Joined, not normalized, so the host follows a
            # `..` past a symlink as written.
            program = os.path.join(cwd, name)
            refusal = _unrunnable(name, program)
            if refusal is not None:
                return refusal
        else:
            found = shutil.which(name)
            if found is None:
                return _not_run(f"{name}: command not found\n", 127)
            # Absolute: a relative PATH entry names a file here, and the
            # program starts in the session's cwd.
            program = (
                found
                if os.path.isabs(found)
                else os.path.join(os.getcwd(), found)
            )
        # A program that cannot start (its script's interpreter missing,
        # say) fails as the shell's would, so `tool || fallback` goes on.
        try:
            return await self._spawn(
                program,
                list(request.argv[1:]),
                request.env,
                request.stdin,
                cwd,
                request.output
                if isinstance(request, StreamExecution)
                else None,
            )
        except OSError as exc:
            reason = fs_strerror(exc) or errno.errorcode.get(
                exc.errno or 0, str(exc)
            )
            return _not_run(f"{name}: cannot execute: {reason}\n", 126)

    async def _spawn(
        self,
        program: str,
        argv: list[str],
        env: dict[str, str],
        stdin: ByteSource | None = None,
        cwd: str | None = None,
        output: Callable[[bytes], Awaitable[None]] | None = None,
    ) -> RunResult:
        stdout, stderr, code = await run_cli(
            program,
            None,
            argv,
            stdin,
            cwd=cwd,
            env={**self.config.env, **env},
            children=self._children,
            output=output,
        )
        return RunResult(stdout=stdout, stderr=stderr or None, exit_code=code)

    async def close(self) -> None:
        """Kill every child still running, so none outlives the workspace."""
        await close_children(self._children)
