import re
from collections.abc import AsyncIterator, Callable, Mapping
from dataclasses import dataclass

from mirage.commands.builtin.constants import C_SPACE
from mirage.commands.builtin.utils.bre import BreError, search_bre
from mirage.commands.builtin.utils.operands import (merge_split_errors,
                                                    normalized_read,
                                                    split_readable)
from mirage.commands.builtin.utils.stream import resolve_source
from mirage.commands.config import CommandOpts
from mirage.commands.quote import quote_text
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import FlagValue, FlagView
from mirage.io.async_line_iterator import AsyncLineIterator
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec, PolymorphicReadFn, StatFn

# One numeric option value as `strtol` reads it: a run of C whitespace,
# then at most one sign, then decimal digits, then NOTHING. Matched with
# `fullmatch`, never `match`, because python's `$` also matches
# immediately before a trailing newline and would read `nl -w $'3\n'` as
# the valid width 3.
#
# The leading run is real GNU behavior and easy to miss: `nl -v $'\t5'`,
# `' 5'`, `$'\n5'` and `'  +5'` are all accepted and number from 5,
# while `'5 '` and `'  3  '` are refused -- leading whitespace is
# skipped, trailing whitespace is garbage. The class is spelled out
# rather than written `\s` because it is C `isspace`: python's
# `str.isspace()` and `\s` also match 0x1c-0x1f, which GNU refuses, so
# `\s` would accept four bytes too many. No whitespace may sit BETWEEN
# the sign and the digits (`'+ 5'` is refused), and there is only ever
# one sign. Measured, ground truth NL3-C.
_NUMBER = re.compile(rf"{C_SPACE}[+-]?[0-9]+")

# gnulib appends `strerror(ERANGE)` when a value parsed but fell outside
# the option's range, and `strerror(EOVERFLOW)` when the value did not
# fit the type it was scanned into. Measured under LC_ALL=C on glibc;
# these are the two strings here most likely to read differently under
# another libc or locale.
_ERANGE = "Numerical result out of range"
_EOVERFLOW = "Value too large for defined data type"

# The two type limits nl's four numeric options are bounded by.
_INT_MAX = 2**31 - 1
_INTMAX_MAX = 2**63 - 1
_INTMAX_MIN = -2**63

# Where the sub-minimum side of `-w` and `-l` switches from the ERANGE
# wording to the EOVERFLOW one, measured by bisection on coreutils 9.4 /
# glibc 2.39 / x86-64: `-w -1073741824` is ERANGE and `-w -1073741825`
# is EOVERFLOW, deterministically and whatever else the line carries.
# -2**30 matches no type boundary and no stated range end, so treat this
# as an unexplained gnulib artifact of that platform rather than a rule
# with a reason; it is the value here most likely to move elsewhere.
#
# It belongs to `-w` and `-l` ALONE. `-v` and `-i` switch at the type
# boundary instead (`-i -9223372036854775808` numbers happily and only
# `-9223372036854775809` is refused), so they carry _INTMAX_MIN here and
# the ERANGE clause is unreachable for them.
_WIDTH_OVERFLOW_LOW = -2**30


@dataclass(frozen=True, slots=True)
class NlFlags:
    body_numbering_raw: str | None = None
    start_raw: str | None = None
    increment_raw: str | None = None
    width_raw: str | None = None
    separator: str | None = None
    footer_numbering_raw: str | None = None
    header_numbering_raw: str | None = None
    join_blank_lines_raw: str | None = None
    number_format: str = "rn"
    delimiter: str = "\\:"
    no_renumber: bool = False


