from mirage.commands.builtin.generic.checksum import (
    StoredDigest,
    hash_operands,
)
from mirage.commands.builtin.utils.constants import STDIN_OPERAND
from mirage.commands.builtin.utils.operands import (
    normalized_read,
    split_in_order,
)
from mirage.commands.builtin.utils.stream import stdin_stream
from mirage.commands.config import Context
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec, PolymorphicReadFn, StatFn


def _md5_line(digest: str, label: str) -> bytes:
    return f"{digest}  {label}\n".encode()


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
    order = await split_in_order(paths, stat, "md5")
    if order and all(isinstance(p, bytes) for p in order):
        return None, IOResult(
            exit_code=1,
            stderr=b"".join(p for p in order if isinstance(p, bytes)),
        )
    return await hash_operands(
        order or [STDIN_OPERAND],
        normalized_read(stream) if order else stdin_stream(stream, ctx.stdin),
        "md5",
        "md5",
        _md5_line,
        stored,
    )
