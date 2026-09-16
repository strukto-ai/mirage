# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
import pytest

from mirage.commands.builtin.generic.cmp import (cmp_cmd, parse_count,
                                                 parse_skip, visible)
from mirage.commands.errors import UsageError
from mirage.io.stream import materialize
from mirage.types import PathSpec

P1 = PathSpec.from_str_path("/F/one", "")
P2 = PathSpec.from_str_path("/F/two", "")


def _reader(first: bytes, second: bytes):

    async def read_bytes(path: PathSpec) -> bytes:
        return first if path.virtual == P1.virtual else second

    return read_bytes


async def _run(first: bytes, second: bytes, **kwargs):
    src, io = await cmp_cmd([P1, P2],
                            read_bytes=_reader(first, second),
                            **kwargs)
    out = b"" if src is None else await materialize(src)
    return out.decode(), (io.stderr or b"").decode(), io.exit_code


def test_parse_count_takes_digits_and_gnu_size_suffixes():
    assert parse_count("4", "--bytes") == 4
    assert parse_count("1K", "--bytes") == 1024
    assert parse_count("1k", "--bytes") == 1024
    assert parse_count("1kB", "--bytes") == 1000
    assert parse_count("1kiB", "--bytes") == 1024
    assert parse_count("1M", "--bytes") == 1024 * 1024


@pytest.mark.parametrize("raw", ["1b", "1B", "1c", "1w", "1m", "1g", "1t"])
def test_parse_count_rejects_the_letters_od_takes_and_cmp_does_not(raw):
    # diffutils 3.10 lists only kB/K/MB/M/... : no block or char
    # suffixes, and lowercase only as far as k. `cmp -n 1b` is exit 2,
    # where od would read it as 512 bytes.
    with pytest.raises(UsageError):
        parse_count(raw, "--bytes")


def test_parse_count_names_the_long_option_it_was_given():
    # GNU says `invalid --bytes value` for -n and `invalid
    # --ignore-initial value` for -i, exit 2. diffutils routes the
    # Try-help line through error(), so it carries the `cmp: ` prefix
    # that coreutils' bare hint does not.
    with pytest.raises(UsageError) as excinfo:
        parse_count("abc", "--bytes")
    assert str(excinfo.value) == ("cmp: invalid --bytes value 'abc'\n"
                                  "cmp: Try 'cmp --help' for more "
                                  "information.")
    assert excinfo.value.exit_code == 2


def test_parse_count_rejects_an_unknown_suffix():
    # Q and R postdate the gnulib diffutils 3.10 was built against, so
    # they are invalid values rather than overflowing ones: `0Q` fails
    # where `0Z` is a valid zero.
    with pytest.raises(UsageError):
        parse_count("1Q", "--bytes")
    with pytest.raises(UsageError):
        parse_count("0Q", "--bytes")
    assert parse_count("0Z", "--bytes") == 0


def test_parse_count_reads_the_digits_at_base_zero():
    # xstrtoumax's base 0, which python's own int(s, 0) will not do:
    # a bare leading zero is octal and 0x is hex.
    assert parse_count("010", "--bytes") == 8
    assert parse_count("0x400", "--bytes") == 1024
    assert parse_count("+1010", "--bytes") == 1010
    assert parse_count(" 1", "--bytes") == 1
    with pytest.raises(UsageError):
        parse_count("1 ", "--bytes")
    with pytest.raises(UsageError):
        parse_count("-1", "--bytes")


def test_parse_count_rejects_a_product_past_intmax():
    # The ceiling is INTMAX, not UINTMAX, and overflow reports as the
    # same invalid-value error as a bad suffix -- not od's "too large".
    assert parse_count("9223372036854775807", "--bytes") == 2**63 - 1
    assert parse_count("7E", "--bytes") == 7 * 1024**6
    for raw in ("9223372036854775808", "8E", "1Z", "1Y"):
        with pytest.raises(UsageError):
            parse_count(raw, "--bytes")


def test_parse_skip_takes_one_count_for_both_files():
    assert parse_skip("3") == (3, 3)


