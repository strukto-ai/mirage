from collections.abc import AsyncIterator
from functools import partial

from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.generic.cut import cut as generic_cut
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.dify.glob import resolve_glob
from mirage.core.dify.read import read_stream
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


@command("cut", resource="dify", spec=SPECS["cut"])
async def cut(
    accessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    f: str | None = None,
    d: str | None = None,
    c: str | None = None,
    complement: bool = False,
    z: bool = False,
    index: IndexCacheStore = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    if paths:
        paths = await resolve_glob(accessor, paths, index)
    return await generic_cut(paths,
                             read_stream=partial(read_stream, index=index),
                             accessor=accessor,
                             stdin=stdin,
                             f=f,
                             d=d,
                             c=c,
                             complement=complement,
                             z=z)
