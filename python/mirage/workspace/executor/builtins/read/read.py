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

from mirage.commands.spec.shell import SHELL_SPECS, parse_shell_options
from mirage.io import IOResult
from mirage.io.async_line_iterator import AsyncLineIterator
from mirage.io.stream import async_chain
from mirage.io.types import ByteSource
from mirage.ops.types import SessionView
from mirage.policy import PolicyDenied
from mirage.shell.errors import ArithError
from mirage.utils.errors import BadDescriptorError
from mirage.workspace.executor.builtins.constants import TARGET_RE
from mirage.workspace.executor.builtins.read.constants import \
    READ_VALUE_LETTERS
from mirage.workspace.executor.builtins.shared import (arith_refusal,
                                                       is_valid_name,
                                                       readonly_refusal,
                                                       refusal, require_view)
from mirage.workspace.executor.builtins.types import BuiltinCall, Result
from mirage.workspace.session import Session
from mirage.workspace.session.elements import assign_element
from mirage.workspace.session.state import session_view, visible_env
from mirage.workspace.types import ExecutionNode


async def _read_store(
    session: Session,
    view: SessionView,
    var: str,
    value: str,
) -> tuple[ByteSource | None, IOResult, ExecutionNode] | None:
    """Store one ``read`` target, scalar or ``name[sub]`` element.

    bash accepts a subscripted target (``read "m[k]"``), which is an
    element write, not a variable literally named ``m[k]``; the
    readonly guard resolves the base name first, since that is what
    ``readonly`` records.

    Args:
        session (Session): shell session state.
        view (SessionView): the session plane's gated door.
        var (str): the target as the operand spelled it.
        value (str): the split word to store.

    Returns:
        The refusal result, or None when the write landed.
    """
    target = TARGET_RE.match(var)
    base = target.group(1) if target is not None else var
    subscript = target.group(2) if target is not None else None
    if view.is_readonly(base):
        return readonly_refusal("read", base)
    if subscript is None:
        try:
            await view.set(var, value)
        except PolicyDenied as exc:
            return refusal("read", exc)
        except ArithError as exc:
            return arith_refusal("read", exc)
        return None
    try:
        status = await assign_element(session, view, base, subscript, value)
    except PolicyDenied as exc:
        return refusal("read", exc)
    except ArithError as exc:
        return arith_refusal("read", exc)
    if status == "readonly":
        return readonly_refusal("read", base)
    if status == "denied":
        err = f"bash: {base}: permission denied\n".encode()
        return None, IOResult(exit_code=1,
                              stderr=err), ExecutionNode(command="read",
                                                         exit_code=1,
                                                         stderr=err)
    if status != "ok":
        err = f"bash: read: {var}: bad array subscript\n".encode()
        return None, IOResult(exit_code=1,
                              stderr=err), ExecutionNode(command="read",
                                                         exit_code=1,
                                                         stderr=err)
    return None


def _read_refusal(
        msg: str) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    err = msg.encode()
    return None, IOResult(exit_code=1,
                          stderr=err), ExecutionNode(command="read",
                                                     exit_code=1,
                                                     stderr=err)


def _read_count(text: str) -> int | None:
    """A `-n`/`-N` operand: a non-negative integer, else None.

    Args:
        text (str): the option's value as typed.
    """
    return int(text) if text.isdigit() else None


def _last_count_flag(args: list[str]) -> str | None:
    """Which of `-n`/`-N` was written last, since bash keeps only one.

    Args:
        args (list[str]): the words after `read`, as typed.
    """
    which: str | None = None
    i = 0
    while i < len(args):
        tok = args[i]
        if tok == "--" or not tok.startswith("-") or tok == "-":
            break
        j = 1
        while j < len(tok):
            ch = tok[j]
            if ch in "nN":
                which = ch
            if ch in READ_VALUE_LETTERS:
                if j == len(tok) - 1:
                    i += 1
                break
            j += 1
        i += 1
    return which


def _read_timeout(text: str) -> float | None:
    """A `-t` operand: a non-negative decimal number, else None.

    Args:
        text (str): the option's value as typed.
    """
    try:
        value = float(text)
    except ValueError:
        return None
    return value if value >= 0 else None


