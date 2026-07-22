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

import re

from mirage.commands.spec.shell import SHELL_SPECS, parse_shell_options
from mirage.io import IOResult
from mirage.io.async_line_iterator import AsyncLineIterator
from mirage.io.stream import async_chain
from mirage.io.types import ByteSource
from mirage.shell.call_stack import CallStack
from mirage.shell.errors import ExitSignal
from mirage.shell.types import SET_FLAG_TO_OPTION
from mirage.workspace.executor.control import ReturnSignal
from mirage.workspace.mount.namespace import Namespace
from mirage.workspace.session import Session
from mirage.workspace.types import ExecutionNode


async def handle_export(
    assignments: list[str],
    session: Session,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    for assign in assignments:
        if "=" in assign:
            key, _, val = assign.partition("=")
            if key in session.readonly_vars:
                err = f"bash: {key}: readonly variable\n".encode()
                return None, IOResult(exit_code=1, stderr=err), ExecutionNode(
                    command="export", exit_code=1, stderr=err)
            session.env[key] = val
        else:
            session.env.setdefault(assign, "")
    return None, IOResult(), ExecutionNode(command="export", exit_code=0)


async def handle_readonly(
    assignments: list[str],
    session: Session,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    for assign in assignments:
        if "=" in assign:
            key, _, val = assign.partition("=")
            if key in session.readonly_vars:
                err = f"bash: {key}: readonly variable\n".encode()
                return None, IOResult(exit_code=1, stderr=err), ExecutionNode(
                    command="readonly", exit_code=1, stderr=err)
            session.env[key] = val
            session.readonly_vars.add(key)
        else:
            session.readonly_vars.add(assign)
    return None, IOResult(), ExecutionNode(command="readonly", exit_code=0)


async def handle_unset(
    names: list[str],
    session: Session,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    for name in names:
        if name in session.readonly_vars:
            err = (f"bash: unset: {name}: cannot unset: "
                   f"readonly variable\n").encode()
            return None, IOResult(exit_code=1,
                                  stderr=err), ExecutionNode(command="unset",
                                                             exit_code=1,
                                                             stderr=err)
        session.env.pop(name, None)
        if name == "OPTIND":
            session._getopts_optind = None
    return None, IOResult(), ExecutionNode(command="unset", exit_code=0)


async def handle_printenv(
    name: str | None,
    session: Session,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    if name:
        val = session.env.get(name)
        if val is None:
            return None, IOResult(exit_code=1), ExecutionNode(
                command="printenv", exit_code=1)
        out = f"{val}\n".encode()
    else:
        lines = [f"{k}={v}" for k, v in session.env.items()]
        out = ("\n".join(sorted(lines)) + "\n").encode()
    return out, IOResult(), ExecutionNode(command="printenv", exit_code=0)


async def handle_whoami(
        namespace: Namespace,  # noqa: E125
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    # GNU whoami reports the effective user and never consults $USER;
    # the workspace user (launch agent_id, shared via the namespace
    # store) is the effective identity here. With no claimed identity
    # it fails like GNU does for a uid with no passwd entry.
    if namespace.user is None:
        err = b"whoami: cannot find name for user ID\n"
        return None, IOResult(exit_code=1,
                              stderr=err), ExecutionNode(command="whoami",
                                                         exit_code=1,
                                                         stderr=err)
    out = f"{namespace.user}\n".encode()
    return out, IOResult(), ExecutionNode(command="whoami", exit_code=0)


async def handle_read(
    args: list[str],
    session: Session,
    stdin: ByteSource | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Read one line into variables, with bash's option handling.

    Only -r is accepted (our read is already raw, so it is consumed
    with no effect); anything else errors like bash instead of being
    treated as a variable name.

    Args:
        args (list[str]): words after the command name.
        session (Session): shell session state.
        stdin (ByteSource | None): line source.
    """
    parse = parse_shell_options(SHELL_SPECS["read"], args)
    if parse.invalid is not None:
        token = (parse.invalid
                 if parse.invalid.startswith("--") else f"-{parse.invalid}")
        err = f"read: {token}: invalid option\n".encode()
        return None, IOResult(exit_code=2,
                              stderr=err), ExecutionNode(command="read",
                                                         exit_code=2)
    variables = parse.operands or ["REPLY"]
    # A NEW stdin source replaces any leftover buffer (a previous
    # command's exhausted herestring/pipe must not shadow this one);
    # the SAME source object reuses the buffer so sequential reads
    # advance through its lines.
    if stdin is not None and (session._stdin_buffer is None
                              or session._stdin_source is not stdin):
        if isinstance(stdin, bytes):
            session._stdin_buffer = AsyncLineIterator(async_chain(stdin))
            session._stdin_source = stdin
        elif hasattr(stdin, "__aiter__"):
            session._stdin_buffer = AsyncLineIterator(stdin)
            session._stdin_source = stdin

    line_bytes: bytes | None = None
    if session._stdin_buffer is not None:
        line_bytes = await session._stdin_buffer.readline()

    if line_bytes is None:
        for var in variables:
            session.env[var] = ""
            session.arrays.pop(var, None)
        return None, IOResult(exit_code=1), ExecutionNode(command="read",
                                                          exit_code=1)

    line = line_bytes.decode(errors="replace").rstrip("\n")
    ifs = session.env.get("IFS", " \t\n")
    if ifs == " \t\n":
        # GNU trims IFS whitespace from both ends before splitting.
        line = line.strip(" \t\n")
        parts = line.split(None, len(variables) - 1) if variables else []
    elif not ifs:
        parts = [line]
    else:
        ifs_ws = "".join(ch for ch in ifs if ch in " \t\n")
        if ifs_ws:
            line = line.strip(ifs_ws)
        n_splits = max(0, len(variables) - 1)
        chars = set(ifs)
        out: list[str] = []
        cur: list[str] = []
        for ch in line:
            if ch in chars and len(out) < n_splits:
                out.append("".join(cur))
                cur = []
                continue
            cur.append(ch)
        out.append("".join(cur))
        parts = out
    for i, var in enumerate(variables):
        session.env[var] = parts[i] if i < len(parts) else ""
        # A scalar write replaces any array of the same name, matching
        # the variable_assignment path.
        session.arrays.pop(var, None)
    return None, IOResult(), ExecutionNode(command="read", exit_code=0)


async def handle_local(
    assignments: list[str],
    session: Session,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    local_vars = getattr(session, "_local_vars", None)
    for assign in assignments:
        if "=" in assign:
            key, _, val = assign.partition("=")
            if local_vars is not None and key not in local_vars:
                local_vars[key] = session.env.get(key)
            session.env[key] = val
        else:
            if local_vars is not None and assign not in local_vars:
                local_vars[assign] = session.env.get(assign)
            session.env.setdefault(assign, "")
    return None, IOResult(), ExecutionNode(command="local", exit_code=0)


async def handle_shift(
    args: list[str],
    call_stack: CallStack | None,
    session: Session | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Shift positional parameters, with bash's argument checks.

    Args:
        args (list[str]): words after the command name; at most one,
            the shift count.
        call_stack (CallStack | None): function-call positional frames.
        session (Session | None): shell session state.
    """
    if len(args) > 1:
        err = b"shift: too many arguments\n"
        return None, IOResult(exit_code=1,
                              stderr=err), ExecutionNode(command="shift",
                                                         exit_code=1)
    if args and not _is_shift_count(args[0]):
        err = f"shift: {args[0]}: numeric argument required\n".encode()
        return None, IOResult(exit_code=1,
                              stderr=err), ExecutionNode(command="shift",
                                                         exit_code=1)
    n = int(args[0]) if args else 1
    shifted = False
    if call_stack is not None and call_stack.get_all_positional():
        call_stack.shift(n)
        shifted = True
    if not shifted and session is not None:
        pos = getattr(session, "positional_args", None)
        if pos is not None:
            session.positional_args = pos[n:]
    return None, IOResult(), ExecutionNode(command="shift", exit_code=0)


def _is_shift_count(word: str) -> bool:
    body = word[1:] if word[:1] in ("-", "+") else word
    return body.isdigit()


async def handle_set(
    args: list[str],
    session: Session,
    call_stack: CallStack | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    if not args:
        lines = [f"{k}={v}" for k, v in session.env.items()]
        out = ("\n".join(sorted(lines)) + "\n").encode()
        return out, IOResult(), ExecutionNode(command="set", exit_code=0)
    i = 0
    while i < len(args):
        tok = args[i]
        if tok == "--":
            session.positional_args = args[i + 1:]
            return None, IOResult(), ExecutionNode(command="set", exit_code=0)
        if tok in ("-o", "+o"):
            if i + 1 < len(args):
                session.shell_options[args[i + 1]] = (tok == "-o")
                i += 2
                continue
            i += 1
            continue
        if (tok.startswith("-") or tok.startswith("+")) and len(tok) > 1:
            enable = tok[0] == "-"
            for ch in tok[1:]:
                opt = SET_FLAG_TO_OPTION.get(ch)
                if opt:
                    session.shell_options[opt] = enable
            i += 1
            continue
        session.positional_args = args[i:]
        break
    return None, IOResult(), ExecutionNode(command="set", exit_code=0)


_IDENTIFIER_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")


def _is_valid_name(name: str) -> bool:
    return _IDENTIFIER_RE.fullmatch(name) is not None


def _getopts_finish(
    session: Session,
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
    # write and turns the call into a status-1 error.
    if not _is_valid_name(name):
        stderr = f"bash: getopts: `{name}': not a valid identifier\n".encode()
        exit_code = 1
    elif name in session.readonly_vars:
        stderr = f"bash: {name}: readonly variable\n".encode()
        exit_code = 1
    else:
        session.env[name] = opt_value
    if optarg is None:
        session.env.pop("OPTARG", None)
    else:
        session.env["OPTARG"] = optarg
    session.env["OPTIND"] = str(new_optind)
    session._getopts_pos = new_pos
    session._getopts_optind = new_optind
    io = IOResult(exit_code=exit_code, stderr=stderr)
    return None, io, ExecutionNode(command="getopts",
                                   exit_code=exit_code,
                                   stderr=stderr)


async def handle_getopts(
    args: list[str],
    session: Session,
    call_stack: CallStack | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Parse one option per call, with bash's getopts semantics.

    Args:
        args (list[str]): words after `getopts`: the optstring, the name
            variable, then optional explicit arguments (the positional
            parameters are scanned when no explicit ones are given).
        session (Session): shell session; OPTIND/OPTARG live in its env
            and the hidden per-word scan offset in its getopts state.
        call_stack (CallStack | None): function-call positional frames;
            inside a shell function getopts scans the function's own
            positional parameters, matching bash.
    """
    if len(args) < 2:
        err = b"getopts: usage: getopts optstring name [arg]\n"
        return None, IOResult(exit_code=2,
                              stderr=err), ExecutionNode(command="getopts",
                                                         exit_code=2,
                                                         stderr=err)
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
        return _getopts_finish(session, name, "?", None, optind, 0, 1)
    word = params[optind - 1]
    # A stale cursor left past the end of the current word (a shorter or
    # reused argument) restarts the scan rather than indexing out of range.
    if pos >= len(word):
        pos = 0
    if pos == 0:
        if not word.startswith("-") or word == "-":
            return _getopts_finish(session, name, "?", None, optind, 0, 1)
        if word == "--":
            return _getopts_finish(session, name, "?", None, optind + 1, 0, 1)
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
            return _getopts_finish(session, name, "?", letter, after_optind,
                                   after_pos, 0)
        err = (f"bash: illegal option -- {letter}\n".encode()
               if verbose else b"")
        return _getopts_finish(session, name, "?", None, after_optind,
                               after_pos, 0, err)

    if not takes_arg:
        if rest:
            after_optind, after_pos = optind, pos + 1
        else:
            after_optind, after_pos = optind + 1, 0
        return _getopts_finish(session, name, letter, None, after_optind,
                               after_pos, 0)

    if rest:
        return _getopts_finish(session, name, letter, rest, optind + 1, 0, 0)
    if optind < len(params):
        return _getopts_finish(session, name, letter, params[optind],
                               optind + 2, 0, 0)
    if silent:
        return _getopts_finish(session, name, ":", letter, optind + 1, 0, 0)
    err = (f"bash: option requires an argument -- {letter}\n".encode()
           if verbose else b"")
    return _getopts_finish(session, name, "?", None, optind + 1, 0, 0, err)


async def handle_trap(
        session: Session,  # noqa: E125
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    return None, IOResult(), ExecutionNode(command="trap", exit_code=0)


async def handle_return(
    args: list[str],
    session: Session,
    call_stack: CallStack | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Return from a function or sourced script, with bash's checks.

    Args:
        args (list[str]): words after the command name; at most one,
            the return status.
        session (Session): session whose last exit code is the default
            status and whose source depth marks sourced execution.
        call_stack (CallStack | None): active call stack; a pushed
            frame marks function execution.
    """
    in_function = call_stack is not None and call_stack.depth > 1
    if not in_function and session.source_depth == 0:
        # bash prints the diagnostic, sets $? to 2, and carries on with
        # the rest of the line.
        err = (b"return: can only `return' from a function "
               b"or sourced script\n")
        return None, IOResult(exit_code=2,
                              stderr=err), ExecutionNode(command="return",
                                                         exit_code=2,
                                                         stderr=err)
    if args and not _is_shift_count(args[0]):
        # bash prints the error and the function returns 2.
        raise ReturnSignal(
            2,
            stderr=f"return: {args[0]}: numeric argument required\n".encode())
    if len(args) > 1:
        err = b"return: too many arguments\n"
        return None, IOResult(exit_code=1,
                              stderr=err), ExecutionNode(command="return",
                                                         exit_code=1,
                                                         stderr=err)
    # A bare return propagates the status of the last command executed.
    raise ReturnSignal(int(args[0]) % 256 if args else session.last_exit_code)


async def handle_exit(
    args: list[str],
    session: Session,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Exit the shell, with bash's argument checks.

    Args:
        args (list[str]): words after the command name; at most one,
            the exit status.
        session (Session): session whose last exit code is the default
            status.
    """
    if args and not _is_shift_count(args[0]):
        # bash exits with 2 after the diagnostic.
        raise ExitSignal(
            2, stderr=f"exit: {args[0]}: numeric argument required\n".encode())
    if len(args) > 1:
        # bash refuses to exit and the command fails with 1.
        err = b"exit: too many arguments\n"
        return None, IOResult(exit_code=1,
                              stderr=err), ExecutionNode(command="exit",
                                                         exit_code=1,
                                                         stderr=err)
    code = int(args[0]) if args else session.last_exit_code
    raise ExitSignal(code % 256)
