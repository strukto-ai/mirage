import pytest

from mirage.commands.builtin.generic.nl import (NlFlags, _section_delimiters,
                                                nl, nl_generic, parse_flags)
from mirage.commands.builtin.generic.rev import rev
from mirage.commands.builtin.generic.sort import sort
from mirage.commands.builtin.generic.tac import tac
from mirage.commands.builtin.generic.tr import tr
from mirage.commands.builtin.generic.uniq import uniq
from mirage.commands.config import CommandOpts
from mirage.commands.spec import SPECS
from mirage.commands.spec.parser import parse_command, parse_to_kwargs
from mirage.commands.spec.types import ParsedFlagValue
from mirage.types import PathSpec


def _spec(path: str) -> PathSpec:
    return PathSpec(vfs_path=(path).strip("/"),
                    virtual=path,
                    directory=path,
                    resolved=True)


def _make_backend(files: dict[str, bytes]):

    async def read_bytes(path):
        spec = path if isinstance(path, PathSpec) else PathSpec(
            vfs_path=(path).strip("/"), virtual=path, directory=path)
        if spec.virtual not in files:
            raise FileNotFoundError(spec.virtual)
        return files[spec.virtual]

    async def read_stream(path):
        spec = path if isinstance(path, PathSpec) else PathSpec(
            vfs_path=(path).strip("/"), virtual=path, directory=path)
        if spec.virtual not in files:
            raise FileNotFoundError(spec.virtual)
        yield files[spec.virtual]

    return read_bytes, read_stream


async def _drain(stdout) -> bytes:
    if stdout is None:
        return b""
    if isinstance(stdout, bytes):
        return stdout
    return b"".join([c async for c in stdout])


@pytest.mark.asyncio
async def test_rev_stdin():
    rb, _ = _make_backend({})
    output, _ = await rev([], read_bytes=rb, stdin=b"hello\nworld\n")
    assert output == b"olleh\ndlrow\n"


@pytest.mark.asyncio
async def test_rev_multi_file_concatenates():
    rb, _ = _make_backend({"/a.txt": b"foo\n", "/b.txt": b"bar\n"})
    output, _ = await rev([_spec("/a.txt"), _spec("/b.txt")], read_bytes=rb)
    assert output == b"oof\nrab\n"


@pytest.mark.asyncio
async def test_rev_missing_input_raises():
    rb, _ = _make_backend({})
    with pytest.raises(ValueError, match="missing operand"):
        await rev([], read_bytes=rb)


@pytest.mark.asyncio
async def test_tac_stdin_reverses_lines():
    _, rs = _make_backend({})
    output, _ = await tac([], read_stream=rs, stdin=b"a\nb\nc\n")
    decoded = (await _drain(output)).decode().splitlines()
    assert decoded == ["c", "b", "a"]


@pytest.mark.asyncio
async def test_tac_file_reverses_lines():
    _, rs = _make_backend({"/a.txt": b"a\nb\nc\n"})
    output, io = await tac([_spec("/a.txt")], read_stream=rs)
    decoded = (await _drain(output)).decode().splitlines()
    assert decoded == ["c", "b", "a"]
    assert io.cache == ["/a.txt"]


@pytest.mark.asyncio
async def test_sort_stdin_alpha():
    rb, _ = _make_backend({})
    output, _ = await sort([], read_bytes=rb, stdin=b"c\na\nb\n")
    assert output == b"a\nb\nc\n"


@pytest.mark.asyncio
async def test_sort_reverse():
    rb, _ = _make_backend({})
    output, _ = await sort([], read_bytes=rb, stdin=b"a\nb\nc\n", reverse=True)
    assert output == b"c\nb\na\n"


@pytest.mark.asyncio
async def test_sort_numeric():
    rb, _ = _make_backend({})
    output, _ = await sort([],
                           read_bytes=rb,
                           stdin=b"10\n2\n1\n",
                           numeric=True)
    assert output == b"1\n2\n10\n"


@pytest.mark.asyncio
async def test_sort_unique():
    rb, _ = _make_backend({})
    output, _ = await sort([],
                           read_bytes=rb,
                           stdin=b"b\na\nb\na\n",
                           unique=True)
    assert output == b"a\nb\n"


@pytest.mark.asyncio
async def test_sort_multi_file_merges():
    rb, _ = _make_backend({"/a.txt": b"c\na\n", "/b.txt": b"b\n"})
    output, _ = await sort([_spec("/a.txt"), _spec("/b.txt")], read_bytes=rb)
    assert output == b"a\nb\nc\n"


@pytest.mark.asyncio
async def test_nl_stdin_default():
    _, rs = _make_backend({})
    output, _ = await nl([], read_stream=rs, stdin=b"alpha\nbeta\n")
    decoded = (await _drain(output)).decode()
    assert "1" in decoded and "alpha" in decoded
    assert "2" in decoded and "beta" in decoded


@pytest.mark.asyncio
async def test_nl_start_value():
    _, rs = _make_backend({})
    output, _ = await nl([],
                         read_stream=rs,
                         stdin=b"alpha\nbeta\n",
                         start_raw="100")
    decoded = (await _drain(output)).decode()
    assert "100" in decoded
    assert "101" in decoded


@pytest.mark.asyncio
async def test_nl_blank_lines_unnumbered_by_default():
    _, rs = _make_backend({})
    output, _ = await nl([], read_stream=rs, stdin=b"alpha\n\nbeta\n")
    decoded = (await _drain(output)).decode().splitlines()
    assert any("1" in ln and "alpha" in ln for ln in decoded)
    assert any("2" in ln and "beta" in ln for ln in decoded)


# Measured against GNU coreutils 9.4: exit 1, one stderr line, no Try line,
# and the WHOLE argument quoted (unlike expand and cut, which quote only the
# unparsed remainder). Each of nl's four numeric options has its own wording.
_NL_REFUSALS = [
    ("starting_line_number", "abc", "invalid starting line number"),
    ("number_width", "abc", "invalid line number field width"),
    ("line_increment", "abc", "invalid line number increment"),
    ("join_blank_lines", "abc", "invalid line number of blank lines"),
    ("starting_line_number", "2x", "invalid starting line number"),
    ("number_width", "2x", "invalid line number field width"),
]


@pytest.mark.parametrize("dest,raw,label", _NL_REFUSALS)
def test_nl_numeric_flag_refusal_matches_gnu(dest, raw, label):
    with pytest.raises(ValueError) as refusal:
        parse_flags({dest: raw})
    assert str(refusal.value) == f"nl: {label}: '{raw}'"


@pytest.mark.parametrize("raw", [" 5 ", "1_0", "0x10", "1e3", ""])
def test_nl_start_is_as_strict_as_gnu(raw):
    """`int()` reads ` 5 ` and `1_0` whole; GNU refuses both."""
    with pytest.raises(ValueError) as refusal:
        parse_flags({"starting_line_number": raw})
    assert str(refusal.value) == f"nl: invalid starting line number: '{raw}'"


