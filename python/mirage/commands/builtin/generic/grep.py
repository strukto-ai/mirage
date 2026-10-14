import re
from collections.abc import (
    AsyncGenerator,
    AsyncIterator,
    Awaitable,
    Callable,
    Sequence,
)
from contextlib import aclosing
from dataclasses import replace
from functools import partial

from mirage.commands.builtin.grep_binary import (
    GrepFlags,
    grep_input,
    name_end,
)
from mirage.commands.builtin.grep_pattern import (
    NEVER_MATCH,
    compile_pattern,
    matcher_syntax,
    pattern_warnings,
    resolve_pattern,
)
from mirage.commands.builtin.grep_scan import exit_code_for
from mirage.commands.builtin.grep_select import (
    WalkFilters,
    dir_admitted,
    file_admitted,
    parse_file_globs,
)
from mirage.commands.builtin.utils.stream import (
    is_stdin,
    operand_label,
    resolve_source,
    stdin_stream,
)
from mirage.commands.builtin.utils.wrap import (
    call_read_bytes,
    call_readdir,
    call_stat,
    mount_parent_readdir,
    mount_parent_stat,
)
from mirage.commands.config import CommandOpts
from mirage.commands.errors import UsageError
from mirage.commands.spec import SPECS
from mirage.commands.spec.argmatch import ArgmatchMatch, argmatch
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.synopsis import SYNOPSES
from mirage.commands.spec.usage import (
    argmatch_line,
    argmatch_valid_block,
    usage_hint,
)
from mirage.concurrency.worker import Worker
from mirage.errors.constants import FS_ERRORS, WALK_ERRORS
from mirage.errors.fs import fs_strerror, walk_refusal
from mirage.errors.posix import posix_phrase
from mirage.errors.types import FsCondition
from mirage.io.types import ByteSource, IOResult, materialize
from mirage.shell.bytes import byte_view, utf8_locale
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.filetype import BINARY_EXTENSIONS, get_extension
from mirage.utils.key_prefix import mount_key, mount_prefix_of
from mirage.utils.path import respell_one
from mirage.view.namespace_view import followed_stat

# GNU grep with no pattern prints its synopsis and the help hint, exit 2
# (grep 3.11; the same two lines follow `option requires an argument`).
GREP_NO_PATTERN = f"Usage: {SYNOPSES['grep']}\n" + usage_hint("grep")
# What --directories takes, an argmatch table: a prefix names one.
DIRECTORIES = ("read", "recurse", "skip")
DEVICES = ("read", "skip")
# The types -D skip passes over; stdin is read whatever it is.
DEVICE_TYPES = frozenset(
    {
        FileType.CHAR_DEVICE,
        FileType.BLOCK_DEVICE,
        FileType.FIFO,
        FileType.SOCKET,
    }
)
STDIN_LABEL = "(standard input)"
UNIX_BYTE_OFFSETS = b"grep: warning: --unix-byte-offsets (-u) is obsolete\n"
# What xstrtoimax takes as -m's count: blanks, a sign, then digits.
MAX_COUNT = re.compile(r"[ \t\n\v\f\r]*[+-]?[0-9]+")


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


def directories_action(fl: FlagView) -> str:
    """What grep does with a directory: read, recurse or skip.

    -r and -R are --directories=recurse, so the last of the three on the
    line wins (grep 3.11: `grep -r -d skip` skips, `-d skip -r`
    recurses). A word argmatch names none of the three by comes back as
    typed; ``check_actions`` refuses it.

    Args:
        fl (FlagView): spec-validated view over the raw flag kwargs.
    """
    action = "read"
    for name in fl.typed_order(
        "recursive", "dereference_recursive", "directories"
    ):
        if name != "directories":
            if fl.as_bool(name):
                action = "recurse"
            continue
        word = fl.as_str(name) or ""
        match = argmatch(word, DIRECTORIES)
        action = match.word if isinstance(match, ArgmatchMatch) else word
    return action


