import logging
import re
import time
from collections.abc import (
    AsyncIterator,
    Awaitable,
    Callable,
    Mapping,
    Sequence,
)
from dataclasses import replace
from functools import partial

from mirage.commands.builtin.grep_pattern import (
    NEVER_MATCH,
    resolve_pattern,
    rust_escape,
)
from mirage.commands.builtin.grep_scan import exit_code_for
from mirage.commands.builtin.rg_filetypes import FileTypes, type_listing
from mirage.commands.builtin.rg_glob import (
    IgnoreRules,
    Overrides,
    Verdict,
    walk_candidate,
)
from mirage.commands.builtin.rg_scan import (
    Haystack,
    WalkFilter,
    on_other_mount,
    open_error_line,
    os_error_text,
    walk_error_line,
    walk_haystacks,
)
from mirage.commands.builtin.rg_search import (
    RgFlags,
    Tally,
    Totals,
    json_line,
    json_text,
    prints_context,
    record_end,
    search_haystack,
    smart_case_folds,
)
from mirage.commands.builtin.utils.constants import STDIN_OPERAND
from mirage.commands.builtin.utils.links import (
    LinkResolver,
    link_resolver,
    mounts_of,
)
from mirage.commands.builtin.utils.output import format_records
from mirage.commands.builtin.utils.pcre import PcreError, translate_pcre
from mirage.commands.builtin.utils.rust_regex import (
    RustRegexError,
    translate_rust,
    whole_line,
    whole_word,
)
from mirage.commands.builtin.utils.stream import is_stdin, stdin_stream
from mirage.commands.builtin.utils.wrap import (
    call_readdir,
    call_stat,
    mount_parent_readdir,
    mount_parent_stat,
    to_pathspec,
)
from mirage.commands.config import Context
from mirage.commands.errors import UsageError
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagBag, FlagView
from mirage.commands.spec.types import FlagValue
from mirage.concurrency.worker import Worker
from mirage.errors.constants import FS_ERRORS, WALK_ERRORS
from mirage.errors.fs import walk_refusal
from mirage.io.stream import close_quietly
from mirage.io.types import ByteSource, IOResult, materialize
from mirage.runtime.types import DispatchFn, ShellFn
from mirage.shell.bytes import decode_text, encode_text
from mirage.shell.join import shell_join
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.compress import GzipDataError, gunzip_stream
from mirage.utils.encoding import encoding_for
from mirage.utils.key_prefix import mount_prefix_of
from mirage.view.types import MountView

logger = logging.getLogger(__name__)

# The names -z searches decompressed, and the rule ripgrep frames gzip's
# refusal in (14.1.1).
GZIP_NAMES = (".gz", ".tgz")
GZIP_RULE = "-" * 79
# The status a line answers for a command it cannot find, which ripgrep
# reports as a --pre command that could not start.
COMMAND_NOT_FOUND = 127
# ripgrep's refusal of a pattern that holds the line terminator outside
# multiline mode, exit 2 (14.1.1).
NEWLINE_REFUSAL = (
    'rg: the literal "\\n" is not allowed in a regex\n\nConsider enabling '
    "multiline mode with the --multiline flag (or -U for short).\nWhen "
    "multiline mode is enabled, new line characters can be matched."
)
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
# The sizes ripgrep reads as digits and a unit, each named as it is refused.
SIZE_SPELLINGS = {
    "max_filesize": "--max-filesize",
    "dfa_size_limit": "--dfa-size-limit",
    "regex_size_limit": "--regex-size-limit",
}
# What --colors takes (ripgrep 14.1.1 and termcolor): OUT:SPEC[:VALUE].
COLOR_OUTPUTS = ("path", "line", "column", "match")
COLOR_SPECS = ("fg", "bg", "style", "none")
COLOR_NAMES = (
    "black",
    "blue",
    "green",
    "red",
    "cyan",
    "magenta",
    "yellow",
    "white",
)
COLOR_STYLES = (
    "nobold",
    "bold",
    "nointense",
    "intense",
    "nounderline",
    "underline",
)
COLOR_NUMBER = re.compile(r"(0x\+?[0-9A-Fa-f]+|\+?[0-9]+)")
# What --hyperlink-format takes: an alias or a URL with variables.
HYPERLINK_ALIASES = (
    "default",
    "file",
    "grep+",
    "kitty",
    "macvim",
    "none",
    "textmate",
    "vscode",
    "vscode-insiders",
    "vscodium",
)
HYPERLINK_VARIABLES = ("path", "line", "column", "host", "wslprefix")
URL_SCHEME = re.compile(r"[0-9A-Za-z+.-]+:")
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


