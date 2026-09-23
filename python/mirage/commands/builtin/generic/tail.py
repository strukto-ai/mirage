import asyncio
import inspect
from collections import deque
from collections.abc import AsyncIterator, Awaitable, Mapping
from dataclasses import dataclass
from typing import Any, Callable

from mirage.cache.read_through import cache_aware_read
from mirage.commands.builtin.tail_counts import (TailCounts, number_flag_error,
                                                 parse_counts, parse_seconds)
from mirage.commands.builtin.utils.operands import operands_io, split_readable
from mirage.commands.builtin.utils.stream import (is_stdin, resolve_source,
                                                  stdin_stat, stdin_stream)
from mirage.commands.config import CommandOpts
from mirage.commands.errors import UsageError
from mirage.commands.quote import quote_text
from mirage.commands.spec import SPECS
from mirage.commands.spec.argmatch import ArgmatchMatch, argmatch
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import FlagValue
from mirage.commands.spec.usage import argmatch_error
from mirage.io.types import ByteSource, IOResult
from mirage.types import FileType, PathSpec, PolymorphicReadFn, StatFn
from mirage.utils.errors import FS_ERRORS, fs_error_line, fs_strerror
from mirage.utils.stream import ensure_stream

DEFAULT_SLEEP_INTERVAL = 1.0
# GNU's `follow_mode_string`, in declaration order.
FOLLOW_ARGS = ("descriptor", "name")
# A bound byte-window reader, called as ``read_range(path, offset=, size=)``.
ReadRangeFn = Callable[..., Awaitable[bytes]]


@dataclass(frozen=True, slots=True)
class TailFlags:
    """The tail flag bag, parsed once.

    Args:
        counts (TailCounts): ``-n``/``-c`` and their ``+N`` forms.
        quiet (bool): ``-q``; never print headers.
        verbose (bool): ``-v``; always print headers.
        follow (bool): ``-f``/``--follow``; keep reading as the file
            grows.
        follow_name (bool): ``--follow=name``/``-F``; a file that goes
            away is reported, and picked up again under ``--retry``.
        retry (bool): ``--retry``/``-F``; keep trying a file that is
            missing or vanishes.
        interval (float): ``-s``; seconds between polls.
    """
    counts: TailCounts
    quiet: bool = False
    verbose: bool = False
    follow: bool = False
    follow_name: bool = False
    retry: bool = False
    interval: float = DEFAULT_SLEEP_INTERVAL


RETRY_IGNORED = (b"tail: warning: --retry ignored; --retry is useful only "
                 b"when following\n")
# What a waited-for name is announced as when it turns up: a missing file
# has appeared, an untailable one (a directory) has become accessible.
APPEARED = "has appeared;  following new file"
ACCESSIBLE = "has become accessible"


def _follow_flags(fl: FlagView) -> tuple[bool, bool, bool]:
    """``-f``, ``--follow[=HOW]`` and ``-F`` as (follow, by name, retry).

    Args:
        fl (FlagView): the tail flag view.
    """
    raw = fl.raw("follow")
    how: str | None = None
    if isinstance(raw, str):
        match = argmatch(raw, FOLLOW_ARGS)
        if not isinstance(match, ArgmatchMatch):
            raise argmatch_error("tail", "--follow", raw, FOLLOW_ARGS, None,
                                 match.kind)
        how = match.word
    # -F is --follow=name --retry. The mode is whichever of -f/--follow
    # and -F came last, GNU's own order (`-F --follow=descriptor` follows
    # the descriptor), while -F's --retry half stays on either way.
    typed = [
        k for k in fl.typed_order("follow", "F")
        if (k == "F" and fl.as_bool("F")) or (
            k == "follow" and raw is not None and raw is not False)
    ]
    if not typed:
        return False, False, fl.as_bool("retry")
    by_name = how == "name" if typed[-1] == "follow" else True
    return True, by_name, fl.as_bool("retry") or "F" in typed


