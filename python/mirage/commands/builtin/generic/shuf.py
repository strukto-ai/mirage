import logging
from collections.abc import (
    AsyncIterator,
    Awaitable,
    Callable,
    Mapping,
    Sequence,
)
from contextlib import aclosing
from dataclasses import dataclass
from functools import partial

from mirage.commands.builtin.utils.random_source import (
    RandomSource,
    RandomSourceError,
)
from mirage.commands.builtin.utils.stream import stdin_stream
from mirage.commands.quote import quote_text
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import FlagValue
from mirage.commands.spec.usage import usage_hint
from mirage.errors.constants import FS_ERRORS
from mirage.errors.fs import fs_strerror
from mirage.io.cooperative import CHUNK_SIZE
from mirage.io.spool import ByteSpool
from mirage.io.stream import (
    OutputStream,
    close_quietly,
    prime_stream,
    rechunk,
)
from mirage.io.types import ByteSource, IOResult
from mirage.io.yield_budget import YieldBudget
from mirage.rs.errors import StreamRefusal
from mirage.rs.scan import refused, scan
from mirage.rs.stream import (
    OpenStream,
    Served,
    close_stream,
    open_stream,
    run_stream,
    serve_requests,
)
from mirage.types import JsonValue, LineFacts, PathSpec, PolymorphicReadFn
from mirage.utils.ids import IdSource, SystemIdSource
from mirage.utils.key_prefix import mount_key

logger = logging.getLogger(__name__)

# A `-o` reached a backend wired without a write op, which is a wiring
# fault rather than anything the command line did wrong. The TypeScript
# twin throws a bare `Error` for it where it RETURNS an IOResult for
# every user-facing refusal, so the builder's local catch has to let
# this one through; naming it here is what keeps the two in step.
NO_WRITE_OP = "shuf: backend provides no write op"

_TRY_HELP = "\n" + usage_hint("shuf")


@dataclass(frozen=True, slots=True)
class ShufFlags:
    count: int | None = None
    echo: bool = False
    zero_terminated: bool = False
    with_replacement: bool = False
    input_range: tuple[int, int] | None = None
    output: PathSpec | None = None
    random_source: PathSpec | None = None


def emit_count(
    available: int, count: int | None, with_replacement: bool
) -> int:
    """How many lines shuf will emit, before any of them are built.

    Computed rather than discovered, because ``-i`` can name 2**64
    values and GNU answers ``-i 1-18446744073709551615 -n 3`` instantly
    by never building the population (SH5). Knowing the emitted count up
    front is what lets the range path sample instead of enumerate, and
    what lets mirage-rs refuse a range it cannot hold without
    allocating it.

    ``-r`` draws independently, so it emits exactly the requested count
    however few values it is drawing from -- except from nothing at all,
    which emits nothing. Without ``-r`` the count is a head count over a
    permutation, so it cannot exceed what is available.

    Args:
        available (int): how many values the source holds; for ``-i``
            the element count, which may be far past 2**53.
        count (int | None): the ``-n`` value, already clamped to
            ``SIZE_MAX``, or None when the line carried no ``-n``.
        with_replacement (bool): whether ``-r`` was given.

    Returns:
        int: the number of lines the command will render.
    """
    if with_replacement:
        if available == 0:
            return 0
        return available if count is None else count
    if count is None:
        return available
    return min(count, available)


def parse_flags(flags: Mapping[str, FlagValue]) -> ShufFlags | IOResult:
    """shuf's options, ``-n``, ``-i``, ``-o`` and ``-e`` read by mirage-rs
    before any operand is resolved, each where it was typed.

    Args:
        flags (Mapping[str, FlagValue]): the dispatcher's flag bag.

    Returns:
        ShufFlags | IOResult: the flags, or shuf's refusal.
    """
    fl = FlagView(flags, spec=SPECS["shuf"])
    # GNU compares two -o by the words typed, which the tape holds resolved.
    words = {
        option: iter(p.raw_path or p.virtual for p in fl.as_paths(option))
        for option in ("output", "random_source")
    }
    typed = [
        (name, next(words[name]) if name in words else text)
        for name, text in fl.texts(
            "head_count", "input_range", "output", "echo", "random_source"
        )
    ]
    try:
        values = scan("shuf", typed)
    except StreamRefusal as refusal:
        return refused(refusal)
    count = values["count"]
    bounds = values["range"]
    if count is not None and not isinstance(count, str):
        raise TypeError(f"shuf: mirage-rs read -n as {count!r}")
    input_range: tuple[int, int] | None = None
    if bounds is not None:
        if not (
            isinstance(bounds, list)
            and len(bounds) == 2
            and all(isinstance(bound, str) for bound in bounds)
        ):
            raise TypeError(f"shuf: mirage-rs read -i as {bounds!r}")
        input_range = (int(str(bounds[0])), int(str(bounds[1])))
    outputs = fl.as_paths("output")
    sources = fl.as_paths("random_source")
    return ShufFlags(
        count=None if count is None else int(count),
        echo=fl.as_bool("echo"),
        zero_terminated=fl.as_bool("zero_terminated"),
        with_replacement=fl.as_bool("repeat"),
        input_range=input_range,
        output=outputs[-1] if outputs else None,
        random_source=sources[-1] if sources else None,
    )


