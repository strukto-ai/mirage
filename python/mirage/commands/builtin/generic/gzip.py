import zlib
from collections.abc import (
    AsyncIterator,
    Awaitable,
    Callable,
    Mapping,
    Sequence,
)
from dataclasses import dataclass
from functools import partial

from mirage.commands.builtin.constants import GZIP_SUFFIX
from mirage.commands.builtin.generic.decompress import (
    SetAttrsFn,
    ask_before_walks,
    beside_link,
    decompress_inputs,
    exists_line,
    gzip_ratio,
    gzip_suffix,
    input_info,
    keep_attributes,
    list_inputs,
    open_gzip_input,
    output_taken,
    remove_input,
    replace_output,
    suffix_refusal,
    verbose_line,
    walked,
)
from mirage.commands.builtin.utils.constants import STDIN_OPERAND
from mirage.commands.builtin.utils.links import (
    LinkResolver,
    dispatch_of,
    link_resolver,
)
from mirage.commands.builtin.utils.operands import normalized_read
from mirage.commands.builtin.utils.output import format_records
from mirage.commands.builtin.utils.stream import stdin_stream
from mirage.commands.config import Context
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import FlagValue
from mirage.errors.constants import FS_ERRORS
from mirage.errors.fs import fs_strerror
from mirage.io.spool import ByteSpool
from mirage.io.stream import OutputStream, close_quietly, drain
from mirage.io.types import ByteSource, IOResult
from mirage.runtime.types import DispatchFn
from mirage.types import (
    LineFacts,
    PathSpec,
    PolymorphicReadFn,
    ReaddirFn,
    StatFn,
)
from mirage.utils.compress import gzip_compress_stream
from mirage.utils.dates import iso_timestamp
from mirage.utils.path import gnu_basename

# The level each digit option asks for, keyed as the spec names it.
LEVELS = {"fast": 1, **{str(n): n for n in range(2, 9)}, "best": 9}
# The last date a gzip header's four bytes hold; zero means no date.
_LAST_STAMP = 0xFFFFFFFF
_UNDATED = "warning: file timestamp out of range for gzip format"


def extract_level(fl: FlagView) -> int:
    """The compression level -1..-9 asked for, or zlib's default.

    ``-1`` and ``-9`` are ``--fast`` and ``--best``, keyed by those
    names; the other digits are short-only and keyed by themselves. The
    reference's option loop keeps the last digit typed, so ``gzip -9
    -1`` compresses at level 1.

    Args:
        fl (FlagView): Flag view constructed with the gzip spec.
    """
    typed = [name for name in fl.typed_order(*LEVELS) if fl.as_bool(name)]
    return LEVELS[typed[-1]] if typed else zlib.Z_DEFAULT_COMPRESSION


def _last_of(fl: FlagView, *names: str) -> str | None:
    """Of a family where the last one typed wins, that one's key.

    Args:
        fl (FlagView): the line's flags.
        names (str): the family's flags.
    """
    typed = [name for name in fl.typed_order(*names) if fl.as_bool(name)]
    return typed[-1] if typed else None


async def _counted(
    source: AsyncIterator[bytes], count: list[int]
) -> AsyncIterator[bytes]:
    try:
        async for chunk in source:
            count[0] += len(chunk)
            yield chunk
    finally:
        await close_quietly(source)


