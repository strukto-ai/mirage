import logging
import re
from collections.abc import (
    AsyncIterator,
    Awaitable,
    Callable,
    Mapping,
    Sequence,
)
from dataclasses import replace
from functools import partial

from mirage.cache.read_through import (
    cache_aware_bound_bytes,
    cache_aware_bound_stream,
)
from mirage.commands.builtin.grep_pattern import (
    NEVER_MATCH,
    resolve_pattern,
    rust_escape,
)
from mirage.commands.builtin.grep_scan import exit_code_for
from mirage.commands.builtin.rg_filetypes import FileTypes, type_listing
from mirage.commands.builtin.rg_glob import Overrides
from mirage.commands.builtin.rg_scan import (
    Haystack,
    WalkFilter,
    on_other_mount,
    open_error_line,
    walk_error_line,
    walk_haystacks,
)
from mirage.commands.builtin.rg_search import (
    RgFlags,
    Tally,
    prints_context,
    search_haystack,
    smart_case_folds,
)
from mirage.commands.builtin.types import RegexSyntax
from mirage.commands.builtin.utils.constants import STDIN_OPERAND
from mirage.commands.builtin.utils.links import LinkDoor, link_door
from mirage.commands.builtin.utils.output import (
    format_optional_records,
    format_records,
)
from mirage.commands.builtin.utils.pcre import PcreError, translate_pcre
from mirage.commands.builtin.utils.rust_regex import (
    RustRegexError,
    translate_rust,
    whole_line,
    whole_word,
)
from mirage.commands.builtin.utils.stream import is_stdin, stdin_stream
from mirage.commands.builtin.utils.wrap import (
    call_read_bytes,
    call_readdir,
    call_stat,
    mount_parent_readdir,
    mount_parent_stat,
)
from mirage.commands.config import CommandOpts
from mirage.commands.errors import UsageError
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagBag, FlagView
from mirage.commands.spec.types import FlagValue
from mirage.doors.types import MountView
from mirage.errors.constants import FS_ERRORS, WALK_ERRORS
from mirage.errors.fs import walk_refusal
from mirage.io.types import ByteSource, IOResult
from mirage.shell.bytes import decode_text, encode_text
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.key_prefix import mount_prefix_of

logger = logging.getLogger(__name__)

# ripgrep's own words for a line with no pattern, exit 2 (14.1.1).
RG_NO_PATTERN = "rg: ripgrep requires at least one pattern to execute a search"
# What ripgrep says when a line that named no path searched nothing,
# exit 2 (14.1.1).
NOTHING_SEARCHED = (
    "rg: No files were searched, which means ripgrep probably applied a "
    "filter you didn't expect.\nRunning with --debug will show why files "
    "are being skipped."
)
# ripgrep's name for stdin wherever it names the file a line came from.
STDIN_NAME = "<stdin>"
# The synthetic cwd operand's spelling (routing.CWD_DEFAULT_RAW["rg"]):
# a line that named no path at all.
IMPLICIT_CWD = ""
SORT_KEYS = ("path", "modified", "accessed", "created", "none")
COLOR_CHOICES = ("never", "auto", "always", "ansi")
# --engine's values (ripgrep 14.1.1).
ENGINES = ("default", "pcre2", "auto")
SIZE = re.compile(r"([0-9]+)([KMG]?)")
SIZE_UNIT = {"": 1, "K": 1 << 10, "M": 1 << 20, "G": 1 << 30}
U64_MAX = (1 << 64) - 1
# The numeric options, each named as ripgrep names it in a refusal. The
# bag keeps no record of which spelling the line typed, so a long one
# is refused under its short name.
NUMBER_SPELLINGS = {
    "max_count": "-m",
    "after_context": "-A",
    "before_context": "-B",
    "context": "-C",
    "max_depth": "-d",
    "threads": "-j",
    "max_columns": "-M",
}
_ESCAPES = {"t": "\t", "n": "\n", "r": "\r", "0": "\0", "\\": "\\"}
_HEX_ESCAPE = re.compile(r"\\x([0-9A-Fa-f]{2})")


def operand_name(p: PathSpec) -> str:
    """The name ripgrep prints for an operand.

    ``-`` is ``<stdin>``. ``/dev/stdin`` reads the same bytes, but
    ripgrep opens it as the path it is and names it as typed.

    Args:
        p (PathSpec): the operand.
    """
    return STDIN_NAME if p.raw_path == "-" else p.raw_path


def number_flag(fl: FlagView, dest: str) -> int | None:
    """One numeric option's value, refused in ripgrep's words.

    ripgrep reads every count as an unsigned 64-bit integer, so a sign,
    a fraction or anything past 2**64-1 is refused, exit 2 (14.1.1).

    Args:
        fl (FlagView): the flag view.
        dest (str): the option's dest.

    Raises:
        UsageError: the value is not an unsigned integer.
    """
    raw = fl.raw(dest)
    if raw is None or isinstance(raw, bool):
        return None
    value = str(raw)
    reason = None
    digits = value[1:] if value.startswith("+") else value
    if not value:
        reason = "cannot parse integer from empty string"
    elif not digits or not (digits.isascii() and digits.isdigit()):
        reason = "invalid digit found in string"
    elif int(digits) > U64_MAX:
        reason = "number too large to fit in target type"
    if reason is not None:
        raise UsageError(
            f"rg: error parsing flag {NUMBER_SPELLINGS[dest]}: "
            f"value is not a valid number: {reason}"
        )
    return int(digits)