class ShufHost:
    """Async storage and injected randomness for the shared shuffle engine:
    the workspace's, or the bytes of a ``--random-source`` file. Each word
    takes four bytes of that file where GNU takes only the bits a draw
    needs, so a short file runs out sooner and the order differs."""

    def __init__(
        self,
        ids: IdSource | RandomSource,
        stream: OpenStream,
        spools: dict[int, ByteSpool],
    ) -> None:
        self.ids = ids
        self.stream = stream
        self.spools = spools
        self.errors = ByteSpool()
        self.closed = False

    async def serve(
        self, request: Mapping[str, JsonValue], data: bytes
    ) -> Served:
        op = request["op"]
        if op == "words":
            count = request["count"]
            assert isinstance(count, int)
            if isinstance(self.ids, RandomSource):
                return Served({}, await self.ids.take(count * 4))
            return Served({}, self.ids.random_words(count))
        spool = request.get(
            "spool", int(op == "swap" or request.get("index") is True)
        )
        assert isinstance(spool, int)
        if op == "close":
            store = self.spools.pop(spool, None)
            if store is not None:
                await store.close()
            return Served({})
        if op == "write":
            if spool not in self.spools:
                self.spools[spool] = ByteSpool(0)
            await self.spools[spool].append(data)
            return Served({})
        store = self.spools[spool]
        if op == "read":
            offset, size = request["offset"], request["size"]
            assert isinstance(offset, int) and isinstance(size, int)
            return Served({}, await store.read(offset, size))
        if op == "swap":
            left, right = request["left"], request["right"]
            assert isinstance(left, int) and isinstance(right, int)
            first = await store.read(left * 16, 16)
            second = await store.read(right * 16, 16)
            await store.write(left * 16, second)
            await store.write(right * 16, first)
            return Served({})
        raise ValueError(f"shuf: unknown request {op}")

    async def close(self) -> None:
        if self.closed:
            return
        self.closed = True
        failures: list[BaseException] = []
        closers: tuple[Callable[[], Awaitable[None]], ...] = (
            partial(close_stream, self.stream),
            self.errors.close,
            *((self.ids.close,) if isinstance(self.ids, RandomSource) else ()),
            *(spool.close for spool in self.spools.values()),
        )
        for close in closers:
            try:
                await close()
            except BaseException as exc:
                failures.append(exc)
        self.spools.clear()
        if failures:
            for failure in failures[1:]:
                logger.debug("shuf cleanup failed", exc_info=failure)
            raise failures[0]


def _engine(
    ids: IdSource | RandomSource,
    config: Mapping[str, JsonValue],
    spools: dict[int, ByteSpool] | None = None,
) -> ByteSource:
    stream = open_stream("shuf", config)
    host = ShufHost(ids, stream, spools or {})
    return rechunk(
        OutputStream(serve_requests(stream, host), host.close), CHUNK_SIZE
    )


async def _sample_records(
    ids: IdSource | RandomSource,
    paths: list[PathSpec],
    read: PolymorphicReadFn,
    stdin: ByteSource | None,
    sep: str,
    count: int | None,
    repeat: bool,
) -> ByteSource:
    stream = stdin_stream(read, stdin)
    terminator = sep.encode()
    data = ByteSpool()
    try:
        for source in (
            [stream(path) for path in paths] if paths else [stdin or b""]
        ):
            await data.fill(source)
            if data.size and await data.read(data.size - 1, 1) != terminator:
                await data.append(terminator)
        async with aclosing(
            run_stream(
                "shuf",
                {"mode": "count", "separator": terminator[0]},
                data.stream(),
            )
        ) as output:
            available = int(b"".join([chunk async for chunk in output]))
        need = emit_count(available, count, repeat)
        return _engine(
            ids,
            {
                "mode": "records",
                "separator": terminator[0],
                "size": data.size,
                "available": available,
                "need": str(need),
                "repeat": repeat,
            },
            {0: data},
        )
    except BaseException:
        await data.close()
        raise


