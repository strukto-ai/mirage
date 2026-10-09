from collections.abc import AsyncIterator, Awaitable, Callable, Iterator
from dataclasses import dataclass
from enum import Enum
from functools import partial
from itertools import islice

from mirage.commands.builtin.constants import (
    SPLIT_BYTE_SUFFIXES,
    SPLIT_BYTE_UNITS,
    SPLIT_COUNT_PATTERN,
    SPLIT_DIGITS,
    SPLIT_HEX_DIGITS,
    SPLIT_TRY_HELP,
    UINTMAX,
)
from mirage.commands.builtin.utils.stream import resolve_source
from mirage.commands.errors import UsageError
from mirage.commands.quote import quote_text
from mirage.commands.spec.types import CommandName
from mirage.commands.spec.usage import extra_operand_error
from mirage.errors.constants import FS_ERRORS
from mirage.errors.fs import fs_strerror
from mirage.io.async_line_iterator import AsyncLineIterator
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key
from mirage.utils.path import resolve_path


class ChunkKind(Enum):
    """The three ``-n`` modes: byte chunks, record chunks, round robin."""

    BYTES = "bytes"
    LINES = "l"
    ROUND_ROBIN = "r"


_CHUNK_KIND_PREFIXES = (("l/", ChunkKind.LINES), ("r/", ChunkKind.ROUND_ROBIN))


@dataclass(frozen=True, slots=True)
class ChunkSpec:
    """A parsed ``-n`` value.

    Args:
        kind (ChunkKind): how the input is cut.
        count (int): N, the number of chunks.
        only (int | None): K of ``K/N``: the one chunk written to stdout,
            with no output file created at all; None writes every chunk
            to its own file.
    """

    kind: ChunkKind
    count: int
    only: int | None = None


def parse_bytes_value(value: str) -> int:
    """GNU ``split -b`` byte count: base-10 digits plus a size suffix.

    Args:
        value (str): the raw flag value, e.g. ``4``, ``1K``, ``2GiB``.
    """
    suffix = next((u for u in SPLIT_BYTE_SUFFIXES if value.endswith(u)), "")
    digits = value[: -len(suffix)] if suffix else value
    if SPLIT_COUNT_PATTERN.fullmatch(digits) is None or int(digits) == 0:
        raise UsageError(
            f"split: invalid number of bytes: '{quote_text(value)}'", 1
        )
    return int(digits) * SPLIT_BYTE_UNITS.get(suffix, 1)


def parse_lines_value(value: str) -> int:
    """GNU ``split -l`` line count: base-10 digits, no suffixes.

    Args:
        value (str): the raw flag value.
    """
    if SPLIT_COUNT_PATTERN.fullmatch(value) is None or int(value) == 0:
        raise UsageError(
            f"split: invalid number of lines: '{quote_text(value)}'", 1
        )
    return int(value)


def parse_chunks_value(value: str) -> ChunkSpec:
    """GNU ``split -n``: ``N``, ``K/N``, ``l/N``, ``l/K/N``, ``r/N``, ``r/K/N``
    (``KIND/K/N`` selects one chunk).

    Args:
        value (str): the raw flag value, e.g. ``4``, ``l/4``, ``2/3``.
    """
    # GNU strips ONE leading `l/` or `r/` and then cuts what is left at
    # its FIRST slash into K and N: a K it cannot parse names the whole
    # remainder, and every other refusal names N, which is the rest of
    # the spec however many slashes that still holds. Measured on
    # coreutils 9.4: `l/xé/4` names `xé/4`, `2/3/4` and `l/2/3/4` name
    # `3/4`, `l//4` names `/4`, `r/l/4` names `l/4`, and `+l/2` and
    # `x/3` name themselves because neither carries a kind prefix.
    # mirage used to name the whole spec for every malformed head and
    # credited that to 9.7; 9.4 disagrees, and so does the accepted set
    # -- a third component is N's problem, not a head component.
    # A K that parses but is 0 or past N is its own refusal, `invalid
    # chunk number`, checked after N (coreutils 9.7: `4/3` and `0/3`
    # name K, `3/0` names N).
    kind = ChunkKind.BYTES
    spec = value
    for prefix, prefixed_kind in _CHUNK_KIND_PREFIXES:
        if value.startswith(prefix):
            kind = prefixed_kind
            spec = value[len(prefix) :]
            break
    head, slash, tail = spec.partition("/")
    if slash and SPLIT_COUNT_PATTERN.fullmatch(head) is None:
        raise UsageError(
            f"split: invalid number of chunks: '{quote_text(spec)}'", 1
        )
    count_raw = tail if slash else head
    if SPLIT_COUNT_PATTERN.fullmatch(count_raw) is None or int(count_raw) == 0:
        raise UsageError(
            f"split: invalid number of chunks: '{quote_text(count_raw)}'", 1
        )
    count = int(count_raw)
    only: int | None = None
    if slash:
        only = int(head)
        if only == 0 or only > count:
            raise UsageError(
                f"split: invalid chunk number: '{quote_text(head)}'", 1
            )
    return ChunkSpec(kind, count, only)