def encoding_flag(fl: FlagView) -> str:
    """-E resolved in line order: auto, none, or the WHATWG encoding a
    label names, --no-encoding going back to auto. ripgrep checks every
    label as it reads it, so an earlier bad one is refused too (14.1.1).

    Args:
        fl (FlagView): the flag view.

    Raises:
        UsageError: a label that names no encoding.
    """
    found = "auto"
    for name, value in fl.occurrences("encoding", "no_encoding"):
        if name == "no_encoding":
            found = "auto" if value else found
            continue
        label = str(value)
        named = label if label in ("auto", "none") else encoding_for(label)
        if named is None:
            raise UsageError(
                "rg: error parsing flag -E: grep config error: unknown "
                f"encoding: {label}"
            )
        found = named
    return found


def size_flag(fl: FlagView, dest: str) -> int | None:
    """A size option in bytes, refused in ripgrep's words. ripgrep parses
    every occurrence as it reads it, so an earlier bad one is refused too.

    Args:
        fl (FlagView): the flag view.
        dest (str): --max-filesize, --dfa-size-limit or --regex-size-limit.

    Raises:
        UsageError: the size is not digits and an optional K, M or G, or
            does not fit in 64 bits.
    """
    sizes = [size_bytes(str(value), dest) for _, value in fl.occurrences(dest)]
    return sizes[-1] if sizes else None


def size_bytes(value: str, dest: str) -> int:
    """One size option's value in bytes, refused in ripgrep's words.

    Args:
        value (str): the value as typed.
        dest (str): the option it was given to.

    Raises:
        UsageError: the size is not digits and an optional K, M or G, or
            does not fit in 64 bits.
    """
    size = SIZE.fullmatch(value)
    reason = None
    if size is None:
        reason = (
            f"invalid format for size '{value}', which should be a "
            "non-empty sequence of digits followed by an optional 'K', 'M' "
            "or 'G' suffix"
        )
    elif int(size.group(1)) > U64_MAX:
        reason = (
            f"invalid integer found in size '{value}': number too large to "
            "fit in target type"
        )
    elif int(size.group(1)) * SIZE_UNIT[size.group(2)] > U64_MAX:
        reason = f"size too big in '{value}'"
    if size is None or reason is not None:
        raise UsageError(
            f"rg: error parsing flag {SIZE_SPELLINGS[dest]}: invalid size: "
            f"{reason}"
        )
    return int(size.group(1)) * SIZE_UNIT[size.group(2)]


def color_refusal(spec: str) -> str | None:
    """Why ripgrep refuses one --colors spec, or None.

    Args:
        spec (str): the spec as typed.
    """
    pieces = spec.split(":")
    malformed = (
        f"invalid color spec format: '{spec}'. Valid format is "
        "'(path|line|column|match):(fg|bg|style):(value)'."
    )
    if not 2 <= len(pieces) <= 3:
        return malformed
    if pieces[0].lower() not in COLOR_OUTPUTS:
        return (
            f"unrecognized output type '{pieces[0]}'. Choose from: "
            f"{', '.join(COLOR_OUTPUTS)}."
        )
    kind = pieces[1].lower()
    if kind not in COLOR_SPECS:
        return (
            f"unrecognized spec type '{pieces[1]}'. Choose from: "
            f"{', '.join(COLOR_SPECS)}."
        )
    if kind == "none":
        return None
    if len(pieces) < 3:
        return malformed
    value = pieces[2]
    if kind == "style":
        if value.lower() in COLOR_STYLES:
            return None
        return (
            f"unrecognized style attribute '{value}'. Choose from: "
            f"{', '.join(COLOR_STYLES)}."
        )
    return color_value_refusal(value)


def color_number(code: str) -> bool:
    """Whether termcolor reads ``code`` as a color number, decimal or 0x
    hex, from 0 to 255.

    Args:
        code (str): one number as typed.
    """
    if COLOR_NUMBER.fullmatch(code) is None:
        return False
    hexed = code.startswith("0x")
    return int(code[2:] if hexed else code, 16 if hexed else 10) <= 255


def color_value_refusal(value: str) -> str | None:
    """Why termcolor refuses a color: a name, 0-255 or an r,g,b triple.

    Args:
        value (str): the color as typed.
    """
    codes = value.split(",")
    if value.lower() in COLOR_NAMES or (
        len(codes) in (1, 3) and all(color_number(code) for code in codes)
    ):
        return None
    if len(codes) == 1 and all(c in "0123456789abcdefABCDEF" for c in value):
        return (
            "unrecognized ansi256 color number, should be '[0-255]' (or a "
            f"hex number), but is '{value}'"
        )
    if "," in value:
        return (
            "unrecognized RGB color triple, should be "
            "'[0-255],[0-255],[0-255]' (or a hex triple), but is "
            f"'{value}'"
        )
    return (
        f"unrecognized color name '{value}'. Choose from: "
        f"{', '.join(COLOR_NAMES)}"
    )


