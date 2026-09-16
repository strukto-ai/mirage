import pytest

from mirage.commands.builtin.generic.uniq import (_parse_count, parse_flags,
                                                  uniq)
from mirage.commands.errors import UsageError
from mirage.types import PathSpec


def _unused_read_stream(_accessor, _path):
    raise AssertionError("read_stream should not be called for stdin input")


async def _generator_read_stream(_path):
    yield b"dup\ndup\nsolo\n"


async def _collect(stdin: bytes | None, **kwargs) -> bytes:
    source, _io = await uniq(
        [],
        read_stream=_unused_read_stream,
        stdin=stdin,
        **kwargs,
    )
    chunks = [chunk async for chunk in source]
    return b"".join(chunks)


def test_parse_count_unset_is_none():
    assert _parse_count(None) is None


def test_parse_count_zero_string():
    assert _parse_count("0") == 0


def test_parse_count_positive():
    assert _parse_count("3") == 3


def test_parse_count_negative_raises():
    with pytest.raises(ValueError, match="invalid count"):
        _parse_count("-1")


def test_parse_count_trailing_text_raises():
    with pytest.raises(ValueError, match="invalid count"):
        _parse_count("2junk")


@pytest.mark.asyncio
async def test_no_operand_uses_empty_standard_input():
    assert await _collect(None) == b""


@pytest.mark.asyncio
async def test_skip_fields_unset_matches_zero():
    data = b"a one\nb one\n"
    unset = await _collect(data)
    zero = await _collect(data, skip_fields="0")
    assert unset == zero == b"a one\nb one\n"


@pytest.mark.asyncio
async def test_skip_fields_collapses_on_second_field():
    data = b"a shared\nb shared\n"
    out = await _collect(data, skip_fields="1")
    assert out == b"a shared\n"


@pytest.mark.asyncio
async def test_skip_chars_offset():
    data = b"Xfoo\nYfoo\n"
    out = await _collect(data, skip_chars="1")
    assert out == b"Xfoo\n"


@pytest.mark.asyncio
async def test_check_chars_limits_comparison():
    data = b"abcAAA\nabcBBB\n"
    out = await _collect(data, check_chars="3")
    assert out == b"abcAAA\n"


@pytest.mark.asyncio
async def test_check_chars_unset_compares_full_line():
    data = b"abcAAA\nabcBBB\n"
    out = await _collect(data)
    assert out == b"abcAAA\nabcBBB\n"


@pytest.mark.asyncio
async def test_check_chars_zero_string_treats_all_lines_as_duplicates():
    # GNU: -w 0 compares zero characters, so every line matches the first
    data = b"abcAAA\nabcBBB\n"
    out = await _collect(data, check_chars="0")
    assert out == b"abcAAA\n"


@pytest.mark.asyncio
async def test_count_prefixes_occurrences():
    data = b"dup\ndup\nsolo\n"
    out = await _collect(data, count=True)
    assert out == b"      2 dup\n      1 solo\n"


@pytest.mark.asyncio
async def test_ignore_case_folds_duplicates():
    data = b"Hello\nhello\n"
    out = await _collect(data, ignore_case=True)
    assert out == b"Hello\n"


@pytest.mark.asyncio
async def test_read_stream_async_generator():
    p = PathSpec(resource_path="x", virtual="/x", directory="/x")
    source, _io = await uniq([p], read_stream=_generator_read_stream)
    out = b"".join([chunk async for chunk in source])
    assert out == b"dup\nsolo\n"


# Both of uniq's ARGMATCH refusals name the refused word through gnulib's
# quote(), so a byte outside 0x20-0x7e comes back escaped. Rows measured
# against GNU coreutils 9.4 under `LC_ALL=C` with a raw `bytes` argv
# (`uniq --all-repeated=<w>`, `uniq --group=<w>`). Mirrored in
# uniq.test.ts.
QUOTED_WORDS = [
    ("xé", r"x\303\251"),
    ("x\r", r"x\r"),
    ("x\x01", r"x\001"),
    ("x\x7f", r"x\177"),
    ("x'", r"x\'"),
    ("x\\", r"x\\"),
]


@pytest.mark.parametrize("value,escaped", QUOTED_WORDS)
def test_all_repeated_refusal_quotes_the_word(value, escaped):
    with pytest.raises(UsageError) as exc:
        parse_flags({"all_repeated": value})
    assert str(exc.value).startswith(
        f"uniq: invalid argument '{escaped}' for '--all-repeated'\n")


@pytest.mark.parametrize("value,escaped", QUOTED_WORDS)
def test_group_refusal_quotes_the_word(value, escaped):
    with pytest.raises(UsageError) as exc:
        parse_flags({"group": value})
    assert str(exc.value).startswith(
        f"uniq: invalid argument '{escaped}' for '--group'\n")


# Measured, coreutils 9.4: both refusals append gnulib's candidate list
# and the Try-help line, in GNU's own declaration order -- `--group`
# lists `prepend append separate both`, not the accepted-set order that
# starts at its `separate` default.
def test_all_repeated_refusal_carries_gnus_candidate_block():
    with pytest.raises(UsageError) as exc:
        parse_flags({"all_repeated": "x"})
    assert str(
        exc.value) == ("uniq: invalid argument 'x' for '--all-repeated'\n"
                       "Valid arguments are:\n"
                       "  - 'none'\n  - 'prepend'\n  - 'separate'\n"
                       "Try 'uniq --help' for more information.")
    assert exc.value.exit_code == 1


def test_group_refusal_carries_gnus_candidate_block():
    with pytest.raises(UsageError) as exc:
        parse_flags({"group": "x"})
    assert str(exc.value) == (
        "uniq: invalid argument 'x' for '--group'\n"
        "Valid arguments are:\n"
        "  - 'prepend'\n  - 'append'\n  - 'separate'\n  - 'both'\n"
        "Try 'uniq --help' for more information.")
    assert exc.value.exit_code == 1


@pytest.mark.parametrize("dest,option", [
    ("all_repeated", "--all-repeated"),
    ("group", "--group"),
])
def test_an_empty_argument_is_ambiguous(dest, option):
    """`uniq --all-repeated=` / `--group=` are `ambiguous argument ''`."""
    with pytest.raises(UsageError) as exc:
        parse_flags({dest: ""})
    assert str(
        exc.value).startswith(f"uniq: ambiguous argument '' for '{option}'\n")
    assert exc.value.exit_code == 1


@pytest.mark.parametrize("value", ["1é", "1\x01"])
def test_fields_to_skip_refusal_stays_raw(value):
    """`-f` is a different clause shape and GNU escapes nothing in it.

    GNU words it `uniq: <w>: invalid number of fields to skip` with the
    bytes as typed, so this one must NOT be routed through quote() --
    measured with `uniq -f 1é`, which reports the two UTF-8 bytes
    intact.
    """
    with pytest.raises(ValueError) as exc:
        _parse_count(value)
    assert value in str(exc.value)