@pytest.mark.parametrize("raw", ["5", "05", "-5", "+5", "0"])
def test_nl_start_accepts_what_gnu_accepts(raw):
    """A control: a too-strict guard would refuse a leading zero or sign.

    `-v` is one of nl's two SIGNED options: GNU numbers from a negative
    start and counts up, so `-v -5` prints `    -5`.
    """
    assert parse_flags({"starting_line_number": raw}).start_raw == raw


@pytest.mark.parametrize("dest", ["starting_line_number", "line_increment"])
@pytest.mark.parametrize("raw", ["-5", "0", "+2"])
def test_nl_signed_options_accept_a_negative_and_zero(dest, raw):
    """`-v` and `-i` are signed, and `-i -2` genuinely decrements."""
    assert parse_flags({dest: raw}) is not None


# `-w` and `-l` are nl's other camp: at least 1, and a value that PARSED
# but fell out of range carries a third colon-clause the scan failure does
# not. Measured on GNU coreutils 9.4 under LC_ALL=C; still no Try line.
_NL_ERANGE = "Numerical result out of range"
_NL_OUT_OF_RANGE = [
    ("number_width", "-3", "invalid line number field width"),
    ("number_width", "0", "invalid line number field width"),
    ("join_blank_lines", "-2", "invalid line number of blank lines"),
    ("join_blank_lines", "0", "invalid line number of blank lines"),
]


@pytest.mark.parametrize("dest,raw,label", _NL_OUT_OF_RANGE)
def test_nl_positive_options_report_out_of_range(dest, raw, label):
    with pytest.raises(ValueError) as refusal:
        parse_flags({dest: raw})
    assert str(refusal.value) == f"nl: {label}: '{raw}': {_NL_ERANGE}"


@pytest.mark.parametrize(
    "dest,label", [("number_width", "invalid line number field width"),
                   ("join_blank_lines", "invalid line number of blank lines")])
def test_nl_positive_options_omit_out_of_range_for_an_empty_value(dest, label):
    """The clause attaches to a range failure, never to a scan failure.

    Within one option the message shape therefore depends on WHY the
    value failed, so the clause must not be appended unconditionally.
    """
    with pytest.raises(ValueError) as refusal:
        parse_flags({dest: ""})
    assert str(refusal.value) == f"nl: {label}: ''"


@pytest.mark.parametrize("dest", ["number_width", "join_blank_lines"])
def test_nl_positive_options_accept_one_and_a_leading_plus(dest):
    """A control: 1 and `+3` are both in range."""
    assert parse_flags({dest: "1"}) is not None
    assert parse_flags({dest: "+3"}) is not None


def _nl_bag(*argv: str) -> dict[str, ParsedFlagValue]:
    """nl's flag bag as the real parser fills it from one command line.

    The precedence rule is about the order the options were TYPED, so a
    hand-written dict would be assuming the very thing under test. These
    cases go through the spec parser so the bag carries whatever order
    the parser actually preserves.

    Args:
        argv (str): the words after `nl`.
    """
    return parse_to_kwargs(parse_command(SPECS["nl"], list(argv), "/"))


def _nl_parse(*argv: str) -> NlFlags:
    """nl's flags read the way the dispatcher hands them over.

    Args:
        argv (str): the words after `nl`.
    """
    return parse_flags(_nl_bag(*argv))


# GNU validates each numeric option's value the moment getopt hands it
# over and exits on that first failure, so the LEFTMOST bad option on the
# line speaks and every pair reverses when the flags are swapped.
# Measured on GNU coreutils 9.4 (ground truth section N). Declaration
# order (-v, -i, -w, -l) would force -v to win in `nl -w abc -v xyz`; GNU
# reports the width.
_NL_FIRST_ON_THE_LINE = [
    (("-w", "abc", "-v", "xyz"), "nl: invalid line number field width: 'abc'"),
    (("-v", "xyz", "-w", "abc"), "nl: invalid starting line number: 'xyz'"),
    (("-i", "abc", "-v", "xyz"), "nl: invalid line number increment: 'abc'"),
    (("-v", "xyz", "-i", "abc"), "nl: invalid starting line number: 'xyz'"),
    (("-l", "abc", "-w", "xyz"),
     "nl: invalid line number of blank lines: 'abc'"),
    (("-w", "xyz", "-l", "abc"), "nl: invalid line number field width: 'xyz'"),
    (("-i", "abc", "-w", "xyz"), "nl: invalid line number increment: 'abc'"),
    (("-w", "abc", "-i", "xyz"), "nl: invalid line number field width: 'abc'"),
    (("-l", "abc", "-i", "xyz"),
     "nl: invalid line number of blank lines: 'abc'"),
    (("-i", "abc", "-l", "xyz"), "nl: invalid line number increment: 'abc'"),
    (("-l", "abc", "-v", "xyz"),
     "nl: invalid line number of blank lines: 'abc'"),
    (("-v", "xyz", "-l", "abc"), "nl: invalid starting line number: 'xyz'"),
    # The rule is about position, not spelling: the long forms reverse
    # exactly the same way.
    (("--line-increment=abc", "--number-width=xyz"),
     "nl: invalid line number increment: 'abc'"),
    (("--number-width=xyz", "--line-increment=abc"),
     "nl: invalid line number field width: 'xyz'"),
]


@pytest.mark.parametrize("argv,expected", _NL_FIRST_ON_THE_LINE)
def test_nl_reports_the_first_bad_option_on_the_line(argv, expected):
    with pytest.raises(ValueError) as refusal:
        _nl_parse(*argv)
    assert str(refusal.value) == expected


# A valid value on the left does not shield the bad one on the right, and
# the out-of-range clause travels with whichever option loses.
_NL_MIXED = [
    (("-v", "5", "-w", "abc"), "nl: invalid line number field width: 'abc'"),
    (("-w", "abc", "-v", "5"), "nl: invalid line number field width: 'abc'"),
    (("-w", "3", "-v", "xyz"), "nl: invalid starting line number: 'xyz'"),
    (("-i", "2", "-l", "abc"),
     "nl: invalid line number of blank lines: 'abc'"),
    (("-w", "0", "-v", "xyz"),
     f"nl: invalid line number field width: '0': {_NL_ERANGE}"),
    (("-v", "xyz", "-w", "0"), "nl: invalid starting line number: 'xyz'"),
]


@pytest.mark.parametrize("argv,expected", _NL_MIXED)
def test_nl_a_valid_value_does_not_shield_a_later_bad_one(argv, expected):
    with pytest.raises(ValueError) as refusal:
        _nl_parse(*argv)
    assert str(refusal.value) == expected


_NL_REPEATED_BAD_LAST = [
    (("-w", "3", "-w", "abc"), "nl: invalid line number field width: 'abc'"),
    (("-v", "5", "-v", "abc"), "nl: invalid starting line number: 'abc'"),
    (("-i", "5", "-i", "abc"), "nl: invalid line number increment: 'abc'"),
    (("-l", "5", "-l", "abc"),
     "nl: invalid line number of blank lines: 'abc'"),
]


