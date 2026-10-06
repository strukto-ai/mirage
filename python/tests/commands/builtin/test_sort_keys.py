import pytest

from mirage.commands.builtin.errors import SortKeyError
from mirage.commands.builtin.generic.sort import sort_generic
from mirage.commands.builtin.sort_keys import (
    KeyMods,
    _compute_fields,
    _extract,
    build_config,
    compare_lines,
    merge_lines,
    parse_keydef,
    sort_lines,
)

_G = KeyMods()


def _cfg(key_defs=None, **kw):
    defaults = dict(
        field_sep=None,
        reverse=False,
        numeric=False,
        unique=False,
        fold_case=False,
        human_numeric=False,
        version_sort=False,
        month_sort=False,
        ignore_blanks=False,
        stable=False,
    )
    defaults.update(kw)
    return build_config(key_defs or [], **defaults)


def _lines(text, key_defs=None, **kw):
    return sort_lines(text.split("\n"), _cfg(key_defs, **kw))


class TestFieldModel:
    def test_default_sep_leading_blanks_belong_to_following_field(self):
        fields = _compute_fields("  zeta    5  x", None)
        assert [start for start, _, _ in fields] == [0, 6, 11]
        assert "".join("  zeta    5  x"[c:e] for _, c, e in fields) == "zeta5x"

    def test_explicit_sep_no_blank_collapsing(self):
        fields = _compute_fields("a::b", ":")
        assert len(fields) == 3
        assert fields[1] == (2, 2, 2)


class TestParseKeydef:
    def test_field_only_extends_to_eol(self):
        key = parse_keydef("2", _G, False)
        assert key.start_field == 2 and key.start_char == 1
        assert key.end_field is None

    def test_range_with_chars(self):
        key = parse_keydef("2.3,4.5", _G, False)
        assert (key.start_field, key.start_char) == (2, 3)
        assert (key.end_field, key.end_char) == (4, 5)

    def test_per_key_numeric_overrides_global(self):
        key = parse_keydef("2,2n", KeyMods(reverse=True), False)
        assert key.mods.numeric is True
        assert key.mods.reverse is False

    def test_blank_flag_suppresses_global_inheritance(self):
        key = parse_keydef("2b", KeyMods(numeric=True), False)
        assert key.mods.numeric is False
        assert key.start_skip is True

    def test_no_own_options_inherits_global(self):
        key = parse_keydef("2", KeyMods(numeric=True, reverse=True), True)
        assert key.mods.numeric is True
        assert key.mods.reverse is True
        assert key.start_skip is True

    def test_zero_field_raises(self):
        with pytest.raises(SortKeyError):
            parse_keydef("0", _G, False)

    def test_unknown_order_letter_raises(self):
        with pytest.raises(SortKeyError):
            parse_keydef("2x", _G, False)

    def test_unicode_digit_field_raises(self):
        # python's \d also matches Unicode digits (int('١') is 1), which
        # JS /\d/ and GNU's C-locale parsers reject.
        with pytest.raises(SortKeyError):
            parse_keydef("١", _G, False)
        with pytest.raises(SortKeyError):
            parse_keydef("2.٣", _G, False)

    def test_h_is_an_ordering_letter(self):
        key = parse_keydef("1,1h", KeyMods(numeric=True), False)
        assert key.mods.human is True
        assert key.mods.numeric is False

    def test_a_number_takes_leading_blanks_and_a_plus(self):
        assert parse_keydef("+2", _G, False).start_field == 2
        assert parse_keydef(" 2", _G, False).start_field == 2
        assert parse_keydef("\t2", _G, False).start_field == 2
        assert parse_keydef("1.+2", _G, False).start_char == 2
        assert parse_keydef("1,+2", _G, False).end_field == 2

    def test_a_zero_end_offset_is_the_end_of_its_field(self):
        key = parse_keydef("2,2.0n", _G, False)
        assert (key.end_field, key.end_char) == (2, 0)
        assert key.mods.numeric is True


