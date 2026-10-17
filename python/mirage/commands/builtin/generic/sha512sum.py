from mirage.commands.builtin.generic.checksum import (
    StoredDigest,
    checksum_generic,
)
from mirage.commands.config import Context
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec, PolymorphicReadFn, StatFn


async def sha512sum_generic(
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
    stat: StatFn,
    stream: PolymorphicReadFn,
    stored: StoredDigest | None = None,
) -> tuple[ByteSource | None, IOResult]:
    return await checksum_generic(
        paths,
        texts,
        ctx,
        stat,
        stream,
        name="sha512sum",
        stored=stored,
    )


__all__ = ["sha512sum_generic"]
