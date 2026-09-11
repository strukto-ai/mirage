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
from mirage.ops.types import SessionView
from mirage.policy import PolicyDenied
from mirage.shell.errors import ArithError
from mirage.types import PathSpec, word_text
from mirage.utils.path import resolve_path
from mirage.workspace.executor.builtins.constants import IDENTIFIER_RE
from mirage.workspace.executor.builtins.types import Result
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
    err = stderr.encode() if stderr else b""
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


def split_flags(
    args: list[str | PathSpec],
    known: str,
) -> tuple[set[str], list[str | PathSpec]]:
    """Split leading single-letter flags, permissively.

    A token containing any unknown letter is kept as an operand instead
    of erroring (``ln``/``readlink`` behavior).

    Args:
        args (list[str | PathSpec]): args after the command name.
        known (str): accepted single-letter flags.

    Returns:
        tuple: (flags, operands).
    """
    flags: set[str] = set()
    operands: list[str | PathSpec] = []
    parsing = True
    for arg in args:
        s = operand_text(arg)
        if parsing and s == "--":
            parsing = False
            continue
        if (parsing and s != "-" and len(s) >= 2 and s.startswith("-")
                and all(c in known for c in s[1:])):
            flags.update(s[1:])
            continue
        parsing = False
        operands.append(arg)
    return flags, operands


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
        if parsing and s != "-" and len(s) >= 2 and s.startswith(
                "-") and not s.startswith("--"):
            body = s[1:]
            for j, c in enumerate(body):
                if c in boolean:
                    flags.add(c)
                    continue
                if c not in valued:
                    return flags, values, operands, c
                # A valued flag consumes the rest of the token (-tSTAMP)
                # or the next argument (-t STAMP).
                rest = body[j + 1:]
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
    operands: list[str | PathSpec],
) -> list[PathSpec]:
    """Coerce operands to PathSpec and expand glob patterns per mount.

    Args:
        namespace (Namespace): addressing authority (mount lookup).
        operands (list[str | PathSpec]): positional operands.
    """
    out: list[PathSpec] = []
    for item in operands:
        spec = item if isinstance(item, PathSpec) else PathSpec.from_str_path(
            str(item))
        if spec.pattern:
            mount = namespace.mount_for(spec.virtual)
            expanded = await mount.expand_glob([spec],
                                               mount.prefix.rstrip("/"))
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
            "session view; thread state= from the executor arm")
    return state


def refusal(cmd: str, exc: PolicyDenied) -> Result:
    """Render a policy denial in the builtin's own voice.

    Args:
        cmd (str): builtin name for the node.
        exc (PolicyDenied): the gate's refusal.
    """
    err = f"{exc.strerror}\n".encode()
    return None, IOResult(exit_code=1, stderr=err), ExecutionNode(command=cmd,
                                                                  exit_code=1,
                                                                  stderr=err)


def read_only_error(cmd: str, namespace: Namespace, path: PathSpec) -> str:
    """Render the mirage read-only refusal, naming the mount.

    The voice ``Mount.execute_cmd`` uses when a command's own mount
    region is unwritable, so a refusal reached from anywhere else says
    the same thing: ``rm`` of a symlink is answered by the node table
    rather than the mount, and rendering it in GNU's per-operand voice
    made one read-only grant speak twice about the same mount.

    It names the mount, not the operand, so two refused operands on one
    mount produce one line and callers collecting several must drop the
    duplicates. A refusal keyed to a *path* rather than a mount region
    (a read-only rename destination on another mount) is not this
    message: those keep GNU's per-operand wording, as the backend path
    does.

    A path no mount owns (an attr overlay or link above every mount,
    gated on its ``/`` turf) has no prefix to blame, so the refusal
    keeps GNU's own phrase instead of naming a mount that is not there.

    Args:
        cmd (str): command name.
        namespace (Namespace): addressing authority (mount lookup).
        path (PathSpec): the refused path.
    """
    mount = namespace.try_mount_for(path.virtual)
    if mount is None:
        return f"{cmd}: {path.virtual}: Read-only file system\n"
    return f"{cmd}: read-only mount at {mount.prefix}\n"


def readonly_refusal(cmd: str, name: str) -> Result:
    """Render the shell's own readonly refusal, checked before the door.

    Args:
        cmd (str): builtin name for the node.
        name (str): the frozen variable.
    """
    err = f"bash: {name}: readonly variable\n".encode()
    return None, IOResult(exit_code=1, stderr=err), ExecutionNode(command=cmd,
                                                                  exit_code=1,
                                                                  stderr=err)


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
    err = f"bash: {cmd}: {exc}\n".encode()
    return None, IOResult(exit_code=1, stderr=err), ExecutionNode(command=cmd,
                                                                  exit_code=1,
                                                                  stderr=err)


def is_valid_name(name: str) -> bool:
    """Whether the word is a shell identifier.

    Args:
        name (str): the word to test.
    """
    return IDENTIFIER_RE.fullmatch(name) is not None


def is_count_word(word: str) -> bool:
    """Whether the word is an optionally signed run of digits, which is
    what ``shift``, ``return`` and ``exit`` accept as their argument.

    Args:
        word (str): the word to test.
    """
    body = word[1:] if word[:1] in ("-", "+") else word
    return body.isdigit()