def filesize_flag(fl: FlagView) -> int | None:
    """--max-filesize in bytes, refused in ripgrep's words.

    Args:
        fl (FlagView): the flag view.

    Raises:
        UsageError: the size is not digits and an optional K, M or G.
    """
    value = fl.as_str("max_filesize")
    if value is None:
        return None
    size = SIZE.fullmatch(value)
    if size is None:
        raise UsageError(
            "rg: error parsing flag --max-filesize: invalid size: invalid "
            f"format for size '{value}', which should be a non-empty "
            "sequence of digits followed by an optional 'K', 'M' or 'G' "
            "suffix"
        )
    return int(size.group(1)) * SIZE_UNIT[size.group(2)]


def _choice(
    fl: FlagView, dest: str, spelling: str, choices: Sequence[str]
) -> str | None:
    """A value from a fixed set, refused in ripgrep's words.

    Args:
        fl (FlagView): the flag view.
        dest (str): the option's dest.
        spelling (str): the option's spelling in the refusal.
        choices (Sequence[str]): the accepted values.
    """
    value = fl.as_str(dest)
    if value is not None and value not in choices:
        raise UsageError(
            f"rg: error parsing flag {spelling}: choice "
            f"'{value}' is unrecognized"
        )
    return value


def unescape(value: str) -> str:
    """A separator's escapes read as ripgrep reads them (``\\t``, ``\\n``,
    ``\\r``, ``\\0``, ``\\\\`` and ``\\xHH``).

    Args:
        value (str): the separator as typed.
    """
    out: list[str] = []
    i = 0
    while i < len(value):
        hexed = _HEX_ESCAPE.match(value, i)
        if hexed is not None:
            out.append(chr(int(hexed.group(1), 16)))
            i = hexed.end()
            continue
        if (
            value[i] == "\\"
            and i + 1 < len(value)
            and value[i + 1] in _ESCAPES
        ):
            out.append(_ESCAPES[value[i + 1]])
            i += 2
            continue
        out.append(value[i])
        i += 1
    return "".join(out)


def _last(fl: FlagView, *names: str) -> str | None:
    """The one of ``names`` the line set last, or None.

    Args:
        fl (FlagView): the flag view.
        names (str): the dests of one last-wins group.
    """
    found = None
    for name in fl.typed_order(*names):
        if (
            fl.as_bool(name)
            or fl.raw(name) is not None
            and not isinstance(fl.raw(name), bool)
        ):
            found = name
    return found


def filename_flag(fl: FlagView) -> str | None:
    """Which of -H and -I the line set last, the one ripgrep obeys.

    Args:
        fl (FlagView): the flag view.
    """
    return _last(fl, "with_filename", "no_filename")


def _context_of(fl: FlagView) -> tuple[bool, int, int]:
    """--passthru and -A/-B/-C resolved in line order, as ripgrep's
    ContextMode resolves them.

    --passthru replaces every context option before it, and a context
    option after it replaces it and starts afresh. -A and -B, even at 0,
    outrank -C for their own side.

    Args:
        fl (FlagView): the flag view.

    Returns:
        tuple[bool, int, int]: --passthru, and the before and after counts.
    """
    passthru = False
    counts: dict[str, int | None] = {}
    for name in fl.typed_order(
        "passthru", "passthrough", "after_context", "before_context", "context"
    ):
        if name in ("passthru", "passthrough"):
            passthru = True
            counts = {}
            continue
        passthru = False
        counts[name] = number_flag(fl, name)
    both = counts.get("context")
    before = counts.get("before_context")
    after = counts.get("after_context")
    return (
        passthru,
        before if before is not None else both or 0,
        after if after is not None else both or 0,
    )


def _binary_mode_of(fl: FlagView, unrestricted: int) -> str:
    """How rg treats a binary file: the last word of its group decides.

    ``text`` under -a, which searches every byte as text; ``binary``
    under --binary or -uuu, which searches what a walk would skip but
    still reports a binary match by its notice; ``auto`` otherwise, and
    after --no-text or --no-binary.

    Args:
        fl (FlagView): the flag view.
        unrestricted (int): how many -u the line gave.
    """
    mode = "auto"
    for name in fl.typed_order(
        "text", "no_text", "binary", "no_binary", "unrestricted"
    ):
        if name == "unrestricted":
            if unrestricted >= 3 and mode == "auto":
                mode = "binary"
        else:
            mode = {"text": "text", "binary": "binary"}.get(name, "auto")
    return mode


def path_separator(fl: FlagView) -> str | None:
    """--path-separator's one byte, None for ripgrep's own ``/``.

    Args:
        fl (FlagView): the flag view.

    Raises:
        UsageError: the separator is not exactly one byte (an empty one
            is the default).
    """
    value = fl.as_str("path_separator")
    if value is None:
        return None
    raw = encode_text(unescape(value))
    if not raw:
        return None
    if len(raw) != 1:
        raise UsageError(
            "rg: error parsing flag --path-separator: A path separator must "
            f"be exactly one byte, but the given separator is {len(raw)} "
            f"bytes: {value}\nIn some shells on Windows '/' is automatically "
            "expanded. Use '//' instead."
        )
    return decode_text(raw)