def parse_suffix_length(value: str) -> int:
    """GNU ``split -a`` suffix length: base-10 digits, 0 means auto.

    Args:
        value (str): the raw flag value.
    """
    if SPLIT_COUNT_PATTERN.fullmatch(value) is None:
        raise UsageError(
            f"split: invalid suffix length: '{quote_text(value)}'", 1
        )
    length = int(value)
    # xstrtoumax overflow: past 2**64 - 1 GNU refuses the width at parse
    # time (byte and line counts saturate instead — a count bigger than
    # the input reads the same either way, but a width this size would be
    # built into a file name).
    if length > UINTMAX:
        raise UsageError(
            f"split: invalid suffix length: '{quote_text(value)}': "
            "Value too large for defined data type",
            1,
        )
    return length


def parse_suffix_start(value: str, hex_mode: bool, suffix_len: int) -> int:
    """GNU ``--numeric-suffixes=``/``--hex-suffixes=`` start value.

    The refused value is named through gnulib's ``quote()`` like every
    other word split reports, and it comes FIRST in this clause where
    the four count clauses put it last (measured on coreutils 9.4:
    ``split: 'x\\303\\251': invalid start value for numerical
    suffix``).

    Hex digits are lower case only, as GNU's own suffixes are:
    ``--hex-suffixes=A`` is refused (coreutils 9.7).

    Args:
        value (str): the raw start value; hex digits when ``hex_mode``.
        hex_mode (bool): parse base 16 (``--hex-suffixes``) or base 10.
        suffix_len (int): the effective suffix width the start must fit.
    """
    # An empty value (`--numeric-suffixes=`) is a start of 0 that still
    # pins the width, since GNU checks `strspn` over an empty string and
    # keeps the pointer; only an absent value auto-lengthens.
    if value == "":
        return 0
    pattern = SPLIT_HEX_DIGITS if hex_mode else SPLIT_DIGITS
    if pattern.fullmatch(value) is None:
        kind = "hexadecimal" if hex_mode else "numerical"
        raise UsageError(
            f"split: '{quote_text(value)}': invalid start value for "
            f"{kind} suffix" + SPLIT_TRY_HELP,
            1,
        )
    start = int(value, 16 if hex_mode else 10)
    if len(format(start, "x" if hex_mode else "d")) > suffix_len:
        raise UsageError(
            "split: numerical suffix start value is too large "
            "for the suffix length" + SPLIT_TRY_HELP,
            1,
        )
    return start


def parse_separator(value: str | None) -> bytes:
    """GNU ``split -t`` record separator: exactly one byte, or ``\\0``.

    GNU reads the value as one byte and refuses every other length rather
    than truncating to the first: an empty value is an empty record
    separator and anything longer is a multi-character one, with the
    two-character spelling ``\\0`` carved out as the only way to write a
    NUL on a command line. The length is counted in bytes, so a lone
    non-ASCII character is multi-character too, and the refused value is
    escaped like every other word split quotes (pinned against coreutils
    9.7). Not covered: GNU also refuses two ``-t`` flags naming different
    characters, which needs a list-valued flag the spec does not have.

    Args:
        value (str | None): the raw flag value, or None when unset.
    """
    if value is None:
        return b"\n"
    if value == "\\0":
        return b"\0"
    encoded = value.encode()
    if not encoded:
        raise UsageError("split: empty record separator", 1)
    if len(encoded) > 1:
        raise UsageError(
            f"split: multi-character separator '{quote_text(value)}'", 1
        )
    return encoded


