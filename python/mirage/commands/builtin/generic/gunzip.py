from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass

from mirage.commands.builtin.constants import GZIP_SUFFIX
from mirage.commands.builtin.generic.decompress import decompress_inputs
from mirage.commands.builtin.utils.links import link_resolver
from mirage.commands.config import Context
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import FlagValue
from mirage.io.types import ByteSource, IOResult
from mirage.types import LineFacts, PathSpec, PolymorphicReadFn, StatFn


@dataclass(frozen=True, slots=True)
class GunzipFlags:
    keep: bool = False
    force: bool = False
    to_stdout: bool = False
    test_only: bool = False
    quiet: bool = False
    suffix: str = GZIP_SUFFIX


def parse_flags(flags: Mapping[str, FlagValue]) -> GunzipFlags:
    fl = FlagView(flags, spec=SPECS["gunzip"])
    suffix = fl.as_str("S")
    return GunzipFlags(
        keep=fl.as_bool("k"),
        force=fl.as_bool("f"),
        to_stdout=fl.as_bool("c"),
        test_only=fl.as_bool("t"),
        quiet=fl.as_bool("q"),
        suffix=GZIP_SUFFIX if suffix is None else suffix,
    )


async def gunzip_generic(
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
    read_bytes: PolymorphicReadFn,
    write_bytes: Callable[..., Awaitable[None]],
    unlink: Callable[..., Awaitable[None]],
    stat: StatFn | None = None,
) -> tuple[ByteSource | None, IOResult]:
    parsed = parse_flags(ctx.flags)
    return await decompress_inputs(
        paths,
        read=read_bytes,
        write=write_bytes,
        unlink=unlink,
        stat=stat,
        stdin=ctx.stdin,
        keep=parsed.keep,
        force=parsed.force,
        quiet=parsed.quiet,
        suffix=parsed.suffix,
        to_stdout=parsed.to_stdout,
        test_only=parsed.test_only,
        resolver=link_resolver(ctx),
    )


def facts(fl: FlagView, operands: Sequence[str | PathSpec]) -> LineFacts:
    """A gunzip line replaces its file operands unless ``-c`` or
    ``-t``.

    Args:
        fl (FlagView): spec-validated view over the raw flag kwargs.
        operands (Sequence[str | PathSpec]): the line's operands.
    """
    return LineFacts(
        writes=len(operands) > 0 and not (fl.as_bool("c") or fl.as_bool("t"))
    )
