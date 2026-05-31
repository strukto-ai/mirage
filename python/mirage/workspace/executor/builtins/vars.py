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
from mirage.io.async_line_iterator import AsyncLineIterator
from mirage.io.stream import async_chain
from mirage.io.types import ByteSource
from mirage.shell.call_stack import CallStack
from mirage.shell.types import SET_FLAG_TO_OPTION
from mirage.workspace.executor.control import ReturnSignal
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
        session: Session,  # noqa: E125
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    user = session.env.get("USER")
    if user is None:
        err = b"whoami: USER not set\n"
        return None, IOResult(exit_code=1,
                              stderr=err), ExecutionNode(command="whoami",
                                                         exit_code=1,
                                                         stderr=err)
    out = f"{user}\n".encode()
    return out, IOResult(), ExecutionNode(command="whoami", exit_code=0)


async def handle_read(
    variables: list[str],
    session: Session,
    stdin: ByteSource | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    if session._stdin_buffer is None and stdin is not None:
        if isinstance(stdin, bytes):
            session._stdin_buffer = AsyncLineIterator(async_chain(stdin))
        elif hasattr(stdin, "__aiter__"):
            session._stdin_buffer = AsyncLineIterator(stdin)

    line_bytes: bytes | None = None
    if session._stdin_buffer is not None:
        line_bytes = await session._stdin_buffer.readline()

    if line_bytes is None:
        for var in variables:
            session.env[var] = ""
        return None, IOResult(exit_code=1), ExecutionNode(command="read",
                                                          exit_code=1)

    line = line_bytes.decode(errors="replace").rstrip("\n")
    ifs = session.env.get("IFS", " \t\n")
    if ifs == " \t\n":
        parts = line.split(None, len(variables) - 1) if variables else []
    elif not ifs:
        parts = [line]
    else:
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
    n: int,
    call_stack: CallStack | None,
    session: Session | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    shifted = False
    if call_stack is not None and call_stack.get_all_positional():
        call_stack.shift(n)
        shifted = True
    if not shifted and session is not None:
        pos = getattr(session, "positional_args", None)
        if pos is not None:
            session.positional_args = pos[n:]
    return None, IOResult(), ExecutionNode(command="shift", exit_code=0)


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


async def handle_trap(
        session: Session,  # noqa: E125
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    return None, IOResult(), ExecutionNode(command="trap", exit_code=0)


async def handle_return(
        exit_code: int,  # noqa: E125
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    raise ReturnSignal(exit_code)