# GNU coreutils 9.7's own words for a KEYDEF it refuses, measured on
# debian:stable-slim under LC_ALL=C. Mirrored in sort_keys.test.ts.
@pytest.mark.parametrize(
    "spec,message",
    [
        ("a", "invalid number at field start: invalid count at start of 'a'"),
        ("", "invalid number at field start: invalid count at start of ''"),
        (
            "-1",
            "invalid number at field start: invalid count at start of '-1'",
        ),
        ("1.a", "invalid number after '.': invalid count at start of 'a'"),
        ("1.", "invalid number after '.': invalid count at start of ''"),
        ("1,a", "invalid number after ',': invalid count at start of 'a'"),
        ("1,", "invalid number after ',': invalid count at start of ''"),
        ("1,-2", "invalid number after ',': invalid count at start of '-2'"),
        ("1,1.a", "invalid number after '.': invalid count at start of 'a'"),
        ("0", "field number is zero: invalid field specification '0'"),
        ("0.x", "field number is zero: invalid field specification '0.x'"),
        ("1.0", "character offset is zero: invalid field specification '1.0'"),
        (
            "1.0x",
            "character offset is zero: invalid field specification '1.0x'",
        ),
        ("1,0", "field number is zero: invalid field specification '1,0'"),
        (
            "1x",
            "stray character in field spec: invalid field specification '1x'",
        ),
        (
            "1,1x",
            "stray character in field spec: invalid field specification '1,1x'",
        ),
        (
            "1x,2",
            "stray character in field spec: invalid field specification '1x,2'",
        ),
        (
            "1n.2",
            "stray character in field spec: invalid field specification '1n.2'",
        ),
        (
            "1,2,3",
            "stray character in field spec: invalid field specification '1,2,3'",
        ),
        (
            "1N",
            "stray character in field spec: invalid field specification '1N'",
        ),
        (
            "1nMx",
            "stray character in field spec: invalid field specification '1nMx'",
        ),
        (
            "'1",
            "invalid number at field start: invalid count at start of '\\'1'",
        ),
        (
            "1'x",
            "stray character in field spec: invalid field specification "
            "'1\\'x'",
        ),
        (
            "1\nx",
            "stray character in field spec: invalid field specification "
            "'1\\nx'",
        ),
        (
            "1é",
            "stray character in field spec: invalid field specification "
            "'1\\303\\251'",
        ),
    ],
)
def test_a_refused_keydef_in_gnus_words(spec, message):
    with pytest.raises(SortKeyError) as exc:
        parse_keydef(spec, _G, False)
    assert str(exc.value) == message


class TestOrderingCompatibility:
    """sort.c's ``check_ordering_compatibility``, measured against GNU
    coreutils 9.7 under LC_ALL=C. Mirrored in sort_keys.test.ts."""

    @pytest.mark.parametrize(
        "options,letters",
        [
            (dict(numeric=True, general_numeric=True), "gn"),
            (dict(numeric=True, dictionary=True), "dn"),
            (dict(human_numeric=True, month_sort=True), "hM"),
            (dict(numeric=True, ignore_nonprinting=True), "in"),
            (
                dict(numeric=True, dictionary=True, ignore_nonprinting=True),
                "dn",
            ),
            (dict(numeric=True, general_numeric=True, fold_case=True), "fgn"),
            (
                dict(
                    numeric=True,
                    general_numeric=True,
                    ignore_blanks=True,
                    reverse=True,
                ),
                "gn",
            ),
            (dict(month_sort=True, version_sort=True), "MV"),
            (dict(human_numeric=True, numeric=True), "hn"),
            (dict(general_numeric=True, month_sort=True), "gM"),
            (dict(dictionary=True, month_sort=True), "dM"),
        ],
    )
    def test_the_global_options_are_the_one_key(self, options, letters):
        with pytest.raises(SortKeyError) as exc:
            _cfg(**options)
        assert str(exc.value) == f"options '-{letters}' are incompatible"

    @pytest.mark.parametrize(
        "key_defs,letters",
        [
            (["1n,1g"], "gn"),
            (["1nM"], "Mn"),
            (["1,1nR"], "nR"),
            (["1bn,1g"], "gn"),
            (["1hM"], "hM"),
            (["1fiM"], "fiM"),
            (["1idn"], "dn"),
            (["1,1Mg"], "gM"),
            (["2Mn", "1gn"], "Mn"),
            (["1n", "2gh"], "gh"),
        ],
    )
    def test_each_key_is_checked_in_the_order_typed(self, key_defs, letters):
        with pytest.raises(SortKeyError) as exc:
            _cfg(key_defs)
        assert str(exc.value) == f"options '-{letters}' are incompatible"

    def test_a_key_without_letters_inherits_the_conflict(self):
        with pytest.raises(SortKeyError) as exc:
            _cfg(["1,1"], numeric=True, general_numeric=True)
        assert str(exc.value) == "options '-gn' are incompatible"
        with pytest.raises(SortKeyError) as exc:
            _cfg(["1"], numeric=True, dictionary=True)
        assert str(exc.value) == "options '-dn' are incompatible"

    def test_globals_no_key_inherits_are_not_checked(self):
        cfg = _cfg(["1,1n"], numeric=True, general_numeric=True)
        assert [key.mods.general_numeric for key in cfg.keys] == [False]
        _cfg(["1d"], numeric=True)

    @pytest.mark.parametrize(
        "key_defs,options",
        [
            (["1dVR"], {}),
            (["1,1VR"], {}),
            ([], dict(version_sort=True, dictionary=True)),
            ([], dict(version_sort=True, ignore_nonprinting=True)),
            ([], dict(dictionary=True, fold_case=True)),
            (["1n", "2g"], {}),
            ([], dict(numeric=True, reverse=True, ignore_blanks=True)),
        ],
    )
    def test_orderings_that_combine(self, key_defs, options):
        _cfg(key_defs, **options)


