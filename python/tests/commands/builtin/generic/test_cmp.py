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

from mirage.commands.builtin.generic.cmp import (
    cmp_cmd,
    parse_count,
    parse_flags,
    parse_skip,
    visible,
)
from mirage.commands.errors import UsageError
from mirage.io.stream import materialize
from mirage.types import PathSpec

P1 = PathSpec.from_str_path("/F/one", "")
P2 = PathSpec.from_str_path("/F/two", "")
DASH = PathSpec(virtual="/F/-", directory="/F/", vfs_path="-", raw_path="-")
DEV_STDIN = PathSpec.from_str_path("/dev/stdin", "")


def _reader(first: bytes, second: bytes):
    async def stream(path: PathSpec):
        yield first if path.virtual == P1.virtual else second

    return stream


@pytest.mark.parametrize(
    "raw,value",
    [
        ("4", 4),
        ("1K", 1024),
        ("1k", 1024),
        ("1kB", 1000),
        ("1kiB", 1024),
        ("1M", 1024 * 1024),
        ("0Z", 0),
        ("010", 8),
        ("0x400", 1024),
        ("+1010", 1010),
        (" 1", 1),
        ("9223372036854775807", 2**63 - 1),
        ("7E", 7 * 1024**6),
    ],
)
def test_parse_count_takes_base_zero_digits_and_gnu_size_suffixes(raw, value):
    assert parse_count(raw, "--bytes") == value


@pytest.mark.parametrize(
    "raw",
    [
        "1b",
        "1B",
        "1c",
        "1w",
        "1m",
        "1g",
        "1t",
        "1Q",
        "0Q",
        "1 ",
        "-1",
        "9223372036854775808",
        "8E",
        "1Z",
        "1Y",
    ],
)
def test_parse_count_refuses(raw):
    # diffutils 3.10 takes no od block or char suffix, no Q or R (newer
    # than its gnulib), and caps a count at INTMAX: each is an invalid
    # value, exit 2.
    with pytest.raises(UsageError):
        parse_count(raw, "--bytes")


def test_parse_count_names_the_long_option_it_was_given():
    # GNU says `invalid --bytes value` for -n and `invalid
    # --ignore-initial value` for -i, exit 2. diffutils routes the
    # Try-help line through error(), so it carries the `cmp: ` prefix
    # that coreutils' bare hint does not.
    with pytest.raises(UsageError) as excinfo:
        parse_count("abc", "--bytes")
    assert str(excinfo.value) == (
        "cmp: invalid --bytes value 'abc'\n"
        "cmp: Try 'cmp --help' for more "
        "information."
    )
    assert excinfo.value.exit_code == 2


def test_parse_skip_takes_one_count_for_both_files():
    assert parse_skip("3") == (3, 3)


@pytest.mark.parametrize(
    "raw,named",
    [
        ("1b:1", "1b:1"),
        ("1:1b", "1b"),
        ("1:abc", "abc"),
        ("abc:1", "abc:1"),
        ("1:2:3", "2:3"),
        ("1:", ""),
        (":1", ":1"),
        (":", ":"),
    ],
)
def test_parse_skip_names_the_operand_from_where_it_stopped(raw, named):
    # GNU prints the operand from the position xstrtoumax was reading,
    # so a bad SKIP1 names the whole pair and a bad SKIP2 names only
    # itself. A colon is the one character the first count may stop on.
    with pytest.raises(UsageError) as excinfo:
        parse_skip(raw)
    assert str(excinfo.value).splitlines()[0] == (
        f"cmp: invalid --ignore-initial value '{named}'"
    )


def test_parse_skip_takes_a_colon_pair_for_one_each():
    assert parse_skip("0:3") == (0, 3)
    assert parse_skip("1K:2") == (1024, 2)


@pytest.mark.parametrize(
    "byte,rendered",
    [
        (ord("b"), "b"),
        (9, "^I"),
        (1, "^A"),
        (127, "^?"),
        (0xC3, "M-C"),
        (0xA9, "M-)"),
        (0x80, "M-^@"),
    ],
)
def test_visible_renders_one_byte_the_cat_v_way(byte, rendered):
    assert visible(byte) == rendered


@pytest.mark.parametrize("value", ["1é", "1\x01", "1\r", "1'", "1\\"])
def test_parse_count_leaves_the_value_unescaped(value):
    """`cmp -n` quotes the value but does NOT escape it.

    diffutils is not coreutils: it interpolates the bytes with a plain
    `%s` inside the quotes rather than passing them through gnulib's
    `quote()`, so a control byte, a backslash and a single quote all
    reach stderr as themselves. Measured against GNU diffutils' cmp
    under `LC_ALL=C` with a raw `bytes` argv: `cmp -n 1é` reports
    `invalid --bytes value '1é'` and `cmp -n "1'"` reports
    `'1''`, where the neighbouring coreutils clauses would say
    `'1\\303\\251'` and `'1\\''`. This asymmetry is deliberate; do not
    "fix" it by routing this clause through quote().
    """
    with pytest.raises(UsageError) as exc:
        parse_count(value, "--bytes")
    assert str(exc.value) == (
        f"cmp: invalid --bytes value '{value}'\n"
        "cmp: Try 'cmp --help' for more information."
    )


async def _unread(path: PathSpec):
    raise AssertionError(f"read {path.virtual}")
    yield b""