def parse_flags(fl: FlagView) -> RgFlags:
    """Convert the raw flag bag into RgFlags, the only string-keyed reads.

    Options that override one another are read in line order, the last
    one winning as it does in ripgrep: -i/-s/-S, -w/-x, -n/-N, -H/-I,
    every option and its --no- negation, --hidden/--no-hidden/-uu, the
    output modes -c/--count-matches/-l/--files-without-match,
    --heading/--no-heading, --passthru and the context options,
    --sort/--sortr/--sort-files/--no-sort-files, and
    --context-separator/--no-context-separator.

    Unlike ripgrep 14.1.1, creation-time sorting is refused: FileStat
    has no birth timestamp, so accepting it would silently do nothing.

    Args:
        fl (FlagView): spec-validated view over the raw flag kwargs.

    Raises:
        UsageError: a value ripgrep refuses, in its words.
    """
    threads = number_flag(fl, "threads")
    _choice(fl, "color", "--color", COLOR_CHOICES)
    case = _last(fl, "ignore_case", "case_sensitive", "smart_case")
    bounds = _last(fl, "word_regexp", "line_regexp")
    listing = _last(
        fl,
        "count",
        "count_matches",
        "files_with_matches",
        "files_without_match",
    )
    numbers = _last(fl, "line_number", "no_line_number")
    vimgrep = fl.as_bool("vimgrep")
    columns = _last(fl, "column", "no_column")
    column = columns == "column" if columns is not None else vimgrep
    passthru, context_before, context_after = _context_of(fl)
    unrestricted = fl.as_int("unrestricted") or 0
    binary_mode = _binary_mode_of(fl, unrestricted)
    hidden = False
    for name in fl.typed_order("hidden", "no_hidden", "unrestricted"):
        if name == "hidden":
            hidden = fl.as_bool(name)
        elif name == "no_hidden":
            hidden = not fl.as_bool(name) and hidden
        elif unrestricted >= 2:
            hidden = True
    sort_flag = _last(fl, "sort", "sortr", "sort_files", "no_sort_files")
    sort = None
    if sort_flag == "sort_files":
        sort = "path"
    elif sort_flag in ("sort", "sortr"):
        sort = _choice(fl, sort_flag, f"--{sort_flag}", SORT_KEYS)
    separator = _last(fl, "context_separator", "no_context_separator")
    typed_separator = fl.as_str("context_separator")
    # An empty field separator is a value: ripgrep runs the fields together.
    match_separator = fl.as_str("field_match_separator")
    context_field_separator = fl.as_str("field_context_separator")
    if sort == "created":
        raise UsageError(
            "rg: sorting by creation time is not supported by the virtual "
            "filesystem"
        )
    selections = [
        (value, name == "type_not")
        for name, value in fl.occurrences("type", "type_not")
        if isinstance(value, str)
    ]
    changes = [
        ("clear" if name == "type_clear" else "add", value)
        for name, value in fl.occurrences("type_clear", "type_add")
        if isinstance(value, str)
    ]
    return RgFlags(
        engine=engine_flag(fl),
        unicode=_last(
            fl, "unicode", "no_unicode", "pcre2_unicode", "no_pcre2_unicode"
        )
        not in ("no_unicode", "no_pcre2_unicode"),
        ignore_case=case == "ignore_case",
        smart_case=case == "smart_case",
        invert=_last(fl, "invert_match", "no_invert_match") == "invert_match",
        whole_word=bounds == "word_regexp",
        line_regexp=bounds == "line_regexp",
        fixed_string=_last(fl, "fixed_strings", "no_fixed_strings")
        == "fixed_strings",
        line_numbers=(numbers == "line_number")
        if numbers
        else column or vimgrep,
        column=column,
        vimgrep=vimgrep,
        byte_offsets=_last(fl, "byte_offset", "no_byte_offset")
        == "byte_offset",
        only_matching=fl.as_bool("only_matching"),
        replace=fl.as_str("replace"),
        trim=_last(fl, "trim", "no_trim") == "trim",
        max_columns=number_flag(fl, "max_columns"),
        max_columns_preview=_last(
            fl, "max_columns_preview", "no_max_columns_preview"
        )
        == "max_columns_preview",
        null=fl.as_bool("null"),
        null_data=fl.as_bool("null_data"),
        path_separator=path_separator(fl),
        quiet=fl.as_bool("quiet"),
        count_only=listing == "count",
        count_matches=listing == "count_matches",
        include_zero=_last(fl, "include_zero", "no_include_zero")
        == "include_zero",
        files_only=listing == "files_with_matches",
        files_without_match=listing == "files_without_match",
        list_files=fl.as_bool("files"),
        type_list=fl.as_bool("type_list"),
        with_filename=filename_flag(fl) == "with_filename",
        no_filename=filename_flag(fl) == "no_filename",
        # --vimgrep prints a location per line, so it never heads a group.
        heading=_last(fl, "heading", "no_heading") == "heading"
        and not vimgrep,
        passthru=passthru,
        max_count=number_flag(fl, "max_count"),
        stop_on_nonmatch=fl.as_bool("stop_on_nonmatch"),
        context_after=context_after,
        context_before=context_before,
        context_separator=(
            None
            if separator == "no_context_separator"
            else unescape(typed_separator)
            if typed_separator is not None
            else "--"
        ),
        field_match_separator=unescape(
            ":" if match_separator is None else match_separator
        ),
        field_context_separator=unescape(
            "-" if context_field_separator is None else context_field_separator
        ),
        globs=tuple(fl.as_list("glob")),
        iglobs=tuple(fl.as_list("iglob")),
        glob_case_insensitive=_last(
            fl, "glob_case_insensitive", "no_glob_case_insensitive"
        )
        == "glob_case_insensitive",
        type_changes=tuple(changes),
        type_selections=tuple(selections),
        hidden=hidden,
        max_depth=number_flag(fl, "max_depth"),
        max_filesize=filesize_flag(fl),
        follow=_last(fl, "follow", "no_follow") == "follow",
        one_file_system=_last(fl, "one_file_system", "no_one_file_system")
        == "one_file_system",
        binary=binary_mode != "auto",
        sort=sort,
        sort_reverse=sort_flag == "sortr",
        no_messages=_last(fl, "no_messages", "messages") == "no_messages",
        threads=threads,
        text=binary_mode == "text",
    )


def rg_syntax(f: RgFlags) -> RegexSyntax:
    """The dialect rg's patterns are written in, for a pushed-down search.

    ``auto`` reads as the default engine's: a pattern only PCRE2 takes
    fails the default translation and the search falls back to the
    generic scan, which runs PCRE2.

    Args:
        f (RgFlags): the parsed flags.
    """
    return RegexSyntax.PERL if f.engine == "pcre2" else RegexSyntax.RUST