@pytest.mark.parametrize("argv,expected", _NL_REPEATED_BAD_LAST)
def test_nl_repeated_option_refuses_a_bad_last_value(argv, expected):
    """`nl -w 3 -w abc` refuses the 'abc', exactly as GNU does."""
    with pytest.raises(ValueError) as refusal:
        _nl_parse(*argv)
    assert str(refusal.value) == expected


# The orderings the flag bag alone cannot express: GNU validated the
# EARLIER value and exited on it, while the bag kept only the later one.
# The parser's per-occurrence record is what answers these (section T).
_NL_REPEATED_BAD_FIRST = [
    (("-w", "abc", "-w", "3"), "nl: invalid line number field width: 'abc'"),
    (("-v", "abc", "-v", "5"), "nl: invalid starting line number: 'abc'"),
    (("-i", "abc", "-i", "5"), "nl: invalid line number increment: 'abc'"),
    (("-l", "abc", "-l", "5"),
     "nl: invalid line number of blank lines: 'abc'"),
    # Both occurrences bad: the leftmost still speaks.
    (("-w", "abc", "-w", "xyz"), "nl: invalid line number field width: 'abc'"),
    # Spelling does not matter, only position.
    (("--number-width=abc", "-w", "3"),
     "nl: invalid line number field width: 'abc'"),
    (("-w", "abc", "--number-width=3"),
     "nl: invalid line number field width: 'abc'"),
]


@pytest.mark.parametrize("argv,expected", _NL_REPEATED_BAD_FIRST)
def test_nl_repeated_option_refuses_the_earlier_bad_value(argv, expected):
    """`nl -w abc -w 3` refuses the 'abc' GNU validated first."""
    with pytest.raises(ValueError) as refusal:
        _nl_parse(*argv)
    assert str(refusal.value) == expected


# A repeat interleaved with another option: every value of an
# accumulating option is checked, in the order the options were FIRST
# typed. That is GNU's answer whenever the bad value comes first
# (`nl -w abc -v xyz -w 3` refuses the width although -v sits between
# its two occurrences, coreutils 9.4 section T) and a documented
# divergence when a repeat lands after a different fatal option:
# `nl -w 3 -v xyz -w abc` names the width here where GNU names -v,
# because keeping the line's own order would take a per-occurrence
# record across options, which neither argparse nor the parser keeps.
_NL_INTERLEAVED_REPEATS = [
    (("-w", "3", "-v", "xyz", "-w", "abc"),
     "nl: invalid line number field width: 'abc'"),
    (("-w", "abc", "-v", "xyz", "-w", "3"),
     "nl: invalid line number field width: 'abc'"),
    (("-v", "xyz", "-w", "abc", "-v", "5"),
     "nl: invalid starting line number: 'xyz'"),
    (("-w", "3", "-w", "abc", "-v", "xyz"),
     "nl: invalid line number field width: 'abc'"),
]


@pytest.mark.parametrize("argv,expected", _NL_INTERLEAVED_REPEATS)
def test_nl_reports_the_leftmost_bad_value_across_a_repeat(argv, expected):
    with pytest.raises(ValueError) as refusal:
        _nl_parse(*argv)
    assert str(refusal.value) == expected


@pytest.mark.parametrize("argv,dest,expected", [
    (("-w", "3", "-w", "9"), "width_raw", "9"),
    (("-w", "3", "-v", "5", "-w", "9"), "width_raw", "9"),
    (("-v", "2", "-v", "8"), "start_raw", "8"),
])
def test_nl_a_repeat_of_valid_values_still_takes_the_last(
        argv, dest, expected):
    """The occurrence record refuses; it never reassigns.

    A control on the fix: reading the leftmost BAD value must not also
    make the leftmost GOOD one win, or `nl -w 3 -w 9` would pad to 3.
    """
    assert getattr(_nl_parse(*argv), dest) == expected


# GNU's own style set, read off build_type_arg: the FIRST character of
# the argument must be one of a/t/n/p, so `-b tt` is accepted (and means
# `t`) while `-b A`, `-b P` and an empty `-b` are refused. All three
# style options word their own refusal, and all three are reported
# WITHOUT exiting, so the line ends in usage() and its hint (section U).
_NL_HINT = "Try 'nl --help' for more information."
_NL_BAD_STYLES = [
    ("-b", "bogus", "invalid body numbering style"),
    ("-b", "", "invalid body numbering style"),
    ("-b", "A", "invalid body numbering style"),
    ("-b", "P", "invalid body numbering style"),
    ("-b", "1", "invalid body numbering style"),
    ("-f", "bogus", "invalid footer numbering style"),
    ("-f", "", "invalid footer numbering style"),
    ("-h", "bogus", "invalid header numbering style"),
    ("-h", "A", "invalid header numbering style"),
    ("-n", "bogus", "invalid line numbering format"),
    ("-n", "", "invalid line numbering format"),
    # -n compares the WHOLE word, unlike the styles' first character.
    ("-n", "LN", "invalid line numbering format"),
    ("-n", "rnn", "invalid line numbering format"),
    ("-n", "l", "invalid line numbering format"),
]


@pytest.mark.parametrize("flag,raw,label", _NL_BAD_STYLES)
def test_nl_refuses_a_style_gnu_refuses(flag, raw, label):
    with pytest.raises(ValueError) as refusal:
        _nl_parse(flag, raw)
    assert str(refusal.value) == f"nl: {label}: '{raw}'\n{_NL_HINT}"


@pytest.mark.parametrize("flag", ["-b", "-f", "-h"])
@pytest.mark.parametrize("raw", ["a", "t", "n", "p", "pfoo", "tt", "nn", "aa"])
def test_nl_accepts_every_style_gnu_accepts(flag, raw):
    """A control: `-b p` (empty pattern) and `-b tt` are both legal."""
    assert _nl_parse(flag, raw) is not None


@pytest.mark.parametrize("raw", ["ln", "rn", "rz"])
def test_nl_accepts_every_number_format_gnu_accepts(raw):
    assert _nl_parse("-n", raw).number_format == raw


@pytest.mark.parametrize("argv", [("-d", ""), ("-d", "x"), ("-d", "xy"),
                                  ("-d", "xyz"), ("-s", ""), ("-s", "::")])
def test_nl_validates_neither_delimiter_nor_separator(argv):
    """GNU validates neither, not even a three-character `-d` (section U)."""
    assert _nl_parse(*argv) is not None


@pytest.mark.asyncio
@pytest.mark.parametrize("raw,rendered", [("tt", b"     1\tx\n"),
                                          ("nn", b"       x\n"),
                                          ("aa", b"     1\tx\n"),
                                          ("n", b"       x\n")])
async def test_nl_reads_only_the_first_character_of_a_style(raw, rendered):
    """`-b nn` is the `n` style, not an unknown one falling through to `t`.

    GNU keeps the whole argument but switches on its first character,
    so a trailing byte changes nothing. Measured stdout, section U.
    """
    _, rs = _make_backend({})
    output, _ = await nl([],
                         read_stream=rs,
                         stdin=b"x\n",
                         body_numbering_raw=raw)
    assert (await _drain(output)) == rendered


