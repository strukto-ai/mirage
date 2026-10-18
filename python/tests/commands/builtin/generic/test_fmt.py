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

from contextlib import aclosing
from typing import TypedDict, Unpack

import pytest

from mirage.commands.builtin.generic.fmt import fmt
from mirage.io.cooperative import chunks
from mirage.io.types import materialize
from mirage.types import PathSpec

# Every expectation below is what GNU coreutils 9.7 fmt printed for the
# same input and flags. Mirrored by fmt.test.ts.
CASES = [
    # Layout costs: each input sits on a tie or a near tie, so moving one
    # cost by a hundredth of a squared column changes the output.
    (
        "cost_line_and_goal",
        {"width": 10, "goal": 0},
        b"e, efaadg (edb\n",
        b"e,\nefaadg\n(edb\n",
    ),
    (
        "cost_uneven",
        {"width": 11},
        b"(fd. ae. (af gjhfhj,\n",
        b"(fd.\nae. (af\ngjhfhj,\n",
    ),
    (
        "cost_sentence_end",
        {"width": 18, "goal": 10},
        b"ghiad, (dhccdi.  (g.\n",
        b"ghiad,\n(dhccdi.  (g.\n",
    ),
    (
        "cost_mark_end",
        {"width": 10},
        b"fij (f, fe, (jecgg.\n",
        b"fij\n(f, fe,\n(jecgg.\n",
    ),
    (
        "cost_opener_start",
        {"width": 9},
        b"jh, ejhj (j.  b df,\n",
        b"jh,\nejhj (j.\nb df,\n",
    ),
    (
        "cost_first_alone",
        {"width": 13},
        b"h fj.  acchc dcfiaa.  jj hie (iifcc (ebbja jhcc\n",
        b"h fj.  acchc\ndcfiaa.\njj hie\n(iifcc\n(ebbja jhcc\n",
    ),
    (
        "cost_last_alone",
        {"width": 9, "goal": 9},
        b"dc jggg hc,\n",
        b"dc\njggg hc,\n",
    ),
    (
        "cost_false_stop_tie_goes_to_the_shorter_line",
        {"width": 63, "goal": 0},
        b"aaaa. " + b"b" * 54 + b" " + b"c" * 7 + b"\n",
        b"aaaa.\n" + b"b" * 54 + b" " + b"c" * 7 + b"\n",
    ),
    (
        "cost_false_stop_outweighs_a_long_line",
        {"width": 64, "goal": 0},
        b"aaaa. " + b"b" * 54 + b" " + b"c" * 8 + b"\n",
        b"aaaa. " + b"b" * 54 + b"\n" + b"c" * 8 + b"\n",
    ),
    (
        "short_last_word_kept_with_another",
        {"width": 10},
        b"aaaa bbbb cc\n",
        b"aaaa\nbbbb cc\n",
    ),
    (
        "two_words_stay_under_the_width",
        {"width": 10},
        b"aaaa bbbbb\n",
        b"aaaa\nbbbbb\n",
    ),
    (
        "remainder_weighs_the_line_after",
        {"width": 33, "goal": 13},
        b"dgmvxmkm knkgnmgs bmdmfkrnsj pqfknn hbcf dwqhc nbxp sfnfwpn\n",
        b"dgmvxmkm knkgnmgs\nbmdmfkrnsj\npqfknn hbcf dwqhc nbxp sfnfwpn\n",
    ),
    (
        "default_goal_rounds_down",
        {"width": 107},
        b"h gdahefd bebdaad aahb ed agabfc haf db bcdec ahgaede gahfa acababh"
        b" b hfcfb gge edf bcag bcafhga gafhf ghad eb gdgcaff ebhbg bfbahc ga"
        b" bbgca bab heebad b afcbd dh gefgf gbgdg cghcgcc h hhcced fd egedeae"
        b" gdcf fh\n",
        b"h gdahefd bebdaad aahb ed agabfc haf db bcdec ahgaede gahfa acababh"
        b" b hfcfb gge edf bcag bcafhga gafhf\nghad eb gdgcaff ebhbg bfbahc ga"
        b" bbgca bab heebad b afcbd dh gefgf gbgdg cghcgcc h hhcced fd egedeae"
        b"\ngdcf fh\n",
    ),
    (
        "goal_alone_allows_ten_more",
        {"goal": 20},
        b"aaaa bbbb cccc dddd eeee ffff gggg hhhh iiii\n",
        b"aaaa bbbb cccc dddd\neeee ffff gggg hhhh iiii\n",
    ),
    (
        "zero_width_puts_a_word_per_line",
        {"width": 0},
        b"one two three\n",
        b"one\ntwo\nthree\n",
    ),
    # Blanks: tabs are written only once the input has shown one, and only
    # where they take fewer bytes than spaces.
    ("tab_not_shorter", {}, b"abcdefg  h\tx\n", b"abcdefg  h\tx\n"),
    ("tab_shorter", {}, b"abcdef  h\tx\n", b"abcdef\th\tx\n"),
    (
        "tab_in_next_indent_counts",
        {},
        b"abc     d\n\ta\nabc     d\n",
        b"abc\td\n\ta\nabc\td\n",
    ),
    (
        "tab_later_in_next_line_does_not",
        {},
        b"abc     d\n  x\ty\n",
        b"abc     d\n  x\ty\n",
    ),
    (
        "gap_keeps_its_typed_columns",
        {},
        b"abc     d\nx\ty\n",
        b"abc\td x\t  y\n",
    ),
    (
        "carriage_return_starts_a_word",
        {"width": 8},
        b"aaaa\rbbbb cccc\n",
        b"aaaa\n\rbbbb\ncccc\n",
    ),
    (
        "width_counts_bytes",
        {"width": 9},
        "éé bbbb\n".encode(),
        "éé\nbbbb\n".encode(),
    ),
    # Sentence ends.
    (
        "closing_quote_keeps_a_sentence_end",
        {"uniform": True},
        b"x end.)  next\n",
        b"x end.)  next\n",
    ),
    (
        "closing_brace_does_not",
        {"uniform": True},
        b"x end.}  next\n",
        b"x end.} next\n",
    ),
    (
        "tab_gap_ends_a_sentence_from_two_columns",
        {"uniform": True},
        b"abcde.\tnext\nabcdef.\tnext\n",
        b"abcde.\tnext abcdef. next\n",
    ),
    # Prefixes.
    (
        "prefix_spaces_are_floors",
        {"prefix": " # ", "width": 10},
        b"# aaa bbb ccc\n # aaa bbb ccc\n\t# aaa bbb ccc\n #aaa bbb ccc\n",
        b"# aaa bbb ccc\n # aaa\n # bbb\n # ccc\n"
        b"\t# aaa\n\t# bbb\n\t# ccc\n #aaa bbb ccc\n",
    ),
    (
        "prefix_tab_matches_as_typed",
        {"prefix": "#\t", "width": 10},
        b"#\taaa bbb ccc\n# aaa bbb ccc\n",
        b"#\taaa\n#\tbbb ccc\n# aaa bbb ccc\n",
    ),
    (
        "prefix_copy_rewrites_blanks_past_it",
        {"prefix": " # "},
        b"\tq\n#        x\n",
        b"\tq\n#\t x\n",
    ),
    (
        "prefix_lines_share_their_lead",
        {"prefix": "#"},
        b" #  a\n #  b\n  # c\n",
        b" #  a b\n  # c\n",
    ),
    (
        "prefix_only_line_prints_bare",
        {"prefix": "# "},
        b"# \n#   \n  #  a b\n",
        b"#\n#\n  #  a b\n",
    ),
    # The input's last line without a newline.
    (
        "copied_last_line_stays_without",
        {"prefix": "#"},
        b"#a\n  x  ",
        b"#a\n  x  ",
    ),
    (
        "space_prefix_wants_its_columns",
        {"prefix": "  ", "width": 10},
        b"  aaa bbb ccc\n aaa bbb\n    aaa bbb ccc\n  \n   \n\taaa bbb ccc\n",
        b"  aaa\n  bbb ccc\n aaa bbb\n    aaa\n    bbb\n    ccc\n\n  \n"
        b"  \taaa\n  \tbbb\n  \tccc\n",
    ),
    ("bare_prefix_last_line_gets_one", {"prefix": "  #"}, b"#", b"#\n"),
    ("blank_last_line_gets_one", {}, b"a\n   ", b"a\n\n"),
    # Indentation under -t, -c and -s.
    (
        "tagged_one_line_hangs_three",
        {"tagged": True, "width": 8},
        b"aaa bbb ccc\n",
        b"aaa bbb\n   ccc\n",
    ),
    (
        "tagged_one_line_keeps_the_last_hang",
        {"tagged": True, "width": 12},
        b"  a\n    b\n\n    xx yy zz ww\n\n    pp qq rr ss\n",
        b"  a b\n\n    xx yy\nzz ww\n\n    pp qq\nrr ss\n",
    ),
    (
        "tagged_hang_left_of_the_prefix",
        {"tagged": True, "width": 10, "prefix": "#"},
        b"#xx aaaa bbbb\n",
        b"#xx\n#aaaa bbbb\n",
    ),
    (
        "crown_one_line_keeps_its_indent",
        {"crown": True, "width": 8},
        b"aaa bbb ccc\n",
        b"aaa\nbbb ccc\n",
    ),
    (
        "crown_wins_over_tagged",
        {"crown": True, "tagged": True},
        b"a b\nc d\ne f\n",
        b"a b c d e f\n",
    ),
    (
        "split_keeps_each_line_and_its_indent",
        {"split_only": True, "width": 6},
        b"  aaa bbb ccc\nddd eee\n",
        b"  aaa\n  bbb\n  ccc\nddd\neee\n",
    ),
]


