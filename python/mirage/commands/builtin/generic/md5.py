from mirage.commands.builtin.generic.checksum import (
    StoredDigest,
    hash_operands,
)
from mirage.commands.builtin.utils.constants import STDIN_OPERAND
from mirage.commands.builtin.utils.operands import (
    merge_split_errors,
    normalized_read,
    split_readable,
)
from mirage.commands.builtin.utils.stream import stdin_stream
from mirage.commands.config import Context
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec, PolymorphicReadFn, StatFn


def _md5_line(digest: str, label: str) -> bytes:
    return f"{digest}  {label}\n".encode()


async def md5(
    paths: list[PathSpec],
    *,
    read_stream: PolymorphicReadFn,
    stdin: ByteSource | None = None,
    stored: StoredDigest | None = None,
) -> tuple[ByteSource | None, IOResult]:
    """BSD md5 over the operands, or stdin.

    Args:
        paths (list[PathSpec]): the operands.
        read_stream (PolymorphicReadFn): bound reader.
        stdin (ByteSource | None): the line's input.
        stored (StoredDigest | None): the mount's stored digest, asked
            before an operand is read.
    """
    return await hash_operands(
        paths or [STDIN_OPERAND],
        normalized_read(read_stream)
        if paths
        else stdin_stream(read_stream, stdin),
        "md5",
        "md5",
        _md5_line,
        stored,
    )


async def md5_generic(
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
    stat: StatFn,
    stream: PolymorphicReadFn,
    stored: StoredDigest | None = None,
) -> tuple[ByteSource | None, IOResult]:
    """Run BSD md5 over resolved operands; mirrors md5Generic.

    Args:
        paths (list[PathSpec]): Glob-resolved operands, empty for stdin.
        texts (list[str]): Non-path words, unused by md5.
        ctx (Context): Flags and stdin from the dispatcher.
        stat (StatFn): Bound stat called as ``stat(path)``.
        stream (PolymorphicReadFn): Bound reader called as
            ``stream(path)``.
        stored (StoredDigest | None): the mount's stored digest.
    """
    readable, err = await split_readable(paths, stat, "md5")
    if err and not readable:
        return None, IOResult(exit_code=1, stderr=err)
    return await merge_split_errors(
        await md5(
            readable,
            read_stream=stream,
            stdin=ctx.stdin,
            stored=stored,
        ),
        err,
    )


__all__ = ["md5", "md5_generic"]