def hyperlink_refusal(fmt: str) -> str | None:
    """Why ripgrep refuses a --hyperlink-format, or None.

    Args:
        fmt (str): the format as typed.
    """
    if not fmt or fmt in HYPERLINK_ALIASES:
        return None
    names: list[str] = []
    head = ""
    i = 0
    while i < len(fmt):
        if fmt.startswith(("{{", "}}"), i):
            head += "" if names else fmt[i]
            i += 2
        elif fmt[i] == "{":
            end = fmt.find("}", i)
            if end < 0:
                return (
                    "unclosed variable: found '{' without a corresponding "
                    "'}' following it"
                )
            name = fmt[i + 1 : end]
            if name not in HYPERLINK_VARIABLES:
                return (
                    f"invalid hyperlink format variable: '{name}', choose "
                    f"from: {', '.join(HYPERLINK_VARIABLES)}"
                )
            names.append(name)
            i = end + 1
        elif fmt[i] == "}":
            return (
                "unopened variable: found '}' without a corresponding '{' "
                "preceding it"
            )
        else:
            head += "" if names else fmt[i]
            i += 1
    if not names:
        return (
            "at least a {path} variable is required in a hyperlink format, "
            "or otherwise use a valid alias: "
            f"{', '.join(HYPERLINK_ALIASES)}"
        )
    if "path" not in names:
        return "the {path} variable is required in a hyperlink format"
    if "column" in names and "line" not in names:
        return (
            "the hyperlink format contains a {column} variable, but no "
            "{line} variable is present"
        )
    if URL_SCHEME.match(head) is None:
        return (
            "the hyperlink format must start with a valid URL scheme, i.e., "
            "[0-9A-Za-z+-.]+:"
        )
    return None


def check_display_flags(fl: FlagView) -> None:
    """Refuse what ripgrep refuses in the options mirage accepts and
    otherwise ignores: --colors, --hyperlink-format and the DFA and regex
    size limits.

    Args:
        fl (FlagView): the flag view.

    Raises:
        UsageError: a value ripgrep refuses, in its words.
    """
    for spec in fl.as_list("colors"):
        refusal = color_refusal(spec)
        if refusal is not None:
            raise UsageError(f"rg: error parsing flag --colors: {refusal}")
    for _, fmt in fl.occurrences("hyperlink_format"):
        refusal = hyperlink_refusal(str(fmt))
        if refusal is not None:
            raise UsageError(
                "rg: error parsing flag --hyperlink-format: invalid "
                f"hyperlink format: {refusal}"
            )
    size_flag(fl, "dfa_size_limit")
    size_flag(fl, "regex_size_limit")


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
    encoding = encoding_flag(fl)
    _choice(fl, "color", "--color", COLOR_CHOICES)
    check_display_flags(fl)
    case = _last(fl, "ignore_case", "case_sensitive", "smart_case")
    bounds = _last(fl, "word_regexp", "line_regexp")
    listing = _last(
        fl,
        "count",
        "count_matches",
        "files_with_matches",
        "files_without_match",
    )
    # -p turns on --heading and -n, each overridden by a later negation.
    numbers = _last(fl, "line_number", "no_line_number", "pretty")
    vimgrep = fl.as_bool("vimgrep")
    columns = _last(fl, "column", "no_column")
    column = columns == "column" if columns is not None else vimgrep
    passthru, context_before, context_after = _context_of(fl)
    # --json prints its own records: no heading or separators, and line
    # numbers unless -N turned them off.
    json_records = _last(fl, "json", "no_json") == "json"
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
        line_numbers=numbers in ("line_number", "pretty")
        if numbers
        else column or vimgrep or json_records,
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
        crlf=_last(fl, "crlf", "no_crlf") == "crlf"
        and not fl.as_bool("null_data"),
        multiline=_last(fl, "multiline", "no_multiline") == "multiline",
        stats=_last(fl, "stats", "no_stats") == "stats",
        search_zip=_last(fl, "search_zip", "no_search_zip") == "search_zip",
        # --pre with no command, or after --no-pre, preprocesses nothing.
        pre=(fl.as_str("pre") or None)
        if _last(fl, "pre", "no_pre") == "pre"
        else None,
        pre_globs=tuple(fl.as_list("pre_glob")),
        json=json_records,
        multiline_dotall=_last(fl, "multiline_dotall", "no_multiline_dotall")
        == "multiline_dotall",
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
        heading=_last(fl, "heading", "no_heading", "pretty")
        in ("heading", "pretty")
        and not vimgrep
        and not json_records,
        passthru=passthru,
        max_count=number_flag(fl, "max_count"),
        stop_on_nonmatch=fl.as_bool("stop_on_nonmatch"),
        context_after=context_after,
        context_before=context_before,
        context_separator=(
            None
            if separator == "no_context_separator" or json_records
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
        max_filesize=size_flag(fl, "max_filesize"),
        follow=_last(fl, "follow", "no_follow") == "follow",
        one_file_system=_last(fl, "one_file_system", "no_one_file_system")
        == "one_file_system",
        binary=binary_mode != "auto",
        sort=sort,
        sort_reverse=sort_flag == "sortr",
        no_messages=_last(fl, "no_messages", "messages") == "no_messages",
        threads=threads,
        text=binary_mode == "text",
        encoding=encoding,
    )


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
    lines = f.null_data or f.multiline
    try:
        translated = translate_rust(
            patterns,
            fold,
            lines,
            f.unicode,
            f.multiline and f.multiline_dotall,
            f.multiline and f.crlf,
        )
    except RustRegexError as exc:
        raise UsageError(f"rg: {exc}") from exc
    if translated.newline and not lines:
        raise UsageError(NEWLINE_REFUSAL)
    source = translated.source
    if f.line_regexp:
        source = whole_line(source, lines, f.multiline and f.crlf)
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
        translated = translate_pcre(
            display,
            f.unicode,
            fold,
            f.null_data or f.multiline,
            f.multiline and f.multiline_dotall,
            f.crlf and f.multiline,
        )
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