def _chunk_end(index: int, base: int, rem: int) -> int:
    """Byte offset where chunk ``index`` (1-based) ends.

    GNU sizes chunks ``base`` bytes each with the remainder spread one
    byte at a time over the FIRST chunks, so the end is a closed form
    rather than a table of N prefix sums.

    Args:
        index (int): 1-based chunk number.
        base (int): ``size // count``.
        rem (int): ``size % count``.
    """
    return base * index + min(index, rem)


def _byte_chunks(data: bytes, count: int) -> Iterator[bytes]:
    """The byte chunks of ``data`` in order, the way GNU sizes them.

    ``size // count`` bytes each, with the remainder spread one byte at
    a time over the FIRST chunks: 7 bytes in 3 are 3, 2, 2 (coreutils
    9.7). Stops once the input is used up, because every chunk after
    that is empty; ``chunk_parts`` pads and ``chunk_at`` reads past the
    end, so a huge N never costs N slices.

    Args:
        data (bytes): the whole input.
        count (int): N.
    """
    base, rem = divmod(len(data), count)
    pos = 0
    for index in range(count):
        if pos >= len(data):
            return
        size = base + (1 if index < rem else 0)
        yield data[pos : pos + size]
        pos += size


def _line_chunks(data: bytes, count: int, eol: bytes) -> Iterator[bytes]:
    """The line chunks of ``data`` in order, no record cut.

    GNU's ``lines_chunk_split``: the byte boundaries are those of
    ``_byte_chunks`` over ``max(size, count)``, and a chunk runs to the
    first terminator at or after its own last byte, so a record that
    straddles a boundary goes whole to the chunk it started in. A
    record long enough to cover a whole later chunk leaves that chunk
    empty, and a chunk that begins exactly where the previous one ended
    takes the next record. Measured on coreutils 9.7 (``-n l/7`` over
    five 6-byte lines is line1, line2, line3, empty, line4, line5,
    empty). Stops once the input is used up, like ``_byte_chunks``.

    Args:
        data (bytes): the whole input.
        count (int): N.
        eol (bytes): the one-byte record terminator.
    """
    size = max(len(data), count)
    base, rem = divmod(size, count)
    buf = bytearray()
    pos = 0
    chunk = 0
    while pos < len(data) and chunk < count:
        start = max(pos, _chunk_end(chunk + 1, base, rem) - 1)
        found = data.find(eol, start) if start < len(data) else -1
        end, terminated = (
            (found + 1, True) if found >= 0 else (len(data), False)
        )
        buf += data[pos:end]
        pos = end
        while terminated or _chunk_end(chunk + 1, base, rem) <= pos:
            if not terminated and pos >= len(data):
                break
            yield bytes(buf)
            buf = bytearray()
            chunk += 1
            if chunk >= count:
                break
            if _chunk_end(chunk + 1, base, rem) > pos:
                terminated = False
    if chunk < count:
        yield bytes(buf)


def _records(data: bytes, eol: bytes) -> list[bytes]:
    """The records of ``data``, a final unterminated one included.

    Args:
        data (bytes): the whole input.
        eol (bytes): the one-byte record terminator.
    """
    records: list[bytes] = []
    pos = 0
    while pos < len(data):
        found = data.find(eol, pos)
        end = found + 1 if found >= 0 else len(data)
        records.append(data[pos:end])
        pos = end
    return records


def _round_robin_chunks(
    data: bytes, count: int, eol: bytes
) -> Iterator[bytes]:
    """The chunks of ``data`` dealt record by record in turn.

    Chunk ``k`` holds every ``count``-th record from the ``k``-th; a
    chunk past the last record is empty, so the walk stops there.

    Args:
        data (bytes): the whole input.
        count (int): N.
        eol (bytes): the one-byte record terminator; a final record
            without one is dealt too.
    """
    records = _records(data, eol)
    for index in range(min(count, len(records))):
        yield b"".join(records[index::count])


def _cut(data: bytes, chunks: ChunkSpec, separator: bytes) -> Iterator[bytes]:
    if chunks.kind is ChunkKind.LINES:
        return _line_chunks(data, chunks.count, separator)
    if chunks.kind is ChunkKind.ROUND_ROBIN:
        return _round_robin_chunks(data, chunks.count, separator)
    return _byte_chunks(data, chunks.count)


