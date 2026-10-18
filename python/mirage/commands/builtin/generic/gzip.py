import zlib
from collections.abc import AsyncIterator, Awaitable, Callable, Mapping
from dataclasses import dataclass
from functools import partial

from mirage.commands.builtin.constants import GZIP_SUFFIX
from mirage.commands.builtin.generic.decompress import (
    beside_link,
    decompress_inputs,
    exists_line,
    gzip_suffix,
    open_gzip_input,
    output_taken,
    remove_input,
    replace_output,
    suffix_refusal,
)
from mirage.commands.builtin.utils.links import LinkResolver, link_resolver
from mirage.commands.builtin.utils.operands import normalized_read
from mirage.commands.builtin.utils.output import format_records
from mirage.commands.builtin.utils.stream import (
    resolve_source,
    stdin_stream,
)
from mirage.commands.config import Context
from mirage.commands.spec import SPECS
from mirage.commands.spec.constants import flag_kwarg_name
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import FlagValue
from mirage.errors.constants import FS_ERRORS
from mirage.errors.fs import fs_strerror
from mirage.io.spool import ByteSpool
from mirage.io.stream import OutputStream, close_quietly, drain
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec, PolymorphicReadFn, StatFn
from mirage.utils.compress import gzip_compress_stream
from mirage.utils.key_prefix import mounted_path
from mirage.utils.path import gnu_basename


def extract_level(fl: FlagView) -> int:
    """The compression level -1..-9 asked for, or zlib's default.

    The digits are short-only options, so each is its own dest -- except
    ``-1``, which the parser disambiguates to ``args_1``
    (``AMBIGUOUS_NAMES``). GNU's option loop keeps the last digit typed,
    so ``gzip -9 -1`` compresses at level 1.

    Args:
        fl (FlagView): Flag view constructed with the gzip spec.
    """
    names = {flag_kwarg_name(str(n)): n for n in range(1, 10)}
    typed = [name for name in fl.typed_order(*names) if fl.as_bool(name)]
    return names[typed[-1]] if typed else zlib.Z_DEFAULT_COMPRESSION