async def _sample_items(
    ids: IdSource | RandomSource,
    items: list[str],
    count: int | None,
    repeat: bool,
    separator: int,
) -> ByteSource:
    need = emit_count(len(items), count, repeat)
    data, index = ByteSpool(), ByteSpool()
    try:
        budget = YieldBudget()
        for item in items:
            await budget.run()
            raw = item.encode()
            await index.append(
                data.size.to_bytes(8, "little")
                + len(raw).to_bytes(8, "little")
            )
            await data.append(raw)
        return _engine(
            ids,
            {
                "mode": "indexed",
                "separator": separator,
                "size": data.size,
                "available": len(items),
                "need": str(need),
                "repeat": repeat,
            },
            {0: data, 1: index},
        )
    except BaseException:
        await data.close()
        await index.close()
        raise


async def _drawn(rendered: ByteSource, io: IOResult) -> AsyncIterator[bytes]:
    """The output, ending at the first draw a ``--random-source`` file
    cannot make, whose refusal settles ``io``.

    Args:
        rendered (ByteSource): the engine's output.
        io (IOResult): receives the refusal and its status.
    """
    if isinstance(rendered, bytes):
        yield rendered
        return
    try:
        async for chunk in rendered:
            yield chunk
    except RandomSourceError as exc:
        io.exit_code = 1
        io.stderr = f"{exc}\n".encode()
    finally:
        await close_quietly(rendered)


async def shuf_generic(
    paths: list[PathSpec],
    texts: list[str],
    *,
    read: PolymorphicReadFn,
    stdin: ByteSource | None = None,
    count: int | None = None,
    echo: bool = False,
    zero_terminated: bool = False,
    with_replacement: bool = False,
    input_range: tuple[int, int] | None = None,
    output: PathSpec | None = None,
    write_bytes: Callable[[PathSpec, ByteSource], Awaitable[None]]
    | None = None,
    root: str = "",
    ids: IdSource | None = None,
    random_source: PathSpec | None = None,
) -> tuple[ByteSource | None, IOResult]:
    draws: IdSource | RandomSource = (
        RandomSource("shuf", random_source, stdin_stream(read, stdin))
        if random_source is not None
        else ids
        if ids is not None
        else SystemIdSource()
    )
    sep = "\x00" if zero_terminated else "\n"
    rendered: ByteSource

    if input_range is not None:
        if paths:
            # GNU: -i names the input, so a file operand is one too many.
            word = paths[0].raw_path or paths[0].virtual
            raise ValueError(
                f"shuf: extra operand '{quote_text(word)}'" + _TRY_HELP
            )
        low, high = input_range
        need = emit_count(high - low + 1, count, with_replacement)
        try:
            rendered = _engine(
                draws,
                {
                    "mode": "range",
                    "separator": ord(sep),
                    "low": str(low),
                    "high": str(high),
                    "need": str(need),
                    "repeat": with_replacement,
                },
            )
        except StreamRefusal as refusal:
            return None, refused(refusal)
    elif echo:
        # An operand -e echoes is named below the mount the command runs
        # on, ``root``.
        items = (
            ["/" + mount_key(p.virtual, root) for p in paths]
            if paths
            else list(texts)
        )
        rendered = await _sample_items(
            draws, items, count, with_replacement, ord(sep)
        )
    else:
        if len(paths) > 1:
            # GNU: shuf reads one input, so a second file is one too many.
            word = paths[1].raw_path or paths[1].virtual
            raise ValueError(
                f"shuf: extra operand '{quote_text(word)}'" + _TRY_HELP
            )
        rendered = await _sample_records(
            draws, paths, read, stdin, sep, count, with_replacement
        )
    io = IOResult()
    if random_source is not None:
        if output is not None and not isinstance(rendered, bytes):
            # GNU draws before it creates the output, so a source that
            # cannot answer leaves none behind.
            try:
                rendered = await prime_stream(rendered)
            except RandomSourceError as exc:
                return None, IOResult(exit_code=1, stderr=f"{exc}\n".encode())
        rendered = _drawn(rendered, io)
    if output is not None:
        if write_bytes is None:
            await close_quietly(rendered)
            raise ValueError(NO_WRITE_OP)
        try:
            await write_bytes(output, rendered)
        except FS_ERRORS as exc:
            return None, IOResult(
                exit_code=1,
                stderr=f"shuf: {output.raw_path}: {fs_strerror(exc)}\n".encode(),
            )
        finally:
            await close_quietly(rendered)
        return None, io
    return rendered, io


def facts(fl: FlagView, operands: Sequence[str | PathSpec]) -> LineFacts:
    """A shuf line writes only the file ``-o`` names.

    Args:
        fl (FlagView): spec-validated view over the raw flag kwargs.
        operands (Sequence[str | PathSpec]): the line's operands.
    """
    return LineFacts(writes=fl.raw("output") is not None)


__all__ = [
    "facts",
    "NO_WRITE_OP",
    "ShufFlags",
    "emit_count",
    "parse_flags",
    "shuf_generic",
]
