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

import asyncio
from collections.abc import Callable
from dataclasses import dataclass

from mirage.commands.config import RegisteredCommand
from mirage.commands.spec import SPECS, CommandSpec
from mirage.io import IOResult
from mirage.io.async_line_iterator import AsyncLineIterator
from mirage.io.stream import async_chain, materialize
from mirage.io.types import ByteSource
from mirage.shell.call_stack import CallStack
from mirage.shell.types import SET_FLAG_TO_OPTION
from mirage.types import FileType, PathSpec
from mirage.utils.path import resolve_path
from mirage.workspace.abort import cancellable_sleep
from mirage.workspace.executor.control import ReturnSignal
from mirage.workspace.mount.mount import Mount
from mirage.workspace.mount.registry import DEV_PREFIX, MountRegistry
from mirage.workspace.session import Session
from mirage.workspace.types import ExecutionNode


def _to_scope(path: str) -> PathSpec:
    """Wrap a resolved path string as PathSpec."""
    last_slash = path.rfind("/")
    directory = path[:last_slash + 1] if last_slash >= 0 else "/"
    return PathSpec(original=path, directory=directory, resolved=True)


def _scope_path(val) -> str:
    """Extract path string from str or PathSpec."""
    if isinstance(val, PathSpec):
        return val.original
    return val


