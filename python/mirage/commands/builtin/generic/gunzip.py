from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass

from mirage.commands.builtin.generic.decompress import decompress_inputs
from mirage.commands.config import CommandOpts
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import FlagValue
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def gunzip(
    paths: list[PathSpec],
    *,
    read_bytes: Callable[..., Awaitable[bytes]],
    write_bytes: Callable[..., Awaitable[None]],
    unlink: Callable[..., Awaitable[None]],
    stdin: ByteSource | None = None,
    keep: bool = False,
    force: bool = False,
    to_stdout: bool = False,
    test_only: bool = False,
) -> tuple[ByteSource | None, IOResult]:
    return await decompress_inputs(paths,
                                   command="gunzip",
                                   read=read_bytes,
                                   write=write_bytes,
                                   unlink=unlink,
                                   stdin=stdin,
                                   keep=keep,
                                   to_stdout=to_stdout,
                                   test_only=test_only)


__all__ = ["gunzip"]


@dataclass(frozen=True, slots=True)
class GunzipFlags:
    keep: bool = False
    force: bool = False
    to_stdout: bool = False
    test_only: bool = False


def parse_flags(flags: Mapping[str, FlagValue]) -> GunzipFlags:
    fl = FlagView(flags, spec=SPECS["gunzip"])
    return GunzipFlags(
        keep=fl.as_bool("k"),
        force=fl.as_bool("f"),
        to_stdout=fl.as_bool("c"),
        test_only=fl.as_bool("t"),
    )


async def gunzip_generic(
    paths: list[PathSpec],
    texts: list[str],
    opts: CommandOpts,
    read_bytes: Callable[..., Awaitable[bytes]],
    write_bytes: Callable[..., Awaitable[None]],
    unlink: Callable[..., Awaitable[None]],
) -> tuple[ByteSource | None, IOResult]:
    parsed = parse_flags(opts.flags)
    return await gunzip(paths,
                        read_bytes=read_bytes,
                        write_bytes=write_bytes,
                        unlink=unlink,
                        stdin=opts.stdin,
                        keep=parsed.keep,
                        force=parsed.force,
                        to_stdout=parsed.to_stdout,
                        test_only=parsed.test_only)