class TestExtract:
    def test_field_to_eol_includes_leading_separator(self):
        line = "a 2 z"
        key = parse_keydef("2", _G, False)
        assert _extract(line, _compute_fields(line, None), key) == " 2 z"

    def test_range_single_field_includes_leading_blank(self):
        line = "a 2 z"
        key = parse_keydef("2,2", _G, False)
        assert _extract(line, _compute_fields(line, None), key) == " 2"

    def test_char_offset_past_field_reaches_separator(self):
        line = "y 5"
        key = parse_keydef("1.2", _G, False)
        assert _extract(line, _compute_fields(line, None), key) == " 5"

    def test_missing_field_is_empty(self):
        line = "x 3"
        key = parse_keydef("3,3", _G, False)
        assert _extract(line, _compute_fields(line, None), key) == ""


class TestSortKeydef:
    def test_k2_extends_to_eol_differs_from_k2_2(self):
        data = "a 2 z\nb 2 a\nc 1 m"
        assert _lines(data, ["2"]) == ["c 1 m", "b 2 a", "a 2 z"]
        assert _lines(data, ["2,2"]) == ["c 1 m", "a 2 z", "b 2 a"]

    def test_per_key_numeric(self):
        data = "apple 3\nbanana 1\ncherry 2\napple 10"
        assert _lines(data, ["2,2n"]) == [
            "banana 1",
            "cherry 2",
            "apple 3",
            "apple 10",
        ]

    def test_global_reverse_ignored_by_per_key_typed_key(self):
        data = "z 2\nm 2\na 2"
        assert _lines(data, ["2,2n"], reverse=True) == ["z 2", "m 2", "a 2"]

    def test_stable_disables_last_resort(self):
        data = "z 2\nm 2\na 2"
        assert _lines(data, ["2,2n"]) == ["a 2", "m 2", "z 2"]
        assert _lines(data, ["2,2n"], stable=True) == ["z 2", "m 2", "a 2"]

    def test_multi_key(self):
        data = "a 2 z\nb 2 a\nc 1 m"
        assert _lines(data, ["2,2n", "1,1r"]) == ["c 1 m", "b 2 a", "a 2 z"]

    def test_blank_only_key_sorts_as_string_under_global_numeric(self):
        data = "  a 30\n  b 5\n  c 200"
        assert _lines(data, ["2b"], numeric=True) == [
            "  c 200",
            "  a 30",
            "  b 5",
        ]

    def test_explicit_sep_char_offsets(self):
        data = "apple:12\nbee:3\ncat:100"
        assert _lines(data, ["1.2,1.3"], field_sep=":") == [
            "cat:100",
            "bee:3",
            "apple:12",
        ]

    def test_invalid_key_leaves_lines_via_config(self):
        with pytest.raises(SortKeyError):
            _cfg(["0"])


