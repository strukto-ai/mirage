from collections.abc import AsyncIterator, Awaitable, Callable

from mirage.commands.builtin.constants import GZIP_SUFFIX
from mirage.commands.builtin.generic.decompress import decompress_inputs
from mirage.commands.builtin.utils.links import link_door
from mirage.commands.builtin.utils.operands import normalized_read
from mirage.commands.config import CommandOpts
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.errors.fs import eisdir
from mirage.io.types import ByteSource, IOResult
from mirage.types import FileType, PathSpec, PolymorphicReadFn, StatFn


async def zcat(
    paths: list[PathSpec],
    *,
    read_bytes: Callable[..., Awaitable[bytes]],
    stdin: ByteSource | None = None,
) -> tuple[ByteSource | None, IOResult]:
    return await decompress_inputs(
        paths, read=read_bytes, stdin=stdin, to_stdout=True
    )


async def zcat_generic(
    paths: list[PathSpec],
    texts: list[str],
    opts: CommandOpts,
    stat: StatFn,
    stream: PolymorphicReadFn,
) -> tuple[ByteSource | None, IOResult]:
    """Run zcat over resolved operands; mirrors zcatGeneric.

    zcat is ``gzip -cd``, so -f copies input that is not gzip, -q drops
    the warnings, and -S names the suffix a missing name is retried with.

    Args:
        paths (list[PathSpec]): Glob-resolved operands, empty for stdin.
        texts (list[str]): Non-path words, unused by zcat.
        opts (CommandOpts): Flags and stdin from the dispatcher.
        stat (StatFn): Bound stat called as ``stat(path)``.
        stream (PolymorphicReadFn): Bound reader called as
            ``stream(path)``.
    """
    fl = FlagView(opts.flags, spec=SPECS["zcat"])
    suffix = fl.as_str("S")
    read_stream = normalized_read(stream)

    async def read(path: PathSpec) -> AsyncIterator[bytes]:
        if (await stat(path)).type is FileType.DIRECTORY:
            raise eisdir(path.virtual)
        async for chunk in read_stream(path):
            yield chunk

    return await decompress_inputs(
        paths,
        read=read,
        stdin=opts.stdin,
        to_stdout=True,
        force=fl.as_bool("f"),
        quiet=fl.as_bool("q"),
        suffix=GZIP_SUFFIX if suffix is None else suffix,
        door=link_door(opts),
    )


__all__ = ["zcat", "zcat_generic"]