def check_actions(fl: FlagView) -> None:
    """Refuse a -d or -D word as GNU does, each one typed and not only
    the last: its option loop stops at the first bad one.

    A -d word argmatch names no action by is gnulib's refusal and grep's
    usage, exit 1; -D takes only the exact words, exit 2.

    Args:
        fl (FlagView): spec-validated view over the raw flag kwargs.
    """
    for name, value in fl.occurrences("directories", "devices"):
        word = str(value)
        if name == "devices":
            if word not in DEVICES:
                raise UsageError("grep: unknown devices method")
            continue
        match = argmatch(word, DIRECTORIES)
        if not isinstance(match, ArgmatchMatch):
            raise UsageError(
                f"{argmatch_line('grep', '--directories', word, match.kind)}"
                f"\n{argmatch_valid_block(DIRECTORIES)}\n{GREP_NO_PATTERN}",
                1,
            )


def group_separator(fl: FlagView) -> bytes | None:
    """The line between context groups; None under --no-group-separator.

    The two options set one variable, so the later one wins.

    Args:
        fl (FlagView): spec-validated view over the raw flag kwargs.
    """
    separator: bytes | None = b"--"
    for name in fl.typed_order("group_separator", "no_group_separator"):
        if name == "group_separator":
            separator = (fl.as_str(name) or "").encode()
        elif fl.as_bool(name):
            separator = None
    return separator


def ignores_case(fl: FlagView) -> bool:
    """-i (or -y) unless a later --no-ignore-case turns it off.

    Args:
        fl (FlagView): spec-validated view over the raw flag kwargs.
    """
    names = [
        name
        for name in fl.typed_order("ignore_case", "no_ignore_case")
        if fl.as_bool(name)
    ]
    return bool(names) and names[-1] == "ignore_case"


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
            f"grep: {raw}: invalid context length argument"
        ) from exc
    if value is not None and value < 0:
        shown = raw if raw is not None else str(value)
        raise UsageError(f"grep: {shown}: invalid context length argument")
    return value


def max_count(fl: FlagView) -> int | None:
    """-m as GNU reads it (xstrtoimax): leading blanks and a sign are
    allowed, a negative count is no limit, and anything else is refused.

    Args:
        fl (FlagView): spec-validated view over the raw flag kwargs.
    """
    raw = fl.as_str("max_count")
    if raw is not None and MAX_COUNT.fullmatch(raw) is None:
        raise UsageError("grep: invalid max count")
    count = int(raw) if raw is not None else fl.as_int("max_count")
    return None if count is None or count < 0 else count


def listing_mode(fl: FlagView) -> tuple[bool, bool]:
    """(-l, -L): which file-listing mode wins, the later one on the line.

    GNU's `-l` and `-L` set one variable (``list_files``) so the last
    typed wins: ``grep -l -L`` lists the files WITHOUT a match and
    ``grep -L -l`` the ones with one (measured on grep 3.11).

    Args:
        fl (FlagView): spec-validated view over the raw flag kwargs.
    """
    winner: str | None = None
    for name in fl.typed_order("files_with_matches", "files_without_match"):
        if fl.as_bool(name):
            winner = name
    return winner == "files_with_matches", winner == "files_without_match"


def filename_mode(fl: FlagView) -> bool | None:
    """The winning filename flag: True for -H, False for -h, None for neither.

    Args:
        fl (FlagView): spec-validated view over the raw flag kwargs.
    """
    mode: bool | None = None
    for name in fl.typed_order("with_filename", "no_filename"):
        if fl.as_bool(name):
            mode = name == "with_filename"
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
    return replace(opts, flags={**flags, "with_filename": True})


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
        for name in fl.typed_order(
            "after_context", "before_context", "context"
        )
    }
    a_ctx = contexts.get("after_context")
    b_ctx = contexts.get("before_context")
    c_ctx = contexts.get("context")
    label = fl.as_str("label")
    check_actions(fl)
    directories = directories_action(fl)
    return GrepFlags(
        ignore_case=ignores_case(fl),
        invert=fl.as_bool("invert_match"),
        line_numbers=fl.as_bool("line_number"),
        byte_offsets=fl.as_bool("byte_offset"),
        count_only=fl.as_bool("count"),
        files_only=files_only,
        files_without_match=files_without_match,
        whole_word=fl.as_bool("word_regexp"),
        line_regexp=fl.as_bool("line_regexp"),
        fixed_string=fl.as_bool("fixed_strings") and not never_match,
        # grep reads a basic expression unless -E or -P says
        # otherwise; -G asks for the default explicitly.
        syntax=matcher_syntax(fl),
        only_matching=fl.as_bool("only_matching"),
        quiet=fl.as_bool("quiet"),
        no_messages=fl.as_bool("no_messages"),
        recursive=directories == "recurse",
        # -R follows every link wherever it stands on the line, -r after
        # it included (grep 3.11).
        dereference=fl.as_bool("dereference_recursive"),
        skip_directories=directories == "skip",
        skip_devices=fl.as_str("devices") == "skip",
        with_filename=filename is True,
        no_filename=filename is False,
        max_count=max_count(fl),
        after_context=a_ctx if a_ctx is not None else c_ctx,
        before_context=b_ctx if b_ctx is not None else c_ctx,
        binary_mode=mode,
        null_data=fl.as_bool("null_data"),
        null=fl.as_bool("null"),
        initial_tab=fl.as_bool("initial_tab"),
        group_separator=group_separator(fl),
        label=STDIN_LABEL if label is None else label,
        filters=WalkFilters(
            file_globs=parse_file_globs(fl),
            exclude_dir=tuple(fl.as_list("exclude_dir")),
            text=mode == "text",
        ),
    )


