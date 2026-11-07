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
from mirage.errors.types import BadDescriptorError
from mirage.io import IOResult
from mirage.io.async_line_iterator import AsyncLineIterator, line_buffer
from mirage.io.memory import check_memory
from mirage.io.types import ByteSource
from mirage.policy import PolicyDenied
from mirage.policy.policies import Policies
from mirage.shell.array import make_array
from mirage.shell.bytes import decode_text, encode_text
from mirage.shell.escapes import ends_escaped
from mirage.shell.voice import shell_voice
from mirage.view.types import SessionView
from mirage.workspace.executor.builtins.constants import TARGET_RE
from mirage.workspace.executor.builtins.read.constants import (
    READ_VALUE_LETTERS,
)
from mirage.workspace.executor.builtins.shared import (
    builtin_usage,
    count_operand,
    identifier_line,
    is_valid_name,
    readonly_refusal,
    record_delimiter,
    refusal,
    require_view,
    subscript_expansion,
)
from mirage.workspace.executor.builtins.types import BuiltinCall, Result
from mirage.workspace.expand.types import SubscriptFn
from mirage.workspace.session import SessionState
from mirage.workspace.session.state import (
    assign_element,
    session_view,
    visible_env,
)
from mirage.workspace.types import ExecutionNode


async def _read_store(
    session: SessionState,
    view: SessionView,
    var: str,
    value: str,
    policies: Policies | None = None,
    subscripts: SubscriptFn | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode] | None:
    """Store one ``read`` target, scalar or ``name[sub]`` element.

    bash accepts a subscripted target (``read "m[k]"``), which is an
    element write, not a variable literally named ``m[k]``; the
    readonly guard resolves the base name first, since that is what
    ``readonly`` records.

    Args:
        session (SessionState): shell session state.
        view (SessionView): the gated session view.
        policies (Policies | None): the policies a subscript's
            assignments clear.
        var (str): the target as the operand spelled it.
        value (str): the split word to store.
        subscripts (SubscriptFn | None): expands a subscript given as
            text; None keeps it as typed.

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
        return None
    if subscripts is not None:
        subscript = await subscripts(subscript)
    try:
        status = await assign_element(
            session, policies, base, subscript, value
        )
    except PolicyDenied as exc:
        return refusal("read", exc)
    if status == "readonly":
        return readonly_refusal("read", base)
    if status == "denied":
        err = encode_text(f"{shell_voice()}{base}: permission denied\n")
        return (
            None,
            IOResult(exit_code=1, stderr=err),
            ExecutionNode(command="read", exit_code=1, stderr=err),
        )
    if status != "ok":
        err = encode_text(f"{shell_voice()}read: {var}: bad array subscript\n")
        return (
            None,
            IOResult(exit_code=1, stderr=err),
            ExecutionNode(command="read", exit_code=1, stderr=err),
        )
    return None


def _invalid_name(
    name: str,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """bash's refusal of a name ``read`` cannot assign.

    Args:
        name (str): the operand as spelled.
    """
    return _read_refusal(identifier_line("read", name) + "\n")


def _read_refusal(
    msg: str,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    err = encode_text(msg)
    return (
        None,
        IOResult(exit_code=1, stderr=err),
        ExecutionNode(command="read", exit_code=1, stderr=err),
    )


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


def _read_chars(text: str, raw: bool) -> list[tuple[str, bool]]:
    """The characters ``read`` splits, each with whether a backslash
    quoted it.

    Without ``-r`` a backslash quotes the next character (``\\x`` reads
    as a quoted ``x``), a backslash-newline pair is a line continuation
    and a backslash at the end goes.

    Args:
        text (str): the raw text read.
        raw (bool): ``-r``, no backslash processing.
    """
    out: list[tuple[str, bool]] = []
    i = 0
    while i < len(text):
        ch = text[i]
        if ch == "\\" and not raw:
            if i + 1 < len(text) and text[i + 1] != "\n":
                out.append((text[i + 1], True))
            i += 2
            continue
        out.append((ch, False))
        i += 1
    return out


def _unescape_read(text: str) -> str:
    """Apply ``read``'s default backslash handling (``_read_chars``).

    Args:
        text (str): the raw text read.
    """
    return "".join(ch for ch, _ in _read_chars(text, False))


def _read_fields(text: str, ifs: str, slots: int, raw: bool) -> list[str]:
    """Split one ``read`` line into at most ``slots`` fields on IFS, as
    bash does.

    Leading IFS whitespace goes; a delimiter is one other IFS character
    with the IFS whitespace around it, or a run of IFS whitespace, and a
    quoted character never splits. The last field takes the rest of the
    line, its trailing IFS whitespace dropped, and the delimiter ending
    it too when it holds one field only (``x:y:`` reads ``y`` into the
    second of two). A zero slot count (``read -a``) means every field,
    a delimiter at the end opening none.

    Args:
        text (str): the line, delimiter already removed.
        ifs (str): the session's IFS.
        slots (int): how many variables are waiting, 0 for unbounded.
        raw (bool): ``-r``, no backslash processing.
    """
    chars = _read_chars(text, raw)
    n = len(chars)

    def white(k: int) -> bool:
        return (
            not chars[k][1] and chars[k][0] in " \t\n" and chars[k][0] in ifs
        )

    def splits(k: int) -> bool:
        return not chars[k][1] and chars[k][0] in ifs

    def joined(a: int, b: int) -> str:
        return "".join(ch for ch, _ in chars[a:b])

    def past_delimiter(k: int) -> int:
        other = not white(k)
        k += 1
        while k < n and white(k):
            k += 1
        if not other and k < n and splits(k):
            k += 1
            while k < n and white(k):
                k += 1
        return k

    k = 0
    while k < n and white(k):
        k += 1
    fields: list[str] = []
    while k < n and (not slots or len(fields) < slots - 1):
        start = k
        while k < n and not splits(k):
            k += 1
        fields.append(joined(start, k))
        if k < n:
            k = past_delimiter(k)
    if not slots or k >= n:
        return fields
    end = n
    while end > k and white(end - 1):
        end -= 1
    if splits(end - 1):
        cut = end - 1
        while cut > k and white(cut - 1):
            cut -= 1
        if not any(splits(i) for i in range(k, cut)):
            end = cut
    fields.append(joined(k, end))
    return fields


async def _read_raw(
    buffer: AsyncLineIterator,
    raw: bool,
    delim: bytes,
    nchars: int | None,
    exact: int | None,
) -> tuple[str, bool]:
    """Pull one `read`'s worth of input off the buffer.

    Without `-r` a backslash quotes the delimiter after it, which the
    text keeps (a newline one continues the line), so the delimiter read
    is retried while the text ends in an odd backslash.

    Args:
        buffer (AsyncLineIterator): the input's line reader.
        raw (bool): `-r`, no backslash processing.
        delim (bytes): the one-byte delimiter (`-d`, newline by default).
        nchars (int | None): `-n`, stop after this many characters.
        exact (int | None): `-N`, read exactly this many, delimiters
            included.

    Returns:
        tuple[str, bool]: the text (delimiter excluded) and whether the
        read ended on its own terms rather than at end of input.
    """
    count = exact if exact is not None else nchars
    stop = None if exact is not None else delim
    if count is not None and raw:
        data, complete = await buffer.read_chars(count, stop)
        return decode_text(data), complete
    if count is not None:
        return await _read_counted(buffer, count, stop)
    data, complete = await buffer.read_until(delim)
    held = len(data)
    text = decode_text(data)
    while not raw and complete and ends_escaped(text):
        more, complete = await buffer.read_until(delim)
        held += len(more) + 1
        check_memory(held)
        text += decode_text(delim) + decode_text(more)
    return text, complete


async def _read_counted(
    buffer: AsyncLineIterator,
    count: int,
    delim: bytes | None,
) -> tuple[str, bool]:
    """Read `count` characters as `-n` and `-N` count them without `-r`:
    once backslashes are processed, so `\\x` is one and a backslash-newline
    none. The character after a backslash is always read, and a quoted
    delimiter kept.

    Args:
        buffer (AsyncLineIterator): the input's line reader.
        count (int): how many characters to read.
        delim (bytes | None): the stop, or None to read through
            delimiters.
    """
    text = ""
    got = held = 0
    escaped = False
    while got < count:
        want = 1 if escaped else count - got
        data, complete = await buffer.read_chars(want, delim)
        held += len(data)
        check_memory(held)
        piece = decode_text(data)
        n, escaped = _counted(piece, escaped)
        text += piece
        got += n
        if not complete:
            return text, False
        if len(piece) < want:
            if not escaped or delim is None:
                return text, True
            text += decode_text(delim)
            got += delim != b"\n"
            escaped = False
    return text, True


def _counted(piece: str, escaped: bool) -> tuple[int, bool]:
    """How many characters `piece` leaves once backslashes are processed,
    and whether a backslash ends it, quoting what follows.

    Args:
        piece (str): text read after `escaped`'s state.
        escaped (bool): a backslash before `piece` quotes its first
            character.
    """
    n = 0
    for ch in piece:
        if escaped:
            n += ch != "\n"
            escaped = False
        elif ch == "\\":
            escaped = True
        else:
            n += 1
    return n, escaped


async def read_reply(buffer: AsyncLineIterator) -> str | None:
    """One line as a bare `read` stores it in REPLY: backslashes
    processed, a continuation joined, nothing split off; None at end of
    input. `select` takes its choice this way (bash calls this builtin).

    Args:
        buffer (AsyncLineIterator): the input's line reader.
    """
    line, complete = await _read_raw(buffer, False, b"\n", None, None)
    return _unescape_read(line) if complete else None


async def handle_read(
    args: list[str],
    session: SessionState,
    stdin: ByteSource | None = None,
    state: SessionView | None = None,
    policies: Policies | None = None,
    subscripts: SubscriptFn | None = None,
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
    what bash itself does when the input is not a terminal; `-u FD`
    reads an open descriptor, sharing its cursor with aliases.
    The status is 1 when end of input
    ended the read, whatever was assigned along the way.

    Args:
        args (list[str]): words after the command name.
        session (SessionState): shell session state.
        stdin (ByteSource | None): line source.
        state (SessionView | None): the gated session view.
        policies (Policies | None): the policies a subscript's
            assignments clear.
        subscripts (SubscriptFn | None): expands a target's subscript
            given as text; None keeps it as typed.
    """
    parse = parse_shell_options(SHELL_SPECS["read"], args)
    if parse.invalid is not None:
        token = (
            parse.invalid
            if parse.invalid.startswith("--")
            else f"-{parse.invalid}"
        )
        err = encode_text(
            f"{shell_voice()}read: {token}: invalid option\n{builtin_usage('read')}"
        )
        return (
            None,
            IOResult(exit_code=2, stderr=err),
            ExecutionNode(command="read", exit_code=2),
        )
    if parse.needs_value is not None:
        missing = encode_text(
            f"{shell_voice()}read: -{parse.needs_value}: option requires an argument\n"
            f"{builtin_usage('read')}"
        )
        return (
            None,
            IOResult(exit_code=2, stderr=missing),
            ExecutionNode(command="read", exit_code=2),
        )
    flags = parse.flags
    raw = bool(flags.get("r"))
    delim = record_delimiter(str(flags["d"]) if "d" in flags else None)
    nchars: int | None = None
    exact: int | None = None
    # `-n` and `-N` are one setting in bash: the last one written wins.
    for key in ("n", "N"):
        if key not in flags:
            continue
        count = count_operand(str(flags[key]))
        if count is None:
            return _read_refusal(
                f"{shell_voice()}read: {flags[key]}: invalid number\n"
            )
    which = _last_count_flag(args)
    if which == "N":
        exact = count_operand(str(flags["N"]))
    elif which == "n":
        nchars = count_operand(str(flags["n"]))
    timeout: float | None = None
    if "t" in flags:
        timeout = _read_timeout(str(flags["t"]))
        if timeout is None:
            return _read_refusal(
                f"{shell_voice()}read: {flags['t']}: invalid timeout specification\n"
            )
    if "u" in flags and str(flags["u"]) != "0":
        fd = str(flags["u"])
        descriptor = session.descriptors.get(int(fd)) if fd.isdigit() else None
        if descriptor is None or descriptor.source is None:
            return _read_refusal(
                f"{shell_voice()}read: {fd}: invalid file "
                "descriptor: Bad file descriptor\n"
            )
        stdin = descriptor.source
    array_name = str(flags["a"]) if "a" in flags else None
    if array_name is not None and not is_valid_name(array_name):
        return _invalid_name(array_name)
    variables = parse.operands or ["REPLY"]
    if TARGET_RE.match(variables[0]) is None:
        # A first name it cannot assign refuses before anything is read.
        return _invalid_name(variables[0])
    view = require_view(state)
    buffer = line_buffer(stdin) if stdin is not None else None
    if timeout == 0:
        # `read -t 0` asks whether input is available and reads nothing.
        # bash asks select(2), which reports a source at end of file as
        # readable too, so any source at all answers yes and only the
        # absence of one (no pipe, no redirect, no here-string) is no.
        code = 0 if buffer is not None else 1
        return (
            None,
            IOResult(exit_code=code),
            ExecutionNode(command="read", exit_code=code),
        )
    complete = False
    line = ""
    if buffer is not None:
        try:
            line, complete = await _read_raw(buffer, raw, delim, nchars, exact)
        except BadDescriptorError:
            # stdin is closed or write-only (`read x <&-`, `read x 0<&1`).
            return _read_refusal(
                f"{shell_voice()}read: read error: 0: Bad file descriptor\n"
            )
    ifs = visible_env(session).get("IFS", " \t\n")
    whole = "".join(ch for ch, _ in _read_chars(line, raw))
    if array_name is not None:
        parts = [] if exact is not None else _read_fields(line, ifs, 0, raw)
        if exact is not None and whole:
            parts = [whole]
        if view.is_readonly(array_name):
            return readonly_refusal("read", array_name)
        try:
            await view.set(array_name, make_array(list(parts)))
        except PolicyDenied as exc:
            return refusal("read", exc)
        code = 0 if complete else 1
        return (
            None,
            IOResult(exit_code=code),
            ExecutionNode(command="read", exit_code=code),
        )
    # With no name the line goes to REPLY whole, its blanks kept.
    if exact is not None or not parse.operands:
        parts = [whole]
    else:
        parts = _read_fields(line, ifs, len(variables), raw)
    for i, var in enumerate(variables):
        if TARGET_RE.match(var) is None:
            # bash stops at the first name it cannot assign, the ones
            # before it assigned.
            return _invalid_name(var)
        refused = await _read_store(
            session,
            view,
            var,
            parts[i] if i < len(parts) else "",
            policies,
            subscripts,
        )
        if refused is not None:
            return refused
    code = 0 if complete else 1
    return (
        None,
        IOResult(exit_code=code),
        ExecutionNode(command="read", exit_code=code),
    )


async def read_builtin(call: BuiltinCall) -> Result:
    """The ``read`` arm.

    Args:
        call (BuiltinCall): the invocation.
    """
    return await handle_read(
        list(call.argv.args),
        call.context.session,
        call.stdin,
        session_view(
            call.context.session,
            call.namespace.registry.policies,
            diagnostics=call.context.frame.diagnostics,
        ),
        call.namespace.registry.policies,
        subscript_expansion(call),
    )
