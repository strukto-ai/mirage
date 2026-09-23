from collections.abc import AsyncIterator, Awaitable, Callable, Sequence
from dataclasses import replace
from functools import partial

from mirage.cache.read_through import (cache_aware_bound_bytes,
                                       cache_aware_bound_stream)
from mirage.commands.builtin.constants import BINARY_EXTENSIONS
from mirage.commands.builtin.grep_binary import GrepFlags, grep_input
from mirage.commands.builtin.grep_pattern import (compile_pattern,
                                                  resolve_pattern)
from mirage.commands.builtin.grep_scan import exit_code_for
from mirage.commands.builtin.grep_select import (WalkFilters, dir_admitted,
                                                 file_admitted,
                                                 parse_file_globs)
from mirage.commands.builtin.utils.stream import (is_stdin, resolve_source,
                                                  stdin_stream)
from mirage.commands.builtin.utils.wrap import (call_read_bytes, call_readdir,
                                                call_stat,
                                                mount_parent_readdir,
                                                mount_parent_stat)
from mirage.commands.config import CommandOpts
from mirage.commands.errors import UsageError
from mirage.commands.resolve import get_extension
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.synopsis import SYNOPSES
from mirage.commands.spec.usage import usage_hint
from mirage.io.types import ByteSource, IOResult, materialize
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.errors import WALK_ERRORS, fs_strerror
from mirage.utils.key_prefix import mount_key, mount_prefix_of
from mirage.utils.path import respell_one

# GNU grep with no pattern prints its synopsis and the help hint, exit 2
# (grep 3.11; the same two lines follow `option requires an argument`).
GREP_NO_PATTERN = f"Usage: {SYNOPSES['grep']}\n" + usage_hint("grep")


def binary_mode(fl: FlagView) -> str:
    mode = "binary"
    for name in fl.typed_order("text", "args_I", "binary_files"):
        if name == "text" and fl.as_bool("text"):
            mode = "text"
        elif name == "args_I" and fl.as_bool("args_I"):
            mode = "without-match"
        elif name == "binary_files":
            value = fl.as_str("binary_files")
            mode = value if value is not None else "binary"
            if mode not in ("binary", "text", "without-match"):
                raise UsageError("grep: unknown binary-files type")
    return mode


def context_length(fl: FlagView, name: str) -> int | None:
    """One -A/-B/-C value, refused the way GNU refuses it.

    Args:
        fl (FlagView): spec-validated view over the raw flag kwargs.
        name (str): the context option to read.
    """
    raw = fl.as_str(name)
    try:
        value = fl.as_int(name)
    except ValueError as exc:
        raise UsageError(
            f"grep: {raw}: invalid context length argument") from exc
    if value is not None and value < 0:
        shown = raw if raw is not None else str(value)
        raise UsageError(f"grep: {shown}: invalid context length argument")
    return value


def listing_mode(fl: FlagView) -> tuple[bool, bool]:
    """(-l, -L): which file-listing mode wins, the later one on the line.

    GNU's `-l` and `-L` set one variable (``list_files``) so the last
    typed wins: ``grep -l -L`` lists the files WITHOUT a match and
    ``grep -L -l`` the ones with one (measured on grep 3.11).

    Args:
        fl (FlagView): spec-validated view over the raw flag kwargs.
    """
    winner: str | None = None
    for name in fl.typed_order("args_l", "files_without_match"):
        if fl.as_bool(name):
            winner = name
    return winner == "args_l", winner == "files_without_match"


def filename_mode(fl: FlagView) -> bool | None:
    """The winning filename flag: True for -H, False for -h, None for neither.

    Args:
        fl (FlagView): spec-validated view over the raw flag kwargs.
    """
    mode: bool | None = None
    for name in fl.typed_order("H", "h"):
        if fl.as_bool(name):
            mode = name == "H"
    return mode