async def handle_cd(
    dispatch: Callable,
    is_mount_root: Callable[[str], bool],
    path: str | PathSpec,
    session: Session,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    raw = _scope_path(path)
    resolved = resolve_path(raw, session.cwd)
    if resolved == "/":
        session.cwd = "/"
        return None, IOResult(), ExecutionNode(command=f"cd {raw}",
                                               exit_code=0)
    scope = _to_scope(resolved)
    s = None
    not_found = False
    try:
        s, _ = await dispatch("stat", scope)
    except FileNotFoundError:
        not_found = True
    except ValueError as exc:
        err = f"cd: {raw}: {exc}\n".encode()
        return None, IOResult(exit_code=1,
                              stderr=err), ExecutionNode(command=f"cd {raw}",
                                                         exit_code=1,
                                                         stderr=err)
    if s is None or not_found:
        if not is_mount_root(resolved):
            err = (f"cd: {raw}: No such file or "
                   f"directory\n").encode()
            return None, IOResult(exit_code=1, stderr=err), ExecutionNode(
                command=f"cd {raw}", exit_code=1, stderr=err)
    elif s.type != FileType.DIRECTORY:
        err = f"cd: {raw}: Not a directory\n".encode()
        return None, IOResult(exit_code=1,
                              stderr=err), ExecutionNode(command=f"cd {raw}",
                                                         exit_code=1,
                                                         stderr=err)
    session.cwd = resolved
    return None, IOResult(), ExecutionNode(command=f"cd {raw}", exit_code=0)


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


@dataclass
class _ManHit:
    mount: Mount
    cmd: RegisteredCommand
    is_general: bool


def _collect_man_hits(name: str, registry: MountRegistry) -> list[_ManHit]:
    hits: list[_ManHit] = []
    for mount in registry.mounts():
        if mount.prefix == DEV_PREFIX:
            continue
        cmd = mount.resolve_command(name)
        if cmd is None:
            continue
        hits.append(
            _ManHit(mount=mount,
                    cmd=cmd,
                    is_general=mount.is_general_command(name)))
    return hits


def _render_options_table(spec: CommandSpec) -> list[str]:
    if not spec.options:
        return []
    lines: list[str] = []
    lines.append("## OPTIONS")
    lines.append("")
    lines.append("| short | long | value | description |")
    lines.append("| ----- | ---- | ----- | ----------- |")
    for opt in spec.options:
        short = opt.short if opt.short is not None else ""
        long = opt.long if opt.long is not None else ""
        desc = opt.description if opt.description is not None else ""
        lines.append(f"| {short} | {long} | {opt.value_kind.value} | {desc} |")
    lines.append("")
    return lines


def _render_man_entry(name: str, hits: list[_ManHit]) -> str:
    first = hits[0]
    spec = first.cmd.spec
    lines: list[str] = []
    lines.append(f"# {name}")
    lines.append("")
    lines.append(spec.description if spec.
                 description is not None else "(no description)")
    lines.append("")
    lines.extend(_render_options_table(spec))
    lines.append("## RESOURCES")
    lines.append("")
    seen: set[str] = set()
    has_general = False
    rows: list[str] = []
    for h in hits:
        if h.is_general:
            has_general = True
            continue
        kind = h.mount.resource.name
        filetype = h.cmd.filetype
        key = f"{kind}\x00{filetype or ''}"
        if key in seen:
            continue
        seen.add(key)
        if filetype is not None:
            rows.append(f"- {kind} (filetype: {filetype})")
        else:
            rows.append(f"- {kind}")
    rows.sort()
    if has_general:
        lines.append("- general")
    for r in rows:
        lines.append(r)
    return "\n".join(lines) + "\n"


_SHELL_BUILTIN_MAN: dict[str, str] = {
    "bash": "bash",
    "sh": "bash",
}


def _render_shell_builtin_man(name: str, spec: CommandSpec) -> str:
    lines: list[str] = []
    lines.append(f"# {name}")
    lines.append("")
    lines.append(spec.description if spec.
                 description is not None else "(no description)")
    lines.append("")
    lines.extend(_render_options_table(spec))
    lines.append("## RESOURCES")
    lines.append("")
    lines.append("- shell builtin")
    return "\n".join(lines) + "\n"


def _render_man_index(session: Session, registry: MountRegistry) -> str:
    by_kind: dict[str, Mount] = {}
    for m in registry.mounts():
        if m.prefix == DEV_PREFIX:
            continue
        if m.resource.name not in by_kind:
            by_kind[m.resource.name] = m
    try:
        cwd_mount: Mount | None = registry.mount_for(session.cwd)
    except ValueError:
        cwd_mount = None
    cwd_kind: str | None = None
    if cwd_mount is not None and cwd_mount.prefix != DEV_PREFIX:
        cwd_kind = cwd_mount.resource.name

    kinds = sorted(by_kind.keys())
    ordered: list[str] = []
    if cwd_kind is not None and cwd_kind in by_kind:
        ordered.append(cwd_kind)
    for k in kinds:
        if k == cwd_kind:
            continue
        ordered.append(k)

    lines: list[str] = []
    general_seen: dict[str, RegisteredCommand] = {}
    for kind in ordered:
        m = by_kind[kind]
        lines.append(f"# {kind}")
        lines.append("")
        all_cmds = m.all_commands()
        resource_cmds = sorted(
            (c for c in all_cmds if not m.is_general_command(c.name)),
            key=lambda c: c.name,
        )
        for cmd in resource_cmds:
            desc = (cmd.spec.description if cmd.spec.description is not None
                    else "(no description)")
            lines.append(f"- {cmd.name} \u2014 {desc}")
        for cmd in all_cmds:
            if (m.is_general_command(cmd.name)
                    and cmd.name not in general_seen):
                general_seen[cmd.name] = cmd
        lines.append("")
    lines.append("# general")
    lines.append("")
    for name in sorted(general_seen):
        cmd = general_seen[name]
        desc = (cmd.spec.description
                if cmd.spec.description is not None else "(no description)")
        lines.append(f"- {name} \u2014 {desc}")
    return "\n".join(lines) + "\n"


async def handle_man(
    args: list[str],
    session: Session,
    registry: MountRegistry,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    if not args:
        out = _render_man_index(session, registry).encode()
        return out, IOResult(), ExecutionNode(command="man", exit_code=0)
    name = args[0]
    hits = _collect_man_hits(name, registry)
    if not hits:
        spec_key = _SHELL_BUILTIN_MAN.get(name)
        spec = SPECS.get(spec_key) if spec_key is not None else None
        if spec is not None:
            out = _render_shell_builtin_man(name, spec).encode()
            return out, IOResult(), ExecutionNode(command=f"man {name}",
                                                  exit_code=0)
        err = f"man: no entry for {name}\n".encode()
        return None, IOResult(exit_code=1,
                              stderr=err), ExecutionNode(command=f"man {name}",
                                                         exit_code=1,
                                                         stderr=err)
    out = _render_man_entry(name, hits).encode()
    return out, IOResult(), ExecutionNode(command=f"man {name}", exit_code=0)


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


async def handle_source(
    dispatch: Callable,
    execute_fn: Callable,
    path: str | PathSpec,
    session: Session,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Read a script file and execute it."""
    raw = _scope_path(path)
    resolved = resolve_path(raw, session.cwd)
    scope = _to_scope(resolved)
    data, _ = await dispatch("read", scope)
    if isinstance(data, bytes):
        script = data.decode(errors="replace")
    else:
        script = ""
    io = await execute_fn(script, session_id=session.session_id)
    return io.stdout, io, ExecutionNode(command=f"source {raw}",
                                        exit_code=io.exit_code)


async def handle_eval(
    execute_fn: Callable,
    args: list[str],
    session: Session,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    script = " ".join(args)
    io = await execute_fn(script, session_id=session.session_id)
    return io.stdout, io, ExecutionNode(command="eval", exit_code=io.exit_code)


_BASH_NOOP_SHORT_FLAGS = frozenset({"l", "i", "e", "u", "x"})
_BASH_NOOP_LONG_FLAGS = frozenset(
    {"--login", "--norc", "--noprofile", "--posix", "--rcfile"})


async def handle_bash(
    execute_fn: Callable,
    args: list[str],
    session: Session,
    stdin: ByteSource | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    script: str | None = None
    read_stdin = False
    i = 0
    while i < len(args):
        tok = args[i]
        if tok == "--":
            i += 1
            break
        if tok == "-c":
            if i + 1 >= len(args):
                err = b"bash: -c: option requires an argument\n"
                return None, IOResult(exit_code=2, stderr=err), ExecutionNode(
                    command="bash", exit_code=2, stderr=err)
            script = args[i + 1]
            break
        if tok == "-s":
            read_stdin = True
            i += 1
            continue
        if tok in ("-o", "+o"):
            i += 2
            continue
        if tok in _BASH_NOOP_LONG_FLAGS:
            i += 1
            continue
        if (tok.startswith("-") and len(tok) > 1 and not tok.startswith("--")):
            chars = tok[1:]
            if "c" in chars:
                if i + 1 >= len(args):
                    err = b"bash: -c: option requires an argument\n"
                    return None, IOResult(
                        exit_code=2, stderr=err), ExecutionNode(command="bash",
                                                                exit_code=2,
                                                                stderr=err)
                script = args[i + 1]
                break
            if all(ch in _BASH_NOOP_SHORT_FLAGS or ch == "s" for ch in chars):
                if "s" in chars:
                    read_stdin = True
                i += 1
                continue
            err = (f"bash: {tok}: unsupported option\n").encode()
            return None, IOResult(exit_code=2,
                                  stderr=err), ExecutionNode(command="bash",
                                                             exit_code=2,
                                                             stderr=err)
        if script is None:
            script = tok
            break
        i += 1
    if script is None and read_stdin and stdin is not None:
        stdin_data = await materialize(stdin)
        if stdin_data:
            script = stdin_data.decode(errors="replace")
            stdin = None
    if script is None:
        return None, IOResult(), ExecutionNode(command="bash", exit_code=0)
    io = await execute_fn(script, session_id=session.session_id, stdin=stdin)
    return io.stdout, io, ExecutionNode(command=f"bash -c {script}",
                                        exit_code=io.exit_code)


async def _eval_test(dispatch: Callable, argv: list) -> bool:
    if not argv:
        return False
    first = _scope_path(argv[0])
    if first == "!" and len(argv) > 1:
        return not await _eval_test(dispatch, argv[1:])
    if len(argv) == 1:
        return bool(first)
    if len(argv) == 2:
        op = _scope_path(argv[0])
        val = argv[1]
        if op == "-z":
            return _scope_path(val) == ""
        if op == "-n":
            return _scope_path(val) != ""
        if op == "-f":
            scope = val if isinstance(val, PathSpec) else _to_scope(
                _scope_path(val))
            try:
                await dispatch("stat", scope)
                return True
            except (FileNotFoundError, ValueError):
                return False
        if op == "-d":
            scope = val if isinstance(val, PathSpec) else PathSpec(
                original=_scope_path(val),
                directory=_scope_path(val),
                resolved=False)
            try:
                await dispatch("readdir", scope)
                return True
            except (FileNotFoundError, ValueError, NotADirectoryError):
                return False
    if len(argv) == 3:
        left = _scope_path(argv[0])
        op = _scope_path(argv[1])
        right = _scope_path(argv[2])
        if op == "=" or op == "==":
            return left == right
        if op == "!=":
            return left != right
        try:
            li, ri = int(left), int(right)
        except (ValueError, TypeError):
            return False
        if op == "-eq":
            return li == ri
        if op == "-ne":
            return li != ri
        if op == "-lt":
            return li < ri
        if op == "-le":
            return li <= ri
        if op == "-gt":
            return li > ri
        if op == "-ge":
            return li >= ri
    return False


async def handle_test(
    dispatch: Callable,
    argv: list,
    session: Session,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    result = await _eval_test(dispatch, argv)
    code = 0 if result else 1
    return None, IOResult(exit_code=code), ExecutionNode(command="test",
                                                         exit_code=code)


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


_SIMPLE_ESCAPES = {
    "\\": "\\",
    "n": "\n",
    "t": "\t",
    "r": "\r",
    "a": "\a",
    "b": "\b",
    "f": "\f",
    "v": "\v",
}

_HEX = set("0123456789abcdefABCDEF")
_OCT = set("01234567")


def _interpret_escapes(text: str) -> str:
    """Process C-style escape sequences for echo -e.

    Single-pass to handle \\\\ correctly (\\\\b → \\b literal).
    Supports: \\\\, \\n, \\t, \\r, \\a, \\b, \\f, \\v,
    \\xHH (hex), \\0NNN (octal), \\c (stop output).
    Unknown escapes like \\z pass through as \\z.
    """
    out: list[str] = []
    i = 0
    n = len(text)
    while i < n:
        if text[i] != "\\" or i + 1 >= n:
            out.append(text[i])
            i += 1
            continue
        ch = text[i + 1]
        if ch in _SIMPLE_ESCAPES:
            out.append(_SIMPLE_ESCAPES[ch])
            i += 2
        elif ch == "c":
            break
        elif ch == "x":
            # \xHH — up to 2 hex digits
            digits = []
            j = i + 2
            while j < n and len(digits) < 2 and text[j] in _HEX:
                digits.append(text[j])
                j += 1
            if digits:
                out.append(chr(int("".join(digits), 16)))
                i = j
            else:
                out.append("\\x")
                i += 2
        elif ch == "0":
            # \0NNN — up to 3 octal digits
            digits = []
            j = i + 2
            while j < n and len(digits) < 3 and text[j] in _OCT:
                digits.append(text[j])
                j += 1
            out.append(chr(int("".join(digits), 8)) if digits else "\0")
            i = j
        else:
            # unknown escape — pass through literally
            out.append("\\")
            out.append(ch)
            i += 2
    return "".join(out)


async def handle_echo(
    args: list[str],
    n_flag: bool = False,
    e_flag: bool = False,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    text = " ".join(args)
    if e_flag:
        text = _interpret_escapes(text)
    if not n_flag:
        text += "\n"
    out = text.encode()
    return out, IOResult(), ExecutionNode(command="echo", exit_code=0)


async def handle_printf(
        args: list[str],  # noqa: E125
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    if not args:
        return b"", IOResult(), ExecutionNode(command="printf", exit_code=0)
    fmt = args[0]
    fmt = fmt.replace("\\n", "\n").replace("\\t", "\t")
    if len(args) > 1:
        try:
            out = (fmt % tuple(args[1:])).encode()
        except TypeError:
            out = fmt.encode()
    else:
        out = fmt.encode()
    return out, IOResult(), ExecutionNode(command="printf", exit_code=0)


async def handle_sleep(
    args: list[str],
    cancel: asyncio.Event | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    try:
        seconds = float(args[0]) if args else 0
    except ValueError:
        err = f"sleep: invalid argument: {args[0]}\n".encode()
        return None, IOResult(exit_code=1,
                              stderr=err), ExecutionNode(command="sleep",
                                                         exit_code=1)
    await cancellable_sleep(seconds, cancel)
    return None, IOResult(), ExecutionNode(command="sleep", exit_code=0)
