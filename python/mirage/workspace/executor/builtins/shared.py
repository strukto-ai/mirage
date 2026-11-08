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

from collections.abc import Sequence
from functools import partial

from mirage.commands.builtin.utils.operands import at_offsets
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.synopsis import SHELL_SYNOPSES
from mirage.errors.types import GlobLimitError
from mirage.io import IOResult
from mirage.policy import PolicyDenied
from mirage.runtime.types import DispatchFn
from mirage.shell.bytes import decode_text, encode_text
from mirage.shell.errors import TooManyMatches
from mirage.shell.voice import shell_voice
from mirage.types import PathSpec
from mirage.utils.path import resolve_path
from mirage.view.types import SessionView
from mirage.workspace.executor.builtins.constants import (
    COUNT_WORD_RE,
    IDENTIFIER_RE,
)
from mirage.workspace.executor.builtins.types import BuiltinCall, Result
from mirage.workspace.executor.command.flags import option_error, parse_flags
from mirage.workspace.executor.command.types import ParsedCommand
from mirage.workspace.expand.globs import expand_glob
from mirage.workspace.expand.node import expand_subscript
from mirage.workspace.expand.types import SubscriptFn
from mirage.workspace.mount.namespace import Namespace
from mirage.workspace.types import ExecutionNode


def result(
    cmd: str,
    out: bytes | None = None,
    exit_code: int = 0,
    stderr: str | None = None,
    io: IOResult | None = None,
) -> Result:
    """Build the (stream, IOResult, ExecutionNode) triple builtins return.

    Args:
        cmd (str): command name recorded on the ExecutionNode.
        out (bytes | None): stdout payload, if any.
        exit_code (int): exit code for both IOResult and ExecutionNode.
        stderr (str | None): error text; encoded onto both results.
        io (IOResult | None): prebuilt IOResult to reuse (e.g. carrying
            writes); its exit_code/stderr are overwritten.
    """
    err = encode_text(stderr) if stderr else b""
    io = io if io is not None else IOResult()
    io.exit_code = exit_code
    if err:
        io.stderr = err
    return out, io, ExecutionNode(command=cmd, exit_code=exit_code, stderr=err)


def written(
    cmd: str, pieces: Sequence[tuple[bool, str]], exit_code: int = 0
) -> Result:
    """``result`` for a builtin whose output and errors take turns:
    each error goes out where it was written among the output, as bash
    writes both as it goes (``declare -p a missing b 2>&1``).

    Args:
        cmd (str): command name recorded on the ExecutionNode.
        pieces (Sequence[tuple[bool, str]]): each piece of text in the
            order written, True for stderr.
        exit_code (int): exit code for both IOResult and ExecutionNode.
    """
    out: list[bytes] = []
    size = 0
    notes: list[tuple[int, bytes]] = []
    for failed, text in pieces:
        data = encode_text(text)
        if failed:
            notes.append((size, data))
        else:
            out.append(data)
            size += len(data)
    body = b"".join(out)
    err = b"".join(line for _, line in notes)
    node = ExecutionNode(command=cmd, exit_code=exit_code, stderr=err)
    if not body or not err:
        return (
            body or None,
            IOResult(exit_code=exit_code, stderr=err or None),
            node,
        )
    io = IOResult(exit_code=exit_code)
    return at_offsets(body, notes, io), io, node


def ok(cmd: str, out: bytes | None = None) -> Result:
    return result(cmd, out=out)


def fail(cmd: str, message: str, exit_code: int = 1) -> Result:
    return result(cmd, exit_code=exit_code, stderr=message)


def finish(cmd: str, errors: list[str], io: IOResult | None = None) -> Result:
    """Close an operand loop: exit 1 with joined stderr when any operand
    failed, exit 0 otherwise.

    Args:
        cmd (str): command name.
        errors (list[str]): per-operand error messages collected so far.
        io (IOResult | None): prebuilt IOResult to reuse (e.g. carrying
            writes).
    """
    if errors:
        return result(cmd, exit_code=1, stderr="".join(errors), io=io)
    return result(cmd, io=io)