def _number_error(label: str, raw: str | None, low: int, high: int,
                  overflow_low: int) -> str | None:
    """GNU ``nl``'s refusal for one of its four numeric options.

    Each option has its own wording and -- unlike expand and cut -- the
    WHOLE argument is quoted. Same shape as ``number_flag_error`` in
    ``tail_counts.py``: validate first, so the ``int`` that follows
    cannot see a prefix.

    THREE message shapes, not two, and which one speaks depends on why
    the value failed rather than on which option it was. A value the
    scanner could not read at all keeps the plain two-clause form
    (``nl -w abc``, ``nl -w ''``). A value that scanned but fell below
    the option's minimum adds ``: Numerical result out of range``
    (``nl -w 0``, ``nl -w -3``). A value too big for the type it is
    scanned into adds ``: Value too large for defined data type``
    instead (``nl -w 2147483648``, ``nl -v 99999999999999999999``) --
    which is the clause a reimplementation is most likely to miss,
    because without it the value is accepted and then blows up building
    the pad rather than being refused.

    The ranges differ per option and split the four two ways. ``-v`` and
    ``-i`` take the whole signed range, so GNU numbers from a negative
    start and counts up, ``-i -2`` genuinely decrements, and zero is
    legal; neither ever produces the ERANGE clause. ``-w`` and ``-l``
    must be at least 1, and ``-w`` additionally tops out at ``INT_MAX``
    where ``-l`` tops out at ``INTMAX_MAX``. All four spell a leading
    ``+`` the way GNU does, as a sign on an otherwise unsigned value.

    Args:
        label (str): the option's own message text, e.g. "invalid
            starting line number".
        raw (str | None): the raw option value, or None when unset.
        low (int): the smallest value GNU accepts for this option.
        high (int): the largest value GNU accepts for this option.
        overflow_low (int): the value below which the refusal takes the
            EOVERFLOW wording rather than the ERANGE one. Equal to
            ``low`` for the two signed options, which is what makes
            their ERANGE clause unreachable.

    Returns:
        str | None: the single stderr line to print, or None when the
            value is one GNU accepts.
    """
    if raw is None:
        return None
    if _NUMBER.fullmatch(raw) is None:
        return f"nl: {label}: '{quote_text(raw)}'"
    value = int(raw)
    if value > high or value < overflow_low:
        return f"nl: {label}: '{quote_text(raw)}': {_EOVERFLOW}"
    if value < low:
        return f"nl: {label}: '{quote_text(raw)}': {_ERANGE}"
    return None


# nl's four numeric options: the dest, the option's own message text,
# the inclusive range GNU accepts, and where the refusal switches to the
# EOVERFLOW wording. The order here is for reading only -- which option
# gets to speak is decided by the command line, never by this tuple.
_NUMERIC_OPTIONS: tuple[tuple[str, str, int, int, int], ...] = (
    ("starting_line_number", "invalid starting line number", _INTMAX_MIN,
     _INTMAX_MAX, _INTMAX_MIN),
    ("line_increment", "invalid line number increment", _INTMAX_MIN,
     _INTMAX_MAX, _INTMAX_MIN),
    ("number_width", "invalid line number field width", 1, _INT_MAX,
     _WIDTH_OVERFLOW_LOW),
    ("join_blank_lines", "invalid line number of blank lines", 1, _INTMAX_MAX,
     _WIDTH_OVERFLOW_LOW),
)

# The three style options and the message each one words its refusal
# with. GNU tests only the FIRST character of the argument (its
# build_type_arg switches on `*optarg`), so `-b tt` is the `t` style
# with a trailing byte GNU never reads again, while `-b A` and an empty
# `-b` fall to the default arm and are refused.
_STYLE_OPTIONS: dict[str, str] = {
    "body_numbering": "invalid body numbering style",
    "footer_numbering": "invalid footer numbering style",
    "header_numbering": "invalid header numbering style",
}
_STYLE_HEADS = frozenset("atnp")

# -n is the one that takes a whole word: GNU strcmps the argument
# against each of the three formats, so `rnn` and `LN` are both refused
# where `-b tt` is accepted. `-d` and `-s` are validated by neither
# GNU nor us -- `-d xyz` and `-s ''` are accepted (measured).
_FORMAT_OPTION = ("number_format", "invalid line numbering format")
_NUMBER_FORMATS = frozenset({"ln", "rn", "rz"})

# The line usage() prints after a deferred refusal. GNU's numeric
# options never reach it: they exit where they are validated.
_HINT = "Try 'nl --help' for more information."


def _style_error(dest: str, raw: str) -> str | None:
    """GNU's refusal for one occurrence of a style or format option.

    Args:
        dest (str): the option's dest, one of the three style options
            or ``number_format``.
        raw (str): the raw option value.

    Returns:
        str | None: the stderr line, or None when GNU accepts the value.
    """
    label = _STYLE_OPTIONS.get(dest)
    if label is not None:
        if raw[:1] in _STYLE_HEADS:
            return None
        return f"nl: {label}: '{quote_text(raw)}'"
    if raw in _NUMBER_FORMATS:
        return None
    return f"nl: {_FORMAT_OPTION[1]}: '{quote_text(raw)}'"