def labelled(opts: CommandOpts) -> CommandOpts:
    """Ask for the filename a walk would have printed on its own.

    A content search hands the generic explicit files where the user
    named a directory, so the label is requested here; an explicit -h
    still wins, and an explicit -H is already on the line.

    Args:
        opts (CommandOpts): the narrowing wrapper's options.
    """
    flags = opts.flags or {}
    if filename_mode(FlagView(flags, spec=SPECS["grep"])) is not None:
        return opts
    return replace(opts, flags={**flags, "H": True})


def parse_flags(fl: FlagView, never_match: bool) -> GrepFlags:
    """Convert the raw flag bag into GrepFlags, the only string-keyed reads.

    Args:
        fl (FlagView): spec-validated view over the raw flag kwargs.
        never_match (bool): zero-pattern sentinel from resolve_pattern; it is
            a regex, so it suppresses -F.
    """
    mode = binary_mode(fl)
    filename = filename_mode(fl)
    files_only, files_without_match = listing_mode(fl)
    # GNU checks each context option as it is read, so the first bad one
    # on the line is the one named.
    contexts = {
        name: context_length(fl, name)
        for name in fl.typed_order("A", "B", "C")
    }
    a_ctx = contexts.get("A")
    b_ctx = contexts.get("B")
    c_ctx = contexts.get("C")
    return GrepFlags(
        ignore_case=fl.as_bool("i"),
        invert=fl.as_bool("v"),
        line_numbers=fl.as_bool("n"),
        byte_offsets=fl.as_bool("byte_offset"),
        count_only=fl.as_bool("c"),
        files_only=files_only,
        files_without_match=files_without_match,
        whole_word=fl.as_bool("w"),
        fixed_string=fl.as_bool("F") and not never_match,
        # grep reads a basic expression unless -E says
        # otherwise; -G asks for the default explicitly.
        basic_regexp=not fl.as_bool("E"),
        only_matching=fl.as_bool("o"),
        quiet=fl.as_bool("q"),
        recursive=fl.as_bool("r") or fl.as_bool("R"),
        with_filename=filename is True,
        no_filename=filename is False,
        max_count=fl.as_int("m"),
        after_context=a_ctx if a_ctx is not None else (c_ctx or 0),
        before_context=b_ctx if b_ctx is not None else (c_ctx or 0),
        binary_mode=mode,
        filters=WalkFilters(file_globs=parse_file_globs(fl),
                            exclude_dir=tuple(fl.as_list("exclude_dir")),
                            text=mode == "text"),
    )