def engine_flag(fl: FlagView) -> str:
    """The regex engine the line asks for, the last of -P, --no-pcre2,
    --engine and the deprecated --auto-hybrid-regex pair winning
    (ripgrep 14.1.1: `rg -P --no-pcre2` is the default engine, `rg
    --no-pcre2 -P` is PCRE2, and --no-auto-hybrid-regex selects the
    default engine as --auto-hybrid-regex selects auto).

    Args:
        fl (FlagView): the flag view.

    Raises:
        UsageError: --engine names no engine ripgrep has.
    """
    chosen = _last(
        fl,
        "pcre2",
        "no_pcre2",
        "engine",
        "auto_hybrid_regex",
        "no_auto_hybrid_regex",
    )
    if chosen == "pcre2":
        return "pcre2"
    if chosen == "auto_hybrid_regex":
        return "auto"
    if chosen != "engine":
        return "default"
    value = fl.as_str("engine") or ""
    if value not in ENGINES:
        raise UsageError(
            f"rg: error parsing flag --engine: "
            f"unrecognized regex engine '{value}'"
        )
    return value


def rust_matcher(
    patterns: list[str], fold: bool, f: RgFlags
) -> re.Pattern[str]:
    """The default engine's matcher, or its refusal in ripgrep's words.

    Args:
        patterns (list[str]): the patterns, escaped under -F.
        fold (bool): case-insensitive.
        f (RgFlags): the parsed flags.

    Raises:
        UsageError: regex-syntax refuses the pattern.
    """
    try:
        translated = translate_rust(patterns, fold, f.null_data, f.unicode)
    except RustRegexError as exc:
        raise UsageError(f"rg: {exc}") from exc
    source = translated.source
    if f.line_regexp:
        source = whole_line(source, f.null_data)
    elif f.whole_word:
        source = whole_word(source, f.unicode)
    return re.compile(source, re.IGNORECASE if translated.ignore_case else 0)


def pcre_matcher(
    patterns: list[str], fold: bool, f: RgFlags
) -> re.Pattern[str]:
    """The PCRE2 engine's matcher, or its refusal in ripgrep's words.

    ripgrep hands PCRE2 the list joined as ``(?:a)|(?:b)``, wrapped for
    -w and -x, and the offset in its refusal counts into that string.

    Args:
        patterns (list[str]): the patterns, escaped under -F.
        fold (bool): case-insensitive.
        f (RgFlags): the parsed flags.

    Raises:
        UsageError: PCRE2 refuses the pattern.
    """
    display = "|".join(f"(?:{p})" for p in patterns)
    if f.line_regexp:
        display = f"(?m:^)(?:{display})(?m:$)"
    elif f.whole_word:
        display = f"(?<!\\w)(?:{display})(?!\\w)"
    try:
        translated = translate_pcre(display, f.unicode, fold, f.null_data)
    except PcreError as exc:
        raise UsageError(
            f"rg: PCRE2: error compiling pattern at offset "
            f"{exc.offset}: {exc.message}"
        ) from exc
    flags = re.IGNORECASE if translated.ignore_case else 0
    if not f.unicode:
        flags |= re.ASCII
    return re.compile(translated.source, flags)


def rg_matcher(pattern: str, never_match: bool, f: RgFlags) -> re.Pattern[str]:
    """The pattern list compiled the way the flags and engine ask.

    -w and -x, whichever the line gave last, bound the whole list: -x to
    the line, -w to ripgrep's half word boundaries (no word character
    just before the match or just after it, which ``\\b`` would also
    demand inside it). -S folds case only when the pattern is all
    lowercase. ``auto`` runs the default engine and falls back to PCRE2
    only when that refuses the pattern.

    Args:
        pattern (str): the newline-joined pattern list.
        never_match (bool): the zero-pattern sentinel from
            ``resolve_pattern``; it is a regex, so it suppresses -F.
        f (RgFlags): the parsed flags.
    """
    if never_match:
        return re.compile(NEVER_MATCH)
    fold = folds_case(pattern, f.fixed_string, f)
    parts = pattern.split("\n")
    pcre = f.engine == "pcre2"
    if f.fixed_string:
        parts = [pcre_escape(p) if pcre else rust_escape(p) for p in parts]
    if pcre:
        return pcre_matcher(parts, fold, f)
    if f.engine != "auto":
        return rust_matcher(parts, fold, f)
    try:
        return rust_matcher(parts, fold, f)
    except UsageError as refused:
        try:
            return pcre_matcher(parts, fold, f)
        except UsageError as also:
            logger.debug("rg --engine auto: PCRE2 refused too: %s", also)
            raise refused from None


def pcre_escape(text: str) -> str:
    """A literal as a PCRE2 pattern.

    Args:
        text (str): the literal.
    """
    return "".join(
        "\\" + ch if ch.isascii() and not ch.isalnum() else ch for ch in text
    )


def folds_case(pattern: str, fixed: bool, f: RgFlags) -> bool:
    """Whether the search ignores case: -i, or -S over a pattern with no
    uppercase literal in it.

    Args:
        pattern (str): the newline-joined pattern list.
        fixed (bool): the patterns are literals (-F).
        f (RgFlags): the parsed flags.
    """
    return f.ignore_case or (f.smart_case and smart_case_folds(pattern, fixed))


