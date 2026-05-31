from collections.abc import AsyncIterator
from functools import partial

from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.generic.awk import awk as generic_awk
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.dify.glob import resolve_glob
from mirage.core.dify.read import read_bytes, read_stream
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


@command("awk", resource="dify", spec=SPECS["awk"])
async def awk(
    accessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    F: str | None = None,
    v: str | None = None,
    f: PathSpec | None = None,
    index: IndexCacheStore = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    if paths:
        paths = await resolve_glob(accessor, paths, index)
    return await generic_awk(
        paths,
        texts,
        read_bytes=partial(read_bytes, index=index),
        read_stream=partial(read_stream, index=index),
        accessor=accessor,
        stdin=stdin,
        field_separator=F,
        variable_assignment=v,
        program_file=f,
        index=index,
    )
