import pytest

from mirage.commands.builtin.generic.sort import sort
from mirage.commands.builtin.sort_helper import (KeyMods, SortKeyError,
                                                 _compute_fields, _extract,
                                                 build_config, parse_keydef,
                                                 sort_lines)

_G = KeyMods()


def _cfg(key_defs=None, **kw):
    defaults = dict(field_sep=None,
                    reverse=False,
                    numeric=False,
                    unique=False,
                    fold_case=False,
                    human_numeric=False,
                    version_sort=False,
                    month_sort=False,
                    ignore_blanks=False,
                    stable=False)
    defaults.update(kw)
    return build_config(key_defs or [], **defaults)


def _lines(text, key_defs=None, **kw):
    return sort_lines(text.split("\n"), _cfg(key_defs, **kw))


class TestFieldModel:

    def test_default_sep_leading_blanks_belong_to_following_field(self):
        fields = _compute_fields("  zeta    5  x", None)
        assert [start for start, _, _ in fields] == [0, 6, 11]
        assert "".join("  zeta    5  x"[c:e] for _, c, e in fields) == \
            "zeta5x"

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
        assert _lines(data, ["2,2n"]) == \
            ["banana 1", "cherry 2", "apple 3", "apple 10"]

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
        assert _lines(data, ["2b"], numeric=True) == \
            ["  c 200", "  a 30", "  b 5"]

    def test_explicit_sep_char_offsets(self):
        data = "apple:12\nbee:3\ncat:100"
        assert _lines(data, ["1.2,1.3"], field_sep=":") == \
            ["cat:100", "bee:3", "apple:12"]

    def test_invalid_key_leaves_lines_via_config(self):
        with pytest.raises(SortKeyError):
            _cfg(["0"])


async def _rb(_path):
    raise AssertionError("stdin-driven tests never read paths")


async def _run_sort(data: bytes, **kwargs) -> list[str]:
    output, _ = await sort([], read_bytes=_rb, stdin=data, **kwargs)
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
        result = await _run_sort(b"banana\napple\nbanana\napple\ncherry",
                                 unique=True)
        assert result == ["apple", "banana", "cherry"]


class TestSortIgnoreCase:

    @pytest.mark.asyncio
    async def test_ignore_case(self):
        result = await _run_sort(b"Banana\napple\nCherry", fold_case=True)
        assert result == ["apple", "Banana", "Cherry"]


class TestSortKeyField:

    @pytest.mark.asyncio
    async def test_key_field_numeric(self):
        result = await _run_sort(b"a 10\nb 2\nc 30",
                                 key_defs=["2"],
                                 numeric=True)
        assert result == ["b 2", "a 10", "c 30"]


class TestSortFieldSep:

    @pytest.mark.asyncio
    async def test_field_sep_with_key(self):
        result = await _run_sort(b"a:10\nb:2\nc:30",
                                 field_separator=":",
                                 key_defs=["2"],
                                 numeric=True)
        assert result == ["b:2", "a:10", "c:30"]


class TestSortGeneralNumeric:

    @pytest.mark.asyncio
    async def test_infinity_and_hex_parse_like_float(self):
        result = await _run_sort(b"inf\n5\n-3\nnan\nabc",
                                 flags={"general_numeric_sort": True})
        assert result == ["abc", "nan", "-3", "5", "inf"]

    @pytest.mark.asyncio
    async def test_hex_is_not_numeric(self):
        result = await _run_sort(b"0x10\n5",
                                 flags={"general_numeric_sort": True})
        assert result == ["0x10", "5"]


class TestSortMixed:

    @pytest.mark.asyncio
    async def test_numeric_reverse(self):
        result = await _run_sort(b"10\n2\n30\n1", numeric=True, reverse=True)
        assert result == ["30", "10", "2", "1"]

    @pytest.mark.asyncio
    async def test_unique_ignore_case(self):
        result = await _run_sort(b"Apple\napple\nBanana\nbanana",
                                 unique=True,
                                 fold_case=True)
        assert len(result) == 2
        assert result[0].lower() == "apple"
        assert result[1].lower() == "banana"