def _split_read_line(line: str, ifs: str, slots: int) -> list[str]:
    """Split one `read` line into at most ``slots`` fields on IFS.

    GNU trims IFS whitespace from both ends first, then splits on IFS
    characters, with the last field taking the remainder of the line
    unsplit. A zero slot count (`read -a`) means every field.

    Args:
        line (str): the line, delimiter already removed.
        ifs (str): the session's IFS.
        slots (int): how many variables are waiting, 0 for unbounded.
    """
    if ifs == " \t\n":
        line = line.strip(" \t\n")
        return line.split(None, slots - 1) if slots else line.split()
    if not ifs:
        return [line]
    ifs_ws = "".join(ch for ch in ifs if ch in " \t\n")
    if ifs_ws:
        line = line.strip(ifs_ws)
    n_splits = max(0, slots - 1) if slots else len(line)
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
    return out


def _unescape_read(text: str) -> str:
    """Apply `read`'s default backslash handling.

    Without `-r`, a backslash quotes the next character (`\\x` reads
    as `x`) and a backslash-newline pair is a line continuation.

    Args:
        text (str): the raw text read.
    """
    out: list[str] = []
    i = 0
    while i < len(text):
        ch = text[i]
        if ch == "\\" and i + 1 < len(text):
            nxt = text[i + 1]
            if nxt != "\n":
                out.append(nxt)
            i += 2
            continue
        out.append(ch)
        i += 1
    return "".join(out)


async def _read_raw(
    buffer: AsyncLineIterator,
    raw: bool,
    delim: bytes,
    nchars: int | None,
    exact: int | None,
) -> tuple[str, bool]:
    """Pull one `read`'s worth of input off the buffer.

    Without `-r`, a backslash-newline pair continues the line, so the
    delimiter read is retried while the text ends in an odd backslash.

    Args:
        buffer (AsyncLineIterator): the session's line source.
        raw (bool): `-r`, no backslash processing.
        delim (bytes): the one-byte delimiter (`-d`, newline by default).
        nchars (int | None): `-n`, stop after this many characters.
        exact (int | None): `-N`, read exactly this many, delimiters
            included.

    Returns:
        tuple[str, bool]: the text (delimiter excluded) and whether the
        read ended on its own terms rather than at end of input.
    """
    if exact is not None:
        data, complete = await buffer.read_chars(exact, None)
        return data.decode(errors="replace"), complete
    if nchars is not None:
        data, complete = await buffer.read_chars(nchars, delim)
        text = data.decode(errors="replace")
        while (not raw and complete and text.endswith("\\")
               and (len(text) - len(text.rstrip("\\"))) % 2 == 1
               and len(text) < nchars):
            more, complete = await buffer.read_chars(nchars - len(text), delim)
            text += more.decode(errors="replace")
        return text, complete
    data, complete = await buffer.read_until(delim)
    text = data.decode(errors="replace")
    while (not raw and complete and delim == b"\n"
           and (len(text) - len(text.rstrip("\\"))) % 2 == 1):
        more, complete = await buffer.read_until(delim)
        text += "\n" + more.decode(errors="replace")
    return text, complete