async def gzip(
    paths: list[PathSpec],
    *,
    read_bytes: PolymorphicReadFn,
    write_bytes: Callable[..., Awaitable[None]] | None = None,
    unlink: Callable[..., Awaitable[None]] | None = None,
    stat: StatFn | None = None,
    readdir: ReaddirFn | None = None,
    set_attrs: SetAttrsFn | None = None,
    stdin: ByteSource | None = None,
    decompress: bool = False,
    keep: bool = False,
    force: bool = False,
    to_stdout: bool = False,
    quiet: bool = False,
    verbose: bool = False,
    test: bool = False,
    listing: bool = False,
    recursive: bool = False,
    named: bool | None = None,
    suffix: str = GZIP_SUFFIX,
    level: int = zlib.Z_DEFAULT_COMPRESSION,
    resolver: LinkResolver | None = None,
    dispatch: DispatchFn | None = None,
) -> tuple[ByteSource | None, IOResult]:
    """gzip, gunzip and zcat over resolved operands, stdin when none.

    -l lists and -t tests, both decompressing; -d decompresses. In
    compression each input stores its name and time unless -n, and an
    in-place output takes the input's mode and times; under -r a
    directory gives way to the files below it, where one already
    suffixed is passed over, said only under -v; -v says each input's
    ratio once done.

    Args:
        paths (list[PathSpec]): the operands.
        read_bytes (PolymorphicReadFn): the mount's reader.
        write_bytes (Callable | None): the mount's write, None for a
            line that only reads.
        unlink (Callable | None): the mount's unlink, likewise.
        stat (StatFn | None): the mount's stat.
        readdir (ReaddirFn | None): the mount's readdir, for -r.
        set_attrs (SetAttrsFn | None): sets an output's attributes.
        stdin (ByteSource | None): the line's standard input.
        decompress (bool): -d.
        keep (bool): -k.
        force (bool): -f.
        to_stdout (bool): -c.
        quiet (bool): -q.
        verbose (bool): -v.
        test (bool): -t.
        listing (bool): -l.
        recursive (bool): -r.
        named (bool | None): -N (True) or -n (False), the last typed.
        suffix (str): the -S suffix.
        level (int): the compression level.
        resolver (LinkResolver | None): the namespace's links.
        dispatch (DispatchFn | None): the command's dispatcher, which
            asks a mount before -r walks it.
    """
    refused = suffix_refusal(suffix)
    if refused is not None:
        return None, refused
    if recursive:
        await ask_before_walks(paths, stat, readdir, dispatch)
    if listing:
        return await list_inputs(
            paths,
            read=read_bytes,
            stdin=stdin,
            quiet=quiet,
            verbose=verbose,
            restore=named is True,
            recursive=recursive,
            suffix=suffix,
            stat=stat,
            readdir=readdir,
            resolver=resolver,
        )
    if decompress or test:
        return await decompress_inputs(
            paths,
            read=read_bytes,
            write=write_bytes,
            unlink=unlink,
            stat=stat,
            readdir=readdir,
            set_attrs=set_attrs,
            stdin=stdin,
            keep=keep,
            force=force,
            quiet=quiet,
            verbose=verbose,
            restore=named is True,
            recursive=recursive,
            suffix=suffix,
            to_stdout=to_stdout,
            test_only=test,
            resolver=resolver,
        )
    operands = paths or [STDIN_OPERAND]
    source = normalized_read(read_bytes)
    piped = stdin_stream(source, stdin)
    io = IOResult()
    lines: list[str] = []

    def note(line: str) -> None:
        lines.append(line.rstrip("\n"))
        io.stderr = format_records(lines)

    def report(line: str, code: int, warning: bool = False) -> None:
        if not (warning and quiet):
            note(line)
        if io.exit_code != 1:
            io.exit_code = code

    async def run() -> AsyncIterator[bytes]:
        async for p, found in walked(
            operands, report, recursive=recursive, stat=stat, readdir=readdir
        ):
            on_stdin = p.raw_path == "-"
            in_place = not (to_stdout or on_stdin)
            opened = (
                None
                if on_stdin
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
            if opened is None and not on_stdin:
                continue
            input_source = piped(p) if opened is None else opened.stream
            link = None if opened is None else opened.link
            try:
                known = gzip_suffix(p.raw_path, suffix) if in_place else None
                if known is not None and not force:
                    if verbose or not (recursive or quiet):
                        note(
                            f"gzip: {p.raw_path} already has {known} "
                            "suffix -- unchanged"
                        )
                    continue
                info = await input_info(stat, p, link, resolver)
                stamp = None if info is None else iso_timestamp(info.modified)
                seconds = (
                    None if stamp is None or named is False else int(stamp)
                )
                undated = seconds is not None and not (
                    0 < seconds <= _LAST_STAMP
                )
                started = f"{p.raw_path}:\t" if verbose and undated else ""
                warning = f"{started}gzip: {p.raw_path}: {_UNDATED}"
                name = (
                    ""
                    if on_stdin or named is False
                    else gnu_basename(p.raw_path)
                )
                read_in = [0]
                written = [0]
                compressed = _counted(
                    gzip_compress_stream(
                        _counted(input_source, read_in),
                        level=level,
                        name=name,
                        mtime=0 if seconds is None or undated else seconds,
                    ),
                    written,
                )
                header = 18 + (len(name.encode()) + 1 if name else 0)
                if not in_place:
                    if undated:
                        report(warning, 2, warning=True)
                    try:
                        async for chunk in compressed:
                            yield chunk
                    except FS_ERRORS as exc:
                        report(f"\ngzip: {p.raw_path}: {fs_strerror(exc)}", 1)
                        return
                    if verbose:
                        ratio = gzip_ratio(read_in[0], written[0], header)
                        note(
                            ratio
                            if on_stdin
                            else verbose_line(
                                p.raw_path, ratio, keep, "stdout"
                            ).removeprefix(started)
                        )
                    continue
                if write_bytes is None or unlink is None:
                    raise ValueError(
                        "in-place compression requires write and unlink"
                    )
                async with ByteSpool() as spool:
                    try:
                        await spool.fill(compressed)
                    except FS_ERRORS as exc:
                        report(f"\ngzip: {p.raw_path}: {fs_strerror(exc)}", 1)
                        return
                    out = (
                        PathSpec.from_str_path(
                            "/" + p.virtual.strip("/") + suffix
                        )
                        if link is None
                        else beside_link(link, p.raw_path + suffix)
                    )
                    existed = await output_taken(out, stat, resolver)
                    if existed and not force:
                        report(exists_line(p.raw_path + suffix), 2)
                        continue
                    if undated:
                        report(warning, 2, warning=True)
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
                await keep_attributes(set_attrs, out, info)
                if verbose:
                    ratio = gzip_ratio(read_in[0], written[0], header)
                    note(
                        verbose_line(
                            p.raw_path, ratio, keep, p.raw_path + suffix
                        ).removeprefix(started)
                    )
                if not keep:
                    await remove_input(p, link, unlink, resolver)
            finally:
                await close_quietly(input_source)

    body = OutputStream(run(), partial(close_quietly, stdin))
    if not to_stdout and all(p.raw_path != "-" for p in operands):
        await drain(body)
        return None, io
    return body, io


def facts(fl: FlagView, operands: Sequence[str | PathSpec]) -> LineFacts:
    """A gzip line replaces its file operands unless ``-c``, ``-t`` or
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


@dataclass(frozen=True, slots=True)
class GzipFlags:
    decompress: bool = False
    keep: bool = False
    force: bool = False
    to_stdout: bool = False
    quiet: bool = False
    verbose: bool = False
    test: bool = False
    listing: bool = False
    recursive: bool = False
    named: bool | None = None
    suffix: str = GZIP_SUFFIX
    level: int = zlib.Z_DEFAULT_COMPRESSION


def parse_flags(
    flags: Mapping[str, FlagValue], command: str = "gzip"
) -> GzipFlags:
    """gzip's options for ``command``: gunzip always decompresses and
    zcat also writes to stdout; -q and -v, and -n and -N, are each a
    pair where the last one typed wins.

    Args:
        flags (Mapping[str, FlagValue]): the line's flags.
        command (str): ``gzip``, ``gunzip`` or ``zcat``.
    """
    fl = FlagView(flags, spec=SPECS[command])
    suffix = fl.as_str("suffix")
    loud = _last_of(fl, "quiet", "verbose")
    name = _last_of(fl, "no_name", "name")
    return GzipFlags(
        decompress=command != "gzip" or fl.as_bool("decompress"),
        keep=fl.as_bool("keep"),
        force=fl.as_bool("force"),
        to_stdout=command == "zcat" or fl.as_bool("stdout"),
        quiet=loud == "quiet",
        verbose=loud == "verbose",
        test=fl.as_bool("test"),
        listing=fl.as_bool("list"),
        recursive=fl.as_bool("recursive"),
        named=None if name is None else name == "name",
        suffix=GZIP_SUFFIX if suffix is None else suffix,
        level=extract_level(fl),
    )


async def gzip_generic(
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
    read_bytes: PolymorphicReadFn,
    write_bytes: Callable[..., Awaitable[None]] | None = None,
    unlink: Callable[..., Awaitable[None]] | None = None,
    stat: StatFn | None = None,
    readdir: ReaddirFn | None = None,
    set_attrs: SetAttrsFn | None = None,
    command: str = "gzip",
) -> tuple[ByteSource | None, IOResult]:
    """Run gzip, gunzip or zcat over resolved operands.

    Args:
        paths (list[PathSpec]): Glob-resolved operands, empty for stdin.
        texts (list[str]): Non-path words, unused.
        ctx (Context): Flags and stdin from the dispatcher.
        read_bytes (PolymorphicReadFn): the mount's reader.
        write_bytes (Callable | None): the mount's write, None for zcat.
        unlink (Callable | None): the mount's unlink, None for zcat.
        stat (StatFn | None): the mount's stat.
        readdir (ReaddirFn | None): the mount's readdir, for -r.
        set_attrs (SetAttrsFn | None): sets an output's attributes.
        command (str): ``gzip``, ``gunzip`` or ``zcat``.
    """
    parsed = parse_flags(ctx.flags, command)
    return await gzip(
        paths,
        read_bytes=read_bytes,
        write_bytes=write_bytes,
        unlink=unlink,
        stat=stat,
        readdir=readdir,
        set_attrs=set_attrs,
        stdin=ctx.stdin,
        decompress=parsed.decompress,
        keep=parsed.keep,
        force=parsed.force,
        to_stdout=parsed.to_stdout,
        quiet=parsed.quiet,
        verbose=parsed.verbose,
        test=parsed.test,
        listing=parsed.listing,
        recursive=parsed.recursive,
        named=parsed.named,
        suffix=parsed.suffix,
        level=parsed.level,
        resolver=link_resolver(ctx),
        dispatch=dispatch_of(ctx),
    )


__all__ = ["extract_level", "facts", "gzip", "gzip_generic", "parse_flags"]