class _Flags(TypedDict, total=False):
    width: int
    goal: int
    prefix: str
    split_only: bool
    tagged: bool
    crown: bool
    uniform: bool


def _unread(path: PathSpec) -> bytes:
    raise AssertionError(path)


async def run(data: bytes, **flags: Unpack[_Flags]) -> bytes:
    out, io = await fmt([], read_stream=_unread, stdin=data, **flags)
    assert io.exit_code == 0
    return await materialize(out)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("flags", "data", "expected"),
    [c[1:] for c in CASES],
    ids=[c[0] for c in CASES],
)
async def test_fmt_matches_gnu(flags, data, expected):
    assert await run(data, **flags) == expected


@pytest.mark.asyncio
async def test_input_split_anywhere_gives_the_same_output():
    data = b"#  one two.  three\n# four\tfive six seven eight nine ten\n\n#x\n"
    whole = await run(data, prefix="#", width=12)

    async def pieces():
        for i in range(len(data)):
            yield data[i : i + 1]

    out, _ = await fmt(
        [], read_stream=_unread, stdin=pieces(), prefix="#", width=12
    )
    assert await materialize(out) == whole


def lcg_words(seed: int, count: int) -> list[bytes]:
    words = []
    x = seed
    for _ in range(count):
        x = (x * 1103515245 + 12345) % 2147483648
        letters = []
        for _ in range(2 + (x >> 16) % 7):
            x = (x * 1103515245 + 12345) % 2147483648
            letters.append(b"abcdefgh"[(x >> 16) % 8])
        words.append(bytes(letters))
    return words


