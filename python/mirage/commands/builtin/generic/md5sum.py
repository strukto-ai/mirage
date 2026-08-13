import hashlib

from mirage.commands.builtin.generic.checksum import hashsum_generic
from mirage.commands.config import CommandOpts
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec, PolymorphicReadFn, StatFn


async def md5sum_generic(
    paths: list[PathSpec],
    texts: list[str],
    opts: CommandOpts,
    stat: StatFn,
    stream: PolymorphicReadFn,
) -> tuple[ByteSource | None, IOResult]:
    return await hashsum_generic(paths,
                                 texts,
                                 opts,
                                 stat,
                                 stream,
                                 factory=hashlib.md5,
                                 algorithm="md5",
                                 name="md5sum")


__all__ = ["md5sum_generic"]