class TestNumericKeys:
    """-n and -h in the C locale, pinned against GNU sort 9.7."""

    def test_a_newline_is_a_blank_before_a_number(self):
        # A -z record may hold one; sort.c's blanks table counts it.
        data = ["\n5", "3", "\n-5", "-4"]
        assert sort_lines(data, _cfg(numeric=True)) == [
            "\n-5",
            "-4",
            "3",
            "\n5",
        ]

    def test_a_newline_separates_fields(self):
        assert sort_lines(["b\n1", "a\n2"], _cfg(["2,2n"])) == ["b\n1", "a\n2"]

    def test_the_unit_outranks_the_magnitude(self):
        assert _lines("1500\n1.5K\n2000\n1K", human_numeric=True) == [
            "1500",
            "2000",
            "1K",
            "1.5K",
        ]

    def test_only_k_is_a_unit_in_lowercase(self):
        assert _lines("1m\n1M\n2\n1k", human_numeric=True) == [
            "1m",
            "2",
            "1k",
            "1M",
        ]

    def test_a_negative_number_negates_its_unit_and_zero_has_none(self):
        assert _lines("-1K\n-2\n1\n-1M\n0\n-0K\n0K", human_numeric=True) == [
            "-1M",
            "-1K",
            "-2",
            "-0K",
            "0",
            "0K",
            "1",
        ]

    def test_the_unit_follows_the_digits_and_points(self):
        assert _lines(
            "5.K\n3K\n.5K\n3\nK", human_numeric=True, stable=True
        ) == ["K", "3", ".5K", "3K", "5.K"]

    def test_human_numbers_compare_exactly(self):
        assert _lines(
            "1.000000000000000002K\n1.000000000000000001K",
            human_numeric=True,
            stable=True,
        ) == ["1.000000000000000001K", "1.000000000000000002K"]


async def _rb(_path):
    raise AssertionError("stdin-driven tests never read paths")


async def _run_sort(data: bytes, **kwargs) -> list[str]:
    output, _ = await sort_generic([], read_bytes=_rb, stdin=data, **kwargs)
    return output.decode().splitlines()


class TestSortDefault:
    @pytest.mark.asyncio
    async def test_alphabetical(self):
        result = await _run_sort(b"banana\napple\ncherry")
        assert result == ["apple", "banana", "cherry"]

    @pytest.mark.asyncio
    async def test_already_sorted(self):
        result = await _run_sort(b"a\nb\nc")
        assert result == ["a", "b", "c"]


class TestSortReverse:
    @pytest.mark.asyncio
    async def test_reverse(self):
        result = await _run_sort(b"banana\napple\ncherry", reverse=True)
        assert result == ["cherry", "banana", "apple"]


class TestSortNumeric:
    @pytest.mark.asyncio
    async def test_numeric(self):
        result = await _run_sort(b"10\n2\n30\n1", numeric=True)
        assert result == ["1", "2", "10", "30"]

    @pytest.mark.asyncio
    async def test_non_numeric_lines(self):
        result = await _run_sort(b"10\nabc\n2\nxyz", numeric=True)
        assert result[0] in ("abc", "xyz")
        assert "10" in result


class TestSortUnique:
    @pytest.mark.asyncio
    async def test_unique(self):
        result = await _run_sort(
            b"banana\napple\nbanana\napple\ncherry", unique=True
        )
        assert result == ["apple", "banana", "cherry"]


class TestSortIgnoreCase:
    @pytest.mark.asyncio
    async def test_ignore_case(self):
        result = await _run_sort(b"Banana\napple\nCherry", fold_case=True)
        assert result == ["apple", "Banana", "Cherry"]


class TestSortKeyField:
    @pytest.mark.asyncio
    async def test_key_field_numeric(self):
        result = await _run_sort(
            b"a 10\nb 2\nc 30", key_defs=["2"], numeric=True
        )
        assert result == ["b 2", "a 10", "c 30"]