def _interval_flag(fl: FlagView) -> float:
    """``-s``/``--sleep-interval`` as seconds, GNU's refusal otherwise.

    Args:
        fl (FlagView): the tail flag view.
    """
    raw = fl.as_str("sleep_interval")
    if raw is None:
        return DEFAULT_SLEEP_INTERVAL
    seconds = parse_seconds(raw)
    # GNU's own two-part test, `xstrtod(...) && 0 <= s`: the grammar
    # first, then the range. `0 <= nan` is false, so NaN is refused,
    # while `inf` passes both and is ACCEPTED (measured, coreutils 9.4).
    if seconds is None or not 0 <= seconds:
        raise ValueError(
            f"tail: invalid number of seconds: '{quote_text(raw)}'\n")
    return seconds


def parse_flags(flags: Mapping[str, FlagValue]) -> TailFlags:
    fl = FlagView(flags, spec=SPECS["tail"])
    n_raw = fl.as_str("n")
    c_raw = fl.as_str("c")
    error = number_flag_error("tail", n_raw, c_raw)
    if error is not None:
        raise ValueError(error)
    follow, by_name, retry = _follow_flags(fl)
    return TailFlags(
        counts=parse_counts(n_raw, c_raw),
        quiet=fl.as_bool("q"),
        verbose=fl.as_bool("v"),
        follow=follow,
        follow_name=by_name,
        retry=retry,
        interval=_interval_flag(fl),
    )


async def tail(
    src: bytes | AsyncIterator[bytes],
    *,
    n: int | None = None,
    c: int | None = None,
    from_line: int | None = None,
    from_byte: int | None = None,
) -> AsyncIterator[bytes]:
    if from_byte is not None:
        # GNU counts `-c +N` from byte N, 1-indexed, so +0 and +1 both mean
        # the whole file.
        skip = max(0, from_byte - 1)
        skipped = 0
        async for chunk in ensure_stream(src):
            if skipped >= skip:
                yield chunk
                continue
            remaining = skip - skipped
            if len(chunk) <= remaining:
                skipped += len(chunk)
                continue
            yield chunk[remaining:]
            skipped = skip
        return

    if from_line is not None:
        start = max(1, from_line)
        skip = start - 1
        if skip == 0:
            async for chunk in ensure_stream(src):
                yield chunk
            return
        skipped = 0
        emitting = False
        async for chunk in ensure_stream(src):
            if emitting:
                yield chunk
                continue
            count = chunk.count(b"\n")
            if skipped + count < skip:
                skipped += count
                continue
            i = 0
            for _ in range(skip - skipped):
                j = chunk.find(b"\n", i)
                i = j + 1
            skipped = skip
            emitting = True
            if i < len(chunk):
                yield chunk[i:]
        return

    if c is not None:
        target_c = abs(c)
        if target_c == 0:
            return
        buf = b""
        async for chunk in ensure_stream(src):
            buf += chunk
            if len(buf) > target_c:
                buf = buf[-target_c:]
        if buf:
            yield buf
        return

    target = abs(n) if n is not None else 10
    if target == 0:
        return

    recent: deque[bytes] = deque(maxlen=target)
    buf = b""
    async for chunk in ensure_stream(src):
        buf += chunk
        while b"\n" in buf:
            line, buf = buf.split(b"\n", 1)
            recent.append(line + b"\n")
    if buf:
        recent.append(buf)

    for line in recent:
        yield line


