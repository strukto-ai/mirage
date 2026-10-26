import asyncio
import sys
from concurrent.futures import ThreadPoolExecutor

import pytest

from mirage.rs.errors import RegexError
from mirage.rs.regex import LineRegex, PosixRegex, posix_escape, posix_regex


async def _texts(regex: PosixRegex, subject: str) -> list[str | None]:
    found = await regex.search(subject)
    assert found is not None
    return [None if span is None else subject[slice(*span)] for span in found]


@pytest.mark.parametrize(
    "pattern,subject,want",
    [
        # Leftmost-longest overall, groups by the first way to that end.
        ("(a|ab)(bc|c)", "abc", ["abc", "a", "bc"]),
        ("(ab|a)(bc|c)", "abc", ["abc", "ab", "c"]),
        ("(a|ab)*", "abab", ["abab", "ab"]),
        ("(a*)(ab)*(b*)", "aabab", ["aabab", "a", "ab", ""]),
        # An iteration that consumes nothing is never taken.
        ("(a*)+", "aa", ["aa", "aa"]),
        ("(a?)*", "aa", ["aa", "a"]),
        # A group inside a later iteration keeps what it took before.
        ("((a)|b)*", "ab", ["ab", "b", "a"]),
    ],
)
@pytest.mark.asyncio
async def test_groups_lie_where_glibc_puts_them(pattern, subject, want):
    assert await _texts(PosixRegex(pattern, True, "sed"), subject) == want


@pytest.mark.asyncio
async def test_offsets_count_characters_of_the_view():
    regex = PosixRegex("é.", utf8=True)
    assert await regex.search("aéb") == [(1, 3)]
    assert await PosixRegex("\\(.\\)", utf8=False).search("\xc3\xa9") == [
        (0, 1),
        (0, 1),
    ]


@pytest.mark.asyncio
async def test_a_global_walk_passes_over_an_empty_match_where_one_ended():
    found = await PosixRegex("a*", dialect="sed").all("baaac")
    assert [spans[0] for spans in found] == [(0, 0), (1, 4), (5, 5)]


@pytest.mark.parametrize(
    "pattern,extended,dialect",
    [
        ("a**", False, "sed"),
        ("*a", True, "sed"),
        ("\\{1\\}", False, "sed"),
        ("*a", True, "posix"),
    ],
)
def test_preceding_refusals_differ_by_dialect(pattern, extended, dialect):
    with pytest.raises(RegexError) as refused:
        PosixRegex(pattern, extended, dialect)
    assert refused.value.message == "Invalid preceding regular expression"


@pytest.mark.asyncio
async def test_regcomps_basic_syntax_takes_what_sed_refuses():
    assert await PosixRegex("a**").search("aa") == [(0, 2)]
    assert await PosixRegex("[z-a]x").search("x") is None
    with pytest.raises(RegexError, match="Invalid range end"):
        PosixRegex("[z-a]", dialect="sed")


@pytest.mark.asyncio
async def test_anchors_read_the_newlines_a_match_consumes():
    assert await PosixRegex("a.^b", True, "sed").search("a\nb") == [(0, 3)]
    assert await PosixRegex("^b", dialect="sed").search("a\nb") is None
    assert await PosixRegex("b$.", True, "sed").search("b\nc") == [(0, 2)]
    assert await PosixRegex("(b)$.", True, "sed").search("b\nc") is None
    assert await PosixRegex("^b", dialect="sed", multiline=True).search(
        "a\nb"
    ) == [(2, 3)]


@pytest.mark.asyncio
async def test_dot_skips_nul_for_regcomp_only():
    assert await PosixRegex("a.b").search("a\0b") is None
    assert await PosixRegex("a[^x]b").search("a\0b") == [(0, 3)]
    assert await PosixRegex("a.b", dialect="sed").search("a\0b") == [(0, 3)]