def _pattern_error(dest: str, raw: str) -> str | None:
    """glibc's refusal for a ``p`` style whose BRE will not compile.

    The style itself is already known good here, so a pattern failure
    prints NO ``invalid body numbering style`` line -- only the
    compiler's own wording, which is glibc's ``regerror`` string and not
    coreutils'. It belongs to the FATAL family: ``nl -b 'p[' -h bogus``
    prints the regex line alone, so nothing to its right is scanned and
    the ``--help`` hint never arrives (section U6).

    Args:
        dest (str): the option's dest; only the three style options
            carry a pattern, ``-n`` never does.
        raw (str): the raw option value, ``p`` and the BRE after it.

    Returns:
        str | None: the stderr line, or None when the BRE compiles.
    """
    if dest not in _STYLE_OPTIONS or not raw.startswith("p"):
        return None
    try:
        search_bre(raw[1:])
    except BreError as exc:
        return f"nl: {exc}"
    return None


def _option_errors(fl: FlagView) -> str | None:
    """Everything GNU ``nl`` prints for the options one line carried.

    GNU validates each value the moment getopt hands it over, which
    decides both which option speaks and how the line ends, and its two
    families of options end it differently:

    * A bad NUMERIC value (``-v -i -w -l``) is fatal on the spot, so
      the leftmost one wins and nothing after it is even looked at.
      ``nl -w abc -v xyz`` names the width, ``nl -v xyz -w abc`` names
      the starting line number, and neither prints the ``--help`` hint.
    * A bad STYLE or FORMAT value (``-b -f -h -n``) is reported without
      exiting and parsing continues, so several can accumulate and the
      line ends in ``usage(EXIT_FAILURE)``, which is where the hint
      comes from. This is why ``nl -b bogus -w abc`` prints two lines
      and NO hint (the width killed the parse), ``nl -b bogus -w 3``
      prints one WITH the hint, and ``nl -w abc -b bogus`` prints only
      the width (the parse died before ``-b`` was scanned). All
      measured on GNU coreutils 9.4.
    * A ``p`` style whose BRE will not compile is a THIRD case that
      behaves like the numeric one -- fatal where it stands, no hint --
      but flushes the style lines already deferred to its left, and
      prints no style line of its own because the style was accepted.
      It is checked after the style test, so a bad style never reaches
      the regex compiler (``nl -b '['`` is an invalid style, not an
      unterminated bracket).

    Validation is per OCCURRENCE, not per option: ``nl -b bogus -b t``
    still refuses, because GNU had already reported ``bogus`` when the
    second ``-b`` overrode it. That is what ``value_occurrences`` is
    for -- the bag keeps one value per scalar option, so it cannot
    answer for ``nl -w abc -w 3``, where the value GNU refuses is the
    one the bag dropped.

    Args:
        fl (FlagView): spec-bound view over nl's flag bag.

    Returns:
        str | None: the stderr text, newline-separated and with no
            trailing newline, or None when GNU accepts every value.
    """
    camps = {
        dest: (label, low, high, overflow_low)
        for dest, label, low, high, overflow_low in _NUMERIC_OPTIONS
    }
    deferred: list[str] = []
    for dest, raw in fl.value_occurrences(*camps, *_STYLE_OPTIONS,
                                          _FORMAT_OPTION[0]):
        if dest in camps:
            label, low, high, overflow_low = camps[dest]
            fatal = _number_error(label, raw, low, high, overflow_low)
            if fatal is not None:
                return "\n".join([*deferred, fatal])
        else:
            error = _style_error(dest, raw)
            if error is not None:
                deferred.append(error)
                continue
            # The style was accepted, so a `p` style now compiles its
            # BRE, and a failure is fatal where it stands -- with every
            # style line deferred before it flushed first.
            fatal = _pattern_error(dest, raw)
            if fatal is not None:
                return "\n".join([*deferred, fatal])
    if deferred:
        return "\n".join([*deferred, _HINT])
    return None