def walk_filter(
    f: RgFlags,
    types: FileTypes | None = None,
    ignores: IgnoreRules | None = None,
) -> WalkFilter:
    """What the walk keeps, the globs and types compiled.

    Args:
        f (RgFlags): the parsed flags.
        types (FileTypes | None): the type matcher when already built.
        ignores (IgnoreRules | None): --ignore-file's rules, once read.

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
        ignores if ignores is not None else IgnoreRules(),
    )


async def ignore_rules(
    fl: FlagView, dispatch: DispatchFn | None, notes: list[str]
) -> IgnoreRules:
    """--ignore-file's rules, each file read through the dispatcher.

    A file ripgrep cannot read is reported and skipped, the search going
    on with its exit status untouched (14.1.1); --no-ignore-files drops
    every one.

    Args:
        fl (FlagView): the flag view.
        dispatch (DispatchFn | None): the workspace's dispatcher.
        notes (list[str]): collects what could not be read.
    """
    if _last(fl, "ignore_files", "no_ignore_files") == "no_ignore_files":
        return IgnoreRules()
    lines: list[str] = []
    for path in fl.as_paths("ignore_file"):
        try:
            if dispatch is None:
                raise FileNotFoundError(path.raw_path)
            data, _ = await dispatch("read", path)
            lines.extend(decode_text(await materialize(data)).splitlines())
        except FS_ERRORS as exc:
            notes.append(f"rg: {path.raw_path}: {os_error_text(exc)}")
    return IgnoreRules(lines)


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
    ctx: Context,
    *,
    readdir: Callable[..., Awaitable[list[str]]],
    stat: Callable[..., Awaitable[FileStat]],
    read_bytes: Callable[..., Awaitable[bytes]],
    read_stream: Callable[..., AsyncIterator[bytes]] | None,
    stdin: ByteSource | None = None,
    unbounded: tuple[
        Callable[..., Awaitable[list[str]]],
        Callable[..., Awaitable[FileStat]],
    ]
    | None = None,
) -> tuple[ByteSource | None, IOResult]:
    """Run ripgrep-style fallback search over backend paths or stdin.

    Interprets the flags itself (TS rgGeneric parity), so backend
    wrappers only wire paths, texts, the bag, and backend I/O.

    Args:
        paths (list[PathSpec]): Backend paths to search. Empty searches
            stdin as an implicit ``-``.
        texts (Sequence[str]): positional TEXT operands (the pattern unless
            -e/-f supplied it).
        ctx (Context): the invocation bag, read for the raw flag
            kwargs and for the mount boundaries. The whole bag rather
            than the two facts, so a wrapper cannot pass one and
            forget the other: sixteen of this generic's nineteen call
            sites omitted the boundaries when they were a keyword of
            their own, which turned the mount-parent wrappers off on
            every bespoke backend. Mirrors TS, whose generic has
            always taken ``ctx`` and read the boundaries off it.
        readdir (Callable[..., Awaitable[list[str]]]): Directory reader.
        stat (Callable[[PathSpec], Awaitable[FileStat]]): Backend stat reader.
        read_bytes (Callable[..., Awaitable[bytes]]): Whole-file reader.
        read_stream (Callable[..., AsyncIterator[bytes]] | None): Optional
            stream reader.
        stdin (ByteSource | None): the invocation's input, which a ``-``
            operand reads, as does a line with no operand at all.
        unbounded (tuple[Callable, Callable] | None): the walk to take
            when no ``--max-depth`` bounds it (one the mount answers
            whole), else ``readdir`` and ``stat``.

    Returns:
        tuple[ByteSource | None, IOResult]: Output stream and exit metadata.
    """
    # Every `-` operand reads stdin through one cursor, as grep's do. With
    # no operand typed, the implicit one below is stdin's sole reader, so a
    # search that stops early closes the input.
    operand_stream = stdin_stream(
        read_stream if read_stream is not None else read_bytes,
        stdin,
        sole=not paths,
    )
    fl = FlagView(ctx.flags, spec=SPECS["rg"])
    f = parse_flags(fl)
    if unbounded is not None and f.max_depth is None:
        readdir, stat = unbounded
    types = FileTypes(f.type_changes, f.type_selections)
    if f.type_list:
        return format_records(type_listing(types.definitions)), IOResult()
    notes: list[str] = []
    walk = walk_filter(f, types, await ignore_rules(fl, ctx.dispatch, notes))
    pat: re.Pattern[str] | None = None
    if not f.list_files:
        pattern, never_match = await resolve_pattern(
            texts,
            fl,
            operand_stream,
            RG_NO_PATTERN,
        )
        pat = rg_matcher(pattern, never_match, f)

    if not paths:
        # A line that names no path searches a piped stdin as an
        # implicit `-` operand, so -l, -H, -c and context answer as they
        # do for a typed one (ripgrep's Paths::from_low_args, 14.1.1).
        if stdin is None:
            raise UsageError(RG_NO_PATTERN)
        paths = [STDIN_OPERAND]

    mounts = mounts_of(ctx)
    mount_prefix = mount_prefix_of(paths[0].virtual, paths[0].vfs_path)
    rd = mount_parent_readdir(
        partial(call_readdir, readdir, prefix=mount_prefix),
        mounts,
        mount_prefix,
    )
    st = mount_parent_stat(
        partial(call_stat, stat, prefix=mount_prefix), mounts
    )

    if (
        pat is not None
        and len(paths) == 1
        and not (f.stats or f.json or f.search_zip or f.pre)
    ):
        single = await _search_single(paths[0], pat, f, st, rd, operand_stream)
        if single is not None:
            return await _noted(single, notes, f)

    warnings: list[str] = []
    cwd = ctx.cwd.virtual
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
        paths, rd, st, cwd, walk, f, warnings, boundary, link_resolver(ctx)
    )
    if f.sort not in (None, "none") and not (
        f.sort == "path" and not f.sort_reverse
    ):
        listed = [h async for h in found]
        found = _replay(sort_haystacks(listed, f))
    io = IOResult()
    out = (
        _list_files(found, f, warnings, io)
        if pat is None
        else _search_all(
            found,
            paths,
            pat,
            f,
            operand_stream,
            mount_prefix,
            warnings,
            implicit,
            cwd,
            io,
            ctx.shell,
        )
    )
    return await _noted((out, io), notes, f)


async def _noted(
    result: tuple[ByteSource | None, IOResult], notes: list[str], f: RgFlags
) -> tuple[ByteSource | None, IOResult]:
    """A search's result with --ignore-file's notes ahead of its stderr,
    as ripgrep prints them before it searches.

    Args:
        result (tuple[ByteSource | None, IOResult]): the search's result.
        notes (list[str]): the ignore files that could not be read.
        f (RgFlags): the parsed flags.
    """
    out, io = result
    if notes and not f.no_messages:
        io.stderr = format_records(notes) + (
            await materialize(io.stderr) if io.stderr is not None else b""
        )
    return out, io


async def _up_to_damage(
    source: AsyncIterator[bytes], faults: list[GzipDataError]
) -> AsyncIterator[bytes]:
    """gzip's output up to where its input is damaged, the damage kept in
    ``faults``: ripgrep searches what gzip wrote before it failed.

    Args:
        source (AsyncIterator[bytes]): the decoded stream.
        faults (list[GzipDataError]): receives the damage.
    """
    try:
        async for chunk in source:
            yield chunk
    except GzipDataError as exc:
        faults.append(exc)
    finally:
        await close_quietly(source)


async def _replay(found: list[Haystack]) -> AsyncIterator[Haystack]:
    for h in found:
        yield h


async def _search_single(
    p: PathSpec,
    pat: re.Pattern[str],
    f: RgFlags,
    st: Callable[[str], Awaitable[FileStat]],
    rd: Callable[[str], Awaitable[list[str]]],
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
        operand_stream (Callable): the operand's reader, stdin's for `-`.
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
    io = IOResult(exit_code=1)
    tally = Tally()
    return _settled(
        search_haystack(
            operand_stream(p), pat, f, name, label, tally, pipe=is_stdin(p)
        ),
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
    with the exit status settled however the output ends.

    Args:
        chunks (AsyncIterator[bytes]): the haystack's records.
        f (RgFlags): the parsed flags.
        label (str | None): the haystack's label.
        tally (Tally): what the search selected.
        io (IOResult): receives the exit status.
        shown (str): the operand as typed, which a failed read names.
    """
    printed = failed = False
    try:
        async for chunk in chunks:
            if not printed and (
                heading := _lead(f, label, False, tally.binary)[1]
            ):
                yield heading
            printed = True
            yield chunk
    except FS_ERRORS as exc:
        # A read that fails once the stream is open is the searcher's to
        # report, exit 2, as ripgrep reports it for any file it searches.
        failed = True
        io.stderr = (
            None
            if f.no_messages
            else f"{open_error_line(shown, exc)}\n".encode()
        )
        io.exit_code = 2
    finally:
        await close_quietly(chunks)
        if not failed:
            listed = printed if f.files_without_match and not f.quiet else None
            selected = tally.selected if listed is None else listed
            io.exit_code = 0 if selected else 1