def tail_multi(
    paths: list[PathSpec],
    *,
    read: Callable[..., Any],
    n: int | None = None,
    c: int | None = None,
    from_line: int | None = None,
    from_byte: int | None = None,
    show_headers: bool = False,
) -> AsyncIterator[bytes]:
    """Run tail over multiple already-resolved paths.

    Globs are expanded by the caller, so ``paths`` is a flat list of concrete
    entries. When ``show_headers`` is set a ``==> path <==`` banner is emitted
    before each file (POSIX/GNU tail with multiple files), separated by a blank
    line between files. The per-file source is produced lazily by ``read``.

    This is a plain ``def`` returning the async generator: the cache-aware
    wrap captures the active manager now, when the command calls
    ``tail_multi`` inside the mount's cache-manager scope, not when the
    returned stream is drained later (after that scope is gone).

    Args:
        paths (list[PathSpec]): Resolved paths; only ``.virtual`` is read.
        read (Callable[..., Any]): Bound reader called as ``read(path)``;
            returns bytes, an awaitable of bytes, or an async byte iterator.
    """
    cached = cache_aware_read(read)
    return _tail_multi(paths,
                       read=lambda p: read(p) if is_stdin(p) else cached(p),
                       n=n,
                       c=c,
                       from_line=from_line,
                       from_byte=from_byte,
                       show_headers=show_headers)


async def _tail_multi(
    paths: list[PathSpec],
    *,
    read: Callable[..., Any],
    n: int | None = None,
    c: int | None = None,
    from_line: int | None = None,
    from_byte: int | None = None,
    show_headers: bool = False,
) -> AsyncIterator[bytes]:
    for i, p in enumerate(paths):
        if show_headers:
            label = "(standard input)" if is_stdin(p) else p.raw_path
            header = f"==> {label} <==\n"
            if i > 0:
                header = "\n" + header
            yield header.encode()
        source = read(p)
        if inspect.isawaitable(source):
            source = await source
        async for chunk in tail(source,
                                n=n,
                                c=c,
                                from_line=from_line,
                                from_byte=from_byte):
            yield chunk


def _note(io: IOResult, message: str) -> None:
    """Append a follow-time diagnostic to the result's stderr.

    A following tail's stdout is a stream the caller drains as the
    file grows, and its stderr is the bytes on the result, which the
    caller reads once the stream ends; a notice raised mid-follow
    lands there.

    Args:
        io (IOResult): the result handed back with the stream.
        message (str): the ``tail: ...`` line, newline included.
    """
    prior = io.stderr if isinstance(io.stderr, bytes) else b""
    io.stderr = prior + message.encode()


async def _counted(source: Any, box: list[int]) -> AsyncIterator[bytes]:
    """Pass a source through, adding up the bytes it yields.

    Args:
        source (Any): bytes, an awaitable of bytes, or an async iterator.
        box (list[int]): one-slot counter the total lands in.
    """
    if inspect.isawaitable(source):
        source = await source
    async for chunk in ensure_stream(source):
        box[0] += len(chunk)
        yield chunk


async def _window(read: Callable[..., Any], read_range: ReadRangeFn | None,
                  path: PathSpec, offset: int, size: int) -> bytes:
    """The bytes a file gained past ``offset``.

    Args:
        read (Callable[..., Any]): whole-file reader, the fallback.
        read_range (ReadRangeFn | None): the backend's byte window, if
            it has one.
        path (PathSpec): the file.
        offset (int): where the last poll ended.
        size (int): how many bytes appeared.
    """
    if read_range is not None:
        # The bound op takes its window by keyword: the accessor and index
        # are already bound, and the protocol names the rest.
        data = await read_range(path, offset=offset, size=size)
        return bytes(data)
    return (await _whole(read, path))[offset:offset + size]


async def _whole(read: Callable[..., Any], path: PathSpec) -> bytes:
    """The file as the whole-file reader returns it, joined.

    Args:
        read (Callable[..., Any]): bound whole-file reader.
        path (PathSpec): the file.
    """
    return b"".join([chunk async for chunk in _counted(read(path), [0])])