async def handle_read(
    args: list[str],
    session: Session,
    stdin: ByteSource | None = None,
    state: SessionView | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Read one line (or delimited record, or character count) into
    variables, with bash's option surface.

    `-r` turns off backslash processing; `-d C` reads to `C` instead of
    newline (an empty `C` is NUL); `-n N` returns after N characters or
    the delimiter, whichever comes first, `-N N` after exactly N with
    delimiters read through and no field splitting; `-a NAME` stores
    every field in an indexed array; `-t N` with a zero timeout answers
    whether input is already buffered and is otherwise accepted as
    written, since a buffered source is never going to arrive later;
    `-p`, `-s`, `-e` and `-i` are accepted and do nothing, which is
    what bash itself does when the input is not a terminal; `-u 0` is
    the input this shell has and any other descriptor is refused as
    bash refuses one it never opened. The status is 1 when end of input
    ended the read, whatever was assigned along the way.

    Args:
        args (list[str]): words after the command name.
        session (Session): shell session state.
        stdin (ByteSource | None): line source.
        state (SessionView | None): the session plane's gated door.
    """
    parse = parse_shell_options(SHELL_SPECS["read"], args)
    if parse.invalid is not None:
        token = (parse.invalid
                 if parse.invalid.startswith("--") else f"-{parse.invalid}")
        err = f"read: {token}: invalid option\n".encode()
        return None, IOResult(exit_code=2,
                              stderr=err), ExecutionNode(command="read",
                                                         exit_code=2)
    if parse.needs_value is not None:
        missing = (f"read: -{parse.needs_value}: option requires an "
                   "argument\n").encode()
        return None, IOResult(exit_code=2,
                              stderr=missing), ExecutionNode(command="read",
                                                             exit_code=2)
    flags = parse.flags
    raw = bool(flags.get("r"))
    delim = b"\n"
    if "d" in flags:
        text = str(flags["d"])
        delim = text[:1].encode() if text else b"\0"
    nchars: int | None = None
    exact: int | None = None
    # `-n` and `-N` are one setting in bash: the last one written wins.
    for key in ("n", "N"):
        if key not in flags:
            continue
        count = _read_count(str(flags[key]))
        if count is None:
            return _read_refusal(f"bash: read: {flags[key]}: invalid number\n")
    which = _last_count_flag(args)
    if which == "N":
        exact = _read_count(str(flags["N"]))
    elif which == "n":
        nchars = _read_count(str(flags["n"]))
    timeout: float | None = None
    if "t" in flags:
        timeout = _read_timeout(str(flags["t"]))
        if timeout is None:
            return _read_refusal(
                f"bash: read: {flags['t']}: invalid timeout specification\n")
    if "u" in flags and str(flags["u"]) != "0":
        return _read_refusal(f"bash: read: {flags['u']}: invalid file "
                             "descriptor: Bad file descriptor\n")
    array_name = str(flags["a"]) if "a" in flags else None
    if array_name is not None and not is_valid_name(array_name):
        return _read_refusal(
            f"bash: read: `{array_name}': not a valid identifier\n")
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

    view = require_view(state)
    buffer = session._stdin_buffer
    if timeout == 0:
        # `read -t 0` asks whether input is available and reads nothing.
        # bash asks select(2), which reports a source at end of file as
        # readable too, so any source at all answers yes and only the
        # absence of one (no pipe, no redirect, no here-string) is no.
        code = 0 if buffer is not None else 1
        return None, IOResult(exit_code=code), ExecutionNode(command="read",
                                                             exit_code=code)
    complete = False
    line = ""
    if buffer is not None:
        try:
            line, complete = await _read_raw(buffer, raw, delim, nchars, exact)
        except BadDescriptorError:
            # stdin is closed or write-only (`read x <&-`, `read x 0<&1`).
            return _read_refusal(
                "bash: read: read error: 0: Bad file descriptor\n")
    if not raw:
        line = _unescape_read(line)
    ifs = visible_env(session).get("IFS", " \t\n")
    if array_name is not None:
        parts = [] if exact is not None else _split_read_line(line, ifs, 0)
        if exact is not None and line:
            parts = [line]
        if view.is_readonly(array_name):
            return readonly_refusal("read", array_name)
        try:
            await view.set(array_name, list(parts))
        except PolicyDenied as exc:
            return refusal("read", exc)
        code = 0 if complete else 1
        return None, IOResult(exit_code=code), ExecutionNode(command="read",
                                                             exit_code=code)
    if exact is not None:
        parts = [line]
    else:
        parts = _split_read_line(line, ifs, len(variables))
    for i, var in enumerate(variables):
        refused = await _read_store(session, view, var,
                                    parts[i] if i < len(parts) else "")
        if refused is not None:
            return refused
    code = 0 if complete else 1
    return None, IOResult(exit_code=code), ExecutionNode(command="read",
                                                         exit_code=code)


async def read_builtin(call: BuiltinCall) -> Result:
    """The ``read`` arm.

    Args:
        call (BuiltinCall): the invocation.
    """
    return await handle_read(
        list(call.argv.args), call.session, call.stdin,
        session_view(call.session, call.namespace.registry.policies))