@pytest.mark.asyncio
@pytest.mark.parametrize("texts", [(), ("1", "0")])
async def test_two_stdin_operands_at_one_offset_are_equal_unread(texts):
    # One name at one skip, or the second skip of zero that leaves the one
    # descriptor where the first put it: diffutils 3.10 reads neither.
    src, io = await cmp_cmd(
        [DASH, DEV_STDIN] if not texts else [DASH, DASH],
        texts,
        stream=_unread,
        stdin=b"abc",
        skip=(1, 1) if not texts else (0, 0),
    )
    assert (src, io.exit_code, io.stderr) == (None, 0, None)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "texts,skip,out,code",
    [
        # SKIP1 skips the first file only; SKIP2 the second.
        (["1"], (0, 0), "", 0),
        (["0", "1"], (0, 0), "/F/one /F/two differ: char 1, line 1\n", 1),
        (["1", "1"], (0, 0), "/F/one /F/two differ: char 1, line 1\n", 1),
        # Base 0 and cmp's own suffixes, as -i reads them.
        (["0x1"], (0, 0), "", 0),
        (["01"], (0, 0), "", 0),
        (["+1"], (0, 0), "", 0),
        # Each file keeps the larger of -i's skip and its operand's.
        (["0", "2"], (1, 1), "/F/one /F/two differ: char 1, line 1\n", 1),
        (["0", "0"], (1, 0), "", 0),
    ],
)
async def test_the_skip_operands_read_as_i_and_keep_the_larger(
    texts, skip, out, code
):
    src, io = await cmp_cmd(
        [P1, P2], texts, stream=_reader(b"xhello\n", b"hello\n"), skip=skip
    )
    got = b"" if src is None else await materialize(src)
    assert (got.decode(), io.exit_code) == (out, code)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "texts,message",
    [
        (["1", "y"], "cmp: invalid --ignore-initial value 'y'"),
        ([""], "cmp: invalid --ignore-initial value ''"),
        (["1:2"], "cmp: invalid --ignore-initial value '1:2'"),
        (["1 "], "cmp: invalid --ignore-initial value '1 '"),
        (
            ["9223372036854775808"],
            "cmp: invalid --ignore-initial value '9223372036854775808'",
        ),
        (["y", "1", "2"], "cmp: invalid --ignore-initial value 'y'"),
    ],
)
async def test_a_bad_or_extra_skip_operand_is_a_usage_error(texts, message):
    with pytest.raises(UsageError) as exc:
        await cmp_cmd([P1, P2], texts, stream=_reader(b"", b""))
    assert str(exc.value) == (
        f"{message}\ncmp: Try 'cmp --help' for more information."
    )
    assert exc.value.exit_code == 2


def test_parse_flags_reads_the_long_spellings_and_refuses_l_with_s():
    # --quiet and --silent are -s; --verbose is -l, and diffutils refuses
    # the pair while it reads the options.
    assert parse_flags({"quiet": True}).silent
    assert parse_flags({"silent": True}).silent
    assert parse_flags({"verbose": True}).verbose
    with pytest.raises(UsageError) as info:
        parse_flags({"verbose": True, "silent": True})
    assert str(info.value) == (
        "cmp: options -l and -s are incompatible\n"
        "cmp: Try 'cmp --help' for more information."
    )


def _chunked(files: dict[str, list[bytes]], pulled: list[str]):
    async def stream(path: PathSpec):
        for chunk in files[path.virtual]:
            pulled.append(path.virtual)
            yield chunk

    return stream


@pytest.mark.asyncio
async def test_a_difference_stops_the_reads():
    pulled: list[str] = []
    files = {
        P1.virtual: [b"ab\nc", b"d", b"never"],
        P2.virtual: [b"ab", b"\ncX", b"never"],
    }
    src, io = await cmp_cmd([P1, P2], stream=_chunked(files, pulled))
    assert (await materialize(src), io.exit_code) == (
        b"/F/one /F/two differ: char 5, line 2\n",
        1,
    )
    assert pulled.count(P1.virtual) == 2
    assert pulled.count(P2.virtual) == 2


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "first,second,err",
    [
        ([b"ab", b"\n"], [b"a", b"b\nmore"], "after byte 3, line 1"),
        ([b"ab", b"c"], [b"abcd"], "after byte 3, in line 1"),
        ([], [b"x"], "which is empty"),
    ],
)
async def test_a_shorter_file_ends_the_streamed_compare(first, second, err):
    files = {P1.virtual: first, P2.virtual: second}
    src, io = await cmp_cmd([P1, P2], stream=_chunked(files, []))
    assert src is None
    assert (await materialize(io.stderr), io.exit_code) == (
        f"cmp: EOF on /F/one {err}\n".encode(),
        1,
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "sizes,limit,code,read",
    [
        ((3, 5), None, 1, False),
        ((3, 5), 3, 0, True),
        ((5, 5), None, 0, True),
        ((None, 5), None, 0, True),
    ],
)
async def test_s_answers_from_the_sizes_when_they_differ(
    sizes, limit, code, read
):
    pulled: list[str] = []
    files = {P1.virtual: [b"abc"], P2.virtual: [b"abc"]}

    async def size_of(path: PathSpec) -> int | None:
        return sizes[0] if path.virtual == P1.virtual else sizes[1]

    src, io = await cmp_cmd(
        [P1, P2],
        stream=_chunked(files, pulled),
        size_of=size_of,
        silent=True,
        limit=limit,
    )
    assert (src, io.exit_code, bool(pulled)) == (None, code, read)
