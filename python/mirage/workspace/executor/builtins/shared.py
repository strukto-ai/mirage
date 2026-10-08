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

from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.doors.types import SessionView
from mirage.io import IOResult
from mirage.policy import PolicyDenied
from mirage.shell.bytes import decode_text, encode_text
from mirage.shell.errors import ArithError
from mirage.types import PathSpec, word_text
from mirage.utils.path import resolve_path
from mirage.workspace.executor.builtins.constants import (
    COUNT_WORD_RE,
    IDENTIFIER_RE,
)
from mirage.workspace.executor.builtins.types import Result
from mirage.workspace.executor.command.flags import option_error, parse_flags
from mirage.workspace.executor.command.types import ParsedCommand
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


def operand_text(arg: str | PathSpec) -> str:
    """A non-path operand's text (a mode or owner spec the classifier may
    have wrapped as a path).

    Args:
        arg (str | PathSpec): a classified command part.
    """
    return arg.virtual if isinstance(arg, PathSpec) else str(arg)


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


def split_value_flags(
    args: list[str | PathSpec],
    boolean: str,
    valued: str,
) -> tuple[set[str], dict[str, str], list[str | PathSpec], str | None]:
    """Split leading flags where some take a value (``-t STAMP``),
    strictly: an unknown letter is reported instead of tolerated.

    Args:
        args (list[str | PathSpec]): args after the command name.
        boolean (str): single-letter flags with no value.
        valued (str): single-letter flags that consume the next arg.

    Returns:
        tuple: (bool flags, valued flags, operands, bad option or None).
    """
    flags: set[str] = set()
    values: dict[str, str] = {}
    operands: list[str | PathSpec] = []
    parsing = True
    i = 0
    while i < len(args):
        arg = args[i]
        s = operand_text(arg)
        if parsing and s == "--":
            parsing = False
            i += 1
            continue
        if (
            parsing
            and s != "-"
            and len(s) >= 2
            and s.startswith("-")
            and not s.startswith("--")
        ):
            body = s[1:]
            for j, c in enumerate(body):
                if c in boolean:
                    flags.add(c)
                    continue
                if c not in valued:
                    return flags, values, operands, c
                # A valued flag consumes the rest of the token (-tSTAMP)
                # or the next argument (-t STAMP).
                rest = body[j + 1 :]
                if rest:
                    values[c] = rest
                elif i + 1 < len(args):
                    i += 1
                    values[c] = word_text(args[i])
                break
            i += 1
            continue
        parsing = False
        operands.append(arg)
        i += 1
    return flags, values, operands, None


async def expand_operands(
    namespace: Namespace,
    operands: Sequence[str | PathSpec],
) -> list[PathSpec]:
    """Coerce operands to PathSpec and expand glob patterns per mount.

    Args:
        namespace (Namespace): addressing authority (mount lookup).
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
            expanded = await mount.expand_glob(
                [spec], mount.prefix.rstrip("/")
            )
            out.extend(p for p in expanded if isinstance(p, PathSpec))
            continue
        out.append(spec)
    return out


def require_view(state: SessionView | None) -> SessionView:
    """The gated session view this builtin writes through.

    Every session write goes through the workspace's gated view, which
    is what makes ``pre_session`` rules enforceable; this used to fall
    back to an ungated view over the same session, so a caller that
    forgot to thread one silently wrote past every policy. A write
    reached without a view is a wiring bug, not a mode, so it raises.

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
    """The shell's own readonly refusal line, checked before the door.

    ``declare``, ``local`` and ``typeset`` name themselves in it
    (``bash: declare: R: readonly variable``); every other writer
    refuses in the assignment's voice (``bash: R: readonly variable``).

    Args:
        cmd (str): the writer's name.
        name (str): the frozen variable.
    """
    voice = f"{cmd}: " if cmd in ("declare", "local", "typeset") else ""
    return f"bash: {voice}{name}: readonly variable"


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


def arith_refusal(cmd: str, exc: ArithError) -> Result:
    """Render the ``-i`` coercion's arithmetic error as bash does.

    GNU voices it as the evaluator's own line, prefixed by the builtin
    and the offending text (``bash: read: 1+: syntax error: operand
    expected``), and fails the builtin with 1 while the variable keeps
    its old value, which is what the door's copy-then-store already
    guarantees. A plain assignment (``n=1+``) is fatal instead and is
    voiced by the executor without a builtin name.

    Args:
        cmd (str): builtin name for the node.
        exc (ArithError): the evaluator's refusal, text already led.
    """
    err = encode_text(f"bash: {cmd}: {exc}\n")
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
    return COUNT_WORD_RE.fullmatch(word) is not None and (
        -(2**63) <= int(word) < 2**63
    )


def status_of(word: str) -> int:
    """A count word's value modulo 256, the status bash keeps of it.

    Args:
        word (str): a word ``is_count_word`` accepted.
    """
    return int(word) % 256


def builtin_error(name: str, message: str) -> bytes:
    """A shell builtin's diagnostic in bash's voice.

    Args:
        name (str): the builtin.
        message (str): what went wrong, without the newline.
    """
    return encode_text(f"bash: {name}: {message}\n")


def numeric_operands(args: list[str]) -> list[str]:
    """The words a numeric builtin reads: a leading ``--`` ends its
    options, and bash skips it before it reads the number.

    Args:
        args (list[str]): words after the builtin name.
    """
    return args[1:] if args[:1] == ["--"] else args