def walk_filter(f: RgFlags, types: FileTypes | None = None) -> WalkFilter:
    """What the walk keeps, the globs and types compiled.

    Args:
        f (RgFlags): the parsed flags.
        types (FileTypes | None): the type matcher when already built.

    Raises:
        UsageError: a glob or a type ripgrep refuses.
    """
    return WalkFilter(
        Overrides(f.globs, f.iglobs, f.glob_case_insensitive),
        types
        if types is not None
        else FileTypes(f.type_changes, f.type_selections),
        f.hidden,
        f.max_depth,
        f.max_filesize,
        f.binary,
    )


def needs_every_file(fl: FlagView, f: RgFlags) -> bool:
    """Whether the answer depends on files a pattern search cannot find.

    A search push-down narrows a walk to the files that contain the
    pattern, which drops exactly the files -v, --files-without-match,
    --files, --passthru and --include-zero answer for, so those keep the
    whole walk. So does --max-filesize, which only a walk's stat can
    apply (a narrowed file is searched as an operand, whatever its size),
    and a pattern file, whose patterns the search never saw.

    Args:
        fl (FlagView): the invocation's flags.
        f (RgFlags): the same flags parsed.
    """
    return (
        f.invert
        or f.files_without_match
        or f.list_files
        or f.passthru
        or f.include_zero
        or f.null_data
        or f.max_filesize is not None
        or bool(fl.raw("file"))
    )


def refuse_missing_pattern(
    pattern: str | None, fl: FlagView, f: RgFlags
) -> None:
    """ripgrep's refusal of a search with no pattern, for a wrapper to
    raise before it spends a request on one.

    Not for --files or --type-list, which search nothing, nor when -f
    named a pattern file: an empty one matches nothing.

    Args:
        pattern (str | None): the pattern ``pattern_arg`` resolved.
        fl (FlagView): the invocation's flags.
        f (RgFlags): the same flags parsed.

    Raises:
        UsageError: the line gave no pattern to search with.
    """
    if (
        pattern is None
        and fl.raw("file") is None
        and not (f.list_files or f.type_list)
    ):
        raise UsageError(RG_NO_PATTERN)


def filters_files(f: RgFlags) -> bool:
    """Whether -g, --iglob, -t or -T filter the files a walk searches.

    Args:
        f (RgFlags): the parsed flags.
    """
    return bool(f.globs or f.iglobs or f.type_selections)


def fifo_stat(path: str) -> FileStat:
    """A stdin operand's stat: a stream, never a directory to walk.

    Args:
        path (str): the operand's name.
    """
    return FileStat(name=path, type=FileType.FIFO)


async def _wrap_bytes(data: bytes) -> AsyncIterator[bytes]:
    yield data


def _sort_key(h: Haystack, key: str) -> str | None:
    """The timestamp a --sort by time orders one haystack by.

    Args:
        h (Haystack): the haystack.
        key (str): modified, accessed or created.
    """
    if h.stat is None:
        return None
    if key == "modified":
        return h.stat.modified
    if key == "accessed":
        return h.stat.atime
    return None


def sort_haystacks(found: list[Haystack], f: RgFlags) -> list[Haystack]:
    """The haystacks in --sort/--sortr order, where that is a global one.

    Ascending path order is the walk's own (each directory in name
    order, operands as typed), so only --sortr path and the time keys
    reorder the whole list. Like ripgrep, a haystack with no timestamp
    sorts after every one that has one, and ties keep walk order.

    Args:
        found (list[Haystack]): the haystacks in walk order.
        f (RgFlags): the parsed flags.
    """
    if f.sort is None or f.sort == "none":
        return found
    if f.sort == "path":
        if not f.sort_reverse:
            return found
        return sorted(found, key=lambda h: h.shown, reverse=True)
    stamped = [(h, _sort_key(h, f.sort)) for h in found]
    known = [pair for pair in stamped if pair[1] is not None]
    unknown = [h for h, stamp in stamped if stamp is None]
    known.sort(key=lambda pair: pair[1] or "", reverse=f.sort_reverse)
    ordered = [h for h, _ in known]
    return unknown + ordered if f.sort_reverse else ordered + unknown


