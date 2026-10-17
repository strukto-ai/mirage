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

from typing import Any

from mirage.io.types import CommandOutput, IOResult
from mirage.runtime.language import LanguageRuntime
from mirage.runtime.types import CommandRuntime, RunResult
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


def not_bound(label: str, unavailable: str | None) -> CommandOutput:
    """The answer of an interpreter command no runtime runs.

    GNU wording (bash prints ``bash: python3: command not found``; the
    shell prefix is dropped workspace-wide), exit 127 whatever the
    operands say, unless the default world recorded why the entry failed
    to build. A bound entry without the interpreter entry point (not a
    ``LanguageRuntime``) is refused the same way: there is nothing to
    run code on. Mirrors TS ``notBound``.

    Args:
        label (str): the command name used in the message.
        unavailable (str | None): the dispatcher-recorded reason this
            command has no runtime (a default entry's build error),
            None when nothing captures it at all.
    """
    hint = unavailable or "command not found"
    return None, IOResult(exit_code=127, stderr=f"{label}: {hint}\n".encode())


async def runtime_version(
    runtime: LanguageRuntime[Any], env: dict[str, str] | None
) -> CommandOutput:
    return run_output(await runtime.version(env or {}))


def exec_refusal(
    label: str, script: PathSpec | None, placement: CommandRuntime
) -> CommandOutput | None:
    """Why policy will not let an interpreter command run its program;
    None when it may.

    The ``x`` check follows the program's entry point. A script operand
    asks ``exec_path_allowed`` about the script's own path, so a session
    whose only ``x`` grant is one show subtree runs scripts there and
    nowhere else; inline code (-c/-e), -m and stdin keep the
    whole-session rule (``exec_allowed``: any ``x`` grant), since no
    path holds them. Outside a workspace no entry point is wired and
    ``exec_allowed`` answers for files too.

    Args:
        label (str): the command name used in the message.
        script (PathSpec | None): the script operand, None for a program
            from -c, -m or stdin (``script_operand``).
        placement (CommandRuntime): the command's exec policy.
    """
    if script is not None:
        allowed = (
            placement.exec_path_allowed(script.virtual)
            if placement.exec_path_allowed is not None
            else placement.exec_allowed
        )
        if allowed:
            return None
        display = script.raw_path or script.virtual
        err = f"{label}: {display}: not in EXEC mode\n".encode()
        return None, IOResult(exit_code=126, stderr=err)
    if placement.exec_allowed:
        return None
    err = f"{label}: root mount '/' is not in EXEC mode\n".encode()
    return None, IOResult(exit_code=126, stderr=err)