def cycle_words(count: int) -> list[bytes]:
    return [
        bytes(b"abcdefgh"[(i * 7 + j) % 8] for j in range(1 + i * 5 % 9))
        for i in range(count)
    ]


def marked_words(seed: int, count: int) -> list[bytes]:
    return [
        word + (b"," if i % 7 == 3 else b"." if i % 11 == 5 else b"")
        for i, word in enumerate(lcg_words(seed, count))
    ]


def sentence_words(seed: int, count: int) -> bytes:
    return b"".join(
        word + (b".  " if i % 3 == 2 else b" ")
        for i, word in enumerate(lcg_words(seed, count))
    )


def full_piece_words() -> list[bytes]:
    # Word text reaching exactly 5000 bytes, then a one-byte word.
    pool = lcg_words(157, 2000)
    words: list[bytes] = []
    size = 0
    while size < 4990:
        words.append(pool[len(words)])
        size += len(words[-1])
    rest = pool[len(words) : len(words) + 40]
    return words + [b"q" * (5000 - size), b"x"] + rest


def words_per_line(out: bytes) -> list[int]:
    return [len(line.split()) for line in out.split(b"\n")[:-1]]


@pytest.mark.asyncio
async def test_a_piece_holds_998_words():
    out = await run(b" ".join([b"a"] * 999) + b"\n")
    assert words_per_line(out) == [35] * 11 + [36] * 17 + [2]


@pytest.mark.asyncio
async def test_a_piece_holds_5000_bytes_of_words():
    out = await run(b" ".join(full_piece_words()) + b"\n", width=40)
    assert "".join(map(str, words_per_line(out))) == (
        "567669678666667766655675565664767676666756546755677555776775755667"
        "666665867687585566667667667665677875565767766575676655766776566667"
        "6575977566766666677668765577657785753"
    )


@pytest.mark.asyncio
async def test_a_piece_weighs_its_first_line_against_the_last_printed():
    out = await run(b" ".join(cycle_words(1300)) + b"\n", width=40)
    assert "".join(map(str, words_per_line(out))) == (
        "7" + "6" * 162 + "7" + "6" * 3 + "5" + "6" * 46 + "762"
    )


@pytest.mark.asyncio
async def test_a_piece_of_998_words_has_read_the_next_words_blanks():
    # The tab after the 999th word is read before the first piece prints.
    data = (
        b"        "
        + b" ".join([b"abcd"] * 999)
        + b"\t"
        + b" ".join([b"abcd"] * 101)
    )
    out = await run(data + b"\n", width=40)
    lines = out.split(b"\n")[:-1]
    assert len(lines) == 184
    assert all(line.startswith(b"\t") for line in lines)