def line_warnings(
    fl: FlagView, f: GrepFlags, pattern: str, never_match: bool
) -> bytes:
    """What grep warns once for the line, before it reads a file: an
    obsolete -u, then the pattern's compile-time warnings.

    Args:
        fl (FlagView): spec-validated view over the raw flag kwargs.
        f (GrepFlags): the parsed flags.
        pattern (str): the pattern list.
        never_match (bool): the pattern list matches nothing.
    """
    warning = (
        b""
        if never_match or f.fixed_string
        else pattern_warnings(pattern, f.syntax)
    )
    if fl.as_bool("unix_byte_offsets"):
        warning = UNIX_BYTE_OFFSETS + warning
    return warning


async def grep_generic(
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
    operand_stream = stdin_stream(
        read_stream if read_stream is not None else read_bytes, stdin
    )
    fl = FlagView(opts.flags, spec=SPECS["grep"])
    # GNU refuses a bad option value in its option loop, before it looks
    # for a pattern.
    f = parse_flags(fl, never_match=False)
    pattern, never_match = await resolve_pattern(
        texts, fl, read_bytes, GREP_NO_PATTERN
    )
    if never_match:
        f = replace(f, fixed_string=False)
    utf8 = utf8_locale(opts.env)
    pat = (
        re.compile(NEVER_MATCH)
        if never_match
        else compile_pattern(
            byte_view(pattern, utf8),
            f.ignore_case,
            f.fixed_string,
            f.whole_word,
            f.syntax,
            utf8,
            f.line_regexp,
        )
    )
    warning = line_warnings(fl, f, pattern, never_match)
    io = IOResult(exit_code=1, stderr=warning or None)
    if not paths:
        source = resolve_source(stdin)
        return grep_input(
            source,
            pat,
            f,
            f.label,
            f.with_filename and not f.no_filename,
            io,
            utf8=utf8,
        ), io

    worker = Worker()
    mounts = opts.ns.mounts if opts.ns is not None else None
    prefix = mount_prefix_of(paths[0].virtual, paths[0].vfs_path)
    rd = mount_parent_readdir(
        partial(call_readdir, readdir, prefix=prefix), mounts, prefix
    )
    st = mount_parent_stat(partial(call_stat, stat, prefix=prefix), mounts)
    links = opts.ns.links if opts.ns is not None else None
    # The walk meets links as entries: -r leaves them, -R reads what each
    # one leads to, and a directory it reaches again is a loop.
    follow = links if f.recursive and f.dereference else None
    walked_st = partial(followed_stat, st, follow)
    rb = partial(call_read_bytes, read_bytes, prefix=prefix)
    failed = False
    diagnostics: list[bytes] = []
    matched = False
    printed = False

    def warn(message: str) -> None:
        nonlocal failed
        failed = True
        io.exit_code = exit_code_for(matched, failed, f.quiet)
        if not f.no_messages:
            diagnostics.append((message + "\n").encode())

    def update_status(file_io: IOResult) -> None:
        io.exit_code = exit_code_for(
            matched or file_io.exit_code == 0, failed, f.quiet
        )

    async def scan(
        p: PathSpec, walked: bool = False, chain: tuple[str, ...] = ()
    ) -> AsyncGenerator[bytes, None]:
        nonlocal matched, printed
        try:
            # The probes below go by `virtual`, which cannot carry the
            # walk's verdict on an operand it refused.
            if p.walk_error is not None:
                raise walk_refusal(p)
            info = (
                FileStat(name="-", type=FileType.FIFO)
                if is_stdin(p)
                else await (walked_st if walked else st)(p.virtual)
            )
            if follow is not None and info.type == FileType.DIRECTORY:
                here = follow.resolve(p.virtual)
                if here in chain:
                    if not f.no_messages:
                        loop = f"grep: {p.raw_path}: warning: recursive"
                        diagnostics.append(f"{loop} directory loop\n".encode())
                    return
                chain = (*chain, here)
            entries = (
                await rd(p.virtual)
                if info.type == FileType.DIRECTORY and f.recursive
                else []
            )
        except WALK_ERRORS as exc:
            warn(f"grep: {p.raw_path}: {fs_strerror(exc) or exc}")
            return
        if walked and follow is not None and info.type == FileType.SYMLINK:
            warn(f"grep: {p.raw_path}: {posix_phrase(FsCondition.ENOENT)}")
            return
        if info.type == FileType.DIRECTORY:
            if f.skip_directories:
                return
            if not f.recursive:
                warn(f"grep: {p.raw_path}: Is a directory")
                # GNU 3.11 still lists it under -L: nothing was read
                # from it, so nothing in it matched. -q suppresses
                # the row like every other normal output.
                if f.files_without_match and not f.quiet:
                    yield p.raw_path.encode() + name_end(f)
                return
            for entry in entries:
                child = PathSpec(
                    virtual=entry,
                    directory=entry,
                    vfs_path=mount_key(entry, prefix),
                    raw_path=respell_one(entry, p.virtual, p.raw_path),
                )
                if not dir_admitted(entry, f.filters):
                    try:
                        if (await walked_st(entry)).type == FileType.DIRECTORY:
                            continue
                    except WALK_ERRORS as exc:
                        warn(
                            f"grep: {child.raw_path}: "
                            f"{fs_strerror(exc) or exc}"
                        )
                        continue
                async with aclosing(scan(child, True, chain)) as child_stream:
                    async for chunk in child_stream:
                        yield chunk
                if f.quiet and matched:
                    break
            return
        if walked and info.type != FileType.FILE:
            return
        if f.skip_devices and info.type in DEVICE_TYPES and not is_stdin(p):
            return
        if (
            walked
            and not f.filters.text
            and get_extension(p.virtual) in BINARY_EXTENSIONS
        ):
            return
        if not file_admitted(p.virtual, f.filters):
            return
        file_io = IOResult(exit_code=1)
        try:
            try:
                source = (
                    operand_stream(p)
                    if is_stdin(p) or read_stream is not None
                    else wrap_bytes(await rb(p.virtual))
                )
                show = not f.no_filename and (
                    f.with_filename or walked or len(paths) > 1
                )
                async with aclosing(
                    grep_input(
                        source,
                        pat,
                        f,
                        operand_label(p, f.label),
                        show,
                        file_io,
                        printed,
                        utf8,
                        info.size if info.type == FileType.FILE else None,
                        worker,
                    )
                ) as output:
                    async for chunk in output:
                        update_status(file_io)
                        printed = True
                        yield chunk
            finally:
                matched = matched or file_io.exit_code == 0
                update_status(file_io)
                if file_io.stderr:
                    diagnostics.append(await materialize(file_io.stderr))
        except FS_ERRORS as exc:
            warn(f"grep: {p.raw_path}: {fs_strerror(exc) or exc}")

    async def run() -> AsyncIterator[bytes]:
        try:
            for path in paths:
                async with aclosing(scan(path)) as output:
                    async for chunk in output:
                        yield chunk
                if f.quiet and matched:
                    break
        finally:
            await worker.close()
            if diagnostics:
                io.stderr = (await materialize(io.stderr)) + b"".join(
                    diagnostics
                )

    return run(), io


async def wrap_bytes(data: bytes) -> AsyncIterator[bytes]:
    yield data