def abs_path(arg: str | PathSpec, cwd: str) -> str:
    """A path operand as an absolute virtual path.

    Args:
        arg (str | PathSpec): a classified command part.
        cwd (str): session working directory for relative operands.
    """
    if isinstance(arg, PathSpec):
        return arg.virtual
    return resolve_path(arg, cwd)


def parse_line(
    cmd: str, args: list[str | PathSpec], cwd: str
) -> tuple[ParsedCommand, FlagView, Result | None]:
    """Parse a builtin's words with its spec, the way getopt_long does.

    Options may follow operands until ``--``, long options take their
    unique abbreviations, and a bad one is refused in GNU's words with
    the ``Try`` line. The operands keep the PathSpecs the classifier made.

    Args:
        cmd (str): the builtin's name.
        args (list[str | PathSpec]): the classified words after the name.
        cwd (str): the session working directory.
    """
    spec = SPECS[cmd]
    parsed = parse_flags(args, spec, cmd, cwd)
    refused = option_error(cmd, parsed)
    if refused is not None:
        message, code = refused
        return (
            parsed,
            FlagView({}, spec=spec),
            fail(cmd, decode_text(message), code),
        )
    return parsed, FlagView(parsed.flag_kwargs, spec=spec), None


async def expand_operands(
    namespace: Namespace,
    dispatch: DispatchFn,
    operands: Sequence[str | PathSpec],
) -> list[PathSpec]:
    """Coerce operands to PathSpec and expand glob patterns per mount,
    through the dispatcher's listings.

    Args:
        namespace (Namespace): addressing authority (mount lookup).
        dispatch (DispatchFn): op dispatcher the patterns list through.
        operands (Sequence[str | PathSpec]): positional operands.
    """
    out: list[PathSpec] = []
    for item in operands:
        spec = (
            item
            if isinstance(item, PathSpec)
            else PathSpec.from_str_path(str(item))
        )
        if spec.pattern:
            mount = namespace.mount_for(spec.virtual)
            try:
                out.extend(
                    await expand_glob(
                        dispatch, mount, [spec], mount.vfs.walk_limit
                    )
                )
            except GlobLimitError as exc:
                raise TooManyMatches(str(exc)) from exc
            continue
        out.append(spec)
    return out


def require_view(state: SessionView | None) -> SessionView:
    """The session view this builtin writes through.

    Every session write goes through the view the line threads; a write
    reached without one is a wiring bug, not a mode, so it raises.

    Args:
        state (SessionView | None): the caller's view, if threaded.

    Raises:
        RuntimeError: no view was threaded.
    """
    if state is None:
        raise RuntimeError(
            "builtin reached a session write without the workspace's gated "
            "session view; thread state= from the executor arm"
        )
    return state


def refusal(cmd: str, exc: PolicyDenied) -> Result:
    """Render a policy denial in the builtin's own voice.

    Args:
        cmd (str): builtin name for the node.
        exc (PolicyDenied): the gate's refusal.
    """
    err = encode_text(f"{exc.strerror}\n")
    return (
        None,
        IOResult(exit_code=1, stderr=err),
        ExecutionNode(command=cmd, exit_code=1, stderr=err),
    )


def readonly_line(cmd: str, name: str) -> str:
    """The shell's own readonly refusal line, checked before the session view.

    ``declare``, ``local`` and ``typeset`` name themselves in it
    (``bash: declare: R: readonly variable``); every other writer
    refuses in the assignment's voice (``bash: R: readonly variable``).

    Args:
        cmd (str): the writer's name.
        name (str): the frozen variable.
    """
    voice = f"{cmd}: " if cmd in ("declare", "local", "typeset") else ""
    return f"{shell_voice()}{voice}{name}: readonly variable"


def identifier_line(cmd: str, name: str) -> str:
    """A builtin's refusal of a word that names no variable
    (``bash: read: `1x': not a valid identifier``).

    Args:
        cmd (str): the builtin's name.
        name (str): the word as given.
    """
    return f"{shell_voice()}{cmd}: `{name}': not a valid identifier"