@pytest.mark.asyncio
async def test_a_piece_with_punctuation_carries_the_lines_it_weighs_best():
    out = await run(b" ".join(marked_words(1, 1300)) + b"\n", width=40)
    assert "".join(map(str, words_per_line(out))) == (
        "754465585655665766666657555656566577665657666565456655666665555656"
        "665565577776574656556675566555575477667566664565556665775766566768"
        "567565446667765476546656657555656576556567864646565677776566766955"
        "5568655676566865565557568674"
    )


@pytest.mark.asyncio
async def test_a_word_filling_a_piece_prints_its_first_5000_bytes_bare():
    out = await run(b"a " + b"x" * 5010 + b" b\n", width=30)
    assert out == b"a\n" + b"x" * 5010 + b" b\n"


@pytest.mark.asyncio
async def test_a_crown_line_past_a_piece_hangs_from_the_word_that_overflowed():
    # The 501st word does not fit the piece; it starts in input column
    # 8 + 500 * 11 = 5508, and the piece's later lines start there too.
    data = b"\t" + b" ".join([b"abcdefghij"] * 520) + b"\n"
    lines = (await run(data, crown=True, width=40)).split(b"\n")[:-1]
    pair = b"\tabcdefghij abcdefghij"
    assert lines == (
        [pair]
        + [b"\t" * 688 + b"    abcdefghij"] * 497
        + [pair] * 10
        + [b"\tabcdefghij"]
    )


@pytest.mark.asyncio
async def test_a_piece_does_not_count_its_first_word_as_a_sentences():
    out = await run(sentence_words(10, 1300).rstrip() + b"\n", width=14)
    counts = "".join(map(str, words_per_line(out)))
    assert len(counts) == 784
    assert counts[540:600] == (
        "111121212212322222222121222212122121211112123131111212212121"
    )


@pytest.mark.asyncio
async def test_a_piece_fills_on_bytes_before_the_word_ends():
    # The piece is printed before the tab after the long word is read.
    data = b" ".join([b"a"] * 998) + b" " + b"x" * 4100 + b"\tb c d e\n"
    lines = (await run(b"        " + data, width=40)).split(b"\n")[:-1]
    assert len(lines) == 68
    assert all(line.startswith(b"        a") for line in lines[:65])
    assert lines[65:] == [
        b"\t" + b" ".join([b"a"] * 16),
        b"\t" + b"x" * 4100,
        b"\tb c d e",
    ]


@pytest.mark.asyncio
async def test_a_word_printed_bare_takes_no_columns():
    # After the bare 5000 bytes the line goes on in column 8, so the piece
    # that fills at the 501st word hangs from 8 + 1 + 1 + 499 * 11 = 5499.
    data = b"\t" + b"x" * 5001 + b" " + b" ".join([b"abcdefghij"] * 520)
    lines = (await run(data + b"\n", crown=True, width=40)).split(b"\n")[:-1]
    assert lines[0] == b"x" * 5000 + b"\tx abcdefghij abcdefghij"
    assert lines[1:497] == [b"\t" * 687 + b"   abcdefghij"] * 496
    assert lines[497:] == [b"\tabcdefghij abcdefghij"] * 11


class _Endless:
    """Repeats one chunk forever, failing once fmt holds too much of it."""

    def __init__(self, chunk: bytes, limit: int) -> None:
        self.chunk = chunk
        self.limit = limit
        self.sent = 0
        self.got = 0

    def __aiter__(self) -> "_Endless":
        return self

    async def __anext__(self) -> bytes:
        held = self.sent - self.got
        if held > self.limit:
            raise AssertionError(f"fmt holds {held} bytes")
        self.sent += len(self.chunk)
        return self.chunk


async def read_endless(
    source: _Endless, upto: int, **flags: Unpack[_Flags]
) -> None:
    out, _ = await fmt([], read_stream=_unread, stdin=source, **flags)
    assert out is not None
    async with aclosing(chunks(out)) as parts:
        async for part in parts:
            source.got += len(part)
            if source.got >= upto:
                return


@pytest.mark.asyncio
async def test_a_line_that_never_ends_prints_a_piece_at_a_time():
    source = _Endless(b"abcd " * 200, 8000)
    await read_endless(source, 200_000, width=40)
    assert source.got >= 200_000


@pytest.mark.asyncio
async def test_a_word_that_never_ends_prints_5000_bytes_at_a_time():
    source = _Endless(b"x" * 1000, 7000)
    await read_endless(source, 200_000)
    assert source.got >= 200_000


@pytest.mark.asyncio
async def test_a_copied_line_that_never_ends_streams_through():
    source = _Endless(b"abcd " * 200, 2000)
    await read_endless(source, 200_000, prefix="#")
    assert source.got >= 200_000