async def rg_generic(
    paths: list[PathSpec],
    texts: Sequence[str],
    opts: CommandOpts,
    *,
    readdir: Callable[..., Awaitable[list[str]]],
    stat: Callable[..., Awaitable[FileStat]],
    read_bytes: Callable[..., Awaitable[bytes]],
    read_stream: Callable[..., AsyncIterator[bytes]] | None,
    stdin: ByteSource | None = None,
) -> tuple[ByteSource | None, IOResult]:
    """Run ripgrep-style fallback search over backend paths or stdin.

    Interprets the flags itself (TS rgGeneric parity), so backend
    wrappers only wire paths, texts, the bag, and backend I/O.

    Args:
        paths (list[PathSpec]): Backend paths to search. Empty searches
            stdin as an implicit ``-``.
        texts (Sequence[str]): positional TEXT operands (the pattern unless
            -e/-f supplied it).
        opts (CommandOpts): the invocation bag, read for the raw flag
            kwargs and for the mount boundaries. The whole bag rather
            than the two facts, so a wrapper cannot pass one and
            forget the other: sixteen of this generic's nineteen call
            sites omitted the boundaries when they were a keyword of
            their own, which turned the mount-parent wrappers off on
            every bespoke backend. Mirrors TS, whose generic has
            always taken ``opts`` and read the boundaries off it.
        readdir (Callable[..., Awaitable[list[str]]]): Directory reader.
        stat (Callable[[PathSpec], Awaitable[FileStat]]): Backend stat reader.
        read_bytes (Callable[..., Awaitable[bytes]]): Whole-file reader.
        read_stream (Callable[..., AsyncIterator[bytes]] | None): Optional
            stream reader.
        stdin (ByteSource | None): the invocation's input, which a ``-``
            operand reads, as does a line with no operand at all.

    Returns:
        tuple[ByteSource | None, IOResult]: Output stream and exit metadata.
    """
    read_bytes = cache_aware_bound_bytes(read_bytes)
    if read_stream is not None:
        read_stream = cache_aware_bound_stream(read_stream)
    # Every `-` operand reads stdin through one cursor, as grep's do. With
    # no operand typed, the implicit one below is stdin's sole reader, so a
    # search that stops early closes the input.
    operand_stream = stdin_stream(
        read_stream if read_stream is not None else read_bytes,
        stdin,
        sole=not paths,
    )
    fl = FlagView(opts.flags, spec=SPECS["rg"])
    f = parse_flags(fl)
    types = FileTypes(f.type_changes, f.type_selections)
    if f.type_list:
        return format_records(type_listing(types.definitions)), IOResult()
    walk = walk_filter(f, types)
    pat: re.Pattern[str] | None = None
    if not f.list_files:
        pattern, never_match = await resolve_pattern(
            texts,
            fl,
            read_bytes,
            RG_NO_PATTERN,
            pattern_key="regexp",
            file_key="file",
        )
        pat = rg_matcher(pattern, never_match, f)

    if not paths:
        # A line that names no path searches a piped stdin as an
        # implicit `-` operand, so -l, -H, -c and context answer as they
        # do for a typed one (ripgrep's Paths::from_low_args, 14.1.1).
        if stdin is None:
            raise UsageError(RG_NO_PATTERN)
        paths = [STDIN_OPERAND]

    mounts = opts.ns.mounts if opts.ns is not None else None
    mount_prefix = mount_prefix_of(paths[0].virtual, paths[0].vfs_path)
    rd = mount_parent_readdir(
        partial(call_readdir, readdir, prefix=mount_prefix),
        mounts,
        mount_prefix,
    )
    st = mount_parent_stat(
        partial(call_stat, stat, prefix=mount_prefix), mounts
    )
    rb = partial(call_read_bytes, read_bytes, prefix=mount_prefix)

    if pat is not None and len(paths) == 1:
        single = await _search_single(
            paths[0], pat, f, st, rd, rb, read_stream, operand_stream
        )
        if single is not None:
            return single

    warnings: list[str] = []
    cwd = opts.cwd.virtual
    # ripgrep's "nothing searched" speaks for the whole walk, so it waits
    # while a fan-out searches the mounts below the cwd in runs of its own.
    # A typed '' shares the synthetic operand's spelling; the walk's
    # verdict is what tells them apart.
    implicit = any(
        p.raw_path == IMPLICIT_CWD
        and p.walk_error is None
        and (
            f.one_file_system
            or not (mounts is not None and mounts.descendants(p.virtual))
        )
        for p in paths
    )
    # A mount below the operand shadows whatever the backend holds there;
    # the fan-out that would search the mount itself is off too.
    boundary = mounts if f.one_file_system else None
    found = haystacks(
        paths, rd, st, cwd, walk, f, warnings, boundary, link_door(opts)
    )
    if f.sort not in (None, "none") and not (
        f.sort == "path" and not f.sort_reverse
    ):
        listed = [h async for h in found]
        found = _replay(sort_haystacks(listed, f))
    if f.list_files:
        return await _list_files(found, f, warnings)
    assert pat is not None
    return await _search_all(
        found,
        paths,
        pat,
        f,
        rb,
        read_stream,
        operand_stream,
        warnings,
        implicit,
    )


async def _replay(found: list[Haystack]) -> AsyncIterator[Haystack]:
    for h in found:
        yield h


async def _search_single(
    p: PathSpec,
    pat: re.Pattern[str],
    f: RgFlags,
    st: Callable[[str], Awaitable[FileStat]],
    rd: Callable[[str], Awaitable[list[str]]],
    rb: Callable[[str], Awaitable[bytes]],
    read_stream: Callable[..., AsyncIterator[bytes]] | None,
    operand_stream: Callable[[PathSpec], AsyncIterator[bytes]],
) -> tuple[ByteSource | None, IOResult] | None:
    """One operand that is a file or stdin, streamed, or None for a
    directory the walk has to answer.

    Args:
        p (PathSpec): the operand.
        pat (re.Pattern[str]): the compiled pattern.
        f (RgFlags): the parsed flags.
        st (Callable): the wrapped stat.
        rd (Callable): the wrapped readdir.
        rb (Callable): the wrapped whole-file read.
        read_stream (Callable | None): the stream reader.
        operand_stream (Callable): stdin's reader for a `-` operand.
    """
    if not is_stdin(p):
        # The probes below go by `virtual`, which cannot carry the walk's
        # verdict: the empty name would read as the cwd and walk it.
        if p.walk_error is not None:
            return _refused(walk_error_line(p.raw_path, walk_refusal(p)), f)
        try:
            s = await st(p.virtual)
        except WALK_ERRORS as exc:
            try:
                await rd(p.virtual)
                return None
            except WALK_ERRORS:
                return _refused(walk_error_line(p.raw_path, exc), f)
        if s.type == FileType.DIRECTORY:
            return None
    name = printed_path(operand_name(p), f)
    label = (
        name if (f.with_filename or f.vimgrep) and not f.no_filename else None
    )
    if is_stdin(p):
        source: AsyncIterator[bytes] = operand_stream(p)
    elif read_stream is not None:
        source = read_stream(p)
    else:
        try:
            source = _wrap_bytes(await rb(p.virtual))
        except FS_ERRORS as exc:
            return _refused(open_error_line(p.raw_path, exc), f)
    io = IOResult(exit_code=1)
    tally = Tally()
    return _settled(
        search_haystack(source, pat, f, name, label, tally, pipe=is_stdin(p)),
        f,
        label,
        tally,
        io,
        p.raw_path,
    ), io