# An unnumbered line is NOT the number field plus the separator: GNU builds
# one `print_no_line_fmt` of `lineno_width` blanks and then
# `strlen(separator_str)` MORE blanks, so the separator is padded over rather
# than printed. The default line is seven spaces, not six and a TAB. All
# od-verified on GNU coreutils 9.4 (ground-truth section W, which corrects
# sections U and V on this point).
_NL_BLANK_PREFIX = [
    ((), b"       x\n"),
    (("-w", "3"), b"    x\n"),
    (("-w", "1"), b"  x\n"),
    (("-w", "10"), b"           x\n"),
    (("-s", ""), b"      x\n"),
    (("-s", "::"), b"        x\n"),
    (("-s", "ab c"), b"          x\n"),
    (("-w", "3", "-s", "::"), b"     x\n"),
    # The `-n` format changes how a NUMBER is rendered and nothing about the
    # padding, so all three formats pad identically.
    (("-n", "ln"), b"       x\n"),
    (("-n", "rz"), b"       x\n"),
    (("-n", "ln", "-w", "3"), b"    x\n"),
    # The separator's length is counted in BYTES, which is glibc's strlen:
    # a two-byte character pads by two. Measured `nl -b n -s 'é'`.
    (("-s", "é"), b"        x\n"),
    (("-s", "→"), b"         x\n"),
]


@pytest.mark.asyncio
@pytest.mark.parametrize("extra,rendered", _NL_BLANK_PREFIX)
async def test_nl_pads_an_unnumbered_line_over_the_separator(extra, rendered):
    _, rs = _make_backend({})
    parsed = _nl_parse("-b", "n", *extra)
    output, _ = await nl([],
                         read_stream=rs,
                         stdin=b"x\n",
                         body_numbering_raw=parsed.body_numbering_raw,
                         width_raw=parsed.width_raw,
                         separator=parsed.separator,
                         number_format=parsed.number_format)
    assert (await _drain(output)) == rendered


@pytest.mark.asyncio
async def test_nl_pads_a_blank_line_the_same_way():
    """The default `-b t` leaves a blank line unnumbered, and pads it.

    Measured: `printf 'a\n\nb\n' | nl` writes the blank line as seven
    spaces, so the padding is not specific to `-b n`.
    """
    _, rs = _make_backend({})
    output, _ = await nl([], read_stream=rs, stdin=b"a\n\nb\n")
    assert (await _drain(output)) == b"     1\ta\n       \n     2\tb\n"


@pytest.mark.asyncio
async def test_nl_pads_a_line_no_pattern_matched():
    """A `-b p<re>` line that did not match is padded, not separated."""
    _, rs = _make_backend({})
    parsed = _nl_parse("-b", "pfoo")
    output, _ = await nl([],
                         read_stream=rs,
                         stdin=b"x\n",
                         body_numbering_raw=parsed.body_numbering_raw)
    assert (await _drain(output)) == b"       x\n"


# The deferred mechanism, end to end: a style refusal does not exit, so
# a numeric refusal after it prints BOTH lines and drops the hint (the
# numeric option killed the parse before usage() was reached), while a
# valid numeric value after it leaves the hint in place. Measured on GNU
# coreutils 9.4 (section U).
_NL_DEFERRED = [
    (("-b", "bogus", "-w", "abc"),
     "nl: invalid body numbering style: 'bogus'\n"
     "nl: invalid line number field width: 'abc'"),
    (("-b", "bogus", "-w", "3"),
     f"nl: invalid body numbering style: 'bogus'\n{_NL_HINT}"),
    (("-w", "abc", "-b", "bogus"),
     "nl: invalid line number field width: 'abc'"),
    (("-n", "bogus", "-w", "abc"),
     "nl: invalid line numbering format: 'bogus'\n"
     "nl: invalid line number field width: 'abc'"),
    (("-w", "abc", "-n", "bogus"),
     "nl: invalid line number field width: 'abc'"),
    (("-b", "bogus", "-v", "xyz", "-w", "abc"),
     "nl: invalid body numbering style: 'bogus'\n"
     "nl: invalid starting line number: 'xyz'"),
    # Several deferred refusals accumulate in scan order, then the hint.
    (("-b", "bogus", "-h", "bogus"),
     "nl: invalid body numbering style: 'bogus'\n"
     f"nl: invalid header numbering style: 'bogus'\n{_NL_HINT}"),
    (("-n", "bogus", "-b", "bogus"),
     "nl: invalid line numbering format: 'bogus'\n"
     f"nl: invalid body numbering style: 'bogus'\n{_NL_HINT}"),
    (("-b", "bogus", "-h", "bogus", "-f", "bogus"),
     "nl: invalid body numbering style: 'bogus'\n"
     "nl: invalid header numbering style: 'bogus'\n"
     f"nl: invalid footer numbering style: 'bogus'\n{_NL_HINT}"),
    (("-b", "bogus", "-f", "bogus", "-w", "abc"),
     "nl: invalid body numbering style: 'bogus'\n"
     "nl: invalid footer numbering style: 'bogus'\n"
     "nl: invalid line number field width: 'abc'"),
    # A style occurrence GNU has already reported still counts after a
    # later occurrence overrides it.
    (("-b", "bogus", "-b", "t"),
     f"nl: invalid body numbering style: 'bogus'\n{_NL_HINT}"),
    (("-b", "t", "-b", "bogus"),
     f"nl: invalid body numbering style: 'bogus'\n{_NL_HINT}"),
]


@pytest.mark.parametrize("argv,expected", _NL_DEFERRED)
def test_nl_defers_a_style_refusal_and_exits_on_a_numeric_one(argv, expected):
    """The executor appends the trailing newline to the raised message."""
    with pytest.raises(ValueError) as refusal:
        _nl_parse(*argv)
    assert str(refusal.value) == expected