def json_summary(f: RgFlags) -> bool:
    """Whether --json writes its records and the summary: only for the
    printing modes, -c and -l printing as they do without it.

    Args:
        f (RgFlags): the parsed flags.
    """
    return f.json and not (
        f.count_only
        or f.count_matches
        or f.files_only
        or f.files_without_match
    )


def headed(f: RgFlags) -> bool:
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


def runs_parallel(f: RgFlags) -> bool:
    """Whether ripgrep searches more than one path on its parallel
    searcher: -j1 and a sort hold it to one thread.

    Args:
        f (RgFlags): the parsed flags.
    """
    return f.threads != 1 and f.sort in (None, "none")


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
    if headed(f) and not f.no_filename:
        return b"\n"
    if prints_context(f) and f.context_separator is not None:
        return encode_text(f.context_separator) + b"\n"
    return b""


def _lead(
    f: RgFlags, label: str | None, printed: bool, binary: bool
) -> tuple[bytes, bytes]:
    """What goes before a file's first output: the gap after the file
    printed before it, and the --heading line naming it.

    Args:
        f (RgFlags): the parsed flags.
        label (str | None): the file's label.
        printed (bool): an earlier file printed.
        binary (bool): a binary-file notice stands in for its lines.
    """
    gap = between_files(f) if printed else b""
    if label is None or not headed(f) or binary:
        return gap, b""
    return gap, encode_text(label) + (b"\0" if f.null else record_end(f))


