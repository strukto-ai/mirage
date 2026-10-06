import zlib
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass

from mirage.commands.builtin.constants import GZIP_SUFFIX
from mirage.commands.builtin.generic.archive.walk import StatFn
from mirage.commands.builtin.generic.decompress import (
    beside_link,
    decompress_inputs,
    gzip_suffix,
    open_gzip_input,
    output_taken,
    replace_output,
    suffix_refusal,
)
from mirage.commands.builtin.utils.links import LinkDoor, link_door
from mirage.commands.builtin.utils.operands import normalized_read
from mirage.commands.builtin.utils.stream import (
    resolve_source,
    stdin_bytes,
    stdin_stream,
)
from mirage.commands.config import CommandOpts
from mirage.commands.spec import SPECS
from mirage.commands.spec.constants import flag_kwarg_name
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import FlagValue
from mirage.errors.constants import FS_ERRORS
from mirage.errors.fs import fs_strerror
from mirage.io.types import ByteSource, IOResult, materialize
from mirage.types import PathSpec
from mirage.utils.compress import gzip_compress, gzip_compress_stream
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
    read_bytes: Callable[..., Awaitable[bytes]],
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
    door: LinkDoor | None = None,
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
            door=door,
        )
    if not paths:
        return gzip_compress_stream(
            resolve_source(stdin), level=level
        ), IOResult()
    read = stdin_bytes(read_bytes, stdin)
    source = normalized_read(read_bytes)
    piped = stdin_stream(source, stdin)
    writes: dict[str, ByteSource] = {}
    stdout: list[bytes] = []
    lines: list[str] = []
    exit_code = 0

    def report(line: str, code: int, warning: bool = False) -> None:
        nonlocal exit_code
        if not (warning and quiet):
            lines.append(line.rstrip("\n"))
        if exit_code != 1:
            exit_code = code

    for p in paths:
        in_place = not (to_stdout or p.raw_path == "-")
        # An input gzip cannot open is reported and skipped, and the run
        # goes on to the next operand (a directory is a warning, exit 2,
        # silent under -q, and a link without -c or -f is ELOOP); so is
        # an input that already has a suffix, without -f and with no
        # exit code of its own, an output already there without -f, a
        # link standing there included, and a replace -f is refused. An
        # output it cannot create is fatal: gzip's write_error leads
        # with a newline and exits, leaving later operands untouched.
        # Pinned against gzip 1.13 (debian:stable-slim).
        link: str | None = None
        if p.raw_path == "-":
            try:
                raw = await read(p)
            except FS_ERRORS as exc:
                report(f"gzip: {p.raw_path}: {fs_strerror(exc)}", 1)
                continue
        else:
            opened = await open_gzip_input(
                p,
                source if in_place else piped,
                report,
                suffix=suffix,
                decompress=False,
                follow=to_stdout or force,
                door=door,
            )
            if opened is None:
                continue
            known = gzip_suffix(p.raw_path, suffix) if in_place else None
            if known is not None and not force:
                if not quiet:
                    lines.append(
                        f"gzip: {p.raw_path} already has {known} "
                        "suffix -- unchanged"
                    )
                continue
            try:
                raw = await materialize(opened.stream)
            except FS_ERRORS as exc:
                report(f"\ngzip: {p.raw_path}: {fs_strerror(exc)}", 1)
                break
            link = opened.link
        data = gzip_compress(
            raw,
            level=level,
            name="" if p.raw_path == "-" else gnu_basename(p.raw_path),
        )
        if not in_place:
            stdout.append(data)
            continue
        out_path = p.mount_path + suffix
        out = (
            mounted_path(p, out_path)
            if link is None
            else beside_link(link, p.raw_path + suffix)
        )
        existed = await output_taken(out, stat, door)
        if existed and not force:
            lines.append(
                f"gzip: {p.raw_path}{suffix} already exists;\tnot overwritten"
            )
            exit_code = exit_code or 2
            continue
        try:
            await replace_output(
                out, data, write_bytes, door, link is not None
            )
        except FS_ERRORS as exc:
            lines.append(
                ("" if existed else "\n")
                + f"gzip: {p.raw_path}{suffix}: {fs_strerror(exc)}"
            )
            exit_code = 1
            if existed:
                continue
            break
        if link is None:
            writes[out_path] = data
        if not keep:
            await (
                unlink(p)
                if link is None or door is None
                else door.unlink(link)
            )
    stderr = ("\n".join(lines) + "\n").encode() if lines else None
    return b"".join(stdout) or None, IOResult(
        writes=writes, stderr=stderr, exit_code=exit_code
    )


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
    opts: CommandOpts,
    read_bytes: Callable[..., Awaitable[bytes]],
    write_bytes: Callable[..., Awaitable[None]],
    unlink: Callable[..., Awaitable[None]],
    stat: StatFn | None = None,
) -> tuple[ByteSource | None, IOResult]:
    parsed = parse_flags(opts.flags)
    return await gzip(
        paths,
        read_bytes=read_bytes,
        write_bytes=write_bytes,
        unlink=unlink,
        stat=stat,
        stdin=opts.stdin,
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
        door=link_door(opts),
    )