def chunk_parts(
    data: bytes, chunks: ChunkSpec, separator: bytes
) -> Iterator[bytes]:
    """Every chunk of ``data`` under one ``-n`` spec, in order.

    Exactly N chunks, the empty tail included, one at a time: the
    caller writes each to its file as it arrives, so N files never
    mean N chunks held at once.

    Args:
        data (bytes): the whole input.
        chunks (ChunkSpec): the parsed ``-n`` value.
        separator (bytes): the record terminator (``-t``).
    """
    produced = 0
    for part in _cut(data, chunks, separator):
        yield part
        produced += 1
    for _ in range(chunks.count - produced):
        yield b""


def chunk_at(
    data: bytes, chunks: ChunkSpec, separator: bytes, index: int
) -> bytes:
    """Chunk ``index`` (1-based) of ``data`` under one ``-n`` spec.

    ``K/N`` wants one chunk, so only the chunks before it are cut, and
    a K past the input's last byte is empty at no cost per skipped
    chunk (``-n 2/1000000000`` over 8 bytes is ``b``, instant in GNU).

    Args:
        data (bytes): the whole input.
        chunks (ChunkSpec): the parsed ``-n`` value.
        separator (bytes): the record terminator (``-t``).
        index (int): K.
    """
    return next(islice(_cut(data, chunks, separator), index - 1, None), b"")


_ALPHA_SUFFIXES = "abcdefghijklmnopqrstuvwxyz"
_NUMERIC_SUFFIXES = "0123456789"
_HEX_SUFFIXES = "0123456789abcdef"


def _to_base(value: int, alphabet: str, width: int) -> str:
    base = len(alphabet)
    chars: list[str] = []
    for _ in range(width):
        chars.append(alphabet[value % base])
        value //= base
    return "".join(reversed(chars))


def _suffix_namer(
    index: int, alphabet: str, auto: bool, width: int, start: int
) -> str:
    """One output-file suffix, GNU next_file_name style.

    With no explicit width and no explicit start value the suffix
    auto-lengthens, reserving the last alphabet character as a prefix —
    aa..yz, then zaaa..zyzz, then zzaaaa.. (00..89 then 9000..9899 then
    990000.. for -d); band k holds (B-1)*B**(k+1) names behind k reserved
    characters. An explicit -a width or a --numeric/hex-suffixes start
    value pins the width, and running past B**width is GNU's exhaustion
    error with the chunks already written kept (pinned against coreutils
    9.7). Deliberate divergence: GNU with a hex start whose leading digit
    is the reserved 'f' (--hex-suffixes=f0) walks past its alphabet and
    names files with non-hex characters; mirage exhausts cleanly.

    Args:
        index (int): zero-based output file ordinal.
        alphabet (str): suffix alphabet (alpha, numeric or hex).
        auto (bool): auto-lengthen instead of erroring at the width.
        width (int): fixed suffix width when ``auto`` is false.
        start (int): first suffix value (numeric/hex start, else 0).
    """
    base = len(alphabet)
    if auto:
        band = 0
        capacity = (base - 1) * base
        while index >= capacity:
            index -= capacity
            band += 1
            capacity *= base
        return alphabet[-1] * band + _to_base(index, alphabet, band + 2)
    value = start + index
    if value >= base**width:
        raise UsageError("split: output file suffixes exhausted", 1)
    return _to_base(value, alphabet, width)


def _prefix_virtual_of(prefix: PathSpec) -> str:
    """Where a PREFIX operand's pieces go, as the string they extend.

    The prefix is glued to each suffix, not walked: an empty one, or one
    ending in a slash, names the directory whose files are the bare
    suffixes (GNU's ``split f ''`` writes ``aa`` to the cwd, and ``split
    f out/`` writes ``out/aa``). ``virtual`` says neither, having
    normalized the slash away and read the empty name as the directory
    itself, so the separator is put back.

    Args:
        prefix (PathSpec): the PREFIX operand.
    """
    if prefix.raw_path == "" or prefix.raw_path.endswith("/"):
        return prefix.virtual.rstrip("/") + "/"
    return prefix.virtual


