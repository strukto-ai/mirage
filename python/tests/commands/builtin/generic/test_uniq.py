from collections.abc import AsyncIterator

import pytest

from mirage.commands.builtin.generic.uniq import (
    SKIP_FIELDS,
    _parse_count,
    parse_flags,
    uniq_generic,
)
from mirage.commands.errors import UsageError
from mirage.io.types import ByteSource


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "option", ["skip_fields", "skip_chars", "check_chars"]
)
async def test_counts_beyond_json_numeric_range_remain_unbounded(option):
    expected = b"a\nb\n" if option == "check_chars" else b"a\n"
    assert await _collect(b"a\nb\n", flags={option: "9" * 400}) == expected


def _unused_read_stream(_accessor, _path):
    raise AssertionError("read_stream should not be called for stdin input")


async def _collect(stdin: ByteSource | None, **kwargs) -> bytes:
    source, _io = await uniq_generic(
        [],
        read_stream=_unused_read_stream,
        stdin=stdin,
        **kwargs,
    )
    chunks = [chunk async for chunk in source]
    return b"".join(chunks)


@pytest.mark.asyncio
async def test_skip_fields_unset_matches_zero():
    data = b"a one\nb one\n"
    unset = await _collect(data)
    zero = await _collect(data, skip_fields="0")
    assert unset == zero == b"a one\nb one\n"


@pytest.mark.asyncio
async def test_check_chars_unset_compares_full_line():
    data = b"abcAAA\nabcBBB\n"
    out = await _collect(data)
    assert out == b"abcAAA\nabcBBB\n"


@pytest.mark.asyncio
async def test_keeps_non_adjacent_dupes():
    """Real uniq only collapses adjacent duplicates."""
    assert await _collect(b"a\nb\na\n") == b"a\nb\na\n"


ARGUMENT_OPTIONS = [
    ("all_repeated", "--all-repeated"),
    ("group", "--group"),
]


# Both of uniq's word-choice refusals name the refused word quoted, so a
# byte outside 0x20-0x7e comes back escaped. Rows measured
# against GNU coreutils 9.4 under `LC_ALL=C` with a raw `bytes` argv
# (`uniq --all-repeated=<w>`, `uniq --group=<w>`). Mirrored in
# uniq.test.ts.
@pytest.mark.parametrize(
    "value,escaped", [("xé", r"x\303\251"), ("x\\", r"x\\")]
)
@pytest.mark.parametrize("dest,option", ARGUMENT_OPTIONS)
def test_an_argument_refusal_quotes_the_word(dest, option, value, escaped):
    with pytest.raises(UsageError) as exc:
        parse_flags({dest: value})
    assert str(exc.value).startswith(
        f"uniq: invalid argument '{escaped}' for '{option}'\n"
    )


# Measured, coreutils 9.4: both refusals append gnulib's candidate list
# and the Try-help line, in GNU's own declaration order -- `--group`
# lists `prepend append separate both`, not the accepted-set order that
# starts at its `separate` default.
@pytest.mark.parametrize(
    "dest,option,candidates",
    [
        ("all_repeated", "--all-repeated", ["none", "prepend", "separate"]),
        ("group", "--group", ["prepend", "append", "separate", "both"]),
    ],
)
def test_an_argument_refusal_carries_gnus_candidate_block(
    dest, option, candidates
):
    with pytest.raises(UsageError) as exc:
        parse_flags({dest: "x"})
    listed = "".join(f"  - '{word}'\n" for word in candidates)
    assert str(exc.value) == (
        f"uniq: invalid argument 'x' for '{option}'\n"
        f"Valid arguments are:\n{listed}"
        "Try 'uniq --help' for more information."
    )
    assert exc.value.exit_code == 1


def test_an_empty_argument_is_ambiguous():
    """`uniq --group=` is `ambiguous argument ''`."""
    with pytest.raises(UsageError) as exc:
        parse_flags({"group": ""})
    assert str(exc.value).startswith(
        "uniq: ambiguous argument '' for '--group'\n"
    )
    assert exc.value.exit_code == 1


@pytest.mark.parametrize("value", ["-1", "1é"])
def test_a_count_refusal_names_the_value_raw(value):
    """GNU words it `uniq: <w>: invalid number of fields to skip`, the
    bytes as typed, never through quote(): `uniq -f 1é` keeps both
    UTF-8 bytes intact.
    """
    with pytest.raises(ValueError) as exc:
        _parse_count(value, SKIP_FIELDS)
    assert str(exc.value) == f"uniq: {value}: invalid number of fields to skip"


