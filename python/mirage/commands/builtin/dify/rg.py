from collections.abc import AsyncIterator
from functools import partial

from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.generic.rg import rg as generic_rg
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.dify.glob import resolve_glob
from mirage.core.dify.read import read_bytes, read_stream
from mirage.core.dify.readdir import readdir
from mirage.core.dify.stat import stat_light
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


@command("rg", resource="dify", spec=SPECS["rg"])
async def rg(
    accessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    i: bool = False,
    v: bool = False,
    n: bool = False,
    c: bool = False,
    args_l: bool = False,
    w: bool = False,
    F: bool = False,
    o: bool = False,
    m: str | None = None,
    A: str | None = None,
    B: str | None = None,
    C: str | None = None,
    hidden: bool = False,
    type: str | None = None,
    glob: str | None = None,
    index: IndexCacheStore = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    if not texts:
        raise ValueError("rg: usage: rg [flags] pattern [path]")
    if paths:
        paths = await resolve_glob(accessor, paths, index)
    context_after = int(A) if A is not None else 0
    context_before = int(B) if B is not None else 0
    if C is not None:
        context_before = context_after = int(C)
    return await generic_rg(
        paths,
        pattern=texts[0],
        readdir=readdir,
        stat=stat_light,
        read_bytes=read_bytes,
        read_stream=partial(read_stream, index=index),
        accessor=accessor,
        stdin=stdin,
        ignore_case=i,
        invert=v,
        line_numbers=n,
        count_only=c,
        files_only=args_l,
        whole_word=w,
        fixed_string=F,
        only_matching=o,
        max_count=int(m) if m is not None else None,
        context_before=context_before,
        context_after=context_after,
        hidden=hidden,
        file_type=type,
        glob_pattern=glob,
        index=index,
    )
