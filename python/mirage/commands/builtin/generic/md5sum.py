import hashlib

from mirage.commands.builtin.generic.checksum import (
    StoredDigest,
    checksum_generic,
)
from mirage.commands.config import CommandOpts
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec, PolymorphicReadFn, StatFn


async def md5sum_generic(
    paths: list[PathSpec],
    texts: list[str],
    opts: CommandOpts,
    stat: StatFn,
    stream: PolymorphicReadFn,
    stored: StoredDigest | None = None,
) -> tuple[ByteSource | None, IOResult]:
    return await checksum_generic(
        paths,
        texts,
        opts,
        stat,
        stream,
        factory=hashlib.md5,
        algorithm="md5",
        name="md5sum",
        stored=stored,
    )


__all__ = ["md5sum_generic"]
