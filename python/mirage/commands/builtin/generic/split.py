from collections.abc import AsyncIterator, Awaitable, Callable
from functools import partial

from mirage.commands.builtin.constants import (SPLIT_BYTE_UNITS,
                                               SPLIT_COUNT_PATTERN,
                                               SPLIT_DIGITS, SPLIT_HEX_DIGITS,
                                               SPLIT_TRY_HELP, UINTMAX)
from mirage.commands.builtin.utils.stream import _resolve_source
from mirage.commands.errors import UsageError
from mirage.commands.spec.types import CommandName
from mirage.commands.spec.usage import extra_operand_error
from mirage.io.async_line_iterator import AsyncLineIterator
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


def parse_bytes_value(value: str) -> int:
    """GNU ``split -b`` byte count: base-10 digits plus a size suffix.

    Args:
        value (str): the raw flag value, e.g. ``4``, ``1K``, ``2GiB``.
    """
    suffix = next((u for u in sorted(SPLIT_BYTE_UNITS, key=len, reverse=True)
                   if value.endswith(u)), "")
    digits = value[:-len(suffix)] if suffix else value
    if SPLIT_COUNT_PATTERN.fullmatch(digits) is None or int(digits) == 0:
        raise UsageError(f"split: invalid number of bytes: '{value}'", 1)
    return int(digits) * SPLIT_BYTE_UNITS.get(suffix, 1)


def parse_lines_value(value: str) -> int:
    """GNU ``split -l`` line count: base-10 digits, no suffixes.

    Args:
        value (str): the raw flag value.
    """
    if SPLIT_COUNT_PATTERN.fullmatch(value) is None or int(value) == 0:
        raise UsageError(f"split: invalid number of lines: '{value}'", 1)
    return int(value)


def parse_chunks_value(value: str) -> int:
    """GNU ``split -n`` chunk count for ``N`` and ``KIND/K/N`` specs.

    Args:
        value (str): the raw flag value, e.g. ``4``, ``l/4``, ``2/3``.
    """
    # A malformed head (the l/r kind letter or the K component) quotes the
    # whole spec; a malformed trailing N quotes only N (GNU).
    parts = value.split("/")
    kinds = ("l", "r")
    if any(p not in kinds and SPLIT_COUNT_PATTERN.fullmatch(p) is None
           for p in parts[:-1]):
        raise UsageError(f"split: invalid number of chunks: '{value}'", 1)
    tail = parts[-1]
    if SPLIT_COUNT_PATTERN.fullmatch(tail) is None or int(tail) == 0:
        raise UsageError(f"split: invalid number of chunks: '{tail}'", 1)
    return int(tail)


def parse_suffix_length(value: str) -> int:
    """GNU ``split -a`` suffix length: base-10 digits, 0 means auto.

    Args:
        value (str): the raw flag value.
    """
    if SPLIT_COUNT_PATTERN.fullmatch(value) is None:
        raise UsageError(f"split: invalid suffix length: '{value}'", 1)
    length = int(value)
    # xstrtoumax overflow: past 2**64 - 1 GNU refuses the width at parse
    # time (byte and line counts saturate instead — a count bigger than
    # the input reads the same either way, but a width this size would be
    # built into a file name).
    if length > UINTMAX:
        raise UsageError(
            f"split: invalid suffix length: '{value}': "
            "Value too large for defined data type", 1)
    return length


def parse_suffix_start(value: str, hex_mode: bool, suffix_len: int) -> int:
    """GNU ``--numeric-suffixes=``/``--hex-suffixes=`` start value.

    Args:
        value (str): the raw start value; hex digits when ``hex_mode``.
        hex_mode (bool): parse base 16 (``--hex-suffixes``) or base 10.
        suffix_len (int): the effective suffix width the start must fit.
    """
    pattern = SPLIT_HEX_DIGITS if hex_mode else SPLIT_DIGITS
    if pattern.fullmatch(value) is None:
        kind = "hexadecimal" if hex_mode else "numerical"
        raise UsageError(
            f"split: '{value}': invalid start value for {kind} suffix" +
            SPLIT_TRY_HELP, 1)
    start = int(value, 16 if hex_mode else 10)
    if len(format(start, "x" if hex_mode else "d")) > suffix_len:
        raise UsageError(
            "split: numerical suffix start value is too large "
            "for the suffix length" + SPLIT_TRY_HELP, 1)
    return start


