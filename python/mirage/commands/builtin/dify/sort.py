from collections.abc import AsyncIterator
from functools import partial

from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.generic.sort import sort as generic_sort
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.dify.glob import resolve_glob
from mirage.core.dify.read import read_bytes
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


@command("sort", resource="dify", spec=SPECS["sort"])
async def sort(
    accessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    r: bool = False,
    n: bool = False,
    u: bool = False,
    f: bool = False,
    k: str | None = None,
    t: str | None = None,
    h: bool = False,
    V: bool = False,
    s: bool = False,
    M: bool = False,
    index: IndexCacheStore = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    if paths:
        paths = await resolve_glob(accessor, paths, index)
    else:
        paths = []
    return await generic_sort(
        paths,
        read_bytes=partial(read_bytes, index=index),
        accessor=accessor,
        stdin=stdin,
        reverse=r,
        numeric=n,
        unique=u,
        fold_case=f,
        key_field=int(k) if k is not None else None,
        field_separator=t,
        human_numeric=h,
        version_sort=V,
        month_sort=M,
    )