# A `p` style's pattern is a POSIX BRE, and GNU compiles it with glibc, so
# both the refusals and the acceptances are glibc's rather than either host
# engine's. Every row below was measured twice, on `nl -b pPAT` and on
# `expr abc : PAT`, which answer with the same string (new ground-truth
# section W). The messages are glibc `regerror` strings, which is why they
# read unlike coreutils' own: `Unmatched ( or \(` really is the wording.
_NL_BAD_PATTERNS = [
    ("[", "Invalid regular expression"),
    ("[^", "Invalid regular expression"),
    # A bracket that ran off the end with anything in it is the OTHER
    # message; only a bare `[` or `[^` is REG_BADPAT.
    ("[a", "Unmatched [, [^, [:, [., or [="),
    ("[]", "Unmatched [, [^, [:, [., or [="),
    ("[[:alpha:]", "Unmatched [, [^, [:, [., or [="),
    ("[a-", "Unmatched [, [^, [:, [., or [="),
    ("[[:", "Unmatched [, [^, [:, [., or [="),
    (r"\(", "Unmatched ( or \\("),
    (r"a\(b", "Unmatched ( or \\("),
    (r"\)", "Unmatched ) or \\)"),
    (r"a\)", "Unmatched ) or \\)"),
    ("\\", "Trailing backslash"),
    (r"\1", "Invalid back reference"),
    (r"\9", "Invalid back reference"),
    (r"\(a\)\2", "Invalid back reference"),
    (r"\(a\1\)", "Invalid back reference"),
    ("[[:bogus:]]", "Invalid character class name"),
    ("[[.ab.]]", "Invalid collation character"),
    ("[[..]]", "Invalid collation character"),
    ("[[=ab=]]", "Invalid collation character"),
    (r"a\{1,", "Unmatched \\{"),
    (r"a\{2,1\}", "Invalid content of \\{\\}"),
    (r"a\{\}", "Invalid content of \\{\\}"),
    (r"a\{x\}", "Invalid content of \\{\\}"),
    (r"a\{ 1\}", "Invalid content of \\{\\}"),
    (r"a\{-1\}", "Invalid content of \\{\\}"),
    (r"a\{1,,2\}", "Invalid content of \\{\\}"),
    (r"a\{1,2,3\}", "Invalid content of \\{\\}"),
    # RE_DUP_MAX is 32767: 32767 compiles, 32768 does not, on either bound.
    (r"a\{32768\}", "Regular expression too big"),
    (r"a\{0,32768\}", "Regular expression too big"),
    (r"a\{100000\}", "Regular expression too big"),
    # `Invalid range end` is about the KIND of endpoint, never its order.
    ("[[:alpha:]-z]", "Invalid range end"),
    ("[z-[:alpha:]]", "Invalid range end"),
    ("[[=a=]-z]", "Invalid range end"),
    ("[a-c-e]", "Invalid range end"),
]


@pytest.mark.parametrize("flag", ["-b", "-f", "-h"])
@pytest.mark.parametrize("pattern,message", _NL_BAD_PATTERNS)
def test_nl_p_style_refuses_the_patterns_glibc_refuses(flag, pattern, message):
    """A compile failure is fatal and prints NO style line and NO hint.

    The style `p` was accepted, so there is no `invalid body numbering
    style` line; only glibc's own wording, and without the usage hint
    because the failure exits where it stands (section U6).
    """
    with pytest.raises(ValueError) as refusal:
        _nl_parse(flag, "p" + pattern)
    assert str(refusal.value) == f"nl: {message}"


# The constructs where GNU's BRE is the exact INVERSE of both host engines,
# and the ones where glibc accepts what both engines refuse. Each row is a
# subject line the pattern must match, so a pass proves the translation and
# not merely that something compiled.
_NL_GOOD_PATTERNS = [
    # A leading `*` is a literal, where both engines say "nothing to repeat".
    ("*", "*a"),
    ("**", "*a"),
    (r"\+", "+"),
    (r"\?", "?"),
    # With nothing to repeat, the WHOLE `\{...\}` is literal text -- so a
    # body glibc would refuse inside a real interval is never even read.
    (r"\{1\}", "{1}"),
    (r"\{2,1\}", "{2,1}"),
    (r"\{x\}", "{x}"),
    (r"\{32768\}", "{32768}"),
    # `\{,m\}` is `{0,m}`, not a malformed body.
    (r"a\{,3\}", "x"),
    (r"a\{,\}", "x"),
    (r"a\{32767\}", "a" * 32767),
    # An inverted plain range compiles; it is the NEGATED one that matches.
    ("[^z-a]", "q"),
    ("[a-cd-f]", "e"),
    ("[a-c-]", "-"),
    # `\(`/`\)` group and bare parens are literal -- both inverted in JS
    # and python.
    (r"\(a\)b", "ab"),
    ("(a)", "(a)"),
    # Bare `+ ? { } |` are literals; the escaped forms are the operators.
    ("a+b", "a+b"),
    ("a?", "a?"),
    ("a{2}", "a{2}"),
    ("a|b", "a|b"),
    (r"a\|b", "b"),
    (r"a\{2\}", "aa"),
    # GNU's own extensions, and the POSIX classes.
    (r"\wx", "_x"),
    (r"\<x", "x y"),
    (r"\(a\)\1", "aa"),
    ("[[:alpha:]]", "q"),
    ("[[:digit:]]", "7"),
    ("[[=a=]]", "a"),
    ("[[.a.]-z]", "m"),
    ("[]]", "]"),
    # The search is UNANCHORED -- `re_search`, not expr's `re_match`.
    ("o", "foo"),
    ("foo", "xfooy"),
    ("o$", "foo"),
    ("^f", "foo"),
]


@pytest.mark.asyncio
@pytest.mark.parametrize("pattern,subject", _NL_GOOD_PATTERNS)
async def test_nl_p_style_matches_what_glibc_matches(pattern, subject):
    """The pattern compiles AND numbers the line glibc numbers."""
    _, rs = _make_backend({})
    parsed = _nl_parse("-b", "p" + pattern)
    output, _ = await nl([],
                         read_stream=rs,
                         stdin=subject.encode() + b"\n",
                         body_numbering_raw=parsed.body_numbering_raw)
    assert (await _drain(output)) == f"     1\t{subject}\n".encode()


@pytest.mark.parametrize("pattern", ["^o", "[z-a]", "[9-0]x", "pfoo", "q"])
def test_nl_p_style_accepts_a_pattern_that_matches_nothing(pattern):
    """A pattern with no match is not an error, only an unnumbered line.

    Asserted on the refusal and not on stdout on purpose: the unnumbered
    line's bytes are a separate, pre-existing divergence (GNU pads the
    separator with blanks where mirage writes the separator itself).
    """
    assert _nl_parse("-b", "p" + pattern) is not None


# A compile failure joins the FATAL family -- it exits where it stands, so
# nothing to its right is scanned and the hint never arrives -- but it
# flushes the style lines already deferred to its left (section U6).
_NL_PATTERN_ORDER = [
    (("-b", "p[", "-w", "abc"), "nl: Invalid regular expression"),
    (("-w", "abc", "-b", "p["), "nl: invalid line number field width: 'abc'"),
    (("-h", "bogus", "-b", "p["),
     "nl: invalid header numbering style: 'bogus'\n"
     "nl: Invalid regular expression"),
    (("-b", "p[", "-h", "bogus"), "nl: Invalid regular expression"),
    (("-b", "bogus", "-b", "p["), "nl: invalid body numbering style: 'bogus'\n"
     "nl: Invalid regular expression"),
    (("-n", "bogus", "-f", "p\\)"),
     "nl: invalid line numbering format: 'bogus'\n"
     "nl: Unmatched ) or \\)"),
]


@pytest.mark.parametrize("argv,expected", _NL_PATTERN_ORDER)
def test_nl_a_bad_pattern_is_fatal_where_it_stands(argv, expected):
    with pytest.raises(ValueError) as refusal:
        _nl_parse(*argv)
    assert str(refusal.value) == expected


def test_nl_a_bad_style_outranks_its_own_pattern():
    """`-b [` is an invalid STYLE, so the `[` is never a pattern at all.

    The style test reads the first character, and `[` is not one of
    a/t/n/p, so this is the deferred family with the hint -- not the
    fatal regex family. Measured: `nl -b '['` is
    `invalid body numbering style: '['` plus the hint.
    """
    with pytest.raises(ValueError) as refusal:
        _nl_parse("-b", "[")
    assert str(refusal.value) == ("nl: invalid body numbering style: '['\n" +
                                  _NL_HINT)


