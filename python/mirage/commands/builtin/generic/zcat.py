from mirage.commands.builtin.generic.gzip import gzip_generic
from mirage.commands.config import Context
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec, PolymorphicReadFn, ReaddirFn, StatFn


async def zcat_generic(
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
    stat: StatFn,
    stream: PolymorphicReadFn,
    readdir: ReaddirFn | None = None,
) -> tuple[ByteSource | None, IOResult]:
    """Run zcat, which is ``gzip -cd``, over resolved operands; mirrors
    zcatGeneric.

    Args:
        paths (list[PathSpec]): Glob-resolved operands, empty for stdin.
        texts (list[str]): Non-path words, unused by zcat.
        ctx (Context): Flags and stdin from the dispatcher.
        stat (StatFn): Bound stat called as ``stat(path)``.
        stream (PolymorphicReadFn): Bound reader called as
            ``stream(path)``.
        readdir (ReaddirFn | None): the mount's readdir, for -r.
    """
    return await gzip_generic(
        paths,
        texts,
        ctx,
        stream,
        stat=stat,
        readdir=readdir,
        command="zcat",
    )


__all__ = ["zcat_generic"]
