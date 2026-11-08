from collections.abc import Sequence

from mirage.commands.builtin.generic.gzip import gzip_generic
from mirage.commands.config import Context
from mirage.commands.spec.flag_view import FlagView
from mirage.io.types import ByteSource, IOResult
from mirage.types import (
    LineFacts,
    PathSpec,
    PolymorphicReadFn,
    ReaddirFn,
    StatFn,
)


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


def facts(fl: FlagView, operands: Sequence[str | PathSpec]) -> LineFacts:
    """A zcat line reads below its operands under ``-r``.

    Args:
        fl (FlagView): spec-validated view over the raw flag kwargs.
        operands (Sequence[str | PathSpec]): the line's operands.
    """
    return LineFacts(reads_subtree=fl.as_bool("recursive"))


__all__ = ["facts", "zcat_generic"]