async def _catch_up(read: Callable[..., Any], read_range: ReadRangeFn | None,
                    io: IOResult, p: PathSpec, size: int | None,
                    pos: int) -> tuple[bytes, int]:
    """What a followed file gained past ``pos``, and where the next poll
    starts: a size-unknown file is read whole and measured, and a file
    shorter than ``pos`` was truncated, which is noted and read from the
    start.

    Args:
        read (Callable[..., Any]): bound whole-file reader.
        read_range (ReadRangeFn | None): the backend's byte window, if
            it has one.
        io (IOResult): the result a truncation notice lands on.
        p (PathSpec): the file.
        size (int | None): the size the poll's stat reported.
        pos (int): how far the previous poll read.
    """
    whole: bytes | None = None
    if size is None:
        whole = await _whole(read, p)
        size = len(whole)
    if size < pos:
        _note(io, f"tail: {p.raw_path}: file truncated\n")
        pos = 0
    if size <= pos:
        return b"", pos
    data = (whole[pos:] if whole is not None else await _window(
        read, read_range, p, pos, size - pos))
    return data, pos + len(data)


async def _follow(
    paths: list[PathSpec],
    pending: list[tuple[PathSpec, str]],
    *,
    read: Callable[..., Any],
    read_range: ReadRangeFn | None,
    stat: StatFn,
    counts: TailCounts,
    show_headers: bool,
    flags: TailFlags,
    io: IOResult,
) -> AsyncIterator[bytes]:
    """Print each operand's tail, then keep printing what it gains.

    GNU tail -f is a poll: every ``-s`` seconds each followed file is
    stat'ed, bytes past the last position are printed under that file's
    header when the previous output was another file's, and a size that
    shrank is ``file truncated`` and a restart from the top. An operand
    whose first read fails after its stat passed is a failed open,
    reported as one and, under ``--retry``, waited for like a file that
    was never there. A file that goes away later, at the poll's stat or
    at the read right after it, is dropped with ``has become
    inaccessible`` under ``--follow=name``; ``--retry`` keeps polling
    for it (and for one that was never there) and announces ``has
    appeared`` when it turns up, reading it from the start as GNU does
    after a rotation. The loop ends only when nothing is left to follow
    (``no files remaining``, exit 1) or the caller stops draining, which
    is how
    ``timeout`` and a killed job end it. A followed file that a
    directory replaces is ``has been replaced with an untailable
    file``: name-following gives the name up, or under ``--retry``
    keeps polling it and announces ``has become accessible`` when a
    file stands there again; a descriptor follow prints nothing, as
    GNU's does while it holds the old descriptor.

    Divergence: a file replaced in place between two polls (an atomic
    rotation that never leaves the name absent) is read as the same
    file. GNU tells the two apart by inode, which no backend here
    reports, so a same-sized replacement prints nothing and a larger
    one prints only its tail; only a smaller size (``file truncated``)
    resets the position to zero. For the same reason a descriptor
    follow cannot keep reading a file renamed away: there is no open
    handle, so the path is polled until it holds bytes again.

    A file whose stat carries no size (a backend that cannot know one
    without reading reports ``None``, never a guess) is polled by
    reading it whole every interval and measuring that: one read per
    poll, rather than a follow that never prints.

    State is per operand, not per path: ``tail -f f f`` prints what
    ``f`` gains twice, under a header each time, as GNU does.

    Args:
        paths (list[PathSpec]): the operands that opened.
        pending (list[tuple[PathSpec, str]]): the ones ``--retry`` waits
            for, each with the notice that announces it.
        read (Callable[..., Any]): bound whole-file reader.
        read_range (ReadRangeFn | None): bound byte-window reader.
        stat (StatFn): bound stat.
        counts (TailCounts): what the first print shows.
        show_headers (bool): the ``==> name <==`` rule.
        flags (TailFlags): the parsed flags.
        io (IOResult): the result the notices are appended to.
    """
    positions: dict[int, int] = {}
    active = list(enumerate(paths))
    waiting = [(len(paths) + i, p, how) for i, (p, how) in enumerate(pending)]
    last: int | None = None
    for slot, p in list(active):
        box = [0]
        try:
            chunks = [
                chunk async for chunk in tail(_counted(read(p), box),
                                              n=counts.lines,
                                              c=counts.byte_count,
                                              from_line=counts.from_line,
                                              from_byte=counts.from_byte)
            ]
        except FS_ERRORS as exc:
            # There is no handle to hold, so this first read is the
            # open: one that fails after the operand's stat passed is
            # GNU's failed open, reported the way the stat's failure
            # would have been, and under --retry waited for like a
            # file that was never there (this is the initial open that
            # a descriptor follow's --retry covers).
            _note(io, fs_error_line("tail", p, exc))
            io.exit_code = 1
            active.remove((slot, p))
            if flags.retry:
                waiting.append((slot, p, APPEARED))
            continue
        if show_headers:
            label = "(standard input)" if is_stdin(p) else p.raw_path
            header = f"==> {label} <==\n"
            yield (("\n" if last is not None else "") + header).encode()
        last = slot
        for chunk in chunks:
            yield chunk
        positions[slot] = box[0]
    while active or waiting:
        await asyncio.sleep(flags.interval)
        for slot, p, how in list(waiting):
            try:
                found = await stat(p)
            except FS_ERRORS:
                continue
            if found.type is FileType.DIRECTORY:
                continue
            _note(io, f"tail: '{p.raw_path}' {how}\n")
            waiting.remove((slot, p, how))
            active.append((slot, p))
            positions[slot] = 0
        for slot, p in list(active):
            grown: tuple[bytes, int] | None
            try:
                current = await stat(p)
                if current.type is FileType.DIRECTORY:
                    grown = None
                else:
                    grown = await _catch_up(read, read_range, io, p,
                                            current.size, positions[slot])
            except IsADirectoryError:
                grown = None
            except FS_ERRORS as exc:
                # A path that went away, whether its stat failed or the
                # read right after it did (a rotation between the two).
                # Only name-following notices; under a descriptor
                # --retry covers the initial open alone, as in GNU.
                if flags.follow_name:
                    _note(
                        io, f"tail: '{p.raw_path}' has become inaccessible: "
                        f"{fs_strerror(exc)}\n")
                    active.remove((slot, p))
                    if flags.retry:
                        waiting.append((slot, p, APPEARED))
                continue
            if grown is None:
                if not flags.follow_name:
                    continue
                line = (f"tail: '{p.raw_path}' has been replaced with an "
                        "untailable file")
                _note(
                    io, line +
                    ("\n" if flags.retry else "; giving up on this name\n"))
                active.remove((slot, p))
                if flags.retry:
                    waiting.append((slot, p, ACCESSIBLE))
                continue
            data, positions[slot] = grown
            if data:
                if show_headers and last != slot:
                    yield f"\n==> {p.raw_path} <==\n".encode()
                last = slot
                yield data
    _note(io, "tail: no files remaining\n")
    io.exit_code = 1