# Neither option's candidates share a prefix that spans two values, so
# `uniq --group=p` and `--all-repeated=n` both exit 0 (measured,
# coreutils 9.4).
def test_group_and_all_repeated_accept_an_unambiguous_prefix():
    assert parse_flags({"group": "p"}).group == "prepend"
    assert parse_flags({"all_repeated": "n"}).all_repeated == "none"


def test_group_still_refuses_an_unmatched_word():
    with pytest.raises(UsageError) as exc:
        parse_flags({"group": "pp"})
    assert str(exc.value).startswith(
        "uniq: invalid argument 'pp' for '--group'\n"
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "flags,data,expected",
    [
        ({}, b"a\n", b"a\n"),
        ({"count": True}, b"a\na\nb\n", b"      2 a\n"),
        ({"repeated": True}, b"a\na\n", b"a\n"),
        ({"unique": True}, b"a\nb\n", b"a\n"),
        ({"D": True}, b"a\na\n", b"a\n"),
        ({"group": "prepend"}, b"a\n", b"\n"),
        ({"all_repeated": "prepend"}, b"a\na\n", b"\n"),
        ({"zero_terminated": True}, b"a\0", b"a\0"),
    ],
)
async def test_uniq_emits_before_reading_the_tail_and_closes(
    flags, data, expected
):
    closed = False

    async def source():
        nonlocal closed
        try:
            yield data
            raise AssertionError("uniq fetched the tail")
        finally:
            closed = True

    output, _ = await uniq_generic(
        [], read_stream=_unused_read_stream, stdin=source(), flags=flags
    )
    try:
        assert await anext(output) == expected
    finally:
        await output.aclose()
    assert closed


async def _one_byte_chunks(data: bytes) -> AsyncIterator[bytes]:
    for byte in data:
        yield bytes([byte])


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "flags,expected",
    [
        ({"ignore_case": True}, b"A\nb\nC\n"),
        (
            {"ignore_case": True, "count": True},
            b"      3 A\n      1 b\n      2 C\n",
        ),
        (
            {"ignore_case": True, "all_repeated": "separate"},
            b"A\na\nA\n\nC\nc\n",
        ),
        (
            {"ignore_case": True, "group": "both"},
            b"\nA\na\nA\n\nb\n\nC\nc\n\n",
        ),
    ],
)
async def test_uniq_groups_survive_one_byte_chunks(flags, expected):
    source = _one_byte_chunks(b"A\na\nA\nb\nC\nc")
    assert await _collect(source, flags=flags) == expected


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "flags,data,expected",
    [
        ({}, b"\xff\n\xfe\n\xff\n", b"\xff\n\xfe\n\xff\n"),
        ({"skip_chars": "1"}, b"\xffA\n\xfeA\nB\n", b"\xffA\nB\n"),
        (
            {"skip_chars": "1", "check_chars": "1"},
            "😀aX\néaY\nzb\n".encode(),
            "😀aX\nzb\n".encode(),
        ),
        (
            {"ignore_case": True},
            "ΟΣ\nΟς\nΟΣΑ\nοσα\n".encode(),
            "ΟΣ\nΟΣΑ\n".encode(),
        ),
        (
            {"ignore_case": True},
            "AΣ\u0301\nAς\u0301\nAΣ\u0301B\nAσ\u0301b\n".encode(),
            "AΣ\u0301\nAΣ\u0301B\n".encode(),
        ),
        (
            {"ignore_case": True, "check_chars": "2"},
            "AΣX\naςY\n".encode(),
            "AΣX\n".encode(),
        ),
        (
            {"zero_terminated": True, "group": "both"},
            b"a\0a\0b",
            b"\0a\0a\0\0b\0\0",
        ),
    ],
)
async def test_uniq_keys_and_separators_survive_byte_splits(
    flags, data, expected
):
    assert await _collect(_one_byte_chunks(data), flags=flags) == expected


@pytest.mark.asyncio
async def test_uniq_large_records_drain_before_a_blocked_tail_and_close():
    closed = False
    record = b"A" * (256 * 1024)

    async def source():
        nonlocal closed
        try:
            yield record + b"\n" + record.lower() + b"\nb\n"
            raise AssertionError("uniq fetched the tail")
        finally:
            closed = True

    output, _ = await uniq_generic(
        [],
        read_stream=_unused_read_stream,
        stdin=source(),
        flags={"ignore_case": True, "count": True},
    )
    received = bytearray()
    try:
        while not received.endswith(b"\n"):
            piece = await anext(output)
            assert len(piece) <= 16 * 1024
            received.extend(piece)
        assert received == b"      2 " + record + b"\n"
    finally:
        await output.aclose()
    assert closed