def parse_flags(flags: Mapping[str, FlagValue]) -> NlFlags:
    fl = FlagView(flags, spec=SPECS["nl"])
    error = _option_errors(fl)
    if error is not None:
        raise ValueError(error)
    raw_delimiter = fl.as_str("section_delimiter")
    return NlFlags(
        body_numbering_raw=fl.as_str("body_numbering"),
        start_raw=fl.as_str("starting_line_number"),
        increment_raw=fl.as_str("line_increment"),
        width_raw=fl.as_str("number_width"),
        separator=fl.as_str("number_separator"),
        footer_numbering_raw=fl.as_str("footer_numbering"),
        header_numbering_raw=fl.as_str("header_numbering"),
        join_blank_lines_raw=fl.as_str("join_blank_lines"),
        number_format=fl.as_str("number_format") or "rn",
        # An empty `-d` is not an absent one: GNU disables delimiter
        # matching entirely for it and does NOT fall back to `\\:`, so
        # the default can only be substituted for None. `or` read the
        # empty string as absent and restored the default, which left
        # every `\\:` line still consumed as a section header.
        delimiter=(raw_delimiter if raw_delimiter is not None else "\\:"),
        no_renumber=fl.as_bool("no_renumber"),
    )


def _should_number(line: str, numbering: str,
                   pattern: re.Pattern[str] | None) -> bool:
    if numbering == "n":
        return False
    if numbering == "a":
        return True
    if numbering == "p" and pattern is not None:
        return pattern.search(line) is not None
    return bool(line.strip())


def _section_delimiters(delimiter: str) -> dict[str, str]:
    """Map each logical-page delimiter line to the section it opens.

    GNU pads a one-character ``-d`` with ``:`` as its second character,
    and an empty ``-d`` disables delimiter matching entirely (it does
    not restore the default ``\\:``).

    "One character" is glibc ``strlen``, i.e. one BYTE, the same measure
    ``_blank_prefix`` takes off the separator. Neither python's code
    points nor JavaScript's UTF-16 units answer it: ``-d 'e-acute'`` is
    two bytes and is used unpadded, so ``é é é`` opens a header while
    ``é:é:é:`` is ordinary text, and both hosts padded it while only one
    of them padded a four-byte emoji. A longer argument is used WHOLE
    and never truncated, so ``-d xyz`` looks for ``xyzxyzxyz``.

    Args:
        delimiter (str): The ``-d``/``--section-delimiter`` argument.
    """
    if not delimiter:
        return {}
    pair = (delimiter if len(delimiter.encode()) > 1 else delimiter + ":")
    return {pair * 3: "header", pair * 2: "body", pair: "footer"}


@dataclass(frozen=True, slots=True)
class NlConfig:
    numbering: dict[str, str]
    patterns: dict[str, re.Pattern[str] | None]
    start: int
    increment: int
    width: int
    separator: str
    number_format: str
    delimiters: dict[str, str]
    join_blank_lines: int
    no_renumber: bool


@dataclass(slots=True)
class NlState:
    number: int
    section: str = "body"
    blank_run: int = 0
    # The advance has left intmax_t; the NEXT line that needs a number
    # is the one that dies (NL3-F).
    overflowed: bool = False
    # That death has happened, so a second operand must not be opened.
    aborted: bool = False


def _format_number(number: int, width: int, number_format: str) -> str:
    if number_format == "ln":
        return str(number).ljust(width)
    if number_format == "rz":
        return str(number).zfill(width)
    return str(number).rjust(width)


def _blank_prefix(config: NlConfig) -> str:
    """What GNU writes in place of a number on an unnumbered line.

    Not the number field plus the separator: GNU builds one
    ``print_no_line_fmt`` of ``lineno_width`` blanks followed by
    ``strlen(separator_str)`` MORE blanks, so the separator is padded
    over rather than printed. The default line is therefore seven
    spaces, not six spaces and a TAB, and the difference is visible on
    every unnumbered line (``nl -b n``, a blank line under ``-b t``, a
    line a ``-b p`` pattern did not match).

    Two things the count does NOT depend on. ``-n``'s format is
    irrelevant -- ``ln``, ``rn`` and ``rz`` all pad to the same width --
    and so is how wide the number would have been, because the declared
    width is what is padded. What it does depend on is the separator's
    length in BYTES, which is glibc's ``strlen``: ``-s 'e-acute'`` pads
    by two, not one, so the length is taken off the encoded form rather
    than off the character count. That also keeps this host and the
    TypeScript twin emitting the same byte count, since python counts
    code points and JavaScript counts UTF-16 units.

    All od-verified on GNU coreutils 9.4 (ground-truth section W):
    ``-w 3`` pads 4, ``-w 10`` pads 11, ``-s ''`` pads 6, ``-s '::'``
    pads 8, ``-w 3 -s '::'`` pads 5.

    Args:
        config (NlConfig): the resolved options, for the number width
            and the separator.

    Returns:
        str: the blanks that stand in for the number and separator.
    """
    return " " * (config.width + len(config.separator.encode()))