def _refused(line: str, f: RgFlags) -> tuple[ByteSource | None, IOResult]:
    """ripgrep's own refusal of an operand it cannot open, exit 2 rather
    than the shared handler's 1.

    Args:
        line (str): ripgrep's line for the failure.
        f (RgFlags): the parsed flags, read for --no-messages.
    """
    stderr = None if f.no_messages else f"{line}\n".encode()
    return b"", IOResult(exit_code=2, stderr=stderr)


async def _settled(
    chunks: AsyncIterator[bytes],
    f: RgFlags,
    label: str | None,
    tally: Tally,
    io: IOResult,
    shown: str,
) -> AsyncIterator[bytes]:
    """One streamed haystack's output, headed when --heading names it,
    with the exit status settled as it goes.

    Args:
        chunks (AsyncIterator[bytes]): the haystack's records.
        f (RgFlags): the parsed flags.
        label (str | None): the haystack's label.
        tally (Tally): what the search selected.
        io (IOResult): receives the exit status.
        shown (str): the operand as typed, which a failed read names.
    """
    printed = False
    try:
        async for chunk in chunks:
            if (
                not printed
                and label is not None
                and _headed(f)
                and not tally.binary
            ):
                yield encode_text(label) + (
                    b"\0" if f.null or f.null_data else b"\n"
                )
            printed = True
            yield chunk
    except FS_ERRORS as exc:
        # A read that fails once the stream is open is the searcher's to
        # report, exit 2, as ripgrep reports it for any file it searches.
        io.stderr = (
            None
            if f.no_messages
            else f"{open_error_line(shown, exc)}\n".encode()
        )
        io.exit_code = 2
        return
    listed = printed if f.files_without_match and not f.quiet else None
    selected = tally.selected if listed is None else listed
    io.exit_code = 0 if selected else 1


def _headed(f: RgFlags) -> bool:
    """Whether --heading names each file above its lines: only the line
    output has one, never the counts or the listings.

    Args:
        f (RgFlags): the parsed flags.
    """
    return f.heading and not (
        f.count_only
        or f.count_matches
        or f.files_only
        or f.files_without_match
        or f.quiet
    )


def printed_path(path: str, f: RgFlags) -> str:
    """A path as ripgrep prints it, every ``/`` spelled as
    --path-separator asks.

    Args:
        path (str): the path.
        f (RgFlags): the parsed flags.
    """
    if f.path_separator is None:
        return path
    return path.replace("/", f.path_separator)


def walks_descendant_mounts(flags: Mapping[str, FlagValue]) -> bool:
    """Whether a search walks into the mounts below its operand: not for
    --type-list, which reads no path, nor under --one-file-system.

    Args:
        flags (Mapping[str, FlagValue]): the raw flag kwargs.
    """
    fl = FlagView(flags, spec=SPECS["rg"])
    return not (
        fl.as_bool("type_list")
        or _last(fl, "one_file_system", "no_one_file_system")
        == "one_file_system"
    )


def between_files(f: RgFlags) -> bytes:
    """What ripgrep prints between one file's output and the next's, for
    output split over several runs that each labelled their files.

    A blank line between --heading groups; otherwise the context
    separator, when context is shown and a separator is set; otherwise
    nothing. ripgrep 14.1.1 keeps this inter-file separator newline-
    terminated even under --null-data; only intra-file context separators
    use the record terminator.

    Args:
        f (RgFlags): the parsed flags.
    """
    if _headed(f) and not f.no_filename:
        return b"\n"
    if prints_context(f) and f.context_separator is not None:
        return encode_text(f.context_separator) + b"\n"
    return b""


async def haystacks(
    paths: list[PathSpec],
    rd: Callable[[str], Awaitable[list[str]]],
    st: Callable[[str], Awaitable[FileStat]],
    cwd: str,
    walk: WalkFilter,
    f: RgFlags,
    warnings: list[str],
    boundary: MountView | None,
    door: LinkDoor | None,
) -> AsyncIterator[Haystack]:
    """Every input the line searches, in order: a stdin operand, a named
    file as itself whatever the filters say, and a directory walked.

    Args:
        paths (list[PathSpec]): the operands.
        rd (Callable): the wrapped readdir.
        st (Callable): the wrapped stat.
        cwd (str): the session's working directory.
        walk (WalkFilter): what a walk keeps.
        f (RgFlags): the parsed flags.
        warnings (list[str]): collects what could not be read.
        boundary (MountView | None): the mounts --one-file-system keeps
            each walk to its operand's own, None when the walk may enter
            any directory.
        door (LinkDoor | None): the namespace's links and the door past
            them, which -L walks through.
    """
    # ripgrep holds one path that is not a directory to one thread, as it
    # does -j1 and a sort; every other line runs its parallel walker.
    parallel = f.threads != 1 and f.sort is None
    several = parallel and len(paths) > 1
    for p in paths:
        if is_stdin(p):
            yield Haystack(
                p.virtual, operand_name(p), fifo_stat(p.raw_path), p
            )
            continue
        if p.walk_error is not None:
            warnings.append(
                walk_error_line(p.raw_path, walk_refusal(p), several)
            )
            continue
        is_dir = False
        s: FileStat | None = None
        try:
            s = await st(p.virtual)
            is_dir = s.type == FileType.DIRECTORY
        except WALK_ERRORS as exc:
            try:
                # A directory that exists only because mounts sit under
                # it answers readdir but not stat.
                await rd(p.virtual)
                is_dir = True
            except WALK_ERRORS:
                warnings.append(walk_error_line(p.raw_path, exc, several))
                continue
        if not is_dir:
            yield Haystack(p.virtual, p.raw_path, s, p)
            continue
        crosses = (
            None
            if boundary is None
            else partial(
                on_other_mount, boundary.root_of, boundary.root_of(p.virtual)
            )
        )
        async for found in walk_haystacks(
            rd,
            st,
            p.virtual,
            p.raw_path,
            cwd,
            walk,
            f.sort == "path" and not f.sort_reverse,
            warnings,
            crosses,
            door,
            f.follow,
            parallel,
        ):
            yield found


