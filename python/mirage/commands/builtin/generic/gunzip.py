from collections.abc import Awaitable, Callable, Sequence

from mirage.commands.builtin.generic.decompress import SetAttrsFn
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


async def gunzip_generic(
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
    read_bytes: PolymorphicReadFn,
    write_bytes: Callable[..., Awaitable[None]],
    unlink: Callable[..., Awaitable[None]],
    stat: StatFn | None = None,
    readdir: ReaddirFn | None = None,
    set_attrs: SetAttrsFn | None = None,
) -> tuple[ByteSource | None, IOResult]:
    """Run gunzip, which is ``gzip -d``, over resolved operands.

    Args:
        paths (list[PathSpec]): Glob-resolved operands, empty for stdin.
        texts (list[str]): Non-path words, unused.
        ctx (Context): Flags and stdin from the dispatcher.
        read_bytes (PolymorphicReadFn): the mount's reader.
        write_bytes (Callable): the mount's write.
        unlink (Callable): the mount's unlink.
        stat (StatFn | None): the mount's stat.
        readdir (ReaddirFn | None): the mount's readdir, for -r.
        set_attrs (SetAttrsFn | None): sets an output's attributes.
    """
    return await gzip_generic(
        paths,
        texts,
        ctx,
        read_bytes,
        write_bytes,
        unlink,
        stat,
        readdir,
        set_attrs,
        command="gunzip",
    )


def facts(fl: FlagView, operands: Sequence[str | PathSpec]) -> LineFacts:
    """A gunzip line replaces its file operands unless ``-c``, ``-t`` or
    ``-l``.

    Args:
        fl (FlagView): spec-validated view over the raw flag kwargs.
        operands (Sequence[str | PathSpec]): the line's operands.
    """
    return LineFacts(
        writes=len(operands) > 0
        and not any(fl.as_bool(n) for n in ("stdout", "test", "list")),
        reads_subtree=fl.as_bool("recursive"),
    )