@pytest.mark.parametrize(
    "argv,dest,expected",
    [(("-v", "1", "-v", "7"), "start_raw", "7"),
     (("-w", "3", "-w", "9"), "width_raw", "9"),
     (("-i", "2", "-i", "4"), "increment_raw", "4"),
     (("-l", "2", "-l", "4"), "join_blank_lines_raw", "4")])
def test_nl_repeated_valid_option_is_last_one_wins(argv, dest, expected):
    """GNU assigns as it reads, so `nl -v 1 -v 7` numbers from 7."""
    assert getattr(_nl_parse(*argv), dest) == expected


@pytest.mark.asyncio
@pytest.mark.parametrize("argv,rendered",
                         [(("-v", "1", "-v", "7"), b"     7\tx\n"),
                          (("-w", "3", "-w", "9"), b"        1\tx\n")])
async def test_nl_last_valid_value_is_the_one_that_numbers(argv, rendered):
    """The od-verified stdout from ground truth section N3."""
    _, rs = _make_backend({})
    parsed = _nl_parse(*argv)
    output, _ = await nl([],
                         read_stream=rs,
                         stdin=b"x\n",
                         start_raw=parsed.start_raw,
                         width_raw=parsed.width_raw)
    assert (await _drain(output)) == rendered


# A trailing newline in a value is refused, and this is the shape of bug
# only python has: `$` also matches immediately BEFORE a trailing newline,
# so `re.match(r"^[+-]?[0-9]+$", "3\\n")` SUCCEEDS and read `nl -w $'3\\n'`
# as the valid width 3. GNU's scanner stops at the first non-digit and
# refuses all four (ground truth NL2-A), as the TypeScript twin always
# did, so the fix is `fullmatch`.
@pytest.mark.parametrize("dest,label", [
    ("starting_line_number", "invalid starting line number"),
    ("line_increment", "invalid line number increment"),
    ("number_width", "invalid line number field width"),
    ("join_blank_lines", "invalid line number of blank lines"),
])
@pytest.mark.parametrize("raw,quoted", [("3\n", "3\\n"), ("5\n", "5\\n"),
                                        ("1\n2", "1\\n2"), ("3\r", "3\\r"),
                                        ("3\x0b", "3\\v"),
                                        ("3\x01", "3\\001")])
def test_nl_numeric_options_refuse_a_trailing_newline(dest, label, raw,
                                                      quoted):
    """The value is rendered through gnulib ``quote()``.

    So the newline is the TWO characters ``\\n``, not the byte. These
    rows were written the other way round in round 8, when the escaping
    was still missing, and are now byte-exact against GNU (NL3-A).
    """
    with pytest.raises(ValueError) as refusal:
        parse_flags({dest: raw})
    assert str(refusal.value) == f"nl: {label}: '{quoted}'"


# The other direction, and the reason `fullmatch` alone was not the whole
# rule: LEADING C whitespace is SKIPPED, because that is what `strtol`
# does. `nl -v $'\t5'` numbers from 5 while `nl -w '3 '` is refused, so
# the anchoring has to reject a trailing blank and accept a leading one.
# The class is C `isspace`, which is NARROWER than python's
# `str.isspace()`: 0x1c-0x1f are whitespace to python and garbage to GNU,
# so `\s` would have accepted four bytes too many. Ground truth NL3-C.
@pytest.mark.parametrize("dest", [
    "starting_line_number", "line_increment", "number_width",
    "join_blank_lines"
])
@pytest.mark.parametrize(
    "raw", ["\t3", " 3", "\n3", "\x0b3", "\f3", "\r3", "  3", "\t\n 3", " +3"])
def test_nl_numeric_options_skip_leading_c_whitespace(dest, raw):
    assert parse_flags({dest: raw}) is not None


@pytest.mark.parametrize("dest,label", [
    ("starting_line_number", "invalid starting line number"),
    ("number_width", "invalid line number field width"),
])
@pytest.mark.parametrize("raw,quoted", [("3 ", "3 "), ("  3  ", "  3  "),
                                        ("+ 3", "+ 3"), ("--3", "--3"),
                                        ("+-3", "+-3"), ("\x1c3", "\\0343")])
def test_nl_numeric_options_refuse_the_rest_of_the_prefix(
        dest, label, raw, quoted):
    """Trailing whitespace, a split sign, two signs, and 0x1c.

    0x1c is the row that says the class is C ``isspace`` and not
    python's: ``str.isspace()`` calls it whitespace, GNU does not.
    """
    with pytest.raises(ValueError) as refusal:
        parse_flags({dest: raw})
    assert str(refusal.value) == f"nl: {label}: '{quoted}'"


@pytest.mark.parametrize("dest", ["starting_line_number", "line_increment"])
def test_nl_signed_options_take_a_negative_after_blanks(dest):
    """`' -5'` is accepted on a signed option; the blanks come first."""
    assert parse_flags({dest: " -5"}) is not None


# nl's numeric options have TWO out-of-range clauses, not one, and which
# one speaks is a type question rather than an option question: a value
# that scanned but fell below the option's minimum gets
# `strerror(ERANGE)`, while one too big for the type it is scanned into
# gets `strerror(EOVERFLOW)`. Without the second clause the huge value is
# ACCEPTED and then fails building the pad. Every row od-verified on GNU
# coreutils 9.4 (ground truth NL2-I).
_NL_EOVERFLOW = "Value too large for defined data type"
_NL_TOO_LARGE = [
    ("number_width", "2147483648", "invalid line number field width"),
    ("number_width", "+2147483648", "invalid line number field width"),
    ("number_width", "99999999999999999999",
     "invalid line number field width"),
    ("join_blank_lines", "9223372036854775808",
     "invalid line number of blank lines"),
    ("join_blank_lines", "99999999999999999999",
     "invalid line number of blank lines"),
    ("starting_line_number", "9223372036854775808",
     "invalid starting line number"),
    ("starting_line_number", "-9223372036854775809",
     "invalid starting line number"),
    ("line_increment", "9223372036854775808", "invalid line number increment"),
    ("line_increment", "-9223372036854775809",
     "invalid line number increment"),
]


@pytest.mark.parametrize("dest,raw,label", _NL_TOO_LARGE)
def test_nl_reports_a_value_too_large_for_the_type(dest, raw, label):
    with pytest.raises(ValueError) as refusal:
        parse_flags({dest: raw})
    assert str(refusal.value) == f"nl: {label}: '{raw}': {_NL_EOVERFLOW}"


