from collections.abc import AsyncIterator
from functools import partial

from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.generic.uniq import uniq as generic_uniq
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.dify.glob import resolve_glob
from mirage.core.dify.read import read_stream
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


@command("uniq", resource="dify", spec=SPECS["uniq"])
async def uniq(
    accessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    c: bool = False,
    d: bool = False,
    u: bool = False,
    f: str | None = None,
    s: str | None = None,
    i: bool = False,
    w: str | None = None,
    index: IndexCacheStore = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    if paths:
        paths = await resolve_glob(accessor, paths, index)
    else:
        paths = []
    return await generic_uniq(
        paths,
        read_stream=partial(read_stream, index=index),
        accessor=accessor,
        stdin=stdin,
        count=c,
        duplicates_only=d,
        unique_only=u,
        skip_fields=int(f) if f else 0,
        skip_chars=int(s) if s else 0,
        ignore_case=i,
        check_chars=int(w) if w else 0,
    )
