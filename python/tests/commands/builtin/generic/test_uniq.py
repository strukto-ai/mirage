import pytest

from mirage.commands.builtin.generic.uniq import (
    SKIP_FIELDS,
    _parse_count,
    parse_flags,
    uniq_generic,
)
from mirage.commands.errors import UsageError


def _unused_read_stream(_accessor, _path):
    raise AssertionError("read_stream should not be called for stdin input")


async def _collect(stdin: bytes | None, **kwargs) -> bytes:
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


# Both of uniq's ARGMATCH refusals name the refused word through gnulib's
# quote(), so a byte outside 0x20-0x7e comes back escaped. Rows measured
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