async def split_generic(
    paths: list[PathSpec],
    *,
    read_stream: Callable[..., AsyncIterator[bytes]],
    write_bytes: Callable[..., Awaitable[None]],
    stdin: ByteSource | None = None,
    lines_per_file: int = 0,
    byte_limit: int = 0,
    chunks: ChunkSpec | None = None,
    suffix_len: int = 2,
    suffix_auto: bool = True,
    numeric_suffix: bool = False,
    hex_suffix: bool = False,
    suffix_start: int = 0,
    additional_suffix: str = "",
    separator: bytes = b"\n",
    mount_prefix: str = "",
    cwd: str = "/",
) -> tuple[ByteSource | None, IOResult]:
    if len(paths) > 2:
        raise extra_operand_error(
            CommandName.SPLIT, paths[2].raw_path or paths[2].virtual
        )
    # An output is the prefix operand, or `x` in the working directory,
    # plus its suffix, wherever the input lives: GNU writes `xaa` to the
    # cwd, names it as it formed it (`split: xaa`, `split: /ro/preaa`),
    # and stops at the first one it cannot create.
    prefix_virtual = (
        _prefix_virtual_of(paths[1])
        if len(paths) >= 2
        else resolve_path("x", cwd)
    )
    typed_prefix = paths[1].raw_path if len(paths) >= 2 else "x"
    if lines_per_file == 0 and byte_limit == 0 and chunks is None:
        lines_per_file = 1000
    suffix_fn = partial(
        _suffix_namer,
        alphabet=(
            _HEX_SUFFIXES
            if hex_suffix
            else _NUMERIC_SUFFIXES
            if numeric_suffix
            else _ALPHA_SUFFIXES
        ),
        auto=suffix_auto,
        width=suffix_len,
        start=suffix_start,
    )

    # `-` is stdin. /dev/stdin would run split on the /dev mount, which
    # is where its pieces would land, so it stays a path.
    if paths and paths[0].raw_path != "-":
        source: AsyncIterator[bytes] = read_stream(paths[0])
    else:
        source = resolve_source(stdin)

    file_idx = 0

    async def emit(name: str, data: bytes) -> None:
        virtual = prefix_virtual + name
        spec = PathSpec.from_str_path(
            virtual, mount_key(virtual, mount_prefix)
        )
        try:
            await write_bytes(spec, data)
        except FS_ERRORS as exc:
            raise UsageError(
                f"split: {typed_prefix + name}: {fs_strerror(exc)}", 1
            ) from exc

    # A write that fails ends the split mid-input, and `async for` leaves
    # the source it stopped in open.
    try:
        if chunks is not None:
            all_data = b"".join([chunk async for chunk in source])
            if chunks.only is not None:
                # `K/N` writes the one chunk to stdout and no file at all.
                return chunk_at(
                    all_data, chunks, separator, chunks.only
                ), IOResult()
            # Every chunk gets its file, an empty one included: GNU creates
            # N files for `-n N` however short the input is.
            for i, part in enumerate(chunk_parts(all_data, chunks, separator)):
                name = suffix_fn(i) + additional_suffix
                await emit(name, part)
        elif byte_limit > 0:
            buf = bytearray()
            async for chunk in source:
                buf.extend(chunk)
                while len(buf) >= byte_limit:
                    name = suffix_fn(file_idx) + additional_suffix
                    data = bytes(buf[:byte_limit])
                    await emit(name, data)
                    buf = buf[byte_limit:]
                    file_idx += 1
            if buf:
                name = suffix_fn(file_idx) + additional_suffix
                data = bytes(buf)
                await emit(name, data)
        else:
            line_buf: list[bytes] = []
            if separator == b"\n":
                records: AsyncIterator[bytes] = AsyncLineIterator(source)
            else:
                raw = b"".join([chunk async for chunk in source])
                records = _record_iterator(raw, separator)
            async for line in records:
                line_buf.append(line)
                if len(line_buf) >= lines_per_file:
                    name = suffix_fn(file_idx) + additional_suffix
                    data = separator.join(line_buf) + separator
                    await emit(name, data)
                    line_buf = []
                    file_idx += 1
            if line_buf:
                name = suffix_fn(file_idx) + additional_suffix
                data = separator.join(line_buf) + separator
                await emit(name, data)
    finally:
        close = getattr(source, "aclose", None)
        if close is not None:
            await close()

    return None, IOResult()


async def _record_iterator(
    data: bytes, separator: bytes
) -> AsyncIterator[bytes]:
    # Every separator terminates a record, so only the final unterminated
    # remainder is dropped when empty; a second trailing separator still
    # yields the empty record it terminates (GNU).
    records = data.split(separator)
    if records and not records[-1]:
        records.pop()
    for record in records:
        yield record


__all__ = ["ChunkKind", "ChunkSpec", "chunk_parts", "split_generic"]