async def _unfollowable(paths: list[PathSpec], readable: list[PathSpec],
                        stat: StatFn, flags: TailFlags,
                        io: IOResult) -> list[tuple[PathSpec, str]]:
    """Sort the operands that did not open into the ones ``--retry``
    waits for and the ones tail gives up on, wording the latter.

    A directory cannot be followed. Without ``--retry`` that is
    ``giving up on this name``; with it GNU drops the suffix, and under
    ``--follow=name`` keeps polling the name until something tailable
    replaces it, announced as ``has become accessible`` rather than the
    ``has appeared`` a missing file gets.

    Args:
        paths (list[PathSpec]): every operand.
        readable (list[PathSpec]): the ones that opened.
        stat (StatFn): bound stat.
        flags (TailFlags): the parsed flags.
        io (IOResult): the result the notices are appended to.
    """
    opened = {p.virtual for p in readable}
    pending: list[tuple[PathSpec, str]] = []
    for p in paths:
        if p.virtual in opened:
            continue
        try:
            is_dir = (await stat(p)).type is FileType.DIRECTORY
        except IsADirectoryError:
            is_dir = True
        except FS_ERRORS:
            if flags.retry:
                pending.append((p, APPEARED))
            continue
        if not is_dir:
            continue
        line = f"tail: {p.raw_path}: cannot follow end of this type of file"
        if not flags.retry:
            _note(io, line + "; giving up on this name\n")
            continue
        _note(io, line + "\n")
        if flags.follow_name:
            pending.append((p, ACCESSIBLE))
    return pending