@pytest.mark.parametrize("dest,raw", [
    ("number_width", "2147483647"),
    ("join_blank_lines", "2147483648"),
    ("join_blank_lines", "9223372036854775807"),
    ("starting_line_number", "9223372036854775807"),
    ("starting_line_number", "-9223372036854775808"),
    ("line_increment", "9223372036854775807"),
    ("line_increment", "-9223372036854775808"),
])
def test_nl_accepts_the_largest_value_in_range(dest, raw):
    """The controls: each option's own limit is IN range.

    The four do not share one limit, which is why they cannot share one
    bound: `-l 2147483648` numbers happily where `-w 2147483648` is
    refused, and `-v`/`-i` reach the whole signed range.
    """
    assert parse_flags({dest: raw}) is not None


# The two options that demand at least 1 switch WORDINGS partway down
# their negative side, at exactly -2**30, and the two signed ones do not
# switch at all -- `-i -9223372036854775808` numbers happily. Measured by
# bisection on coreutils 9.4 / glibc 2.39 / x86-64 and stable over five
# runs and whatever else the line carried; -2**30 matches no type
# boundary, so this is an unexplained gnulib artifact of that platform
# and is the row here most likely to move (ground truth NL2-I).
@pytest.mark.parametrize("dest,label", [
    ("number_width", "invalid line number field width"),
    ("join_blank_lines", "invalid line number of blank lines"),
])
def test_nl_width_options_switch_wording_at_the_overflow_floor(dest, label):
    with pytest.raises(ValueError) as inside:
        parse_flags({dest: "-1073741824"})
    assert str(inside.value) == (f"nl: {label}: '-1073741824': {_NL_ERANGE}")
    with pytest.raises(ValueError) as below:
        parse_flags({dest: "-1073741825"})
    assert str(below.value) == (f"nl: {label}: '-1073741825': {_NL_EOVERFLOW}")


@pytest.mark.parametrize("dest", ["starting_line_number", "line_increment"])
@pytest.mark.parametrize("raw", ["-1073741825", "-2000000000", "-2147483648"])
def test_nl_signed_options_have_no_overflow_floor_of_their_own(dest, raw):
    """The floor above belongs to `-w` and `-l` alone."""
    assert parse_flags({dest: raw}) is not None


# `-d ''` DISABLES section-delimiter matching; it does not restore the
# default `\\:`. `or` read the empty string as absent, so python kept
# consuming every `\\:` line as a header while TypeScript's `??` did not
# (ground truth NL2-H).
def test_nl_an_empty_delimiter_survives_as_empty():
    assert _nl_parse("-d", "").delimiter == ""


def test_nl_an_absent_delimiter_takes_the_default():
    assert _nl_parse().delimiter == "\\:"


@pytest.mark.asyncio
async def test_nl_an_empty_delimiter_numbers_the_delimiter_lines():
    """The `\\:\\:\\:` line is ordinary text, not a logical-page header."""
    _, rs = _make_backend({})
    output, _ = await nl([],
                         read_stream=rs,
                         stdin=b"\\:\\:\\:\nH\n\\:\\:\nB\n",
                         delimiter="")
    assert (await _drain(output)) == (b"     1\t\\:\\:\\:\n"
                                      b"     2\tH\n"
                                      b"     3\t\\:\\:\n"
                                      b"     4\tB\n")


@pytest.mark.asyncio
async def test_nl_a_default_delimiter_consumes_the_delimiter_lines():
    """The control: the same input with `-d` absent."""
    _, rs = _make_backend({})
    output, _ = await nl([],
                         read_stream=rs,
                         stdin=b"\\:\\:\\:\nH\n\\:\\:\nB\n")
    assert (await _drain(output)) == (b"\n       H\n\n     1\tB\n")


# GNU pads a one-character `-d` with `:`, and "one character" is glibc
# `strlen`, i.e. one BYTE. Neither host's native length answers it:
# python counts code points and JavaScript counts UTF-16 units, so both
# read a two-byte `é` as one and padded it, and only python also padded a
# four-byte emoji. Measured against GNU by feeding each candidate line in
# (ground truth NL2-H): `ééé` opens a header while `é:é:é:` does not.
@pytest.mark.parametrize("delimiter,pair", [
    ("x", "x:"),
    (":", "::"),
    ("é", "é"),
    ("\U0001f600", "\U0001f600"),
    ("xy", "xy"),
    ("xyz", "xyz"),
])
def test_nl_pads_a_delimiter_only_when_it_is_one_byte(delimiter, pair):
    assert _section_delimiters(delimiter) == {
        pair * 3: "header",
        pair * 2: "body",
        pair: "footer",
    }


def test_nl_an_empty_delimiter_maps_nothing():
    assert _section_delimiters("") == {}


_NL_BARE_DELIMITER_HEADERS = [
    ("é", "ééé"),
    ("\U0001f600", "\U0001f600\U0001f600\U0001f600"),
]


@pytest.mark.asyncio
@pytest.mark.parametrize("delimiter,header", _NL_BARE_DELIMITER_HEADERS)
async def test_nl_a_multibyte_delimiter_is_used_unpadded(delimiter, header):
    _, rs = _make_backend({})
    output, _ = await nl([],
                         read_stream=rs,
                         stdin=f"{header}\nH\nA\n".encode(),
                         delimiter=delimiter)
    assert (await _drain(output)) == b"\n       H\n       A\n"


# yapf and ruff measure an emoji's width differently, so this pair lives
# here rather than inline in the decorator.
_NL_PADDED_DELIMITER_LINES = [
    ("é", "é:é:é:"),
    ("\U0001f600", "\U0001f600:\U0001f600:\U0001f600:"),
]


@pytest.mark.asyncio
@pytest.mark.parametrize("delimiter,line", _NL_PADDED_DELIMITER_LINES)
async def test_nl_a_multibyte_delimiter_does_not_match_a_padded_line(
        delimiter, line):
    """The other direction: the `:`-padded form is ordinary text."""
    _, rs = _make_backend({})
    output, _ = await nl([],
                         read_stream=rs,
                         stdin=f"{line}\nH\n".encode(),
                         delimiter=delimiter)
    assert (await _drain(output)) == f"     1\t{line}\n     2\tH\n".encode()


@pytest.mark.asyncio
async def test_nl_generic_returns_a_refusal_rather_than_raising():
    """Every sibling generic catches its own ValueError; nl did not.

    Inside a workspace the executor's catch-all produced identical
    bytes, so this is invisible there -- but a direct call (a unit test,
    an embedder) raised on python where the TypeScript twin returned an
    IOResult. The bytes and the exit code must not move.
    """

    async def never_stat(path):
        raise AssertionError("nl opened an operand although -w was refused")

    def never_stream(path):
        raise AssertionError("nl read an operand although -w was refused")

    output, io = await nl_generic([], [],
                                  CommandOpts(stdin=b"x\n",
                                              flags={"number_width": "abc"}),
                                  never_stat, never_stream)
    assert output is None
    assert io.exit_code == 1
    assert io.stderr == b"nl: invalid line number field width: 'abc'\n"