def _render_line(line: str, config: NlConfig, state: NlState) -> bytes | None:
    """One input line as nl writes it, or None to abort.

    None means "this line needs a number and the counter has already
    overflowed", which is GNU's fatal `line number overflow`. The check
    is here rather than after the advance because the abort is
    DEFERRED to the next line that needs a number:
    ``nl -v 9223372036854775805`` on three lines prints all three and
    exits 0, while the same start on four lines prints three and exits
    1. An unnumbered line in between still prints
    (``printf 'a\n\nb\n' | nl -v <max>`` writes the numbered line and
    the padded blank, then dies on the `b`). Measured, NL3-F.
    """
    section = config.delimiters.get(line)
    if section is not None:
        state.section = section
        state.blank_run = 0
        if not config.no_renumber:
            state.number = config.start
        # GNU writes an empty line in place of the delimiter itself.
        return b"\n"
    numbering = config.numbering[state.section]
    pattern = config.patterns[state.section]
    should_number = _should_number(line, numbering, pattern)
    if numbering == "a" and not line:
        state.blank_run += 1
        should_number = state.blank_run >= config.join_blank_lines
        if should_number:
            state.blank_run = 0
    else:
        state.blank_run = 0
    if should_number:
        if state.overflowed:
            return None
        prefix = _format_number(state.number, config.width,
                                config.number_format)
        advanced = state.number + config.increment
        if not _INTMAX_MIN <= advanced <= _INTMAX_MAX:
            state.overflowed = True
        else:
            state.number = advanced
        return f"{prefix}{config.separator}{line}\n".encode()
    return _blank_prefix(config).encode() + f"{line}\n".encode()


async def _nl_stream(
    source: AsyncIterator[bytes],
    config: NlConfig,
    state: NlState,
    io: IOResult | None = None,
) -> AsyncIterator[bytes]:
    """Number one source's lines, stopping if the counter overflows.

    GNU numbers the line, prints it, and THEN adds the increment; an
    addition that leaves ``intmax_t`` marks the counter, and the next
    line that NEEDS a number is the one that dies. So the line whose
    number was the limit is still written
    (``nl -v 9223372036854775807`` prints line 1 and exits 1), and a
    run that ends exactly on the limit never dies at all
    (``nl -v 9223372036854775805`` exits 0 on three lines and 1 on
    four). The counter advances only for a line nl NUMBERED, which is
    why ``nl -b n -v 9223372036854775807`` never overflows.

    Reported by mutating the caller's ``IOResult`` the way
    ``truncate_stream`` does, because the exit code is decided after
    the handler already returned its stream. ``error(EXIT_FAILURE, 0,
    ...)`` means errnum 0, so there is no colon clause here -- unlike
    every option refusal in this module.

    Args:
        source (AsyncIterator[bytes]): the raw byte stream to number.
        config (NlConfig): the resolved options.
        state (NlState): the counter and section, carried across
            sources so a second operand continues the numbering.
        io (IOResult | None): the result to mark on overflow. None when
            no caller is watching, which keeps the stream usable from a
            unit test that only wants the bytes.
    """
    async for raw_line in AsyncLineIterator(source):
        line = raw_line.decode(errors="replace")
        rendered = _render_line(line, config, state)
        if rendered is None:
            if io is not None:
                io.exit_code = 1
                io.stderr = b"nl: line number overflow\n"
            state.aborted = True
            return
        yield rendered


async def _nl_multi(
    paths: list[PathSpec],
    read_stream: Callable[..., AsyncIterator[bytes]],
    config: NlConfig,
    io: IOResult | None = None,
) -> AsyncIterator[bytes]:
    state = NlState(config.start)
    for p in paths:
        async for rendered in _nl_stream(read_stream(p), config, state, io):
            yield rendered
        if state.aborted:
            return


