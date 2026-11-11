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

from mirage.context import is_program_invocation
from mirage.io import IOResult
from mirage.io.types import ByteSource
from mirage.shell.bytes import encode_text
from mirage.shell.constants import BIN_PREFIX
from mirage.workspace.executor.builtins.types import BuiltinCall, Result
from mirage.workspace.session import SessionState
from mirage.workspace.session.state import env_snapshot
from mirage.workspace.types import ExecutionNode


async def handle_printenv(
    args: list[str],
    session: SessionState,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Print each named variable's exported value in order, or every
    exported ``NAME=value`` sorted when none is named; ``-0`` /
    ``--null`` ends each with a NUL instead of a newline. A name with no
    exported value prints nothing and fails the command with 1 once the
    others printed. Run by the shell, its environment holds ``_`` as the
    program's path, last, as bash hands every program it runs; run by
    ``env``, the ``_`` env handed on.

    Args:
        args (list[str]): the words after ``printenv``.
        session (SessionState): the session whose environment it reads.
    """
    # The process view, not the shell view: GNU printenv is a separate
    # binary, so the only names it can possibly see are the exported
    # ones. A plain `X=hello` is invisible to it and exits 1.
    env = env_snapshot(session)
    if not is_program_invocation(session):
        env.pop("_", None)
        env["_"] = f"{BIN_PREFIX}/printenv"
    end = "\n"
    names: list[str] = []
    for i, arg in enumerate(args):
        if arg == "--":
            names += args[i + 1 :]
            break
        if arg in ("-0", "--null"):
            end = "\0"
        else:
            names.append(arg)
    if not names:
        last = env.pop("_", None)
        lines = sorted(f"{k}={v}" for k, v in env.items())
        if last is not None:
            lines.append(f"_={last}")
        out = encode_text("".join(line + end for line in lines))
        return out, IOResult(), ExecutionNode(command="printenv", exit_code=0)
    values = [env[name] for name in names if name in env]
    code = 0 if len(values) == len(names) else 1
    out = encode_text("".join(value + end for value in values))
    return (
        out or None,
        IOResult(exit_code=code),
        ExecutionNode(command="printenv", exit_code=code),
    )


async def printenv_builtin(call: BuiltinCall) -> Result:
    """The ``printenv`` arm.

    Args:
        call (BuiltinCall): the invocation.
    """
    return await handle_printenv(list(call.argv.args), call.context.session)