# GNU numbers the line, prints it, and THEN adds the increment; an
# addition that leaves intmax_t marks the counter, and the next line that
# NEEDS a number is the one that dies. The deferral is the whole point:
# `-v <max-2>` on THREE lines prints all three and exits 0, and only the
# fourth line makes it fatal. `error(EXIT_FAILURE, 0, ...)` means errnum
# 0, so there is no colon clause -- unlike every option refusal.
# Everything here od-verified, ground truth NL3-F.
_INTMAX_MAX_TXT = "9223372036854775807"
_NL_OVERFLOW = [
    # (start, line count, lines printed, exit)
    (_INTMAX_MAX_TXT, 1, 1, 0),
    (_INTMAX_MAX_TXT, 2, 1, 1),
    (_INTMAX_MAX_TXT, 3, 1, 1),
    ("9223372036854775806", 1, 1, 0),
    ("9223372036854775806", 2, 2, 0),
    ("9223372036854775806", 3, 2, 1),
    ("9223372036854775805", 3, 3, 0),
    ("9223372036854775805", 4, 3, 1),
]


@pytest.mark.asyncio
@pytest.mark.parametrize("start,count,printed,exit_code", _NL_OVERFLOW)
async def test_nl_line_number_overflow_is_deferred(start, count, printed,
                                                   exit_code):
    _, rs = _make_backend({})
    stdin = "".join(f"l{i}\n" for i in range(count)).encode()
    output, io = await nl([], read_stream=rs, stdin=stdin, start_raw=start)
    rendered = await _drain(output)
    assert io.exit_code == exit_code
    assert len(rendered.splitlines()) == printed
    if exit_code:
        assert io.stderr == b"nl: line number overflow\n"
    else:
        assert io.stderr in (None, b"")


@pytest.mark.asyncio
async def test_nl_overflow_counts_only_numbered_lines():
    """`-b n` never advances the counter, so it never overflows.

    The row that says the check is on the advance and the advance
    belongs to numbering, not to reading a line.
    """
    _, rs = _make_backend({})
    output, io = await nl([],
                          read_stream=rs,
                          stdin=b"a\nb\n",
                          start_raw=_INTMAX_MAX_TXT,
                          body_numbering_raw="n")
    rendered = await _drain(output)
    assert io.exit_code == 0
    assert rendered == b"       a\n       b\n"


@pytest.mark.asyncio
async def test_nl_overflow_still_prints_unnumbered_lines_first():
    """An unnumbered line between the limit and the abort still prints.

    So the abort is "this line needs a number and cannot have one", not
    "stop reading": `printf 'a\\n\\nb\\n' | nl -v <max>` writes the
    numbered line AND the padded blank, then dies on the `b`.
    """
    _, rs = _make_backend({})
    output, io = await nl([],
                          read_stream=rs,
                          stdin=b"a\n\nb\n",
                          start_raw=_INTMAX_MAX_TXT)
    rendered = await _drain(output)
    assert io.exit_code == 1
    assert io.stderr == b"nl: line number overflow\n"
    assert rendered == f"{_INTMAX_MAX_TXT}\ta\n       \n".encode()


@pytest.mark.asyncio
async def test_nl_overflow_reaches_the_negative_limit_too():
    _, rs = _make_backend({})
    output, io = await nl([],
                          read_stream=rs,
                          stdin=b"a\nb\n",
                          start_raw="-9223372036854775808",
                          increment_raw="-1")
    rendered = await _drain(output)
    assert io.exit_code == 1
    assert io.stderr == b"nl: line number overflow\n"
    assert rendered == b"-9223372036854775808\ta\n"


@pytest.mark.asyncio
async def test_nl_numbers_past_two_to_the_fifty_third_exactly():
    """The counter is an int, not a float.

    A float64 line number loses digits here, which is what the
    TypeScript twin did before it moved to bigint: it printed
    9223372036854776000 where GNU and this host print the value.
    """
    _, rs = _make_backend({})
    output, io = await nl([],
                          read_stream=rs,
                          stdin=b"x\ny\n",
                          start_raw="9007199254740991")
    assert (await _drain(output)) == (b"9007199254740991\tx\n"
                                      b"9007199254740992\ty\n")
    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_tr_translate_charset():
    _, rs = _make_backend({})
    output, _ = await tr([], ("abc", "xyz"), read_stream=rs, stdin=b"cab")
    assert (await _drain(output)) == b"zxy"


@pytest.mark.asyncio
async def test_tr_delete():
    _, rs = _make_backend({})
    # One set: GNU refuses a second operand beside -d without -s.
    output, _ = await tr([], ("aeiou", ),
                         read_stream=rs,
                         stdin=b"hello world",
                         flags={"delete": True})
    assert (await _drain(output)) == b"hll wrld"


@pytest.mark.asyncio
async def test_tr_squeeze():
    _, rs = _make_backend({})
    output, _ = await tr([], (" ", " "),
                         read_stream=rs,
                         stdin=b"a   b   c",
                         flags={"squeeze_repeats": True})
    assert (await _drain(output)) == b"a b c"


@pytest.mark.asyncio
async def test_tr_missing_args_raises():
    _, rs = _make_backend({})
    # GNU: `tr: missing operand` plus the help hint, exit 1 (coreutils 9.7).
    with pytest.raises(ValueError, match="tr: missing operand\n"):
        await tr([], (), read_stream=rs)


@pytest.mark.asyncio
async def test_uniq_dedupes_adjacent():
    _, rs = _make_backend({})
    output, _ = await uniq([], read_stream=rs, stdin=b"a\na\nb\nb\nc\n")
    assert (await _drain(output)) == b"a\nb\nc\n"


@pytest.mark.asyncio
async def test_uniq_keeps_non_adjacent_dupes():
    """Real uniq only collapses adjacent duplicates."""
    _, rs = _make_backend({})
    output, _ = await uniq([], read_stream=rs, stdin=b"a\nb\na\n")
    assert (await _drain(output)) == b"a\nb\na\n"


@pytest.mark.asyncio
async def test_uniq_count():
    _, rs = _make_backend({})
    output, _ = await uniq([],
                           read_stream=rs,
                           stdin=b"a\na\na\nb\n",
                           count=True)
    decoded = (await _drain(output)).decode()
    assert "3" in decoded and "a" in decoded
    assert "1" in decoded and "b" in decoded


@pytest.mark.asyncio
async def test_uniq_duplicates_only():
    _, rs = _make_backend({})
    output, _ = await uniq([],
                           read_stream=rs,
                           stdin=b"a\na\nb\n",
                           duplicates_only=True)
    decoded = (await _drain(output)).decode()
    assert "a" in decoded
    assert "b" not in decoded


@pytest.mark.asyncio
async def test_uniq_unique_only():
    _, rs = _make_backend({})
    output, _ = await uniq([],
                           read_stream=rs,
                           stdin=b"a\na\nb\n",
                           unique_only=True)
    decoded = (await _drain(output)).decode()
    assert "b" in decoded
    assert decoded.count("a") == 0


@pytest.mark.asyncio
async def test_uniq_ignore_case():
    _, rs = _make_backend({})
    output, _ = await uniq([],
                           read_stream=rs,
                           stdin=b"Apple\napple\nBanana\n",
                           ignore_case=True)
    decoded = (await _drain(output)).decode().splitlines()
    assert len(decoded) == 2
