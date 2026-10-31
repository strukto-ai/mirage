import logging
from collections.abc import (
    Awaitable,
    Callable,
    Mapping,
    Sequence,
)
from contextlib import aclosing
from dataclasses import dataclass
from functools import partial

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
from mirage.io.stream import OutputStream, close_quietly, rechunk
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

# GNU's own out-of-memory wording, exit 1. It is what real shuf answers
# with when a range is too large to materialize, so it is borrowed
# rather than invented. Measured, ground truth SH5.
MEMORY_EXHAUSTED = "shuf: memory exhausted"

_TRY_HELP = "\n" + usage_hint("shuf")

# Preserve the existing one-million-record output limit. Output now streams;
# this limit bounds shuffle indexes and sampling state, not rendered bytes.
# GNU has no fixed ceiling and may enumerate larger populations.
MAX_OUTPUT_LINES = 1_000_000


@dataclass(frozen=True, slots=True)
class ShufFlags:
    count: int | None = None
    echo: bool = False
    zero_terminated: bool = False
    with_replacement: bool = False
    input_range: tuple[int, int] | None = None
    output: PathSpec | None = None


def emit_count(
    available: int, count: int | None, with_replacement: bool
) -> int:
    """How many lines shuf will emit, before any of them are built.

    Computed rather than discovered, because ``-i`` can name 2**64
    values and GNU answers ``-i 1-18446744073709551615 -n 3`` instantly
    by never building the population (SH5). Knowing the emitted count up
    front is what lets the range path sample instead of enumerate, and
    what lets an output larger than `MAX_OUTPUT_LINES` be refused
    without allocating it.

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
    words = iter(p.raw_path or p.virtual for p in fl.as_paths("output"))
    typed = [
        (name, next(words) if name == "output" else text)
        for name, text in fl.texts(
            "head_count", "input_range", "output", "echo"
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
    return ShufFlags(
        count=None if count is None else int(count),
        echo=fl.as_bool("echo"),
        zero_terminated=fl.as_bool("zero_terminated"),
        with_replacement=fl.as_bool("repeat"),
        input_range=input_range,
        output=outputs[-1] if outputs else None,
    )


def _need(available: int, count: int | None, with_replacement: bool) -> int:
    """`emit_count`, enforcing the existing output-record ceiling.

    Args:
        available (int): how many values the source holds.
        count (int | None): the clamped ``-n`` value, or None.
        with_replacement (bool): whether ``-r`` was given.

    Raises:
        ValueError: `MEMORY_EXHAUSTED`, which the builder turns into
            GNU's one-line stderr and exit 1.
    """
    need = emit_count(available, count, with_replacement)
    if need > MAX_OUTPUT_LINES:
        raise ValueError(MEMORY_EXHAUSTED)
    return need


class ShufHost:
    """Async storage and injected randomness for the shared shuffle engine."""

    def __init__(
        self, ids: IdSource, stream: OpenStream, spools: dict[int, ByteSpool]
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
    ids: IdSource,
    config: Mapping[str, JsonValue],
    spools: dict[int, ByteSpool] | None = None,
) -> ByteSource:
    stream = open_stream("shuf", config)
    host = ShufHost(ids, stream, spools or {})
    return rechunk(
        OutputStream(serve_requests(stream, host), host.close), CHUNK_SIZE
    )


async def _sample_records(
    ids: IdSource,
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
        need = _need(available, count, repeat)
        return _engine(
            ids,
            {
                "mode": "records",
                "separator": terminator[0],
                "size": data.size,
                "available": available,
                "need": need,
                "repeat": repeat,
            },
            {0: data},
        )
    except BaseException:
        await data.close()
        raise


async def _sample_items(
    ids: IdSource,
    items: list[str],
    count: int | None,
    repeat: bool,
    separator: int,
) -> ByteSource:
    need = _need(len(items), count, repeat)
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
                "need": need,
                "repeat": repeat,
            },
            {0: data, 1: index},
        )
    except BaseException:
        await data.close()
        await index.close()
        raise


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
) -> tuple[ByteSource | None, IOResult]:
    ids = ids if ids is not None else SystemIdSource()
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
        need = _need(high - low + 1, count, with_replacement)
        rendered = _engine(
            ids,
            {
                "mode": "range",
                "separator": ord(sep),
                "low": str(low),
                "high": str(high),
                "need": need,
                "repeat": with_replacement,
            },
        )
    elif echo:
        # An operand -e echoes is named below the mount the command runs
        # on, ``root``.
        items = (
            ["/" + mount_key(p.virtual, root) for p in paths]
            if paths
            else list(texts)
        )
        rendered = await _sample_items(
            ids, items, count, with_replacement, ord(sep)
        )
    else:
        rendered = await _sample_records(
            ids, paths, read, stdin, sep, count, with_replacement
        )
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
        return None, IOResult()
    return rendered, IOResult()


def facts(fl: FlagView, operands: Sequence[str | PathSpec]) -> LineFacts:
    """A shuf line writes only the file ``-o`` names.

    Args:
        fl (FlagView): spec-validated view over the raw flag kwargs.
        operands (Sequence[str | PathSpec]): the line's operands.
    """
    return LineFacts(writes=fl.raw("output") is not None)


__all__ = [
    "facts",
    "MAX_OUTPUT_LINES",
    "MEMORY_EXHAUSTED",
    "NO_WRITE_OP",
    "ShufFlags",
    "emit_count",
    "parse_flags",
    "shuf_generic",
]
