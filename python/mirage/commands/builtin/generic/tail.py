import asyncio
import functools
import inspect
import math
from collections.abc import AsyncGenerator, AsyncIterator, Awaitable, Mapping
from contextlib import aclosing
from dataclasses import dataclass
from typing import Any, Callable

from mirage.commands.builtin.utils.links import dispatch_of
from mirage.commands.builtin.utils.operands import (
    operand_lines,
    operands_io,
    report_fs_error,
    say,
    split_opened,
)
from mirage.commands.builtin.utils.stream import (
    is_stdin,
    operand_header,
    ranged_stream,
    resolve_source,
    shows_headers,
    stdin_stat,
    stdin_stream,
)
from mirage.commands.config import Context
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import FlagValue
from mirage.errors.constants import FS_ERRORS, READ_FAILURES
from mirage.errors.fs import enoent, fs_strerror
from mirage.execution.process.session import SessionProcesses
from mirage.io.cooperative import CHUNK_SIZE, chunks
from mirage.io.memory import check_memory
from mirage.io.stream import async_chain, close_quietly
from mirage.io.types import ByteSource, IOResult, materialize
from mirage.io.yield_budget import YieldBudget
from mirage.observe.context import revision_for
from mirage.rs.errors import StreamRefusal
from mirage.rs.scan import refused, scan
from mirage.rs.select import progress
from mirage.rs.stream import close_stream, open_stream
from mirage.runtime.types import DispatchFn
from mirage.shell.bytes import encode_text
from mirage.types import (
    FileStat,
    FileType,
    JsonValue,
    PathSpec,
    PolymorphicReadFn,
    ReadStreamFn,
    StatFn,
)
from mirage.utils.quote import shell_quote

DEFAULT_SLEEP_INTERVAL = 1.0


