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
from mirage.types import PathSpec, word_text
from mirage.utils.path import resolve_path
from mirage.workspace.mount.namespace import Namespace
from mirage.workspace.types import ExecutionNode

Result = tuple[ByteSource | None, IOResult, ExecutionNode]


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
            expanded = await mount.resource.resolve_glob(
                [spec], mount.prefix.rstrip("/"))
            out.extend(p for p in expanded if isinstance(p, PathSpec))
            continue
        out.append(spec)
    return out