@pytest.mark.asyncio
async def test_classes_and_case_are_unicode_under_utf8():
    assert await PosixRegex("[[:alpha:]]", utf8=True).search("-é") == [(1, 2)]
    assert await PosixRegex("é", ignore_case=True, utf8=True).search("É")
    assert await PosixRegex("[[:alpha:]]").search("\xc3\xa9") is None


@pytest.mark.asyncio
async def test_a_raw_byte_is_never_found_inside_a_character():
    regex = PosixRegex("\udca9", utf8=True)
    assert await regex.search("é") is None
    assert await regex.search("a\udca9") == [(1, 2)]


@pytest.mark.asyncio
async def test_word_wraps_the_match():
    regex = PosixRegex("ab|abc", True, word=True)
    assert await regex.search("abcd abc") == [(5, 8)]


@pytest.mark.asyncio
async def test_posix_escape_matches_only_itself():
    text = "a.b*c[d]^$\\(e)"
    regex = PosixRegex(posix_escape(text), True)
    assert await regex.search("x" + text) == [(1, 1 + len(text))]


@pytest.mark.asyncio
async def test_lines_select_and_extend_like_grep():
    regex = LineRegex(["ab|abcd", "x"], "extended", word=True)
    assert await regex.matches("abcd y")
    assert not await regex.matches("abcde")
    assert await regex.extents("abcd x") == [(0, 4), (5, 6)]
    assert regex.needles == (b"ab", b"abcd", b"x")


def test_lines_carry_greps_warnings_and_refusals():
    assert LineRegex(["*a"], "extended").warnings == (
        "* at start of expression",
    )
    with pytest.raises(RegexError, match=r"Unmatched \( or \\\("):
        LineRegex(["\\(a"], "basic")


def test_unicode_folding_drops_needles_it_could_miss():
    assert LineRegex(["kelvin"], "fixed", True, True).needles is None
    assert LineRegex(["KELVIN"], "fixed", True).needles == (b"kelvin",)


def test_threads_sharing_one_expression_keep_their_subjects_apart():
    regex = posix_regex("^a.*z$", extended=True)
    subjects = [("a" + "x" * n + ("z" if n % 2 else "y")) for n in range(64)]
    want = [n % 2 == 1 for n in range(64)]

    def scan(_: int) -> bool:
        return all(
            (regex.search_blocking(text) is not None) == hit
            for text, hit in zip(subjects, want, strict=True)
        )

    interval = sys.getswitchinterval()
    sys.setswitchinterval(1e-6)
    try:
        with ThreadPoolExecutor(8) as pool:
            assert all(pool.map(scan, range(64)))
    finally:
        sys.setswitchinterval(interval)


# Backtracking through every way to split the a's before refusing the b:
# millions of steps, so the search pauses and the loop runs between.
LONG_PATTERN = "^\\(a\\|aa\\)*\\1c$"
LONG_SUBJECT = "a" * 26 + "b"


@pytest.mark.asyncio
async def test_a_long_search_lets_the_loop_run_between_its_steps():
    ticks = 0
    done = False

    async def tick() -> None:
        nonlocal ticks
        while not done:
            ticks += 1
            await asyncio.sleep(0)

    ticker = asyncio.create_task(tick())
    try:
        regex = PosixRegex(LONG_PATTERN)
        assert await regex.matches(LONG_SUBJECT) is False
    finally:
        done = True
        await ticker
    assert ticks > 1


@pytest.mark.asyncio
async def test_tasks_sharing_one_expression_keep_their_searches_apart():
    regex = posix_regex(LONG_PATTERN)
    found = await asyncio.gather(
        regex.matches(LONG_SUBJECT),
        regex.search("a" * 26 + "c"),
        regex.matches("aac"),
    )
    assert found == [False, [(0, 27), (24, 25)], True]


@pytest.mark.asyncio
async def test_a_cancelled_search_stops_and_leaves_the_expression_usable():
    regex = PosixRegex(LONG_PATTERN)
    with pytest.raises(TimeoutError):
        await asyncio.wait_for(regex.matches("a" * 40 + "b"), 0.05)
    assert await regex.matches("aac")