async def haystacks(
    paths: list[PathSpec],
    rd: Callable[[str], Awaitable[list[str]]],
    st: Callable[[str], Awaitable[FileStat]],
    cwd: str,
    walk: WalkFilter,
    f: RgFlags,
    warnings: list[str],
    boundary: MountView | None,
    resolver: LinkResolver | None,
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
        resolver (LinkResolver | None): the namespace's links and the
            dispatcher past them, which -L walks through.
    """
    # ripgrep holds one path that is not a directory to one thread, as it
    # does -j1 and a sort; every other line runs its parallel walker.
    parallel = runs_parallel(f)
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
            resolver,
            f.follow,
            parallel,
        ):
            yield found


async def _list_files(
    found: AsyncIterator[Haystack],
    f: RgFlags,
    warnings: list[str],
    io: IOResult,
) -> AsyncIterator[bytes]:
    """--files: every path the search would read, and nothing searched.

    Args:
        found (AsyncIterator[Haystack]): the haystacks.
        f (RgFlags): the parsed flags.
        warnings (list[str]): what could not be read.
        io (IOResult): receives the exit status and the warnings, however
            the output ends.
    """
    term = b"\0" if f.null else b"\n"
    selected = False
    try:
        async for h in found:
            selected = True
            if f.quiet:
                break
            yield encode_text(printed_path(h.shown, f)) + term
    finally:
        await close_quietly(found)
        io.exit_code = exit_code_for(selected, bool(warnings), f.quiet)
        if warnings and not f.no_messages:
            io.stderr = await materialize(io.stderr) + format_records(warnings)


async def preprocessed(
    command: str, path: str, name: str, data: bytes, shell: ShellFn | None
) -> tuple[bytes, str | None]:
    """What --pre's command prints for one file, or ripgrep's report of
    why it failed: it runs ``COMMAND PATH`` with the file's contents on
    stdin, here as a line in the session.

    Args:
        command (str): the --pre command.
        path (str): the file as the line named it.
        name (str): the file as rg prints it.
        data (bytes): the file's contents.
        shell (ShellFn | None): runs a line in the session.
    """
    shown = " ".join(f'"{word}"' for word in (command, path))
    head = f"rg: {name}: preprocessor command"
    io = await shell(shell_join([command, path]), data) if shell else None
    if io is None or io.exit_code == COMMAND_NOT_FOUND:
        return b"", (
            f"{head} could not start: '{shown}': No such file or directory "
            "(os error 2)"
        )
    if io.exit_code != 0:
        err = decode_text(await materialize(io.stderr)) if io.stderr else ""
        body = (
            f"\n{GZIP_RULE}\n{err}{GZIP_RULE}" if err else "<stderr is empty>"
        )
        return b"", f"{head} failed: '{shown}': {body}"
    return (await materialize(io.stdout) if io.stdout else b""), None


async def _search_all(
    found: AsyncIterator[Haystack],
    paths: list[PathSpec],
    pat: re.Pattern[str],
    f: RgFlags,
    operand_stream: Callable[[PathSpec], AsyncIterator[bytes]],
    prefix: str,
    warnings: list[str],
    implicit: bool,
    cwd: str,
    io: IOResult,
    shell: ShellFn | None = None,
) -> AsyncIterator[bytes]:
    """Search every haystack in order and put the output together.

    ripgrep labels every line when the line named more than one path or
    walked a directory; -H forces the label and -I drops it. Between one
    file's context and the next file's goes the context separator, and
    under --heading a blank line goes between files instead.

    Args:
        found (AsyncIterator[Haystack]): the haystacks, closed with the
            output.
        paths (list[PathSpec]): the operands.
        pat (re.Pattern[str]): the compiled pattern.
        f (RgFlags): the parsed flags.
        operand_stream (Callable): each file's reader, stdin's for `-`.
        prefix (str): the operands' mount prefix, which a walked file's
            key is spelled under.
        warnings (list[str]): collects what could not be read.
        implicit (bool): the line named no path, so ripgrep reports a
            search that found nothing to search.
        cwd (str): the session's working directory, which --pre-glob's
            globs are rooted at.
        io (IOResult): receives the exit status and the warnings, however
            the output ends.
        shell (ShellFn | None): runs --pre's command in the session.
    """
    multi = len(paths) > 1
    lone = not multi
    pre_globs = Overrides(f.pre_globs, (), False)
    progressive = not (f.stats or f.json or f.search_zip)
    printed = selected = skipped = False
    searched = 0
    records = json_summary(f)
    totals = Totals()
    worker = Worker()
    started = time.perf_counter()
    try:
        async for h in found:
            searched += 1
            walked = h.spec is None
            lone = lone and not walked
            name = printed_path(h.shown, f)
            label = (
                name
                if not f.no_filename
                and (walked or multi or f.with_filename or f.vimgrep)
                else None
            )
            tally = Tally()
            began = time.perf_counter()
            chunks: list[bytes] = []
            file_printed = False
            damaged = False
            faults: list[GzipDataError] = []
            stdin = h.spec is not None and is_stdin(h.spec)
            try:
                source = (
                    h.resolver.read(h.virtual)
                    if h.resolver is not None
                    else operand_stream(
                        to_pathspec(h.virtual, prefix)
                        if h.spec is None
                        else h.spec
                    )
                )
                if (
                    f.pre is not None
                    and not stdin
                    and pre_globs.verdict(walk_candidate(h.shown, cwd), False)
                    is not Verdict.IGNORE
                ):
                    text, refusal = await preprocessed(
                        f.pre, h.shown, name, await materialize(source), shell
                    )
                    if refusal is not None:
                        warnings.append(refusal)
                        continue
                    source = _wrap_bytes(text)
                elif (
                    f.search_zip
                    and h.virtual.endswith(GZIP_NAMES)
                    and not stdin
                ):
                    source = _up_to_damage(gunzip_stream(source), faults)
                matches = search_haystack(
                    source,
                    pat,
                    f,
                    name,
                    label,
                    tally,
                    not walked,
                    stdin,
                    worker,
                )
                try:
                    async for c in matches:
                        if not progressive:
                            chunks.append(c)
                            continue
                        if not file_printed:
                            if lead := b"".join(
                                _lead(f, label, printed, tally.binary)
                            ):
                                yield lead
                            file_printed = printed = True
                        selected = selected or tally.selected
                        yield c
                finally:
                    await close_quietly(matches)
                if faults:
                    raise faults[0]
            except FS_ERRORS as exc:
                # ripgrep reports the failed input and keeps searching the
                # rest.
                warnings.append(open_error_line(h.shown, exc))
                continue
            except GzipDataError as exc:
                # -z runs gzip, whose refusal ripgrep frames in rules.
                warnings.append(
                    f"rg: {name}: \n{GZIP_RULE}\n"
                    f"{exc.render(name).lstrip()}{GZIP_RULE}"
                )
                # gzip's output streams into the search, so the lines it
                # decoded before the damage still print, but not what
                # ripgrep writes once the file is done (a count,
                # --files-without-match), and the file adds to no total.
                damaged = True
                if f.count_only or f.count_matches or f.files_without_match:
                    chunks.clear()
            elapsed = time.perf_counter() - began
            selected = selected or tally.selected
            skipped = skipped or tally.skipped
            if records:
                if chunks:
                    begin = json_line(
                        {"type": "begin", "data": {"path": json_text(name)}}
                    )
                    sent = len(begin) + sum(len(c) for c in chunks)
                    yield begin
                    for chunk in chunks:
                        yield chunk
                    if not damaged:
                        totals.add(tally, sent, elapsed)
                        yield totals.end_record(name, tally, sent, elapsed)
                elif f.quiet and tally.selected and not damaged:
                    totals.add(tally, 0, elapsed)
            elif chunks:
                gap, heading = _lead(f, label, printed, tally.binary)
                # -c and -l counts and names are not what --stats counts.
                sent = len(heading) + (
                    0
                    if f.count_only
                    or f.count_matches
                    or f.files_only
                    or f.files_without_match
                    else sum(len(c) for c in chunks)
                )
                if gap + heading:
                    yield gap + heading
                for chunk in chunks:
                    yield chunk
                printed = True
                if not damaged:
                    totals.add(tally, sent, elapsed)
            elif not damaged:
                totals.add(tally, 0, elapsed)
            # --stats and --json count every file, -q or not (14.1.1).
            if f.quiet and tally.selected and not (f.stats or f.json):
                break
        if records:
            yield totals.summary_record(time.perf_counter() - started)
        elif f.stats:
            # ripgrep's parallel searcher gives the last --heading group its
            # blank line too; one thread, as for a lone file, does not.
            if printed and headed(f) and runs_parallel(f) and not lone:
                yield b"\n"
            yield totals.stats_block(time.perf_counter() - started)
    finally:
        await close_quietly(found)
        await worker.close()
        if f.files_without_match and not f.quiet:
            # ripgrep's status under --files-without-match follows the
            # listing, not the matching: 0 when a file was listed, 1 when
            # every file matched (14.1.1; GNU grep keeps the match
            # status). A walked binary file it skipped counts as one
            # without a match, though no listing names it.
            selected = printed or skipped
        code = exit_code_for(selected, bool(warnings), f.quiet)
        shown = [] if f.no_messages else list(warnings)
        if implicit and searched == 0:
            # An error whatever --no-messages says, which only silences it.
            if not f.no_messages:
                shown.append(NOTHING_SEARCHED)
            code = 2
        io.exit_code = code
        if shown:
            io.stderr = await materialize(io.stderr) + format_records(shown)


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


def labelled(ctx: Context) -> Context:
    """Ask for the filename a walk would have printed on its own.

    A content search hands the generic explicit files where the user
    named a directory, and the generic labels explicit operands only when
    there are several, so ``-H`` is requested here; an ``-I`` the line
    set after any ``-H`` still wins, since forcing ``-H`` under it would
    defeat the suppression in the delegated scan.

    Args:
        ctx (Context): the narrowing wrapper's options.
    """
    flags = ctx.flags or {}
    if filename_flag(FlagView(flags, spec=SPECS["rg"])) == "no_filename":
        return ctx
    return replace(ctx, flags=label_flags(flags))