def denied_line(name: str) -> str:
    """The refusal of a write to a name the session hides, in the
    assignment's voice (``bash: SECRET: permission denied``).

    Args:
        name (str): the hidden variable.
    """
    return f"{shell_voice()}{name}: permission denied"


def readonly_refusal(cmd: str, name: str) -> Result:
    """Render the readonly refusal (``readonly_line``) as the result.

    Args:
        cmd (str): builtin name for the node.
        name (str): the frozen variable.
    """
    err = encode_text(readonly_line(cmd, name) + "\n")
    return (
        None,
        IOResult(exit_code=1, stderr=err),
        ExecutionNode(command=cmd, exit_code=1, stderr=err),
    )


def record_delimiter(text: str | None) -> bytes:
    """The byte ``read -d`` and ``mapfile -d`` stop at.

    Bash takes the first byte of the argument, not its first character
    (bash 5.2: ``-d é`` stops at 0xc3, ``-d $'\\xff'`` at the raw byte);
    an empty argument is NUL and no ``-d`` is a newline.

    Args:
        text (str | None): the ``-d`` argument, or None when not given.
    """
    if text is None:
        return b"\n"
    return encode_text(text)[:1] or b"\0"


def count_operand(text: str) -> int | None:
    """A count option's value (``read -n``/``-N``, ``mapfile -n``/``-s``
    and the rest): a run of ASCII digits, else None.

    Args:
        text (str): the option's value as typed.
    """
    return int(text) if text.isascii() and text.isdigit() else None


def is_valid_name(name: str) -> bool:
    """Whether the word is a shell identifier.

    Args:
        name (str): the word to test.
    """
    return IDENTIFIER_RE.fullmatch(name) is not None


def is_count_word(word: str) -> bool:
    """Whether the word is a number as bash's builtins read one,
    which is what ``shift``, ``return``, ``exit``, ``break`` and
    ``continue`` accept: blanks around an optionally signed run of
    digits that fits in 64 bits.

    Args:
        word (str): the word to test.
    """
    if COUNT_WORD_RE.fullmatch(word) is None:
        return False
    # A 64-bit value has at most 19 digits past its leading zeros, which
    # also keeps a long run of them out of Python's int() digit limit.
    digits = word.strip().lstrip("+-").lstrip("0")
    if len(digits) > 19:
        return False
    value = int(digits or "0")
    return value <= 2**63 if "-" in word else value < 2**63


def status_of(word: str) -> int:
    """A count word's value modulo 256, the status bash keeps of it.

    Args:
        word (str): a word ``is_count_word`` accepted.
    """
    value = int(word.strip().lstrip("+-").lstrip("0") or "0")
    return (-value if "-" in word else value) % 256


def builtin_error(name: str, message: str) -> bytes:
    """A shell builtin's diagnostic in bash's voice.

    Args:
        name (str): the builtin.
        message (str): what went wrong, without the newline.
    """
    return encode_text(f"{shell_voice()}{name}: {message}\n")


def builtin_usage(name: str) -> str:
    """A builtin's usage line, which bash prints after refusing one of
    its options: the synopsis `help NAME` opens with.

    Args:
        name (str): the builtin, as it was called.
    """
    return f"{name}: usage: {SHELL_SYNOPSES[name]}\n"


def numeric_operands(args: list[str]) -> list[str]:
    """The words a numeric builtin reads: a leading ``--`` ends its
    options, and bash skips it before it reads the number.

    Args:
        args (list[str]): words after the builtin name.
    """
    return args[1:] if args[:1] == ["--"] else args


def subscript_expansion(call: BuiltinCall) -> SubscriptFn:
    """How the call's builtin expands a subscript it was given as text
    (``unset 'a[$i]'``), in the call's session and frame.

    Args:
        call (BuiltinCall): the invocation.
    """
    return partial(
        expand_subscript,
        context=call.context,
        execute_fn=call.execute_fn,
        call_stack=call.call_stack,
    )