def _parse_numbering(raw: str) -> tuple[str, re.Pattern[str] | None]:
    """The style a ``-b``/``-f``/``-h`` argument selects, as GNU reads it.

    GNU switches on the argument's FIRST character and keeps the rest
    only to compile a ``p`` style's pattern, so ``-b nn`` is the ``n``
    style and prints no numbers rather than an unrecognized style
    falling through to ``t``. Anything but a/t/n/p was already refused
    by ``_option_errors``, and so was a ``p`` style whose BRE does not
    compile, so this cannot raise.

    The pattern is a POSIX BRE, not this host's dialect: GNU compiles it
    with ``RE_SYNTAX_POSIX_BASIC``, where ``\\(`` groups and a bare
    ``(`` is a literal -- the inverse of both python ``re`` and
    JavaScript ``RegExp``. It goes through the shared translator so the
    two hosts cannot answer differently, which is what they did when
    each handed the text to its own engine (``nl -b 'p['`` said
    ``unterminated character set at position 0`` here and
    ``Invalid regular expression: /[/: Unterminated character class``
    there, and neither was GNU's ``Invalid regular expression``).

    Args:
        raw (str): the raw option value.
    """
    if raw.startswith("p"):
        return "p", search_bre(raw[1:])
    return raw[:1], None


async def nl(
    paths: list[PathSpec],
    *,
    read_stream: Callable[..., AsyncIterator[bytes]],
    stdin: ByteSource | None = None,
    body_numbering_raw: str | None = None,
    start_raw: str | None = None,
    increment_raw: str | None = None,
    width_raw: str | None = None,
    separator: str | None = None,
    footer_numbering_raw: str | None = None,
    header_numbering_raw: str | None = None,
    join_blank_lines_raw: str | None = None,
    number_format: str = "rn",
    delimiter: str = "\\:",
    no_renumber: bool = False,
) -> tuple[ByteSource | None, IOResult]:
    body_numbering, body_pattern = _parse_numbering(body_numbering_raw or "t")
    footer_numbering, footer_pattern = _parse_numbering(footer_numbering_raw
                                                        or "n")
    header_numbering, header_pattern = _parse_numbering(header_numbering_raw
                                                        or "n")
    start = int(start_raw) if start_raw is not None else 1
    increment = int(increment_raw) if increment_raw is not None else 1
    width = int(width_raw) if width_raw is not None else 6
    config = NlConfig(
        numbering={
            "body": body_numbering,
            "footer": footer_numbering,
            "header": header_numbering,
        },
        patterns={
            "body": body_pattern,
            "footer": footer_pattern,
            "header": header_pattern,
        },
        start=start,
        increment=increment,
        width=width,
        separator=separator if separator is not None else "\t",
        number_format=number_format,
        delimiters=_section_delimiters(delimiter),
        join_blank_lines=int(join_blank_lines_raw or "1"),
        no_renumber=no_renumber,
    )

    # The IOResult is handed back before the stream is drained, so the
    # overflow abort reports by mutating it as it goes -- the shape
    # `truncate_stream` uses for the same reason.
    io = IOResult()
    if paths:
        return _nl_multi(paths, read_stream, config, io), io
    source = resolve_source(stdin, "nl: missing operand")
    return _nl_stream(source, config, NlState(start), io), io


async def nl_generic(
    paths: list[PathSpec],
    texts: list[str],
    opts: CommandOpts,
    stat: StatFn,
    stream: PolymorphicReadFn,
) -> tuple[ByteSource | None, IOResult]:
    """Run nl over resolved operands; mirrors nlGeneric.

    Args:
        paths (list[PathSpec]): Glob-resolved operands, empty for stdin.
        texts (list[str]): Non-path words, unused by nl.
        opts (CommandOpts): Flags and stdin from the dispatcher.
        stat (StatFn): Bound stat called as ``stat(path)``.
        stream (PolymorphicReadFn): Bound reader called as
            ``stream(path)``.
    """
    try:
        parsed = parse_flags(opts.flags)
    except ValueError as exc:
        return None, IOResult(exit_code=1, stderr=f"{exc}\n".encode())
    readable, err = await split_readable(paths, stat, "nl")
    if err and not readable:
        return None, IOResult(exit_code=1, stderr=err)
    return await merge_split_errors(
        await nl(readable,
                 read_stream=normalized_read(stream),
                 stdin=opts.stdin,
                 body_numbering_raw=parsed.body_numbering_raw,
                 start_raw=parsed.start_raw,
                 increment_raw=parsed.increment_raw,
                 width_raw=parsed.width_raw,
                 separator=parsed.separator,
                 footer_numbering_raw=parsed.footer_numbering_raw,
                 header_numbering_raw=parsed.header_numbering_raw,
                 join_blank_lines_raw=parsed.join_blank_lines_raw,
                 number_format=parsed.number_format,
                 delimiter=parsed.delimiter,
                 no_renumber=parsed.no_renumber), err)


__all__ = ["nl", "nl_generic"]