@dataclass(frozen=True, slots=True)
class TailCounts:
    """``-n``/``-c`` split by the end they count from.

    A leading ``+`` counts forward from the start, 1-indexed, so ``+0``
    and ``+1`` both mean the whole input; any other spelling counts back
    from the end.

    Args:
        lines (int | None): lines kept from the end.
        from_line (int | None): the line printing starts at.
        byte_count (int | None): bytes kept from the end.
        from_byte (int | None): the byte printing starts at.
        terminator (int): the byte that ends a line, NUL under ``-z``.
    """

    lines: int | None = None
    from_line: int | None = None
    byte_count: int | None = None
    from_byte: int | None = None
    terminator: int = 10


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
        pid (int | None): ``--pid``; a follow ends once this process is
            gone, and 0 names none.
    """

    counts: TailCounts
    quiet: bool = False
    verbose: bool = False
    follow: bool = False
    follow_name: bool = False
    retry: bool = False
    interval: float = DEFAULT_SLEEP_INTERVAL
    pid: int | None = None


RETRY_IGNORED = (
    b"tail: warning: --retry ignored; --retry is useful only when following\n"
)
RETRY_INITIAL = b"tail: warning: --retry only effective for the initial open\n"
PID_IGNORED = (
    b"tail: warning: PID ignored; --pid=PID is useful only when following\n"
)
# A name is what -F follows, and standard input has none.
STDIN_BY_NAME = b"tail: cannot follow '-' by name\n"
# What a waited-for name is announced as when it turns up: a missing file
# has appeared, an untailable one (a directory) has become accessible.
APPEARED = "has appeared;  following new file"
ACCESSIBLE = "has become accessible"


def _follow_flags(fl: FlagView, how: str | None) -> tuple[bool, bool, bool]:
    """``-f``, ``--follow[=HOW]`` and ``-F`` as (follow, by name, retry).

    Args:
        fl (FlagView): the tail flag view.
        how (str | None): the ``--follow`` word mirage-rs read, if typed.
    """
    raw = fl.raw("follow")
    # -F is --follow=name --retry. The mode is whichever of -f/--follow
    # and -F came last, GNU's own order (`-F --follow=descriptor` follows
    # the descriptor), while -F's --retry half stays on either way.
    typed = [
        k
        for k in fl.typed_order("follow", "F")
        if (k == "F" and fl.as_bool("F"))
        or (k == "follow" and raw is not None and raw is not False)
    ]
    if not typed:
        return False, False, fl.as_bool("retry")
    by_name = how == "name" if typed[-1] == "follow" else True
    return True, by_name, fl.as_bool("retry") or "F" in typed


def _counts_of(value: JsonValue) -> tuple[int | None, int | None]:
    """A count mirage-rs read as (from the end, from the start).

    Args:
        value (JsonValue): ``{"count", "from_start"}``, or None.
    """
    if value is None:
        return None, None
    assert isinstance(value, dict)
    count = value["count"]
    assert isinstance(count, int)
    return (None, count) if value["from_start"] else (count, None)


def parse_flags(flags: Mapping[str, FlagValue]) -> TailFlags | IOResult:
    """tail's options, the values read by mirage-rs before any operand is
    resolved.

    Args:
        flags (Mapping[str, FlagValue]): the parsed flags.

    Returns:
        TailFlags | IOResult: the flags, or tail's refusal of a value.
    """
    fl = FlagView(flags, spec=SPECS["tail"])
    raw = fl.raw("follow")
    typed = fl.texts(
        "lines", "bytes", "sleep_interval", "pid", "max_unchanged_stats"
    )
    if isinstance(raw, str):
        typed.append(("follow", raw))
    try:
        values = scan("tail", typed)
    except StreamRefusal as refusal:
        return refused(refusal)
    how = values.get("follow")
    follow, by_name, retry = _follow_flags(
        fl, how if isinstance(how, str) else None
    )
    # The last of -q and -v decides, as in GNU tail, and so does the last
    # of -n and -c.
    order = fl.typed_order("quiet", "silent", "verbose")
    headers = order[-1] if order else None
    units = fl.typed_order("lines", "bytes")
    unit = units[-1] if units else None
    lines, from_line = _counts_of(None if unit == "bytes" else values["lines"])
    byte_count, from_byte = _counts_of(
        None if unit == "lines" else values["bytes"]
    )
    interval = values["sleep_interval"]
    assert interval is None or isinstance(interval, (int, float))
    pid = values["pid"]
    assert pid is None or isinstance(pid, int)
    return TailFlags(
        counts=TailCounts(
            lines,
            from_line,
            byte_count,
            from_byte,
            0 if fl.as_bool("zero_terminated") else 10,
        ),
        quiet=headers in ("quiet", "silent"),
        verbose=headers == "verbose",
        follow=follow,
        follow_name=by_name,
        retry=retry,
        interval=math.inf if interval is None else float(interval),
        pid=pid,
    )


async def tail(
    src: bytes | AsyncIterator[bytes],
    *,
    n: int | None = None,
    c: int | None = None,
    from_line: int | None = None,
    from_byte: int | None = None,
    terminator: int = 10,
) -> AsyncGenerator[bytes, None]:
    forward = from_byte is not None or from_line is not None
    byte_mode = from_byte is not None or (from_line is None and c is not None)
    count = (
        max(0, from_byte - 1)
        if from_byte is not None
        else max(0, from_line - 1)
        if from_line is not None
        else abs(c)
        if c is not None
        else abs(n if n is not None else 10)
    )
    engine = open_stream(
        "select",
        {
            "mode": "skip" if forward else "last",
            "unit": "bytes" if byte_mode else "records",
            "count": str(count),
            "terminator": terminator,
        },
    )
    budget = YieldBudget()
    try:
        async with aclosing(chunks(src)) as source:
            if engine.done():
                return
            async for chunk in source:
                if output := engine.feed(chunk):
                    yield output
                while engine.busy():
                    await budget.run()
                    if output := engine.drain():
                        yield output
                if not forward and not byte_mode:
                    check_memory(progress(engine).retained)
        if output := engine.finish():
            yield output
        while engine.busy():
            await budget.run()
            if output := engine.drain():
                yield output
    finally:
        await close_stream(engine)


async def tail_multi(
    paths: list[PathSpec | bytes],
    *,
    read: Callable[..., Any],
    n: int | None = None,
    c: int | None = None,
    from_line: int | None = None,
    from_byte: int | None = None,
    terminator: int = 10,
    show_headers: bool = False,
    unread: Mapping[str, bytes] | None = None,
    io: IOResult | None = None,
    selected: bool = False,
) -> AsyncIterator[bytes]:
    """Run tail over multiple already-resolved paths.

    Globs are expanded by the caller, so ``paths`` is a flat list of concrete
    entries. When ``show_headers`` is set a ``==> path <==`` banner is emitted
    before each file (POSIX/GNU tail with multiple files), separated by a blank
    line between files. The per-file source is produced lazily by ``read``.

    Args:
        paths (list[PathSpec | bytes]): Resolved paths, only
            ``.virtual`` read, and the stderr line of each operand that
            did not open, said on ``io`` where it stood.
        read (Callable[..., Any]): Bound reader called as ``read(path)``;
            returns bytes, an awaitable of bytes, or an async byte iterator.
        unread (Mapping[str, bytes] | None): operands that opened but do
            not read (a directory): each prints its header, then its line.
        io (IOResult | None): the result a failed read is reported on,
            so the next operand still prints; None lets it raise.
    """
    unread = unread or {}
    lines = operand_lines(paths, unread)
    printed = 0
    try:
        for i, p in enumerate(paths):
            if isinstance(p, bytes):
                if io is not None:
                    await say(io, lines.pop(i))
                continue
            header = b""
            if show_headers:
                # The blank line goes before a printed block, not an operand:
                # a file after one that printed nothing starts without it.
                header = operand_header(p, printed > 0)
            pending = header
            if p.raw_path in unread:
                if pending:
                    yield pending
                    printed += 1
                if io is not None:
                    await say(io, lines.pop(i))
                continue
            # A stream opens on its first read, so the header waits for that
            # read: an operand whose open is refused prints no header, as
            # tailGeneric's whole read does.
            try:
                source = read(p)
                if inspect.isawaitable(source):
                    source = await source
                output = (
                    chunks(source)
                    if selected
                    else tail(
                        source,
                        n=n,
                        c=c,
                        from_line=from_line,
                        from_byte=from_byte,
                        terminator=terminator,
                    )
                )
                async for chunk in output:
                    if pending:
                        yield pending
                        pending = b""
                    yield chunk
            except FS_ERRORS as exc:
                if io is None:
                    raise
                # A read that fails once the stat passed (a table past its
                # read cap) is reported, and the next operand still prints.
                # The open succeeded, so a read failure still heads it; the
                # report lands first, as a reader may stop at the header.
                await report_fs_error(io, "tail", p, exc)
                if pending and isinstance(exc, READ_FAILURES):
                    yield pending
                    pending = b""
            else:
                if pending:
                    yield pending
                    pending = b""
            if header and not pending:
                printed += 1
    finally:
        if lines and io is not None:
            await say(io, b"".join(lines.values()))


def _note(io: IOResult, message: str) -> None:
    """Append a diagnostic raised while the output streams to the
    result's stderr.

    tail's stdout is a stream the caller drains, as the file grows when
    it follows, and its stderr is the bytes on the result, which the
    caller reads once the stream ends; a notice raised mid-stream lands
    there.

    Args:
        io (IOResult): the result handed back with the stream.
        message (str): the ``tail: ...`` line, newline included.
    """
    prior = io.stderr if isinstance(io.stderr, bytes) else b""
    io.stderr = prior + encode_text(message)


async def _counted(source: Any, box: list[int]) -> AsyncGenerator[bytes, None]:
    """Pass a source through, adding up the bytes it yields.

    Args:
        source (Any): bytes, an awaitable of bytes, or an async iterator.
        box (list[int]): one-slot counter the total lands in.
    """
    if inspect.isawaitable(source):
        source = await source
    async with aclosing(chunks(source)) as stream:
        async for chunk in stream:
            box[0] += len(chunk)
            yield chunk


async def _window(
    read: Callable[..., Any],
    read_range: ReadStreamFn | None,
    path: PathSpec,
    offset: int,
    size: int,
) -> bytes:
    """The bytes a file gained past ``offset``.

    Args:
        read (Callable[..., Any]): whole-file reader, the fallback.
        read_range (ReadStreamFn | None): the backend's byte window, if
            it has one.
        path (PathSpec): the file.
        offset (int): where the last poll ended.
        size (int): how many bytes appeared.
    """
    if read_range is not None:
        return await materialize(read_range(path, offset=offset, size=size))
    return (await _whole(read, path))[offset : offset + size]


async def _whole(read: Callable[..., Any], path: PathSpec) -> bytes:
    """The file as the whole-file reader returns it, joined.

    Args:
        read (Callable[..., Any]): bound whole-file reader.
        path (PathSpec): the file.
    """
    return b"".join([chunk async for chunk in _counted(read(path), [0])])


async def _tail_file(
    path: PathSpec,
    *,
    read: PolymorphicReadFn,
    stat: StatFn,
    read_range: ReadStreamFn | None,
    last_lines: Callable[[PathSpec, int], Awaitable[bytes | None]] | None,
    counts: TailCounts,
    box: list[int] | None = None,
) -> AsyncGenerator[bytes, None]:
    """One operand's tail, a count from the end read backwards in windows
    where the backend reads ranges and the size is known.

    Args:
        path (PathSpec): the operand.
        read (PolymorphicReadFn): bound whole-file reader.
        stat (StatFn): bound stat.
        read_range (ReadStreamFn | None): the backend's byte window.
        last_lines (Callable | None): the mount's ``last_lines``.
        counts (TailCounts): what to print.
        box (list[int] | None): receives where in the file the print
            ended, which a follow polls from.
    """
    n = counts.lines if counts.lines is not None else 10
    from_end = counts.from_line is None and counts.from_byte is None
    if not is_stdin(path) and from_end:
        if (
            counts.byte_count is None
            and counts.terminator == 10
            and last_lines is not None
        ):
            answer = await last_lines(path, abs(n))
            if answer is not None:
                async for part in chunks(answer):
                    yield part
                return
        if read_range is not None and revision_for(path.virtual) is None:
            info = await stat(path)
            if (
                info.type == FileType.FILE
                and info.size is not None
                and info.size > 0
            ):
                size = info.size
                if box is not None:
                    box[0] = size
                if counts.byte_count is not None:
                    offset = max(0, size - abs(counts.byte_count))
                    if offset == size:
                        return
                    async with aclosing(
                        ranged_stream(read_range, path, offset, size)
                    ) as source:
                        async for part in source:
                            yield part
                    return
                if n == 0:
                    return
                end = size
                window = CHUNK_SIZE
                budget = YieldBudget()
                selector = open_stream(
                    "select",
                    {
                        "mode": "reverse",
                        "unit": "records",
                        "count": str(abs(n)),
                        "terminator": counts.terminator,
                    },
                )
                try:
                    while end > 0:
                        await budget.run()
                        start = max(0, end - window)
                        data = await materialize(
                            read_range(path, offset=start, size=end - start)
                        )
                        if len(data) != end - start:
                            break
                        selected: int | None = None
                        for stop in range(len(data), 0, -CHUNK_SIZE):
                            offset = max(0, stop - CHUNK_SIZE)
                            selector.feed(data[offset:stop])
                            while selector.busy():
                                await budget.run()
                                selector.drain()
                            if selector.done():
                                selected = offset + progress(selector).consumed
                                break
                            await budget.run()
                        if selected is not None or start == 0:
                            offset = selected if selected is not None else 0
                            async for part in chunks(data[offset:]):
                                yield part
                            if end < size:
                                async with aclosing(
                                    ranged_stream(read_range, path, end, size)
                                ) as source:
                                    async for part in source:
                                        yield part
                            return
                        end = start
                        window = min(window * 2, 1 << 20)
                finally:
                    await close_stream(selector)
    count = counts.byte_count if counts.byte_count is not None else n
    if box is not None and from_end and count == 0:
        # Nothing to print, but the follow starts at the file's end.
        box[0] = 0
        async with aclosing(_counted(read(path), box)) as drained:
            async for _ in drained:
                pass
        return
    raw = read(path)
    if box is not None:
        box[0] = 0
        raw = _counted(raw, box)
    elif inspect.isawaitable(raw):
        raw = await raw
    async with aclosing(
        tail(
            raw,
            n=counts.lines,
            c=counts.byte_count,
            from_line=counts.from_line,
            from_byte=counts.from_byte,
            terminator=counts.terminator,
        )
    ) as output:
        async for part in output:
            yield part


async def _polled_stat(dispatch: DispatchFn, path: PathSpec) -> FileStat:
    """A follow poll's stat: what the backend holds now, at the dispatcher.

    Past the mount's index and past the stat the command's freshness
    probe kept: the poll looks for exactly the change neither has yet.

    Args:
        dispatch (DispatchFn): the command's dispatcher.
        path (PathSpec): the followed file.
    """
    found: FileStat | None
    found, _ = await dispatch("stat", path, fresh=True)
    if found is None:
        raise enoent(path)
    return found


async def _polled_window(
    dispatch: DispatchFn,
    path: PathSpec,
    offset: int = 0,
    size: int | None = None,
) -> AsyncIterator[bytes]:
    """A follow poll's read, whole or a window: what the backend holds
    now, at the dispatcher.

    A direct read, never served from the file cache nor kept in it: the
    poll looks for exactly the bytes a cached copy does not have yet.

    Args:
        dispatch (DispatchFn): the command's dispatcher.
        path (PathSpec): the followed file.
        offset (int): where the window starts.
        size (int | None): the window's length, None for the rest.
    """
    data, _ = await dispatch(
        "read", path, filetype=None, offset=offset, size=size, direct=True
    )
    yield await materialize(data)


async def _gained(
    read_range: ReadStreamFn, io: IOResult, p: PathSpec, pos: int
) -> tuple[bytes, int]:
    """What a size-unknown file gained past ``pos``, read from there, and
    where the next poll starts. A read that finds nothing at a position
    the file no longer reaches, its byte before ``pos`` gone too, means
    it was truncated, which is noted and read from the start.

    Args:
        read_range (ReadStreamFn): the backend's byte window.
        io (IOResult): the result a truncation notice lands on.
        p (PathSpec): the file.
        pos (int): how far the previous poll read.
    """
    data = await materialize(read_range(p, offset=pos, size=None))
    if (
        not data
        and pos
        and not await materialize(read_range(p, offset=pos - 1, size=1))
    ):
        _note(io, f"tail: {p.raw_path}: file truncated\n")
        data = await materialize(read_range(p, offset=0, size=None))
        pos = 0
    return data, pos + len(data)


async def _catch_up(
    read: Callable[..., Any],
    read_range: ReadStreamFn | None,
    io: IOResult,
    p: PathSpec,
    size: int | None,
    pos: int,
) -> tuple[bytes, int]:
    """What a followed file gained past ``pos``, and where the next poll
    starts: a size-unknown file is read from ``pos`` where the backend
    reads windows (``_gained``) and otherwise read whole and measured,
    and a file shorter than ``pos`` was truncated, which is noted and
    read from the start.

    Args:
        read (Callable[..., Any]): bound whole-file reader.
        read_range (ReadStreamFn | None): the backend's byte window, if
            it has one.
        io (IOResult): the result a truncation notice lands on.
        p (PathSpec): the file.
        size (int | None): the size the poll's stat reported.
        pos (int): how far the previous poll read.
    """
    whole: bytes | None = None
    if size is None and read_range is not None:
        return await _gained(read_range, io, p, pos)
    if size is None:
        whole = await _whole(read, p)
        size = len(whole)
    if size < pos:
        _note(io, f"tail: {p.raw_path}: file truncated\n")
        pos = 0
    if size <= pos:
        return b"", pos
    data = (
        whole[pos:]
        if whole is not None
        else await _window(read, read_range, p, pos, size - pos)
    )
    return data, pos + len(data)


async def _follow(
    paths: list[PathSpec],
    pending: list[tuple[PathSpec, str]],
    *,
    first: Callable[..., AsyncGenerator[bytes, None]],
    poll_read: Callable[..., Any],
    read_range: ReadStreamFn | None,
    stat: StatFn,
    counts: TailCounts,
    show_headers: bool,
    flags: TailFlags,
    io: IOResult,
    unread: frozenset[str] = frozenset(),
    only_stdin: bool = False,
    follow_lines: int | None = None,
    follow: Callable[
        [PathSpec, int, float], Awaitable[AsyncIterator[bytes] | None]
    ]
    | None = None,
    processes: SessionProcesses | None = None,
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
    (``no files remaining``, exit 1), when ``--pid``'s process is gone
    (a poll that finds nothing new looks, and once it is gone one more
    poll reads what it wrote last), or when the caller stops draining,
    which is how ``timeout`` and a killed job end it. A followed file that a
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

    The first print is a plain tail's (``_tail_file``), printed as it
    is read, so a count from the end reads only the end where the
    backend reads windows; the polls go on from where it ended. Its
    first bytes are the open: a read that fails before them is a failed
    open, and one that fails later is reported and the file dropped the
    same way.

    A file whose stat carries no size (a backend that cannot know one
    without reading reports ``None``, never a guess) is polled by
    reading from where the last poll ended, where the backend reads
    windows, and otherwise by reading it whole every interval and
    measuring that, rather than a follow that never prints.

    One file followed by descriptor, under a count of lines from the
    end, is asked of the mount's ``follow`` first: a mount that is told
    about new lines (a change stream), or can be asked for only the new
    ones every ``-s`` seconds, hands over the last lines and then each
    new one as it lands, so the file is not read again on each poll and
    the two meet at one point.

    State is per operand, not per path: ``tail -f f f`` prints what
    ``f`` gains twice, under a header each time, as GNU does.

    Standard input is printed once and never followed: POSIX has tail
    ignore -f on a pipe, and GNU extends that to every ``-`` operand. A
    line that named nothing else has nothing left to wait for, so it
    ends there, without ``no files remaining``.

    Args:
        paths (list[PathSpec]): the operands that opened.
        pending (list[tuple[PathSpec, str]]): the ones ``--retry`` waits
            for, each with the notice that announces it.
        first (Callable[..., AsyncGenerator[bytes, None]]): a file's
            first print, ``_tail_file`` asking no ``last_lines``, whose
            answer says nothing of where the polls go on from.
        poll_read (Callable[..., Any]): the polls' whole-file reader.
        read_range (ReadStreamFn | None): the polls' byte-window reader.
        stat (StatFn): the polls' stat.
        counts (TailCounts): what the first print shows.
        show_headers (bool): the ``==> name <==`` rule.
        flags (TailFlags): the parsed flags.
        io (IOResult): the result the notices are appended to.
        unread (frozenset[str]): operands that opened but do not read (a
            directory): each prints its header, and none is followed.
        only_stdin (bool): every operand is standard input.
        follow_lines (int | None): the count of last lines ``follow`` is
            asked for; None when the count is not lines from the end, and
            the file is polled.
        follow (Callable[[PathSpec, int, float],
            Awaitable[AsyncIterator[bytes] | None]] | None): the mount's
            ``follow``; None, or an answer of None, polls. A line with a
            ``--pid`` polls, since only a poll can look for the process.
        processes (SessionProcesses | None): the session's processes, which
            ``--pid`` is looked up in.
    """
    writer = flags.pid or None
    positions: dict[int, int] = {}
    added: AsyncIterator[bytes] | None = None
    active = list(enumerate(paths))
    waiting = [(len(paths) + i, p, how) for i, (p, how) in enumerate(pending)]
    last: int | None = None

    async def lost(slot: int, p: PathSpec, exc: Exception) -> None:
        await report_fs_error(io, "tail", p, exc)
        active.remove((slot, p))
        if flags.retry:
            waiting.append((slot, p, APPEARED))

    # The stream follow opened holds the mount busy, so it closes however
    # the print ends, a reader that stops early included.
    try:
        for slot, p in list(active):
            if p.raw_path in unread:
                if show_headers:
                    yield operand_header(p, last is not None)
                last = slot
                active.remove((slot, p))
                continue
            box = [0]
            printed: AsyncGenerator[bytes, None] | None = None
            head: bytes | None = None
            try:
                if (
                    follow is not None
                    and follow_lines is not None
                    and len(paths) == 1
                    and not pending
                    and not flags.follow_name
                    and writer is None
                    and not is_stdin(p)
                ):
                    added = await follow(p, follow_lines, flags.interval)
                # A follow's stream holds the first print too.
                if added is None:
                    printed = first(p, box=box)
                    head = await anext(printed, None)
            except FS_ERRORS as exc:
                if added is not None:
                    await close_quietly(added)
                    added = None
                if printed is not None:
                    await printed.aclose()
                # There is no handle to hold, so this first read is the
                # open: one that fails after the operand's stat passed is
                # GNU's failed open, reported the way the stat's failure
                # would have been, and under --retry waited for like a
                # file that was never there (this is the initial open that
                # a descriptor follow's --retry covers).
                await lost(slot, p, exc)
                continue
            header = (
                operand_header(p, last is not None) if show_headers else b""
            )
            last = slot
            if printed is None:
                if header:
                    yield header
                continue
            # The header goes out inside the scope that closes the opened
            # read, so a reader that stops at the header closes it too.
            async with aclosing(printed):
                try:
                    if header:
                        yield header
                    if head is not None:
                        yield head
                    async for chunk in printed:
                        yield chunk
                except FS_ERRORS as exc:
                    await lost(slot, p, exc)
                    continue
            positions[slot] = box[0]
        if added is not None:
            async for chunk in added:
                yield chunk
            _note(io, "tail: no files remaining\n")
            io.exit_code = 1
            return
    finally:
        if added is not None:
            await close_quietly(added)
    active = [(slot, p) for slot, p in active if not is_stdin(p)]
    if only_stdin:
        return
    gone = False
    idle = True
    while active or waiting:
        if writer is not None and idle:
            if gone:
                return
            gone = not _writer_runs(processes, writer)
        if not gone:
            await asyncio.sleep(flags.interval)
        idle = True
        for slot, p, how in list(waiting):
            try:
                found = await stat(p)
            except FS_ERRORS:
                # The name is gone now, so whatever stands there next
                # has appeared, whatever stood there before.
                if how != APPEARED:
                    waiting[waiting.index((slot, p, how))] = (
                        slot,
                        p,
                        APPEARED,
                    )
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
                    grown = await _catch_up(
                        poll_read,
                        read_range,
                        io,
                        p,
                        current.size,
                        positions[slot],
                    )
            except IsADirectoryError:
                grown = None
            except FS_ERRORS as exc:
                # A path that went away, whether its stat failed or the
                # read right after it did (a rotation between the two).
                # Only name-following notices; under a descriptor
                # --retry covers the initial open alone, as in GNU,
                # which words the loss as an inaccessible name only
                # when it means to wait for the name to come back.
                if flags.follow_name:
                    _note(
                        io,
                        f"tail: '{p.raw_path}' has become inaccessible: "
                        f"{fs_strerror(exc)}\n"
                        if flags.retry
                        else f"tail: {shell_quote(p.raw_path)}: {fs_strerror(exc)}\n",
                    )
                    active.remove((slot, p))
                    if flags.retry:
                        waiting.append((slot, p, APPEARED))
                continue
            if grown is None:
                if not flags.follow_name:
                    continue
                line = f"tail: '{p.raw_path}' has been replaced with an untailable file"
                _note(
                    io,
                    line
                    + ("\n" if flags.retry else "; giving up on this name\n"),
                )
                active.remove((slot, p))
                if flags.retry:
                    waiting.append((slot, p, ACCESSIBLE))
                continue
            data, positions[slot] = grown
            if data:
                if show_headers and last != slot:
                    yield operand_header(p, True)
                last = slot
                idle = False
                yield data
    _note(io, "tail: no files remaining\n")
    io.exit_code = 1