def parse_separator(value: str | None) -> bytes:
    """GNU ``split -t`` record separator: exactly one byte, or ``\\0``.

    GNU reads the value as one byte and refuses every other length rather
    than truncating to the first: an empty value is an empty record
    separator and anything longer is a multi-character one, with the
    two-character spelling ``\\0`` carved out as the only way to write a
    NUL on a command line. The length is counted in bytes, so a lone
    non-ASCII character is multi-character too (pinned against coreutils
    9.7). Deliberate divergence, matching truncate: GNU's quotearg escapes
    control characters in the message and mirage quotes the raw value. Not
    covered: GNU also refuses two ``-t`` flags naming different characters,
    which needs a list-valued flag the spec does not have.

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
        raise UsageError(f"split: multi-character separator '{value}'", 1)
    return encoded


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


def _suffix_name(index: int, alphabet: str, auto: bool, width: int,
                 start: int) -> str:
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


async def split(
    paths: list[PathSpec],
    *,
    read_stream: Callable[..., AsyncIterator[bytes]],
    write_bytes: Callable[..., Awaitable[None]],
    stdin: ByteSource | None = None,
    lines_per_file: int = 0,
    byte_limit: int = 0,
    n_chunks: int = 0,
    suffix_len: int = 2,
    suffix_auto: bool = True,
    numeric_suffix: bool = False,
    hex_suffix: bool = False,
    suffix_start: int = 0,
    additional_suffix: str = "",
    separator: bytes = b"\n",
) -> tuple[ByteSource | None, IOResult]:
    if len(paths) > 2:
        raise extra_operand_error(CommandName.SPLIT, paths[2].raw_path
                                  or paths[2].virtual)
    prefix_name = paths[1].mount_path if len(paths) >= 2 else "x"
    if lines_per_file == 0 and byte_limit == 0 and n_chunks == 0:
        lines_per_file = 1000
    suffix_fn = partial(
        _suffix_name,
        alphabet=(_HEX_SUFFIXES if hex_suffix else
                  _NUMERIC_SUFFIXES if numeric_suffix else _ALPHA_SUFFIXES),
        auto=suffix_auto,
        width=suffix_len,
        start=suffix_start)

    if paths:
        source: AsyncIterator[bytes] = read_stream(paths[0])
    else:
        source = _resolve_source(stdin)

    writes: dict[str, ByteSource] = {}
    file_idx = 0

    if n_chunks > 0:
        all_data = bytearray()
        async for chunk in source:
            all_data.extend(chunk)
        total = len(all_data)
        chunk_size = max(1, (total + n_chunks - 1) // n_chunks)
        offset = 0
        for i in range(n_chunks):
            part = bytes(all_data[offset:offset + chunk_size])
            if not part:
                break
            out_path = (prefix_name + suffix_fn(i) + additional_suffix)
            await write_bytes(PathSpec.from_str_path(out_path), part)
            writes[out_path] = part
            offset += chunk_size
    elif byte_limit > 0:
        buf = bytearray()
        async for chunk in source:
            buf.extend(chunk)
            while len(buf) >= byte_limit:
                out_path = (prefix_name + suffix_fn(file_idx) +
                            additional_suffix)
                data = bytes(buf[:byte_limit])
                await write_bytes(PathSpec.from_str_path(out_path), data)
                writes[out_path] = data
                buf = buf[byte_limit:]
                file_idx += 1
        if buf:
            out_path = (prefix_name + suffix_fn(file_idx) + additional_suffix)
            data = bytes(buf)
            await write_bytes(PathSpec.from_str_path(out_path), data)
            writes[out_path] = data
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
                out_path = (prefix_name + suffix_fn(file_idx) +
                            additional_suffix)
                data = separator.join(line_buf) + separator
                await write_bytes(PathSpec.from_str_path(out_path), data)
                writes[out_path] = data
                line_buf = []
                file_idx += 1
        if line_buf:
            out_path = (prefix_name + suffix_fn(file_idx) + additional_suffix)
            data = separator.join(line_buf) + separator
            await write_bytes(PathSpec.from_str_path(out_path), data)
            writes[out_path] = data

    return None, IOResult(writes=writes)


async def _record_iterator(data: bytes,
                           separator: bytes) -> AsyncIterator[bytes]:
    # Every separator terminates a record, so only the final unterminated
    # remainder is dropped when empty; a second trailing separator still
    # yields the empty record it terminates (GNU).
    records = data.split(separator)
    if records and not records[-1]:
        records.pop()
    for record in records:
        yield record


__all__ = ["split"]