class TestSortFieldSep:
    @pytest.mark.asyncio
    async def test_field_sep_with_key(self):
        result = await _run_sort(
            b"a:10\nb:2\nc:30",
            field_separator=":",
            key_defs=["2"],
            numeric=True,
        )
        assert result == ["b:2", "a:10", "c:30"]


class TestSortGeneralNumeric:
    @pytest.mark.asyncio
    async def test_infinity_and_hex_parse_like_float(self):
        result = await _run_sort(
            b"inf\n5\n-3\nnan\nabc", flags={"general_numeric_sort": True}
        )
        assert result == ["abc", "nan", "-3", "5", "inf"]

    @pytest.mark.asyncio
    async def test_a_leading_number_is_read_like_strtold(self):
        result = await _run_sort(
            b"0x10\n5\n12abc\n0x\n0x1p99999",
            flags={"general_numeric_sort": True},
        )
        assert result == ["0x", "5", "12abc", "0x10", "0x1p99999"]


class TestSortMixed:
    @pytest.mark.asyncio
    async def test_numeric_reverse(self):
        result = await _run_sort(b"10\n2\n30\n1", numeric=True, reverse=True)
        assert result == ["30", "10", "2", "1"]

    @pytest.mark.asyncio
    async def test_unique_ignore_case(self):
        result = await _run_sort(
            b"Apple\napple\nBanana\nbanana", unique=True, fold_case=True
        )
        assert len(result) == 2
        assert result[0].lower() == "apple"
        assert result[1].lower() == "banana"


# Measured against GNU coreutils 9.7 on debian:stable-slim, LC_ALL=C.
class TestUniqueStopsAtTheKeys:
    def test_key_equal_lines_compare_equal_under_unique(self):
        cfg = _cfg(["2,2"], unique=True)
        assert compare_lines("b 1", "a 1", cfg) == 0
        assert compare_lines("b 1", "a 1", _cfg(["2,2"])) > 0

    def test_unique_keeps_the_first_key_equal_line_in_input_order(self):
        assert _lines("b 1\na 1", ["2,2"], unique=True) == ["b 1"]
        assert _lines("b\na\nB", fold_case=True, unique=True) == ["a", "b"]

    def test_unique_reverse_keeps_input_order_among_ties(self):
        assert _lines("a 1\nb 1\nc 2", ["2,2"], unique=True, reverse=True) == [
            "c 2",
            "a 1",
        ]


class TestMergeLines:
    def test_a_run_is_never_reordered(self):
        assert merge_lines([["b", "a"]], _cfg()) == ["b", "a"]

    def test_the_smallest_head_goes_first(self):
        assert merge_lines([["c", "a"], ["b"]], _cfg()) == ["b", "c", "a"]
        assert merge_lines([["a", "d"], ["b", "e"], ["c", "f"]], _cfg()) == [
            "a",
            "b",
            "c",
            "d",
            "e",
            "f",
        ]

    def test_a_tie_goes_to_the_earlier_run(self):
        runs = [["k 3"], ["k 1"], ["k 2"]]
        assert merge_lines(runs, _cfg(["1,1"], stable=True)) == [
            "k 3",
            "k 1",
            "k 2",
        ]
        assert merge_lines(runs, _cfg(["1,1"])) == ["k 1", "k 2", "k 3"]

    def test_empty_runs_are_skipped(self):
        assert merge_lines([[], ["b", "a"], []], _cfg()) == ["b", "a"]
        assert merge_lines([[], []], _cfg()) == []

    def test_unique_collapses_only_adjacent_duplicates(self):
        cfg = _cfg(unique=True)
        assert merge_lines([["a", "b", "a"]], cfg) == ["a", "b", "a"]
        assert merge_lines([["a", "b"], ["a", "c"]], cfg) == ["a", "b", "c"]

    def test_unique_keeps_the_first_line_of_a_key_equal_series(self):
        assert merge_lines([["x 1"], ["a 1"]], _cfg(["2,2"], unique=True)) == [
            "x 1"
        ]
        assert merge_lines(
            [["b"], ["B"]], _cfg(fold_case=True, unique=True)
        ) == ["b"]
