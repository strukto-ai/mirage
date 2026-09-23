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
from mirage.ops.types import SessionView
from mirage.policy import PolicyDenied
from mirage.shell.call_stack import CallStack
from mirage.workspace.executor.builtins.shared import (is_valid_name,
                                                       require_view)
from mirage.workspace.executor.builtins.types import BuiltinCall, Result
from mirage.workspace.session import SessionState
from mirage.workspace.session.errors import ReadonlyVariableError
from mirage.workspace.session.state import session_view
from mirage.workspace.types import ExecutionNode


async def _getopts_finish(
    session: SessionState,
    view: SessionView,
    name: str,
    opt_value: str,
    optarg: str | None,
    new_optind: int,
    new_pos: int,
    exit_code: int,
    stderr: bytes = b"",
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    # The name is assigned last, exactly as bash does: OPTIND/OPTARG and
    # the hidden cursor still advance, but a bad destination fails the
    # write and turns the call into a status-1 error. Writes go through
    # the session view, so a pre_session policy or a readonly OPTARG /
    # OPTIND refuses here too.
    try:
        if not is_valid_name(name):
            stderr = (f"bash: getopts: `{name}': "
                      f"not a valid identifier\n").encode()
            exit_code = 1
        elif name in session.readonly_vars:
            stderr = f"bash: {name}: readonly variable\n".encode()
            exit_code = 1
        else:
            await view.set(name, opt_value)
        if optarg is None:
            await view.unset("OPTARG")
        else:
            await view.set("OPTARG", optarg)
        await view.set("OPTIND", str(new_optind))
    except ReadonlyVariableError as exc:
        stderr = f"bash: {exc.name}: readonly variable\n".encode()
        exit_code = 1
    except PolicyDenied as exc:
        stderr = f"{exc.strerror}\n".encode()
        exit_code = 1
    session._getopts_pos = new_pos
    session._getopts_optind = new_optind
    io = IOResult(exit_code=exit_code, stderr=stderr)
    return None, io, ExecutionNode(command="getopts",
                                   exit_code=exit_code,
                                   stderr=stderr)


async def handle_getopts(
    args: list[str],
    session: SessionState,
    call_stack: CallStack | None = None,
    state: SessionView | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Parse one option per call, with bash's getopts semantics.

    Args:
        args (list[str]): words after `getopts`: the optstring, the name
            variable, then optional explicit arguments (the positional
            parameters are scanned when no explicit ones are given).
        session (SessionState): shell session; OPTIND/OPTARG live in its env
            and the hidden per-word scan offset in its getopts state.
        call_stack (CallStack | None): function-call positional frames;
            inside a shell function getopts scans the function's own
            positional parameters, matching bash.
        state (SessionView | None): the session plane's gated door.
    """
    if len(args) < 2:
        err = b"getopts: usage: getopts optstring name [arg]\n"
        return None, IOResult(exit_code=2,
                              stderr=err), ExecutionNode(command="getopts",
                                                         exit_code=2,
                                                         stderr=err)
    view = require_view(state)
    optstring = args[0]
    name = args[1]
    if len(args) > 2:
        params = args[2:]
    elif call_stack is not None and call_stack.get_all_positional():
        params = call_stack.get_all_positional()
    else:
        params = session.positional_args
    silent = optstring.startswith(":")
    verbose = not silent and session.env.get("OPTERR", "1") != "0"
    try:
        optind = int(session.env.get("OPTIND", "1"))
    except ValueError:
        optind = 1
    # Bash treats a nonpositive OPTIND as a restart at argument 1.
    restart = optind < 1
    if restart:
        optind = 1
    if restart or session._getopts_optind != optind:
        session._getopts_pos = 0
    pos = session._getopts_pos

    if optind > len(params):
        return await _getopts_finish(session, view, name, "?", None, optind, 0,
                                     1)
    word = params[optind - 1]
    # A stale cursor left past the end of the current word (a shorter or
    # reused argument) restarts the scan rather than indexing out of range.
    if pos >= len(word):
        pos = 0
    if pos == 0:
        if not word.startswith("-") or word == "-":
            return await _getopts_finish(session, view, name, "?", None,
                                         optind, 0, 1)
        if word == "--":
            return await _getopts_finish(session, view, name, "?", None,
                                         optind + 1, 0, 1)
        pos = 1

    letter = word[pos]
    rest = word[pos + 1:]
    idx = optstring.find(letter)
    is_valid = letter != ":" and idx != -1
    takes_arg = (is_valid and idx + 1 < len(optstring)
                 and optstring[idx + 1] == ":")

    if not is_valid:
        if rest:
            after_optind, after_pos = optind, pos + 1
        else:
            after_optind, after_pos = optind + 1, 0
        if silent:
            return await _getopts_finish(session, view, name, "?", letter,
                                         after_optind, after_pos, 0)
        err = (f"bash: illegal option -- {letter}\n".encode()
               if verbose else b"")
        return await _getopts_finish(session, view, name, "?", None,
                                     after_optind, after_pos, 0, err)

    if not takes_arg:
        if rest:
            after_optind, after_pos = optind, pos + 1
        else:
            after_optind, after_pos = optind + 1, 0
        return await _getopts_finish(session, view, name, letter, None,
                                     after_optind, after_pos, 0)

    if rest:
        return await _getopts_finish(session, view, name, letter, rest,
                                     optind + 1, 0, 0)
    if optind < len(params):
        return await _getopts_finish(session, view, name, letter,
                                     params[optind], optind + 2, 0, 0)
    if silent:
        return await _getopts_finish(session, view, name, ":", letter,
                                     optind + 1, 0, 0)
    err = (f"bash: option requires an argument -- {letter}\n".encode()
           if verbose else b"")
    return await _getopts_finish(session, view, name, "?", None, optind + 1, 0,
                                 0, err)


async def getopts_builtin(call: BuiltinCall) -> Result:
    """The ``getopts`` arm.

    Args:
        call (BuiltinCall): the invocation.
    """
    return await handle_getopts(
        list(call.argv.args), call.session, call.call_stack,
        session_view(call.session, call.namespace.registry.policies))
