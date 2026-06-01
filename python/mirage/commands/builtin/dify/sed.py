from collections.abc import AsyncIterator
from functools import partial

from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.generic.sed import sed as generic_sed
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.dify.glob import resolve_glob
from mirage.core.dify.read import read_bytes
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def reject_write_bytes(accessor, path: str | PathSpec,
                             data: bytes) -> None:
    raise PermissionError("sed -i not supported on read-only Dify mount")


@command("sed", resource="dify", spec=SPECS["sed"])
async def sed(
    accessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    i: bool = False,
    e: bool = False,
    n: bool = False,
    E: bool = False,
    index: IndexCacheStore = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    if not texts:
        raise ValueError("sed: usage: sed EXPRESSION [path]")
    if i:
        raise PermissionError("sed -i not supported on read-only Dify mount")
    if paths:
        paths = await resolve_glob(accessor, paths, index)
    return await generic_sed(
        paths,
        texts[0],
        read_bytes=partial(read_bytes, index=index),
        write_bytes=reject_write_bytes,
        accessor=accessor,
        stdin=stdin,
        in_place=False,
        suppress=n,
    )