async def gzip(
    paths: list[PathSpec],
    *,
    read_bytes: PolymorphicReadFn,
    write_bytes: Callable[..., Awaitable[None]],
    unlink: Callable[..., Awaitable[None]],
    stat: StatFn | None = None,
    stdin: ByteSource | None = None,
    decompress: bool = False,
    keep: bool = False,
    force: bool = False,
    to_stdout: bool = False,
    quiet: bool = False,
    suffix: str = GZIP_SUFFIX,
    level: int = zlib.Z_DEFAULT_COMPRESSION,
    resolver: LinkResolver | None = None,
) -> tuple[ByteSource | None, IOResult]:
    refused = suffix_refusal(suffix)
    if refused is not None:
        return None, refused
    if decompress:
        return await decompress_inputs(
            paths,
            read=read_bytes,
            write=write_bytes,
            unlink=unlink,
            stat=stat,
            stdin=stdin,
            keep=keep,
            force=force,
            quiet=quiet,
            suffix=suffix,
            to_stdout=to_stdout,
            resolver=resolver,
        )
    if not paths:
        return gzip_compress_stream(
            resolve_source(stdin), level=level
        ), IOResult()
    source = normalized_read(read_bytes)
    piped = stdin_stream(source, stdin)
    io = IOResult()
    lines: list[str] = []

    def report(line: str, code: int, warning: bool = False) -> None:
        if not (warning and quiet):
            lines.append(line.rstrip("\n"))
            io.stderr = format_records(lines)
        if io.exit_code != 1:
            io.exit_code = code

    async def run() -> AsyncIterator[bytes]:
        for p in paths:
            in_place = not (to_stdout or p.raw_path == "-")
            opened = (
                None
                if p.raw_path == "-"
                else await open_gzip_input(
                    p,
                    source if in_place else piped,
                    report,
                    suffix=suffix,
                    decompress=False,
                    follow=to_stdout or force,
                    resolver=resolver,
                )
            )
            if opened is None and p.raw_path != "-":
                continue
            input_source = piped(p) if opened is None else opened.stream
            link = None if opened is None else opened.link
            try:
                known = gzip_suffix(p.raw_path, suffix) if in_place else None
                if known is not None and not force:
                    report(
                        f"gzip: {p.raw_path} already has {known} suffix -- unchanged",
                        io.exit_code,
                        True,
                    )
                    continue
                compressed = gzip_compress_stream(
                    input_source,
                    level=level,
                    name="" if p.raw_path == "-" else gnu_basename(p.raw_path),
                )
                if not in_place:
                    try:
                        async for chunk in compressed:
                            yield chunk
                    except FS_ERRORS as exc:
                        report(f"\ngzip: {p.raw_path}: {fs_strerror(exc)}", 1)
                        return
                    continue
                async with ByteSpool() as spool:
                    try:
                        await spool.fill(compressed)
                    except FS_ERRORS as exc:
                        report(f"\ngzip: {p.raw_path}: {fs_strerror(exc)}", 1)
                        return
                    out = (
                        mounted_path(p, p.mount_path + suffix)
                        if link is None
                        else beside_link(link, p.raw_path + suffix)
                    )
                    existed = await output_taken(out, stat, resolver)
                    if existed and not force:
                        report(exists_line(p.raw_path + suffix), 2)
                        continue
                    try:
                        await replace_output(
                            out,
                            spool.stream(),
                            write_bytes,
                            resolver,
                            link is not None,
                        )
                    except FS_ERRORS as exc:
                        report(
                            ("" if existed else "\n")
                            + f"gzip: {p.raw_path}{suffix}: {fs_strerror(exc)}",
                            1,
                        )
                        if existed:
                            continue
                        return
                if not keep:
                    await remove_input(p, link, unlink, resolver)
            finally:
                await close_quietly(input_source)

    body = OutputStream(run(), partial(close_quietly, stdin))
    if not to_stdout and all(p.raw_path != "-" for p in paths):
        await drain(body)
        return None, io
    return body, io


__all__ = ["gzip", "extract_level"]


@dataclass(frozen=True, slots=True)
class GzipFlags:
    decompress: bool = False
    keep: bool = False
    force: bool = False
    to_stdout: bool = False
    quiet: bool = False
    suffix: str = GZIP_SUFFIX
    level: int | None = None


def parse_flags(flags: Mapping[str, FlagValue]) -> GzipFlags:
    fl = FlagView(flags, spec=SPECS["gzip"])
    suffix = fl.as_str("S")
    return GzipFlags(
        decompress=fl.as_bool("d"),
        keep=fl.as_bool("k"),
        force=fl.as_bool("f"),
        to_stdout=fl.as_bool("c"),
        quiet=fl.as_bool("q"),
        suffix=GZIP_SUFFIX if suffix is None else suffix,
        level=extract_level(fl),
    )


async def gzip_generic(
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
    read_bytes: PolymorphicReadFn,
    write_bytes: Callable[..., Awaitable[None]],
    unlink: Callable[..., Awaitable[None]],
    stat: StatFn | None = None,
) -> tuple[ByteSource | None, IOResult]:
    parsed = parse_flags(ctx.flags)
    return await gzip(
        paths,
        read_bytes=read_bytes,
        write_bytes=write_bytes,
        unlink=unlink,
        stat=stat,
        stdin=ctx.stdin,
        decompress=parsed.decompress,
        keep=parsed.keep,
        force=parsed.force,
        to_stdout=parsed.to_stdout,
        quiet=parsed.quiet,
        suffix=parsed.suffix,
        level=(
            parsed.level
            if parsed.level is not None
            else zlib.Z_DEFAULT_COMPRESSION
        ),
        resolver=link_resolver(ctx),
    )