def _writer_runs(processes: SessionProcesses | None, pid: int) -> bool:
    """Whether ``--pid``'s process still runs, as ``kill(pid, 0)``
    answers: one the session cannot see is gone, and one it sees but may
    not signal still runs.

    Args:
        processes (SessionProcesses | None): the session's processes.
        pid (int): the process.
    """
    if processes is None:
        return False
    try:
        return processes.probe(pid)
    except PermissionError:
        return True


async def _unfollowable(
    paths: list[PathSpec],
    readable: list[PathSpec],
    stat: StatFn,
    flags: TailFlags,
    io: IOResult,
) -> list[tuple[PathSpec, str]]:
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
    parsed: TailFlags,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
    stat: StatFn,
    stream: PolymorphicReadFn,
    read_range: ReadStreamFn | None = None,
    last_lines: Callable[[PathSpec, int], Awaitable[bytes | None]]
    | None = None,
    follow: Callable[
        [PathSpec, int, float], Awaitable[AsyncIterator[bytes] | None]
    ]
    | None = None,
) -> tuple[ByteSource | None, IOResult]:
    """Run tail over resolved operands, GNU semantics; mirrors tailGeneric.

    The wiring resolves globs and binds the backend ops; everything else
    lives here: flag parsing, the header rule, the per-operand
    report-and-continue split, and the stdin fallback. A line count
    from the end (``-n N``, or the default 10) is asked of
    ``last_lines`` first, so a mount that can fetch the end of a file on
    its own does not send the rest; ``-f`` on one file asks ``follow``
    (see ``_follow``).

    Args:
        parsed (TailFlags): the options, read before the operands were.
        paths (list[PathSpec]): Glob-resolved operands, empty for stdin.
        texts (list[str]): Non-path words, unused by tail.
        ctx (Context): Flags and stdin from the dispatcher.
        stat (StatFn): Bound stat called as ``stat(path)``.
        stream (PolymorphicReadFn): Bound reader called as
            ``stream(path)``.
        read_range (ReadStreamFn | None): Bound byte-window reader
            called as ``read_range(path, offset, size)``, for a seekable
            tail or a follow that only wants what the file gained.
        last_lines (Callable[[PathSpec, int], Awaitable[bytes | None]]
            | None): the mount's ``last_lines`` called as
            ``last_lines(path, n)``; None, or an answer of None, reads
            the file.
        follow (Callable[[PathSpec, int, float],
            Awaitable[AsyncIterator[bytes] | None]] | None): the mount's
            ``follow`` called as ``follow(path, n, interval)``; None, or
            an answer of None, polls.
    """
    stat = stdin_stat(stat)
    stream = stdin_stream(stream, ctx.stdin)
    counts = parsed.counts
    n = counts.lines if counts.lines is not None else 10
    from_end = (
        counts.byte_count is None
        and counts.from_line is None
        and counts.from_byte is None
        and counts.terminator == 10
    )
    if (
        parsed.follow
        and parsed.follow_name
        and (not paths or any(is_stdin(p) for p in paths))
    ):
        return None, IOResult(exit_code=1, stderr=STDIN_BY_NAME)
    # The warnings come first, then tail runs as if --retry and --pid were
    # not there; a descriptor it follows only after the initial open says
    # so too.
    warnings = (
        RETRY_IGNORED
        if parsed.retry and not parsed.follow
        else RETRY_INITIAL
        if parsed.retry and not parsed.follow_name
        else b""
    ) + (PID_IGNORED if parsed.pid is not None and not parsed.follow else b"")
    # GNU opens nothing when a tail from the end keeps no line or byte.
    if (
        not parsed.follow
        and counts.from_line is None
        and counts.from_byte is None
        and (n if counts.byte_count is None else counts.byte_count) == 0
    ):
        return None, IOResult(stderr=warnings or None)
    if paths:
        show_headers = shows_headers(parsed.verbose, parsed.quiet, len(paths))
        order, unread = await split_opened(paths, stat, "tail")
        opened = [p for p in order if isinstance(p, PathSpec)]
        io = operands_io(
            b"".join(operand_lines(order, unread).values())
            if parsed.follow or not opened
            else b""
        )
        if not parsed.follow and (len(opened) < len(order) or unread):
            io.exit_code = 1
        if warnings:
            io.stderr = warnings + (
                io.stderr if isinstance(io.stderr, bytes) else b""
            )
        if parsed.follow:
            readable = [p for p in opened if p.raw_path not in unread]
            pending = await _unfollowable(paths, readable, stat, parsed, io)
            if not readable and not pending and not (show_headers and opened):
                _note(io, "tail: no files remaining\n")
                io.exit_code = 1
                return None, io
            # The first print reads like any other tail; the polls ask
            # the dispatcher for what the backend holds now, past the file
            # cache and past the stat the command's freshness probe kept:
            # they look for exactly the change neither has yet.
            poll_stat, poll_read, poll_range = stat, stream, read_range
            if (dispatch := dispatch_of(ctx)) is not None:
                poll_stat = functools.partial(_polled_stat, dispatch)
                poll_read = functools.partial(_polled_window, dispatch)
                poll_range = poll_read
            return _follow(
                opened,
                pending,
                first=functools.partial(
                    _tail_file,
                    read=stream,
                    stat=stat,
                    read_range=read_range,
                    last_lines=None,
                    counts=counts,
                ),
                poll_read=poll_read,
                read_range=poll_range,
                stat=poll_stat,
                counts=counts,
                show_headers=show_headers,
                flags=parsed,
                io=io,
                unread=frozenset(unread),
                only_stdin=all(is_stdin(p) for p in paths),
                follow_lines=n if from_end else None,
                follow=follow,
                processes=ctx.processes,
            ), io
        if not opened:
            return None, io
        return tail_multi(
            order,
            read=functools.partial(
                _tail_file,
                read=stream,
                stat=stat,
                read_range=read_range,
                last_lines=last_lines,
                counts=counts,
            ),
            selected=True,
            n=counts.lines,
            c=counts.byte_count,
            from_line=counts.from_line,
            from_byte=counts.from_byte,
            terminator=counts.terminator,
            show_headers=show_headers,
            unread=unread,
            io=io,
        ), io
    source = resolve_source(ctx.stdin)
    body: AsyncIterator[bytes] = tail(
        source,
        n=counts.lines,
        c=counts.byte_count,
        from_line=counts.from_line,
        from_byte=counts.from_byte,
        terminator=counts.terminator,
    )
    if parsed.verbose and not parsed.quiet:
        # -v heads a stdin nobody named with the name it gives `-`.
        body = async_chain([operand_header(None), body])
    return body, IOResult(stderr=warnings or None)
