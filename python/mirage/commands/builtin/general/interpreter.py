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

from dataclasses import dataclass, field
from typing import Any, Callable

from mirage.commands.builtin.utils.paths import resolve_script
from mirage.commands.builtin.utils.stream import _read_stdin_async
from mirage.io.types import ByteSource, CommandOutput, IOResult
from mirage.runtime.base import Runtime
from mirage.runtime.language import LanguageRuntime
from mirage.runtime.types import RunArgs, RunResult
from mirage.types import PathSpec


def run_output(result: RunResult) -> CommandOutput:
    """Convert one interpreter outcome into a command's output shape.

    The single RunResult-to-IOResult mapping: empty stdout becomes
    None (no stream), the exit code and stderr pass through. The
    interpreter commands and the CLI script arm both convert through
    here so the mapping cannot drift.

    Args:
        result (RunResult): the interpreter execution outcome.
    """
    return result.stdout if result.stdout else None, IOResult(
        exit_code=result.exit_code,
        stderr=result.stderr,
    )


@dataclass(frozen=True, slots=True)
class Source:
    """An interpreter command's inputs, resolved from the command line.

    Args:
        code (str): the source to run (script content, payload flag,
            or piped stdin).
        args (list[str]): argv exposed to the script.
        stdin (bytes | None): remaining stdin after any consumed as
            source.
        script_path (PathSpec | None): the resolved script operand,
            None for payload/stdin sources.
    """

    code: str
    args: list[str] = field(default_factory=list)
    stdin: bytes | None = None
    script_path: PathSpec | None = None


async def resolve_source(
    label: str,
    paths: list[PathSpec] | None,
    texts: tuple[str, ...],
    payload: str | None,
    stdin: ByteSource | None,
    dispatch: Callable[..., Any] | None,
    cwd: PathSpec | None,
    exec_allowed: bool,
) -> tuple[CommandOutput | None, Source | None]:
    """Resolve what an interpreter command should run, shared by all.

    The GNU-style resolution every interpreter command follows: a
    payload flag wins (-c/-e), else the first operand is the script
    (read through the workspace dispatch), else piped stdin is the
    source. Words after the script pass through verbatim as argv.

    Args:
        label (str): the command name used in error messages.
        paths (list[PathSpec] | None): positional path operands.
        texts (tuple[str, ...]): positional text operands.
        payload (str | None): the -c/-e flag value, if given.
        stdin (ByteSource | None): piped stdin.
        dispatch (Callable[..., Any] | None): workspace dispatch for
            reading the script operand.
        cwd (PathSpec | None): the session cwd for script resolution.
        exec_allowed (bool): whether the root mount is in EXEC mode.

    Returns:
        tuple[CommandOutput | None, Source | None]: an early
            error result, or the prepared source (exactly one is not
            None).
    """
    if not exec_allowed:
        err = f"{label}: root mount '/' is not in EXEC mode\n".encode()
        return (None, IOResult(exit_code=126, stderr=err)), None

    paths = paths or []
    text_list = list(texts)
    code = payload
    script_path: PathSpec | None = None
    if code is not None:
        arg_strs = [p.virtual for p in paths] + text_list
    elif paths:
        script_path = paths[0]
        arg_strs = [p.virtual for p in paths[1:]] + text_list
    elif text_list:
        script_path = resolve_script(text_list[0], cwd)
        arg_strs = text_list[1:]
    else:
        arg_strs = []

    if code is None and script_path is not None:
        if dispatch is None:
            err = f"{label}: no dispatch available to read script\n".encode()
            return (None, IOResult(exit_code=1, stderr=err)), None
        try:
            data, _ = await dispatch("read", script_path)
        except FileNotFoundError:
            err = f"{label}: {script_path.virtual}: No such file\n".encode()
            return (None, IOResult(exit_code=1, stderr=err)), None
        code = data.decode(errors="replace") if isinstance(data, bytes) else ""

    stdin_data = await _read_stdin_async(stdin)
    if code is None:
        if stdin_data:
            code = stdin_data.decode(errors="replace")
            stdin_data = None
        else:
            err = f"{label}: no input\n".encode()
            return (None, IOResult(exit_code=1, stderr=err)), None

    return None, Source(code=code,
                        args=arg_strs,
                        stdin=stdin_data,
                        script_path=script_path)


async def run_code(
    label: str,
    prepared: Source,
    env: dict[str, str] | None,
    flags: dict[str, Any],
    runtime: Runtime | None,
    unavailable: str | None,
) -> CommandOutput:
    """Run a prepared source on the bound runtime, shared by all.

    An unbound command (no workspace runtime entry captures it) is
    refused: an explicit runtimes list is policy, and a builtin that
    spun up its own interpreter would bypass captures and admission
    scripts (TS parity). The refusal names the recorded reason when
    the default world dropped the entry (the registry keys build
    failures by captured command), so no command code ever names a
    runtime class or probes one.

    Args:
        label (str): the command name used in error messages.
        prepared (Source): the resolved source and argv.
        env (dict[str, str] | None): the session environment.
        flags (dict[str, Any]): interpreter-level switches for the
            runtime (each runtime reads its own).
        runtime (Runtime | None): the workspace-bound runtime for this
            command; None when no entry captures it.
        unavailable (str | None): the dispatcher-recorded reason this
            command has no runtime (a default entry's build error),
            None when nothing captures it at all.
    """
    if not isinstance(runtime, LanguageRuntime):
        # GNU wording (bash prints `bash: python3: command not found`;
        # the shell prefix is dropped workspace-wide), unless the
        # default world recorded why the entry failed to build. A bound
        # entry without the interpreter door (not a LanguageRuntime) is
        # refused the same way: there is nothing to run code on.
        hint = unavailable or "command not found"
        return None, IOResult(exit_code=127,
                              stderr=f"{label}: {hint}\n".encode())
    result = await runtime.run(
        RunArgs(code=prepared.code,
                args=prepared.args,
                env=env or {},
                stdin=prepared.stdin,
                flags=flags))
    return run_output(result)