async def _list_files(
    found: AsyncIterator[Haystack], f: RgFlags, warnings: list[str]
) -> tuple[bytes, IOResult]:
    """--files: every path the search would read, and nothing searched.

    Args:
        found (AsyncIterator[Haystack]): the haystacks.
        f (RgFlags): the parsed flags.
        warnings (list[str]): what could not be read.
    """
    term = b"\0" if f.null else b"\n"
    out: list[bytes] = []
    async for h in found:
        out.append(encode_text(printed_path(h.shown, f)) + term)
        if f.quiet:
            break
    code = exit_code_for(bool(out), bool(warnings), f.quiet)
    stderr = None if f.no_messages else format_optional_records(warnings)
    return b"" if f.quiet else b"".join(out), IOResult(
        exit_code=code, stderr=stderr
    )


async def _search_all(
    found: AsyncIterator[Haystack],
    paths: list[PathSpec],
    pat: re.Pattern[str],
    f: RgFlags,
    rb: Callable[[str], Awaitable[bytes]],
    read_stream: Callable[..., AsyncIterator[bytes]] | None,
    operand_stream: Callable[[PathSpec], AsyncIterator[bytes]],
    warnings: list[str],
    implicit: bool,
) -> tuple[bytes, IOResult]:
    """Search every haystack in order and put the output together.

    ripgrep labels every line when the line named more than one path or
    walked a directory; -H forces the label and -I drops it. Between one
    file's context and the next file's goes the context separator, and
    under --heading a blank line goes between files instead.

    Args:
        found (AsyncIterator[Haystack]): the haystacks.
        paths (list[PathSpec]): the operands.
        pat (re.Pattern[str]): the compiled pattern.
        f (RgFlags): the parsed flags.
        rb (Callable): the wrapped whole-file read.
        read_stream (Callable | None): the stream reader.
        operand_stream (Callable): stdin's reader for a `-` operand.
        warnings (list[str]): collects what could not be read.
        implicit (bool): the line named no path, so ripgrep reports a
            search that found nothing to search.
    """
    multi = len(paths) > 1
    context = prints_context(f)
    out: list[bytes] = []
    printed = False
    selected = False
    skipped = False
    searched = 0
    async for h in found:
        searched += 1
        walked = h.spec is None
        name = printed_path(h.shown, f)
        label = (
            name
            if not f.no_filename
            and (walked or multi or f.with_filename or f.vimgrep)
            else None
        )
        tally = Tally()
        try:
            if h.spec is not None and is_stdin(h.spec):
                source = operand_stream(h.spec)
            elif h.spec is not None and read_stream is not None:
                source = read_stream(h.spec)
            elif h.door is not None:
                source = h.door.read(h.virtual)
            else:
                source = _wrap_bytes(await rb(h.virtual))
            chunks = [
                c
                async for c in search_haystack(
                    source,
                    pat,
                    f,
                    name,
                    label,
                    tally,
                    not walked,
                    h.spec is not None and is_stdin(h.spec),
                )
            ]
        except FS_ERRORS as exc:
            # ripgrep reports the failed input and keeps searching the rest.
            warnings.append(open_error_line(h.shown, exc))
            continue
        selected = selected or tally.selected
        skipped = skipped or tally.skipped
        if chunks:
            if label is not None and _headed(f):
                if printed:
                    out.append(b"\n")
                if not tally.binary:
                    out.append(
                        encode_text(label)
                        + (b"\0" if f.null or f.null_data else b"\n")
                    )
            elif context and printed and f.context_separator is not None:
                out.append(encode_text(f.context_separator) + b"\n")
            out.extend(chunks)
            printed = True
        if f.quiet and tally.selected:
            break
    if f.files_without_match and not f.quiet:
        # ripgrep's status under --files-without-match follows the
        # listing, not the matching: 0 when a file was listed, 1 when
        # every file matched (14.1.1; GNU grep keeps the match status).
        # A walked binary file it skipped counts as one without a match,
        # though no listing names it.
        selected = printed or skipped
    code = exit_code_for(selected, bool(warnings), f.quiet)
    shown = [] if f.no_messages else list(warnings)
    if implicit and searched == 0:
        # An error whatever --no-messages says, which only silences it.
        if not f.no_messages:
            shown.append(NOTHING_SEARCHED)
        code = 2
    return b"".join(out), IOResult(
        exit_code=code, stderr=format_optional_records(shown)
    )


__all__ = ["rg_generic"]


def label_flags(flags: Mapping[str, FlagValue]) -> dict[str, FlagValue]:
    """The flags with -H added, unless -I is the line's last word on it.

    Args:
        flags (Mapping[str, FlagValue]): the raw flag kwargs.
    """
    labelled_flags = FlagBag(flags)
    if filename_flag(FlagView(flags, spec=SPECS["rg"])) != "no_filename":
        labelled_flags["with_filename"] = True
    return labelled_flags


def labelled(opts: CommandOpts) -> CommandOpts:
    """Ask for the filename a walk would have printed on its own.

    A content search hands the generic explicit files where the user
    named a directory, and the generic labels explicit operands only when
    there are several, so ``-H`` is requested here; an ``-I`` the line
    set after any ``-H`` still wins, since forcing ``-H`` under it would
    defeat the suppression in the delegated scan.

    Args:
        opts (CommandOpts): the narrowing wrapper's options.
    """
    flags = opts.flags or {}
    if filename_flag(FlagView(flags, spec=SPECS["rg"])) == "no_filename":
        return opts
    return replace(opts, flags=label_flags(flags))