@pytest.mark.parametrize("raw,named", [
    ("1b:1", "1b:1"),
    ("1:1b", "1b"),
    ("1:abc", "abc"),
    ("abc:1", "abc:1"),
    ("1:2:3", "2:3"),
    ("1:", ""),
    (":1", ":1"),
    (":", ":"),
])
def test_parse_skip_names_the_operand_from_where_it_stopped(raw, named):
    # GNU prints the operand from the position xstrtoumax was reading,
    # so a bad SKIP1 names the whole pair and a bad SKIP2 names only
    # itself. A colon is the one character the first count may stop on.
    with pytest.raises(UsageError) as excinfo:
        parse_skip(raw)
    assert str(excinfo.value).splitlines()[0] == (
        f"cmp: invalid --ignore-initial value '{named}'")


def test_parse_skip_takes_a_colon_pair_for_one_each():
    assert parse_skip("0:3") == (0, 3)
    assert parse_skip("1K:2") == (1024, 2)


@pytest.mark.parametrize("byte,rendered", [
    (ord("b"), "b"),
    (9, "^I"),
    (1, "^A"),
    (127, "^?"),
    (0xC3, "M-C"),
    (0xA9, "M-)"),
    (0x80, "M-^@"),
])
def test_visible_renders_one_byte_the_cat_v_way(byte, rendered):
    assert visible(byte) == rendered


@pytest.mark.asyncio
async def test_print_bytes_switches_the_word_to_byte():
    # GNU counts in `byte` under -b and in `char` otherwise.
    plain, _, _ = await _run(b"abc", b"aXc")
    tagged, _, _ = await _run(b"abc", b"aXc", print_bytes=True)
    assert plain == "/F/one /F/two differ: char 2, line 1\n"
    assert tagged == ("/F/one /F/two differ: byte 2, line 1"
                      " is 142 b 130 X\n")


@pytest.mark.asyncio
async def test_verbose_pads_the_octal_to_three_columns():
    out, _, _ = await _run(b"a\x01c", b"a\x7fc", verbose=True)
    assert out == "2   1 177\n"


@pytest.mark.asyncio
async def test_verbose_with_print_bytes_adds_a_four_wide_char_column():
    out, _, _ = await _run(b"abc", b"aXc", verbose=True, print_bytes=True)
    assert out == "2 142 b    130 X\n"


@pytest.mark.asyncio
async def test_skip_is_applied_per_file():
    # `-i 0:3` keeps all of the first file and drops three bytes of the
    # second, so the very first compared byte differs.
    out, _, code = await _run(b"abcdefgh", b"abcXefgh", skip=(0, 3))
    assert out == "/F/one /F/two differ: char 1, line 1\n"
    assert code == 1


@pytest.mark.asyncio
async def test_eof_is_a_stderr_diagnostic_naming_the_byte_and_line():
    out, err, code = await _run(b"ab\nc", b"ab\ncdef")
    assert out == ""
    assert err == "cmp: EOF on /F/one after byte 4, in line 2\n"
    assert code == 1


@pytest.mark.asyncio
async def test_verbose_eof_reports_the_byte_without_the_line():
    out, err, code = await _run(b"aXc", b"aYcdef", verbose=True)
    assert out == "2 130 131\n"
    assert err == "cmp: EOF on /F/one after byte 3\n"
    assert code == 1


@pytest.mark.asyncio
async def test_a_limit_inside_the_common_prefix_reports_no_difference():
    assert await _run(b"abcdef", b"abcXef", limit=2) == ("", "", 0)


@pytest.mark.parametrize("value", ["1é", "1\x01", "1\r", "1'", "1\\"])
def test_parse_count_leaves_the_value_unescaped(value):
    """`cmp -n` quotes the value but does NOT escape it.

    diffutils is not coreutils: it interpolates the bytes with a plain
    `%s` inside the quotes rather than passing them through gnulib's
    `quote()`, so a control byte, a backslash and a single quote all
    reach stderr as themselves. Measured against GNU diffutils' cmp
    under `LC_ALL=C` with a raw `bytes` argv: `cmp -n 1é` reports
    `invalid --bytes value '1é'` and `cmp -n "1'"` reports
    `'1''`, where the coreutils clauses next door would say
    `'1\\303\\251'` and `'1\\''`. This asymmetry is deliberate; do not
    "fix" it by routing this clause through quote().
    """
    with pytest.raises(UsageError) as exc:
        parse_count(value, "--bytes")
    assert str(exc.value) == (f"cmp: invalid --bytes value '{value}'\n"
                              "cmp: Try 'cmp --help' for more information.")
