from functools import partial

from mirage.commands.builtin.generic.crossmount.types import CrossResult
from mirage.commands.builtin.generic.crossmount.utils import (
    flat_scopes,
    read_file,
)
from mirage.commands.builtin.generic.sed import sed_generic
from mirage.commands.config import CommandOpts
from mirage.commands.spec.types import FlagValue
from mirage.io.types import ByteSource, IOResult
from mirage.runtime.types import DispatchFn
from mirage.types import PathSpec


async def _resolved(paths: list[PathSpec]) -> list[PathSpec]:
    return paths


async def run_sed(
    scopes: list[PathSpec],
    texts: list[str],
    flags: dict[str, FlagValue],
    dispatch: DispatchFn,
    stdin: ByteSource | None,
    cwd: str,
    argv: tuple[str, ...],
    env: dict[str, str] | None = None,
) -> CrossResult:
    """Keep one sed machine and each operand's identity across mounts.

    GNU sed 4.9 keeps filenames and file boundaries for F and -s, and
    shares its output files and quit state even under -i. The executor
    already expanded the operands; every read and write uses their
    owning mount's dispatcher door.

    Args:
        scopes (list[PathSpec]): Expanded operands, in order.
        texts (list[str]): Script text, unless flags supplied it.
        flags (dict[str, FlagValue]): Parsed options.
        dispatch (DispatchFn): Workspace operation dispatcher.
        stdin (ByteSource | None): Shared standard input cursor.
        cwd (str): Directory for filenames in the script.
        argv (tuple[str, ...]): Original argument spellings for diagnostics.
        env (dict[str, str] | None): The session's environment, whose
            locale decides bytes or characters.
    """
    reads = IOResult()

    async def write(path: PathSpec, data: bytes) -> None:
        await dispatch("write", path, data=data)
        reads.reads.pop(path.virtual, None)

    body, io = await sed_generic(
        flat_scopes(scopes),
        texts,
        CommandOpts(
            flags=flags,
            stdin=stdin,
            cwd=PathSpec.from_str_path(cwd),
            dispatch=dispatch,
            env=env,
            argv=argv,
        ),
        _resolved,
        partial(read_file, dispatch, reads),
        write,
    )
    merged = await reads.merge(io)
    # Every read went through the dispatcher, whose cold read keeps what
    # the file cache may hold; listing a read path again would keep a
    # filetype renderer's output there, which cat would then print. A
    # written path stays listed.
    merged.cache = [p for p in merged.cache if p not in merged.reads]
    return body, merged