async def grep(
    paths: list[PathSpec],
    texts: Sequence[str],
    opts: CommandOpts,
    *,
    readdir: Callable[..., Awaitable[list[str]]],
    stat: Callable[..., Awaitable[FileStat]],
    read_bytes: Callable[..., Awaitable[bytes]],
    read_stream: Callable[..., AsyncIterator[bytes]] | None,
    stdin: ByteSource | None = None,
) -> tuple[ByteSource | None, IOResult]:
    read_bytes = cache_aware_bound_bytes(read_bytes)
    if read_stream is not None:
        read_stream = cache_aware_bound_stream(read_stream)
    operand_stream = stdin_stream(
        read_stream if read_stream is not None else read_bytes, stdin)
    fl = FlagView(opts.flags, spec=SPECS["grep"])
    pattern, never_match = await resolve_pattern(texts, fl, read_bytes,
                                                 GREP_NO_PATTERN)
    f = parse_flags(fl, never_match)
    pat = compile_pattern(pattern, f.ignore_case, f.fixed_string, f.whole_word,
                          f.basic_regexp)
    io = IOResult(exit_code=1)
    if not paths:
        source = resolve_source(stdin, GREP_NO_PATTERN, error_cls=UsageError)
        return grep_input(source, pat, f, "(standard input)", f.with_filename
                          and not f.no_filename, io), io

    mounts = opts.ns.mounts if opts.ns is not None else None
    prefix = mount_prefix_of(paths[0].virtual, paths[0].vfs_path)
    rd = mount_parent_readdir(partial(call_readdir, readdir, prefix=prefix),
                              mounts)
    st = mount_parent_stat(partial(call_stat, stat, prefix=prefix), mounts)
    rb = partial(call_read_bytes, read_bytes, prefix=prefix)
    if not f.recursive and len(paths) == 1 and not (f.files_only or f.quiet
                                                    or f.files_without_match):
        p = paths[0]
        try:
            info = FileStat(name="-",
                            type=FileType.FIFO) if is_stdin(p) else await st(
                                p.virtual)
            if info.type == FileType.DIRECTORY:
                return b"", IOResult(
                    exit_code=2,
                    stderr=f"grep: {p.raw_path}: Is a directory\n".encode())
            if not file_admitted(p.virtual, f.filters):
                return b"", io
            # Start the reader while the mount's cache context is still active.
            source = (operand_stream(p) if is_stdin(p) or read_stream
                      is not None else wrap_bytes(await rb(p.virtual)))
        except WALK_ERRORS as exc:
            return b"", IOResult(
                exit_code=2,
                stderr=f"grep: {p.raw_path}: {fs_strerror(exc) or exc}\n".
                encode())
        io = IOResult()
        return grep_input(source, pat, f,
                          "(standard input)" if is_stdin(p) else p.raw_path,
                          f.with_filename and not f.no_filename, io), io
    warnings: list[str] = []
    diagnostics: list[bytes] = []
    matched = False
    printed = False

    def warn(message: str) -> None:
        warnings.append(message)
        diagnostics.append((message + "\n").encode())

    async def scan(p: PathSpec, walked: bool = False) -> AsyncIterator[bytes]:
        nonlocal matched, printed
        try:
            info = FileStat(name="-",
                            type=FileType.FIFO) if is_stdin(p) else await st(
                                p.virtual)
            if info.type == FileType.DIRECTORY:
                if not f.recursive:
                    warn(f"grep: {p.raw_path}: Is a directory")
                    # GNU 3.11 still lists it under -L: nothing was read
                    # from it, so nothing in it matched. -q suppresses
                    # the row like every other normal output.
                    if f.files_without_match and not f.quiet:
                        yield p.raw_path.encode() + b"\n"
                    return
                for entry in await rd(p.virtual):
                    child = PathSpec(virtual=entry,
                                     directory=entry,
                                     vfs_path=mount_key(entry, prefix),
                                     raw_path=respell_one(
                                         entry, p.virtual, p.raw_path))
                    if not dir_admitted(entry, f.filters):
                        try:
                            if (await st(entry)).type == FileType.DIRECTORY:
                                continue
                        except WALK_ERRORS as exc:
                            warn(f"grep: {child.raw_path}: "
                                 f"{fs_strerror(exc) or exc}")
                            continue
                    async for chunk in scan(child, True):
                        yield chunk
                return
            if walked and info.type != FileType.FILE:
                return
            if walked and not f.filters.text and get_extension(
                    p.virtual) in BINARY_EXTENSIONS:
                return
            if not file_admitted(p.virtual, f.filters):
                return
            source = (operand_stream(p) if is_stdin(p) or read_stream
                      is not None else wrap_bytes(await rb(p.virtual)))
            file_io = IOResult(exit_code=1)
            show = not f.no_filename and (f.with_filename or walked
                                          or len(paths) > 1)
            async for chunk in grep_input(
                    source, pat, f,
                    "(standard input)" if is_stdin(p) else p.raw_path, show,
                    file_io, printed):
                printed = True
                yield chunk
            matched = matched or file_io.exit_code == 0
            if file_io.stderr:
                diagnostics.append(await materialize(file_io.stderr))
        except WALK_ERRORS as exc:
            warn(f"grep: {p.raw_path}: {fs_strerror(exc) or exc}")

    async def run() -> AsyncIterator[bytes]:
        for path in paths:
            async for chunk in scan(path):
                yield chunk
            if f.quiet and matched:
                break
        if diagnostics:
            io.stderr = b"".join(diagnostics)
        io.exit_code = exit_code_for(matched, bool(warnings), f.quiet)

    return await materialize(run()), io


async def wrap_bytes(data: bytes) -> AsyncIterator[bytes]:
    yield data
