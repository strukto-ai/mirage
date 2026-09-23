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

from mirage.io import IOResult
from mirage.io.types import ByteSource
from mirage.types import PathSpec
from mirage.workspace.executor.builtins.dirs.constants import (PWD_OPTIONS,
                                                               PWD_USAGE)
from mirage.workspace.executor.builtins.dirs.dirs import split_mode_options
from mirage.workspace.executor.builtins.types import BuiltinCall, Result
from mirage.workspace.session import SessionState
from mirage.workspace.session.shell_dirs import logical_cwd
from mirage.workspace.types import ExecutionNode


async def handle_pwd(
    operands: list[str | PathSpec],
    session: SessionState,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Print the working directory, logical by default and physical
    under ``-P`` (or ``set -P``).

    Args:
        operands (list[str | PathSpec]): the words after ``pwd``; GNU
            ignores every operand, so ``pwd extra`` still prints the cwd.
        session (SessionState): the shell session.
    """
    shell_physical = bool(session.shell_options.get("physical"))
    _, bad_opt, physical = split_mode_options(operands, PWD_OPTIONS,
                                              shell_physical)
    if bad_opt is not None:
        err = f"pwd: -{bad_opt}: invalid option\n{PWD_USAGE}".encode()
        return None, IOResult(exit_code=2,
                              stderr=err), ExecutionNode(command="pwd",
                                                         exit_code=2,
                                                         stderr=err)
    cwd = session.cwd if physical else logical_cwd(session)
    out = (cwd + "\n").encode()
    return out, IOResult(), ExecutionNode(command="pwd", exit_code=0)


async def pwd_builtin(call: BuiltinCall) -> Result:
    """The ``pwd`` arm.

    Args:
        call (BuiltinCall): the invocation.
    """
    return await handle_pwd(list(call.argv.operands), call.session)