async def tail_generic(
    paths: list[PathSpec],
    texts: list[str],
    opts: CommandOpts,
    stat: StatFn,
    stream: PolymorphicReadFn,
    read_range: ReadRangeFn | None = None,
) -> tuple[ByteSource | None, IOResult]:
    """Run tail over resolved operands, GNU semantics; mirrors tailGeneric.

    The wiring resolves globs and binds the backend ops (including any
    push-down, like mongodb serving the last N documents server-side);
    everything else lives here: flag parsing, the header rule, the
    per-operand report-and-continue split, and the stdin fallback.

    Args:
        paths (list[PathSpec]): Glob-resolved operands, empty for stdin.
        texts (list[str]): Non-path words, unused by tail.
        opts (CommandOpts): Flags and stdin from the dispatcher.
        stat (StatFn): Bound stat called as ``stat(path)``.
        stream (PolymorphicReadFn): Bound reader called as
            ``stream(path)``.
        read_range (ReadRangeFn | None): Bound byte-window reader
            called as ``read_range(path, offset, size)``, for a follow
            that only wants what the file gained; None reads whole.
    """
    stat = stdin_stat(stat)
    stream = stdin_stream(stream, opts.stdin)
    try:
        parsed = parse_flags(opts.flags)
    except UsageError as exc:
        return None, IOResult(exit_code=exc.exit_code,
                              stderr=f"{exc}\n".encode())
    except ValueError as exc:
        return None, IOResult(exit_code=1, stderr=str(exc).encode())
    counts = parsed.counts
    # GNU warns first, then tails as if --retry were not there.
    retry_warning = (RETRY_IGNORED
                     if parsed.retry and not parsed.follow else b"")
    if paths:
        show_headers = (parsed.verbose or len(paths) > 1) and not parsed.quiet
        readable, err = await split_readable(paths, stat, "tail")
        io = operands_io(err)
        if retry_warning:
            io.stderr = retry_warning + (io.stderr if isinstance(
                io.stderr, bytes) else b"")
        if parsed.follow:
            if parsed.retry and not parsed.follow_name:
                io.stderr = (
                    b"tail: warning: --retry only effective for "
                    b"the initial open\n" +
                    (io.stderr if isinstance(io.stderr, bytes) else b""))
            pending = await _unfollowable(paths, readable, stat, parsed, io)
            if not readable and not pending:
                _note(io, "tail: no files remaining\n")
                io.exit_code = 1
                return None, io
            # A follow reads the backend itself, never the read-through
            # cache: what it is polling for is exactly the change the
            # cached body does not have yet.
            return _follow(readable,
                           pending,
                           read=stream,
                           read_range=read_range,
                           stat=stat,
                           counts=counts,
                           show_headers=show_headers,
                           flags=parsed,
                           io=io), io
        if not readable:
            return None, io
        return tail_multi(readable,
                          read=stream,
                          n=counts.lines,
                          c=counts.byte_count,
                          from_line=counts.from_line,
                          from_byte=counts.from_byte,
                          show_headers=show_headers), io
    source = resolve_source(opts.stdin, "tail: missing operand")
    return tail(
        source,
        n=counts.lines,
        c=counts.byte_count,
        from_line=counts.from_line,
        from_byte=counts.from_byte), IOResult(stderr=retry_warning or None)
