import functools
import logging
import posixpath
import string
import sys
from collections import deque
from collections.abc import (
    AsyncGenerator,
    AsyncIterator,
    Callable,
    Mapping,
    Sequence,
)
from contextlib import aclosing
from dataclasses import dataclass, fields, replace
from typing import Any

from mirage.commands.builtin.generic.sort import engine_config
from mirage.commands.builtin.utils import formatting
from mirage.commands.builtin.utils.identity import Identity, identity_of
from mirage.commands.builtin.utils.links import (
    links_of,
    mounts_of,
    owed_names,
)
from mirage.commands.builtin.utils.operands import at_offsets, say
from mirage.commands.builtin.utils.output import (
    format_optional_records,
    format_records,
)
from mirage.commands.builtin.utils.paths import vfs_stat_path
from mirage.commands.builtin.utils.tree import WalkBudget
from mirage.commands.config import Context
from mirage.commands.errors import UsageError
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import FlagValue
from mirage.errors.classify import is_entry_error
from mirage.errors.constants import MISS_ERRORS
from mirage.errors.fs import fs_strerror, strerror_of
from mirage.errors.posix import posix_phrase
from mirage.errors.types import DotWalkError, DotWalkLoop, FsCondition
from mirage.io.types import ByteSource, IOResult
from mirage.rs import open_stream
from mirage.rs.scan import scan, scanned
from mirage.shell.bytes import decode_text, encode_text, text_view
from mirage.types import (
    LINK_TARGET_KEY,
    FileStat,
    FileType,
    Follow,
    JsonValue,
    LineFacts,
    LsFormat,
    LsIndicator,
    LsLinkMode,
    LsSortBy,
    LsTimeKind,
    PathSpec,
    ReaddirFn,
    StatFn,
)
from mirage.utils.fnmatch import fnmatch
from mirage.utils.key_prefix import mount_prefix_of, rekey, under_path
from mirage.utils.path import respell_one
from mirage.utils.quote import quote_name
from mirage.utils.stat_view import content_size
from mirage.utils.width import text_width
from mirage.view.namespace_view import followed_stat
from mirage.view.types import ChildMounts, LinkView, MountView, StatPath

logger = logging.getLogger(__name__)

LS_OK = 0
LS_MINOR_PROBLEM = 1
LS_FAILURE = 2
# The width and tab stops a listing in columns takes when nothing names
# them.
LINE_WIDTH = 80
TAB_SIZE = 8
# How a name prints under the line's quoting style.
Quote = Callable[[str], str]


@dataclass(frozen=True, slots=True)
class LsFlags:
    layout: LsFormat = LsFormat.SINGLE_COLUMN
    all_files: bool = False
    show_dot_entries: bool = False
    human: bool = False
    sort_by: LsSortBy = LsSortBy.NAME
    reverse: bool = False
    recursive: bool = False
    list_dir: bool = False
    indicator: LsIndicator = LsIndicator.NONE
    deref: bool = False
    follow_args: bool = False
    time_kind: LsTimeKind = LsTimeKind.MTIME
    group_dirs_first: bool = False
    columns: formatting.LsColumns = formatting.DEFAULT_COLUMNS
    quoting: str = "literal"
    hide_control: bool = False
    hyperlink: bool = False
    width: int | None = LINE_WIDTH
    tabsize: int = TAB_SIZE
    ignore: tuple[str, ...] = ()
    notices: tuple[str, ...] = ()


# The three spellings of a command-line link policy; the last one wins.
_DEREF_DESTS = (
    "dereference",
    "dereference_command_line",
    "dereference_command_line_symlink_to_dir",
)
# The four spellings of an indicator style; the last one typed wins.
_INDICATOR_DESTS = ("classify", "file_type", "p", "indicator_style")
# The spellings of a format; the last one typed wins, but -1 leaves a long
# format long.
_FORMAT_DESTS = (
    "args_l",
    "g",
    "o",
    "numeric_uid_gid",
    "full_time",
    "args_1",
    "C",
    "x",
    "m",
    "format",
)
# What mirage-rs reads: every option that carries a word, a size or a
# style, in the order typed.
_SCANNED = (
    "sort",
    "t",
    "S",
    "X",
    "v",
    "U",
    "time",
    "c",
    "u",
    "hyperlink",
    "color",
    "classify",
    "indicator_style",
    "p",
    "file_type",
    "block_size",
    "human_readable",
    "si",
    "time_style",
    "f",
    *_FORMAT_DESTS,
    "quoting_style",
    "escape",
    "literal",
    "quote_name",
    "hide_control_chars",
    "show_control_chars",
    "width",
    "tabsize",
)
# The environment ls reads where no option gives the value, and the name
# the scan reads each one under.
_ENVIRONMENT = (("QUOTING_STYLE", "quoting_env"), ("COLUMNS", "columns_env"))
# The quoting styles that leave some names bare, under which a bare name
# in columns or a long listing takes a space to line up with quoted ones.
_ALIGNED_STYLES = frozenset(("shell", "shell-escape", "c-maybe"))
_ALIGNED_LAYOUTS = frozenset(
    (LsFormat.VERBOSE, LsFormat.VERTICAL, LsFormat.HORIZONTAL)
)
# What -B leaves out.
_BACKUPS = ("*~", ".*~")
# GNU reads a bare --classify, --hyperlink or --color as `always`.
_BARE_ALWAYS = frozenset(("classify", "hyperlink", "color"))
# What a quoted name opens with.
_QUOTES = ("'", '"', "\u2018")

_FOLLOWS = {
    LsLinkMode.ALL: Follow.LAST,
    LsLinkMode.DIRECTORY: Follow.DIRECTORY,
    LsLinkMode.NONE: Follow.NONE,
}


@dataclass(frozen=True, slots=True)
class LsValues:
    """What mirage-rs read out of ls's typed options.

    Args:
        sort_by (LsSortBy | None): the last sort spelling, None when the
            line typed none.
        time_kind (LsTimeKind): the timestamp shown and sorted by.
        indicator (LsIndicator): the mark appended to a name.
        hyperlink (bool): whether ``--hyperlink`` asked for OSC 8 links.
        block_size (formatting.BlockSize | None): ``--block-size``, None
            for bytes or when ``-h`` came after it.
        time_style (str): ``locale``, ``full-iso``, ``long-iso``, ``iso``
            or ``+FORMAT``.
        layout (LsFormat): the format.
        quoting (str): the ``--quoting-style`` word.
        hide_control (bool): ``-q``, a control printed as ``?``.
        width (int | None): the line width, None for no limit.
        tabsize (int): the tab stops, 0 for spaces only.
        warnings (tuple[str, ...]): an environment value ls ignored, each
            in its words.
    """

    sort_by: LsSortBy | None
    time_kind: LsTimeKind
    indicator: LsIndicator
    hyperlink: bool
    block_size: formatting.BlockSize | None
    time_style: str
    layout: LsFormat
    quoting: str
    hide_control: bool
    width: int | None
    tabsize: int
    warnings: tuple[str, ...]


def _tape(fl: FlagView, names: Sequence[str]) -> list[tuple[str, str]]:
    """The typed options as the scan reads them: a switch empty, except
    the bare spelling of an option that takes ``WHEN``, which is the word
    GNU reads it as and stays apart from an explicit empty value.

    Args:
        fl (FlagView): the ls flag view.
        names (Sequence[str]): the options to read.
    """
    return [
        (
            dest,
            "always"
            if value is True and dest in _BARE_ALWAYS
            else (value if isinstance(value, str) else ""),
        )
        for dest, value in fl.occurrences(*names)
        if value is not False
    ]


def scan_values(
    fl: FlagView,
    names: Sequence[str] = _SCANNED,
    env: Mapping[str, str] | None = None,
) -> LsValues:
    """ls's option values, read by mirage-rs in one pass over the line.

    Args:
        fl (FlagView): the ls flag view.
        names (Sequence[str]): which options to read; the others keep
            their defaults.
        env (Mapping[str, str] | None): the environment, whose
            ``QUOTING_STYLE`` and ``COLUMNS`` stand in for an option the
            line did not type.

    Raises:
        UsageError: the first value ls refuses, in its words and with its
            exit status.
    """
    tape = _tape(fl, names)
    if env is not None:
        tape += [(dest, env[var]) for var, dest in _ENVIRONMENT if var in env]
    values = scanned("ls", tape)
    sort = values["sort"]
    time = values["time"]
    indicator = values["indicator"]
    hyperlink = values["hyperlink"]
    style = values["time_style"]
    layout = values["format"]
    quoting = values["quoting"]
    hide_control = values["hide_control"]
    width = values["width"]
    tabsize = values["tabsize"]
    warnings = values["warnings"]
    if not (
        (sort is None or isinstance(sort, str))
        and isinstance(time, str)
        and isinstance(indicator, str)
        and isinstance(hyperlink, bool)
        and isinstance(style, str)
        and isinstance(layout, str)
        and isinstance(quoting, str)
        and isinstance(hide_control, bool)
        and (width is None or type(width) is int)
        and type(tabsize) is int
        and isinstance(warnings, list)
        and all(isinstance(w, str) for w in warnings)
    ):
        raise TypeError(f"ls: mirage-rs read the options as {values!r}")
    return LsValues(
        sort_by=None if sort is None else LsSortBy(sort),
        time_kind=LsTimeKind(time),
        indicator=LsIndicator(indicator),
        hyperlink=hyperlink,
        block_size=formatting.block_size_of(values["block_size"]),
        time_style=text_view(style),
        layout=LsFormat(layout),
        quoting=quoting,
        hide_control=hide_control,
        width=width,
        tabsize=tabsize,
        warnings=tuple(text_view(w) for w in warnings if isinstance(w, str)),
    )


def indicator_flag(fl: FlagView) -> LsIndicator:
    """The indicator style a line asks for.

    The last of ``-F``/``--classify[=WHEN]``, ``-p``, ``--file-type`` and
    ``--indicator-style`` wins, and every one is checked on the way, as
    GNU checks each value while it reads the options (coreutils 9.7).

    Args:
        fl (FlagView): the ls flag view.
    """
    return scan_values(fl, _INDICATOR_DESTS).indicator


def link_mode(fl: FlagView, values: LsValues | None = None) -> LsLinkMode:
    """Which command-line links ls resolves before it lists them.

    It is settled once: the last of ``-L``, ``-H`` and
    ``--dereference-command-line-symlink-to-dir`` wins, and with none of
    them ``-d``, a long format or the classify style resolve no link
    while anything else resolves one that leads to a directory
    (coreutils 9.7). A value the command refuses leaves the line neither
    long nor classified, since that line fails before it lists anything.

    Args:
        fl (FlagView): the ls flag view.
        values (LsValues | None): a scan of the whole line already read;
            None reads the format and indicator options here.
    """
    typed = fl.typed_order(*_DEREF_DESTS)
    if typed:
        return (
            LsLinkMode.DIRECTORY
            if typed[-1] == "dereference_command_line_symlink_to_dir"
            else LsLinkMode.ALL
        )
    try:
        read = (
            values
            if values is not None
            else scan_values(fl, (*_INDICATOR_DESTS, *_FORMAT_DESTS))
        )
        long = read.layout is LsFormat.VERBOSE
        classify = read.indicator is LsIndicator.CLASSIFY
    except UsageError as exc:
        logger.debug("ls: the command refuses this line itself: %s", exc)
        long = classify = False
    if fl.as_bool("directory") or long or classify:
        return LsLinkMode.NONE
    return LsLinkMode.DIRECTORY


def facts(fl: FlagView, operands: Sequence[str | PathSpec]) -> LineFacts:
    """An ls line resolves the command-line links ``link_mode`` says, and
    walks, and reads, below its operands under ``-R``.

    Args:
        fl (FlagView): spec-validated view over the raw flag kwargs.
        operands (Sequence[str | PathSpec]): the line's operands.
    """
    recursive = fl.as_bool("recursive")
    return LineFacts(
        follows=_FOLLOWS[link_mode(fl)],
        walks=recursive,
        reads_subtree=recursive,
    )


def parse_flags(
    flags: Mapping[str, FlagValue], env: Mapping[str, str] | None = None
) -> LsFlags:
    """Parse the ls flag bag once into a frozen struct.

    The rules that are easy to get wrong: ``-g``, ``-o``, ``-n`` and
    ``--full-time`` imply the long format, and ``-1`` never undoes it in
    either order; ``-n`` prints the same columns as ``-l``, because a
    mirage owner is already the id (an agent, a profile) and never a name
    looked up from one; ``-c`` or ``-u`` with no sort sorts by that time
    unless the format is long; ``-f`` lists every entry unsorted, and the
    last of ``-a``, ``-A`` and ``-f`` says which dot entries show;
    ``--hide`` leaves names out only where none of those three asked for
    them. The words, sizes and styles (the last sort, time, format,
    quoting and indicator spelling, the later of ``-h``, ``--si`` and
    ``--block-size``) are mirage-rs's, read in one pass. Raises
    ``UsageError`` for a value ls refuses, with its exit status for that
    option.

    Args:
        flags (Mapping[str, FlagValue]): flags for the shared ls spec.
        env (Mapping[str, str] | None): the environment, for
            ``QUOTING_STYLE`` and ``COLUMNS``.
    """
    fl = FlagView(flags, spec=SPECS["ls"])
    values = scan_values(fl, env=env)
    long = values.layout is LsFormat.VERBOSE
    sort_by = LsSortBy.NAME if values.sort_by is None else values.sort_by
    if (
        values.sort_by is None
        and values.time_kind is not LsTimeKind.MTIME
        and not long
    ):
        sort_by = LsSortBy.TIME
    columns = formatting.LsColumns(
        owner=not fl.as_bool("g"),
        group=not (fl.as_bool("o") or fl.as_bool("no_group")),
        inode=fl.as_bool("inode"),
        blocks=fl.as_bool("size"),
        context=fl.as_bool("context"),
        time_kind=values.time_kind,
        time_style=values.time_style,
        block_size=values.block_size,
    )
    shown = fl.typed_order("all", "almost_all", "f")[-1:]
    all_files = bool(shown)
    ignore = tuple(fl.as_list("ignore"))
    if fl.as_bool("ignore_backups"):
        ignore += _BACKUPS
    if not all_files:
        ignore += tuple(fl.as_list("hide"))
    return LsFlags(
        layout=values.layout,
        all_files=all_files,
        show_dot_entries=shown != ["almost_all"] and all_files,
        human=fl.as_bool("human_readable"),
        sort_by=sort_by,
        reverse=fl.as_bool("reverse"),
        recursive=fl.as_bool("recursive"),
        list_dir=fl.as_bool("directory"),
        indicator=values.indicator,
        # -L alone dereferences what a listing finds; -H and its sibling
        # stop at the command line, and the last of the three wins.
        deref=fl.typed_order(*_DEREF_DESTS)[-1:] == ["dereference"],
        follow_args=link_mode(fl, values) is LsLinkMode.ALL,
        time_kind=values.time_kind,
        group_dirs_first=fl.as_bool("group_directories_first"),
        columns=columns,
        quoting=values.quoting,
        hide_control=values.hide_control,
        hyperlink=values.hyperlink,
        width=values.width,
        tabsize=values.tabsize,
        ignore=ignore,
        notices=values.warnings,
    )


def ls_options(
    flags: Mapping[str, FlagValue], env: Mapping[str, str] | None = None
) -> dict[str, Any]:
    """Parsed ls flags as the generic's own keyword arguments.

    ``LsFlags`` names every field after the ``ls`` parameter it feeds,
    so both entry points -- the single-mount ``ls_generic`` and the
    cross-mount relay -- share one mapping instead of restating it. A
    shallow view, so the nested column struct rides through whole.

    Args:
        flags (Mapping[str, FlagValue]): Flags for the shared ls spec.
        env (Mapping[str, str] | None): the environment, for
            ``QUOTING_STYLE`` and ``COLUMNS``.
    """
    parsed = parse_flags(flags, env)
    return {f.name: getattr(parsed, f.name) for f in fields(parsed)}


@dataclass(frozen=True, slots=True)
class LsWarning:
    """One diagnostic plus how serious GNU ls considers it.

    Args:
        message (str): The rendered `ls: ...` stderr line.
        serious (bool): True when the failure was on a command-line operand
            (GNU exit 2); False for problems met while listing or
            recursing below an operand (GNU exit 1).
    """

    message: str
    serious: bool


@dataclass(frozen=True, slots=True)
class Operand:
    """One ls operand once its kind is known.

    ``row`` is set when the operand is not a directory: GNU prints those
    first, as one block with no header. ``groups`` holds the operand's own
    ``(dir, entries)`` listing; under ``-R`` what lies below is walked as
    it prints. Both empty means the operand could not be accessed.
    ``notes`` holds a directory the operand could not list, with the
    number of groups listed before it: GNU reports one where its listing
    would have printed.
    """

    path: PathSpec
    row: FileStat | None
    groups: list[tuple[PathSpec, list[FileStat]]]
    notes: tuple[tuple[int, LsWarning], ...] = ()


def _err_text(exc: BaseException) -> str:
    return fs_strerror(exc) or str(exc)


def exit_status_for(warnings: list[LsWarning]) -> int:
    """Collapse diagnostics into a GNU ls exit status.

    GNU ratchets the status upward: a serious problem (bad command-line
    operand) always wins, a minor one only upgrades a clean run.

    Args:
        warnings (list[LsWarning]): Diagnostics gathered over every operand.

    Returns:
        0 when clean, 1 for minor problems only, 2 if any was serious.
    """
    if any(w.serious for w in warnings):
        return LS_FAILURE
    return LS_MINOR_PROBLEM if warnings else LS_OK


def type_indicator(entry: FileStat | None, style: LsIndicator) -> str:
    """The mark GNU appends to a name for a style (coreutils 9.7).

    A directory is ``/`` in every style but none; ``slash`` marks nothing
    else. A link is ``@`` and a FIFO ``|``; an executable regular file is
    ``*``, but only under classify. The mark rides the row's own type and
    mode, so it needs no separate lookup.

    Args:
        entry (FileStat | None): the row, or None for an entry nothing
            could stat (a dangling link's target), which takes no mark.
        style (LsIndicator): the indicator style.
    """
    if entry is None or style is LsIndicator.NONE:
        return ""
    if entry.type == FileType.DIRECTORY:
        return "/"
    if style is LsIndicator.SLASH:
        return ""
    if entry.type == FileType.SYMLINK:
        return "@"
    if entry.type == FileType.FIFO:
        return "|"
    if (
        style is LsIndicator.CLASSIFY
        and entry.type == FileType.FILE
        and entry.mode is not None
        and entry.mode & 0o111
    ):
        return "*"
    return ""


def format_simple(
    entries: list[FileStat],
    *,
    indicator: LsIndicator = LsIndicator.NONE,
    columns: formatting.LsColumns = formatting.DEFAULT_COLUMNS,
    names: list[str] | None = None,
) -> list[str]:
    """Short rows: the name, the indicator style's mark, and
    ``-i``/``-Z``'s lead.

    Args:
        entries (list[FileStat]): the rows.
        indicator (LsIndicator): the indicator style.
        columns (formatting.LsColumns): the requested columns.
        names (list[str] | None): the name per row when the caller
            decorated it (``--hyperlink``), else the row's own.
    """
    lead = formatting.ls_prefix(columns)
    return [
        lead
        + (names[i] if names is not None else e.name)
        + type_indicator(e, indicator)
        for i, e in enumerate(entries)
    ]


def long_names(
    entries: list[FileStat],
    names: list[str] | None,
    indicator: LsIndicator,
    targets: list[FileStat | None],
) -> list[str] | None:
    """The long format's name column with the indicator style's marks.

    GNU marks a row after its name, but a link after its target, with the
    target's own mark, and only under file-type and classify: ``dl ->
    sub/``, ``dang -> nowhere`` (coreutils 9.7). None when no mark is
    asked for, so the row's own column stands.

    Args:
        entries (list[FileStat]): the rows.
        names (list[str] | None): the decorated names, if any.
        indicator (LsIndicator): the indicator style.
        targets (list[FileStat | None]): what each link row leads to,
            None for a row that is no link or leads nowhere.
    """
    if indicator is LsIndicator.NONE:
        return names
    out: list[str] = []
    for i, e in enumerate(entries):
        name = names[i] if names is not None else formatting.ls_name(e)
        if e.type != FileType.SYMLINK:
            out.append(name + type_indicator(e, indicator))
        elif indicator is LsIndicator.SLASH:
            out.append(name)
        else:
            out.append(name + type_indicator(targets[i], indicator))
    return out


async def link_targets(
    entries: list[FileStat],
    virtuals: list[str],
    links: LinkView | None,
    long: bool,
    indicator: LsIndicator,
) -> list[FileStat | None]:
    """What each link row leads to, when the long format marks it.

    Args:
        entries (list[FileStat]): the rows.
        virtuals (list[str]): each row's virtual path.
        links (LinkView | None): the namespace's symlink facts.
        long (bool): the long format.
        indicator (LsIndicator): the indicator style.
    """
    wanted = (
        long
        and links is not None
        and indicator in (LsIndicator.FILE_TYPE, LsIndicator.CLASSIFY)
    )
    out: list[FileStat | None] = []
    for e, virtual in zip(entries, virtuals):
        if wanted and links is not None and e.type == FileType.SYMLINK:
            out.append(await links.target_stat(virtual))
        else:
            out.append(None)
    return out


# GNU 9.7's `ls -v` lists names in the order `sort -zV` prints them, ties
# broken by bytes as sort's last resort does (1,500 random directories
# agreed), so the names go through mirage-rs's sort with one version key.
# A run holds every name, so the sort writes one run and never merges.
@functools.cache
def _version_sort() -> dict[str, JsonValue]:
    typed = (("version_sort", ""), ("zero_terminated", ""))
    config = engine_config(scan("sort", typed))
    return {**config, "mode": "sort", "run_bytes": sys.maxsize}


def sort_by_version(names: Sequence[str]) -> list[int]:
    """Indices of ``names`` in ``ls -v`` order.

    Args:
        names (Sequence[str]): the names, none holding a NUL.

    Returns:
        list[int]: each index once; equal names keep their input order.
    """
    places: dict[bytes, deque[int]] = {}
    records = bytearray()
    for index, name in enumerate(names):
        raw = name.encode("utf-8", "surrogateescape")
        places.setdefault(raw, deque()).append(index)
        records += raw + b"\0"
    stream = open_stream("sort", _version_sort())
    out = bytearray(stream.feed(bytes(records)))
    out += stream.finish()
    while stream.busy():
        out += stream.drain()
    return [places[raw].popleft() for raw in bytes(out).split(b"\0")[:-1]]


def ignored(patterns: Sequence[str], name: str) -> bool:
    """Whether ``-I``, ``-B`` or ``--hide`` leaves a listed name out: a
    pattern matches it whole, a leading dot only where the pattern spells
    one.

    Args:
        patterns (Sequence[str]): the patterns.
        name (str): the entry's own name.
    """
    return any(fnmatch(name, pattern, period=True) for pattern in patterns)


def laid_out(
    rows: list[str], layout: LsFormat, width: int | None, tabsize: int
) -> list[str]:
    """Short rows as their format lays them out: in ``-C`` or ``-x``
    columns or ``-m``'s comma list by mirage-rs, else one to a line.

    Args:
        rows (list[str]): the rendered rows.
        layout (LsFormat): the format.
        width (int | None): the line width, None for no limit.
        tabsize (int): the tab stops, 0 for spaces only.
    """
    if layout in (LsFormat.SINGLE_COLUMN, LsFormat.VERBOSE) or not rows:
        return rows
    stream = open_stream(
        "ls_columns",
        {"format": layout.value, "width": width, "tabsize": tabsize},
    )
    out = bytearray(
        stream.feed(b"".join(encode_text(row) + b"\0" for row in rows))
    )
    out += stream.finish()
    return decode_text(bytes(out)).split("\n")[:-1]


def _extension_of(name: str) -> str:
    """The key ``ls -X`` compares first: the name from its last dot,
    empty for a name without one.

    Args:
        name (str): the entry name.
    """
    dot = name.rfind(".")
    return name[dot:] if dot >= 0 else ""


def _primary_value(
    entry: FileStat, sort_by: LsSortBy, time_kind: LsTimeKind
) -> str | int:
    if sort_by is LsSortBy.TIME:
        return formatting.time_of(entry, time_kind) or ""
    if sort_by is LsSortBy.SIZE:
        # A row whose stat failed sorts as 0, as GNU's zeroed stat does.
        if entry.extra.get(formatting.STAT_FAILED_KEY):
            return 0
        return content_size(entry)
    return entry.name


def _order_rows(
    rows: list[FileStat],
    sort_by: LsSortBy,
    reverse: bool,
    *,
    time_kind: LsTimeKind = LsTimeKind.MTIME,
    group_dirs_first: bool = False,
    quote: Quote | None = None,
) -> list[int]:
    """Indices of ``rows`` in GNU ls order.

    GNU's `-t`/`-S` comparators fall back to the name when the timestamps or
    sizes tie, and `-r` negates the whole comparison, tie-break included. A
    stable name sort followed by the primary key reproduces the first half;
    reversing the finished order reproduces the second. `-X` and
    `--sort=width` are stable sorts over the name order too; `-v` is
    ``sort -V``'s order; `-U` keeps the listing order, and `-r` does
    not reverse it (GNU's `-r` reverses while sorting, and `-U` does not
    sort). `--group-directories-first` partitions the finished
    order, so the directories come first in every sort but `-U`, where
    GNU ignores it.

    Args:
        rows (list[FileStat]): The stats to order.
        sort_by (LsSortBy): The active sort key.
        reverse (bool): Whether `-r` is in effect.
        time_kind (LsTimeKind): Which timestamp `-t` compares.
        group_dirs_first (bool): `--group-directories-first`.
        quote (Quote | None): how a name prints, whose
            width `--sort=width` compares; None for as it is.
    """
    if sort_by is LsSortBy.NONE:
        order = list(range(len(rows)))
    elif sort_by is LsSortBy.VERSION:
        order = sort_by_version([row.name for row in rows])
    else:
        order = sorted(range(len(rows)), key=lambda i: rows[i].name)
        if sort_by is LsSortBy.EXTENSION:
            order.sort(key=lambda i: _extension_of(rows[i].name))
        elif sort_by is LsSortBy.WIDTH:
            order.sort(
                key=lambda i: text_width(
                    rows[i].name if quote is None else quote(rows[i].name)
                )
            )
        elif sort_by is not LsSortBy.NAME:
            # -t and -S list newest/largest first.
            order.sort(
                key=lambda i: _primary_value(rows[i], sort_by, time_kind),
                reverse=True,
            )
    if reverse and sort_by is not LsSortBy.NONE:
        order.reverse()
    if group_dirs_first and sort_by is not LsSortBy.NONE:
        order = [i for i in order if rows[i].type is FileType.DIRECTORY] + [
            i for i in order if rows[i].type is not FileType.DIRECTORY
        ]
    return order


def sort_stats(
    entries: list[FileStat],
    sort_by: LsSortBy,
    reverse: bool,
    *,
    time_kind: LsTimeKind = LsTimeKind.MTIME,
    group_dirs_first: bool = False,
    quote: Quote | None = None,
) -> list[FileStat]:
    return [
        entries[i]
        for i in _order_rows(
            entries,
            sort_by,
            reverse,
            time_kind=time_kind,
            group_dirs_first=group_dirs_first,
            quote=quote,
        )
    ]


async def _operand_stat(path: PathSpec, stat: StatFn) -> FileStat | None:
    """An operand's stat, None for a path nothing is at.

    Args:
        path (PathSpec): the operand.
        stat (StatFn): the stat it is asked through.

    Raises:
        OSError: when its stat fails other than by absence.
    """
    try:
        return await stat(path)
    except MISS_ERRORS:
        return None


async def _file_entry(
    path: PathSpec,
    stat: StatFn,
) -> FileStat | None:
    """The row of an operand that is no directory, None for a directory
    or a path nothing is at.

    Args:
        path (PathSpec): the operand.
        stat (StatFn): the stat it is asked through.

    Raises:
        OSError: when its stat fails other than by absence.
    """
    s = await _operand_stat(path, stat)
    if s is None or s.type == FileType.DIRECTORY:
        return None
    return _as_operand(s, path)


def _as_operand(s: FileStat, path: PathSpec) -> FileStat:
    """GNU ls prints a file operand as given (`ls sub/x.txt` shows
    sub/x.txt, not x.txt); the row carries the operand spelling.

    Args:
        s (FileStat): the operand's stat.
        path (PathSpec): the operand.
    """
    return replace(s, name=path.raw_path)


def _link_row(path: PathSpec, links: LinkView | None) -> FileStat | None:
    """The row for an operand that is itself a symlink, else None, named
    with the operand's own spelling like every other ls row.

    Args:
        path (PathSpec): the operand being listed.
        links (LinkView | None): the namespace's symlink facts.
    """
    if links is None:
        return None
    row = links.stat_at(path.virtual)
    if row is None:
        return None
    return replace(row, name=path.raw_path)


def _child_spec(path: PathSpec, name: str) -> PathSpec:
    child = path.child(name)
    return PathSpec(
        virtual=child,
        directory=child,
        resolved=False,
        vfs_path=rekey(path.virtual, path.vfs_path, child),
    )


async def _mount_row(
    directory: PathSpec,
    name: str,
    stat_path: StatPath | None,
) -> FileStat:
    """The row for a child mount, carrying its real type.

    No backend can supply it: the parent's cannot see into the child
    mount, and the child's own answers its root with that mount's name
    for itself (``/``), which is why the row is renamed here the way the
    relay renames one. So the fact comes through the dispatcher, which
    routes to whichever mount owns the path.

    A mount root is not always a directory -- every workspace mounts
    ``/.bash_history`` as a whole mount serving one file -- and calling
    one a directory suffixes it with ``/`` under ``-F``, renders it
    ``drwxr-xr-x`` under ``-l``, and offers it to ``-R`` as something to
    descend. GNU lists a file that happens to be a mountpoint as an
    ordinary file row (pinned on coreutils 9.7 over a ``mount --bind``
    of one file onto another). Directory is the fallback for a caller
    with no dispatcher, which is the only thing that absence can mean.

    Args:
        directory (PathSpec): the directory being listed.
        name (str): the child's own name.
        stat_path (StatPath | None): dispatcher-backed stat of one path.
    """
    if stat_path is not None:
        row = await stat_path(directory.child(name))
        if row is not None:
            return replace(row, name=name)
    return FileStat(name=name, type=FileType.DIRECTORY)


def _stat_failed_row(entry: str) -> FileStat:
    """The row for an entry the listing named but its stat could not describe.

    GNU keeps it, since readdir is what named it, and ``?`` stands for
    every fact only the stat knows; its type is a directory's when the
    listing slash-marked it, and unknown otherwise.

    Args:
        entry (str): the entry path from the backend readdir.
    """
    return FileStat(
        name=entry.rstrip("/").rsplit("/", 1)[-1],
        type=(FileType.DIRECTORY if entry.endswith("/") else FileType.FILE),
        extra={formatting.STAT_FAILED_KEY: True},
    )


async def _stat_entries(
    path: PathSpec,
    names: list[str],
    *,
    stat: StatFn,
    all_files: bool,
    links: LinkView | None = None,
    deref: bool = False,
    child_mounts: ChildMounts | None = None,
    stat_path: StatPath | None = None,
    stat_needed: bool = True,
    spell: Callable[[str], str] = str,
    ignore: Sequence[str] = (),
) -> tuple[list[FileStat], list[LsWarning]]:
    """Stat every name in a directory, plus the mounts below it.

    An entry whose stat fails keeps its row and never fails the whole
    directory, whatever the error: a dropped connection on a mount
    whose stat is a request costs that entry alone, as any failed stat
    does in a GNU listing. It is reported, and the exit is 1, only
    when the listing prints something the stat supplies
    (``stat_needed``). One entry at a time, as GNU stats them.

    Args:
        path (PathSpec): the directory being listed.
        names (list[str]): entry paths from the backend readdir.
        stat (StatFn): backend stat.
        all_files (bool): keep dotfiles.
        links (LinkView | None): the namespace's symlink facts. The
            table's readdir names the links among the entries and its stat
            answers each with its own row.
        deref (bool): -L, report the target's stat under the link's own
            name instead of the link row. A dereferenced directory link
            then carries FileType.DIRECTORY, which is what makes -R
            descend it.
        child_mounts (ChildMounts | None): session-filtered child-mount
            names under a directory. A nested mount is namespace
            structure the backend readdir cannot name, merged here. GNU
            lists a mountpoint as an ordinary entry of
            its parent, so the merge is unconditional: withholding it
            under ``-R`` dropped the row whenever the parent's backend
            held no key of that name.
        stat_path (StatPath | None): dispatcher-backed stat, which is
            the only way to learn a child mount's real type. See
            ``_mount_row``.
        stat_needed (bool): the listing prints something an entry's
            stat supplies, so a failed one is reported. See
            ``stat_needed``.
        spell (Callable[[str], str]): an entry's path as the operand
            spelled it, for a diagnostic.
        ignore (Sequence[str]): the patterns of ``-I``, ``-B`` and
            ``--hide``; a name one matches is left out unstatted.
    """
    stats: list[FileStat] = []
    warnings: list[LsWarning] = []
    entry_stat = functools.partial(
        followed_stat, stat, links if deref else None
    )
    for entry in names:
        if ignore and ignored(ignore, entry.rstrip("/").rsplit("/", 1)[-1]):
            continue
        entry_spec = PathSpec(
            virtual=entry,
            directory=entry,
            resolved=False,
            vfs_path=rekey(path.virtual, path.vfs_path, entry),
        )
        try:
            s = await entry_stat(entry_spec)
        except Exception as exc:
            if not is_entry_error(exc):
                raise
            s = _stat_failed_row(entry)
            if not all_files and s.name.startswith("."):
                continue
            stats.append(s)
            if not stat_needed:
                logger.debug("ls: stat %s: %r", entry, exc)
                continue
            # An entry below an operand is never a command-line arg, so
            # GNU treats it as a minor problem (exit 1).
            warnings.append(
                LsWarning(
                    f"ls: cannot access '{spell(entry.rstrip('/'))}': "
                    f"{strerror_of(exc)}",
                    False,
                )
            )
            continue
        if not all_files and s.name.startswith("."):
            continue
        if deref and stat_needed and s.type is FileType.SYMLINK:
            # -L reports what each link leads to; one leading nowhere is
            # listed by name and reported, a minor problem (exit 1), where
            # the listing stats an entry at all.
            warnings.append(
                LsWarning(
                    f"ls: cannot access '{spell(entry.rstrip('/'))}': "
                    f"{posix_phrase(FsCondition.ENOENT)}",
                    False,
                )
            )
        stats.append(s)
    seen = {s.name for s in stats}
    for name in child_mounts(path.virtual) if child_mounts is not None else []:
        if name in seen:
            continue
        if not all_files and name.startswith("."):
            continue
        if ignored(ignore, name):
            continue
        seen.add(name)
        stats.append(await _mount_row(path, name, stat_path))
    return stats, warnings


async def probe_operand(
    path: PathSpec,
    *,
    readdir: ReaddirFn,
    stat: StatFn,
    all_files: bool = False,
    sort_by: LsSortBy = LsSortBy.NAME,
    reverse: bool = False,
    command_line_arg: bool = True,
    links: LinkView | None = None,
    deref: bool = False,
    follow_args: bool = False,
    child_mounts: ChildMounts | None = None,
    stat_path: StatPath | None = None,
    time_kind: LsTimeKind = LsTimeKind.MTIME,
    group_dirs_first: bool = False,
    stat_needed: bool = True,
    quote: Quote | None = None,
    spell: Callable[[str], str] | None = None,
    budget: WalkBudget | None = None,
    ignore: Sequence[str] = (),
) -> tuple[Operand, list[LsWarning]]:
    """List one directory and report whether it turned out to be one.

    Args:
        path (PathSpec): the operand to list.
        readdir (ReaddirFn): backend directory lister.
        stat (StatFn): backend stat.
        all_files (bool): keep dotfiles.
        sort_by (LsSortBy): active sort key.
        reverse (bool): reverse the sort.
        command_line_arg (bool): False below an operand, where GNU downgrades
            a failure to a minor problem (exit 1).
        links (LinkView | None): the namespace's symlink facts.
        deref (bool): ``-L``, report what a listed link leads to.
        follow_args (bool): the command line's links were resolved on
            request (``-L``, ``-H``), so one that loops is an error
            rather than a link to list.
        child_mounts (ChildMounts | None): session-filtered child-mount
            names, merged into every listing: a mountpoint is an
            ordinary directory entry of its parent, ``-R`` or not.
        stat_path (StatPath | None): dispatcher-backed stat, for the
            child-mount rows no backend can supply.
        time_kind (LsTimeKind): which timestamp ``-t`` compares.
        group_dirs_first (bool): ``--group-directories-first``.
        stat_needed (bool): report an entry whose stat failed. See
            ``stat_needed``.
        quote (Quote | None): how a name prints, for
            ``--sort=width``; None for as it is.
        spell (Callable[[str], str] | None): a path below the operand as
            the operand spelled it; None at the operand itself.
        budget (WalkBudget | None): under ``-R``, the entries the walk
            may still list; a directory past it is listed in its parent
            but not opened.
        ignore (Sequence[str]): the patterns a listed name is left out
            by.
    """
    if spell is None:
        spell = functools.partial(
            respell_one, original=path.virtual, raw=path.raw_path
        )
    own_stat = functools.partial(followed_stat, stat, links if deref else None)
    warnings: list[LsWarning] = []
    structure_only = False
    if path.walk_error is None and (command_line_arg or not deref):
        # The table's readdir opens what a link leads to, as opendir(3)
        # does, so a link the line left unresolved is asked first: the
        # router already resolved every one this ls follows.
        link_row = _link_row(path, links)
        if link_row is not None:
            return Operand(path, link_row, []), warnings
    limit = None if budget is None else budget.listing_limit(path.virtual)
    try:
        names = await (
            readdir(path) if limit is None else readdir(path, limit=limit)
        )
    except (OSError, ValueError) as exc:
        if isinstance(exc, DotWalkError):
            # The operand did not resolve, so neither the path it
            # simplifies to nor the names the namespace owes it answer.
            # A command-line link whose stat loops is the exception: GNU
            # lstats it then and lists the link itself, unless -L or -H
            # asked for the target (coreutils 9.7).
            if (
                isinstance(exc, DotWalkLoop)
                and command_line_arg
                and not follow_args
            ):
                link_row = _link_row(path, links)
                if link_row is not None:
                    return Operand(path, link_row, []), warnings
            refusal = LsWarning(
                f"ls: cannot access '{path.raw_path}': {fs_strerror(exc)}",
                command_line_arg,
            )
            if command_line_arg:
                warnings.append(refusal)
                return Operand(path, None, []), warnings
            return Operand(path, None, [], ((0, refusal),)), warnings
        found: FileStat | None = None
        refused: str | None = None
        try:
            found = await _operand_stat(path, own_stat)
        except OSError as stat_exc:
            refused = _err_text(stat_exc)
        if found is not None and found.type != FileType.DIRECTORY:
            return Operand(path, _as_operand(found, path), []), warnings
        if (
            # A directory the session may not open is refused whole: the
            # names the namespace owes it (a link in it, a mount below it)
            # are as much its listing as the backend's are.
            isinstance(exc, PermissionError)
            or child_mounts is None
            or not child_mounts(path.virtual)
        ):
            # GNU 9.7 stats an operand before it opens one: a stat that
            # fails is what it names, and a directory it may not read is
            # worded apart, the entry being there.
            reason = _err_text(exc) if refused is None else refused
            verb = (
                "cannot open directory"
                if found is not None and isinstance(exc, PermissionError)
                else "cannot access"
            )
            refusal = LsWarning(
                f"ls: {verb} '{path.raw_path}': {reason}", command_line_arg
            )
            if command_line_arg and verb == "cannot access":
                warnings.append(refusal)
                return Operand(path, None, []), warnings
            # A directory that is there but will not open is reported
            # where its listing would have printed (GNU 9.7).
            return Operand(path, None, [], ((0, refusal),)), warnings
        # No backend serves it, but the namespace owes it children (a
        # nested mount, a link's ancestors), so the dispatcher lists it as a
        # directory and ls must agree: the merge below renders those
        # rows from an empty backend listing.
        names = []
        structure_only = True

    if not names and not structure_only:
        try:
            row = await _file_entry(path, own_stat)
        except OSError as refusal:
            logger.debug(
                "ls: %s listed empty, its stat refused: %s",
                path.virtual,
                refusal,
            )
            row = None
        if row is not None:
            return Operand(path, row, []), warnings

    if budget is not None:
        names = [name for name in names if budget.spend(path.virtual)]
    entries, entry_ws = await _stat_entries(
        path,
        names,
        stat=stat,
        all_files=all_files,
        links=links,
        deref=deref,
        child_mounts=child_mounts,
        stat_path=stat_path,
        stat_needed=stat_needed,
        spell=spell,
        ignore=ignore,
    )
    warnings.extend(entry_ws)
    entries = sort_stats(
        entries,
        sort_by,
        reverse,
        time_kind=time_kind,
        group_dirs_first=group_dirs_first,
        quote=quote,
    )
    return Operand(path, None, [(path, entries)]), warnings


async def _operand_row(
    path: PathSpec,
    stat: StatFn,
    links: LinkView | None,
    child_mounts: ChildMounts | None,
) -> FileStat | LsWarning:
    """The row ``ls -d`` prints for one operand, or why it cannot.

    Args:
        path (PathSpec): the operand to stat.
        stat (StatFn): backend stat.
        links (LinkView | None): the namespace's symlink facts.
        child_mounts (ChildMounts | None): session-filtered child-mount
            names, which make a path no backend serves a directory.
    """
    link_row = _link_row(path, links)
    if link_row is not None:
        return link_row
    try:
        listed = await stat(path)
    except (OSError, ValueError) as exc:
        if (
            not isinstance(exc, DotWalkError)
            and child_mounts is not None
            and child_mounts(path.virtual)
        ):
            # No backend serves it, but the namespace owes it
            # children, so the dispatcher stats it as a directory and -d
            # must print the same row.
            return FileStat(name=path.raw_path, type=FileType.DIRECTORY)
        return LsWarning(
            f"ls: cannot access '{path.raw_path}': {_err_text(exc)}", True
        )
    # GNU ls -d prints the operand as given.
    return replace(listed, name=path.raw_path)


async def _operand_key(
    operand: Operand,
    *,
    sort_by: LsSortBy,
    stat: StatFn,
) -> FileStat:
    """Sort row for one operand, named with the operand's own spelling."""
    if operand.row is not None:
        return operand.row
    if sort_by is LsSortBy.NAME:
        return FileStat(name=operand.path.raw_path, type=FileType.DIRECTORY)
    try:
        s = await stat(operand.path)
    except (OSError, ValueError):
        # The stat only supplies a sort key; an operand that cannot be
        # statted sorts as if it had none rather than failing the listing.
        return FileStat(name=operand.path.raw_path, type=FileType.DIRECTORY)
    return replace(s, name=operand.path.raw_path)


async def _sort_operands(
    operands: list[Operand],
    *,
    sort_by: LsSortBy,
    reverse: bool,
    stat: StatFn,
    time_kind: LsTimeKind = LsTimeKind.MTIME,
    quote: Quote | None = None,
) -> list[Operand]:
    keys = [
        await _operand_key(o, sort_by=sort_by, stat=stat) for o in operands
    ]
    return [
        operands[i]
        for i in _order_rows(
            keys, sort_by, reverse, time_kind=time_kind, quote=quote
        )
    ]


def _hyperlinked(name: str, virtual: str) -> str:
    """A name wrapped in the OSC 8 hyperlink GNU emits under
    ``--hyperlink``, pointing at the entry's virtual path.

    Args:
        name (str): the name as rendered.
        virtual (str): the entry's absolute virtual path.
    """
    return f"\x1b]8;;file://{uri_escape(virtual)}\x07{name}\x1b]8;;\x07"


URI_SAFE = frozenset(string.ascii_letters + string.digits + "~_-./")


def uri_escape(path: str) -> str:
    """Percent-encode a path for a ``file:`` URI the way GNU ls does:
    every byte outside the unreserved set and ``/`` is ``%xx`` in
    lowercase hex, so a space, ``?`` or ``#`` cannot end the path.

    Args:
        path (str): the absolute virtual path.
    """
    return "".join(
        c if c in URI_SAFE else "".join(f"%{b:02x}" for b in c.encode())
        for c in path
    )


def _decorated_names(
    entries: list[FileStat],
    hrefs: list[str] | None,
    long: bool,
    quote: Quote | None,
    align: bool,
) -> list[str] | None:
    """The name column quoted, lined up and hyperlinked, None when every
    name prints as it is.

    Where ``align`` asks and a name of the group is quoted, every bare one
    takes a space before it, so the names line up past the opening
    quotes. A lined-up name keeps its quotes outside its hyperlink;
    any other name is linked whole, quotes and all.

    Args:
        entries (list[FileStat]): the rows.
        hrefs (list[str] | None): each row's virtual path, when linking.
        long (bool): whether the long format's ``-> target`` applies.
        quote (Quote | None): how a name or a link target
            prints; None for as it is.
        align (bool): the quoting style and format line bare names up.
    """
    if hrefs is None and quote is None:
        return None
    quoted = [e.name if quote is None else quote(e.name) for e in entries]
    opened = [quote is not None and q.startswith(_QUOTES) for q in quoted]
    spaced = align and any(opened)
    out: list[str] = []
    for i, e in enumerate(entries):
        name = quoted[i]
        if hrefs is not None:
            name = (
                name[0] + _hyperlinked(name[1:-1], hrefs[i]) + name[-1]
                if spaced and opened[i]
                else _hyperlinked(name, hrefs[i])
            )
        if spaced and not opened[i]:
            name = " " + name
        target = e.extra.get(LINK_TARGET_KEY)
        if long and e.type is FileType.SYMLINK and isinstance(target, str):
            name += " -> " + (target if quote is None else quote(target))
        out.append(name)
    return out


def stat_needed(
    *,
    long: bool,
    sort_by: LsSortBy,
    columns: formatting.LsColumns,
    hyperlink: bool,
    recursive: bool,
    indicator: LsIndicator,
    group_dirs_first: bool,
) -> bool:
    """Whether GNU's ls would stat a listed entry to print this listing.

    That is when a failed stat reaches stderr: the long format, a time
    or size sort, ``-i``, ``-s``, ``-Z`` and ``--hyperlink`` read the stat,
    and ``-R``, ``-F`` and ``--group-directories-first`` read the type,
    which a mirage listing never carries, as a readdir without d_type
    does not. A plain listing prints the names readdir gave and nothing
    else. Mirrors TS ``statNeeded``.

    Args:
        long (bool): the long format (``-l``, ``-g``, ``-o``, ``-n``).
        sort_by (LsSortBy): the active sort key.
        columns (formatting.LsColumns): ``-i``, ``-s`` and ``-Z`` ride
            here.
        hyperlink (bool): ``--hyperlink``.
        recursive (bool): ``-R``.
        indicator (LsIndicator): the indicator style, which reads the
            type whatever the style.
        group_dirs_first (bool): ``--group-directories-first``.
    """
    return (
        long
        or sort_by in (LsSortBy.TIME, LsSortBy.SIZE)
        or columns.inode
        or columns.blocks
        or columns.context
        or hyperlink
        or recursive
        or indicator is not LsIndicator.NONE
        or group_dirs_first
    )


def _render_group(
    results: list[str],
    entries: list[FileStat],
    *,
    layout: LsFormat,
    human: bool,
    indicator: LsIndicator,
    identity: Identity | None,
    columns: formatting.LsColumns,
    quote: Quote | None,
    align: bool,
    width: int | None,
    tabsize: int,
    hrefs: list[str] | None = None,
    targets: list[FileStat | None] | None = None,
) -> None:
    long = layout is LsFormat.VERBOSE
    names = _decorated_names(entries, hrefs, long, quote, align)
    if long:
        results.extend(
            formatting.format_ls_long(
                entries,
                human=human,
                identity=identity,
                columns=columns,
                names=long_names(
                    entries, names, indicator, targets or [None] * len(entries)
                ),
            )
        )
    else:
        rows = format_simple(
            entries, indicator=indicator, columns=columns, names=names
        )
        results.extend(laid_out(rows, layout, width, tabsize))


def _finish(
    results: list[str], warnings: list[LsWarning], notices: Sequence[str]
) -> tuple[ByteSource, IOResult]:
    """The listing, with what GNU reports before it said on ``io`` first.

    Args:
        results (list[str]): the listing's lines.
        warnings (list[LsWarning]): reported before the listing.
        notices (Sequence[str]): stderr lines that come first of all.
    """
    out = format_records(results)
    io = IOResult(exit_code=exit_status_for(warnings))
    lines = [*notices, *(w.message for w in warnings)]
    if not out:
        io.stderr = format_optional_records(lines)
        return out, io
    notes = [(0, format_records(lines))] if lines else []
    return at_offsets(out, notes, io), io


async def ls(
    paths: list[PathSpec],
    *,
    readdir: ReaddirFn,
    stat: StatFn,
    layout: LsFormat = LsFormat.SINGLE_COLUMN,
    all_files: bool = False,
    show_dot_entries: bool = False,
    human: bool = False,
    sort_by: LsSortBy = LsSortBy.NAME,
    reverse: bool = False,
    recursive: bool = False,
    list_dir: bool = False,
    indicator: LsIndicator = LsIndicator.NONE,
    links: LinkView | None = None,
    deref: bool = False,
    follow_args: bool = False,
    child_mounts: ChildMounts | None = None,
    mounts: MountView | None = None,
    stat_path: StatPath | None = None,
    identity: Identity | None = None,
    time_kind: LsTimeKind = LsTimeKind.MTIME,
    group_dirs_first: bool = False,
    columns: formatting.LsColumns = formatting.DEFAULT_COLUMNS,
    quoting: str = "literal",
    hide_control: bool = False,
    hyperlink: bool = False,
    width: int | None = LINE_WIDTH,
    tabsize: int = TAB_SIZE,
    ignore: Sequence[str] = (),
    notices: Sequence[str] = (),
) -> tuple[ByteSource, IOResult]:
    results: list[str] = []
    warnings: list[LsWarning] = []
    long = layout is LsFormat.VERBOSE
    quote = (
        None
        if quoting == "literal" and not hide_control
        else functools.partial(quote_name, style=quoting, hide=hide_control)
    )
    render = functools.partial(
        _render_group,
        results,
        layout=layout,
        human=human,
        indicator=indicator,
        identity=identity,
        columns=columns,
        quote=quote,
        align=quoting in _ALIGNED_STYLES and layout in _ALIGNED_LAYOUTS,
        width=width,
        tabsize=tabsize,
    )

    if list_dir:
        # -d turns every operand into a plain row, sorted together and
        # printed with no headers.
        rows: list[FileStat] = []
        row_hrefs: list[str] = []
        for p in paths:
            row = await _operand_row(p, stat, links, child_mounts)
            if isinstance(row, LsWarning):
                warnings.append(row)
                continue
            rows.append(row)
            row_hrefs.append(p.virtual)
        if len(rows) > 1:
            order = _order_rows(
                rows,
                sort_by,
                reverse,
                time_kind=time_kind,
                group_dirs_first=group_dirs_first,
                quote=quote,
            )
            rows = [rows[i] for i in order]
            row_hrefs = [row_hrefs[i] for i in order]
        render(
            rows,
            hrefs=row_hrefs if hyperlink else None,
            targets=await link_targets(
                rows, row_hrefs, links, long, indicator
            ),
        )
        return _finish(results, warnings, notices)

    needed = stat_needed(
        long=long,
        sort_by=sort_by,
        columns=columns,
        hyperlink=hyperlink,
        recursive=recursive,
        indicator=indicator,
        group_dirs_first=group_dirs_first,
    )
    probe = functools.partial(
        probe_operand,
        readdir=readdir,
        stat=stat,
        all_files=all_files,
        sort_by=sort_by,
        reverse=reverse,
        links=links,
        deref=deref,
        follow_args=follow_args,
        child_mounts=child_mounts,
        stat_path=stat_path,
        time_kind=time_kind,
        group_dirs_first=group_dirs_first,
        stat_needed=needed,
        quote=quote,
        ignore=ignore,
    )
    operands: list[Operand] = []
    budgets: dict[int, WalkBudget] = {}
    for p in paths:
        budget = WalkBudget(p, mounts) if recursive else None
        operand, p_ws = await probe(p, budget=budget)
        warnings.extend(p_ws)
        if budget is not None:
            budgets[id(operand)] = budget
        operands.append(operand)
    if len(operands) > 1:
        operands = await _sort_operands(
            operands,
            sort_by=sort_by,
            reverse=reverse,
            stat=stat,
            time_kind=time_kind,
            quote=quote,
        )

    async def below(
        path: PathSpec,
        entries: list[FileStat],
        chain: tuple[str, ...],
        spell: Callable[[str], str],
        budget: WalkBudget | None,
    ) -> AsyncIterator[tuple[PathSpec, list[FileStat]] | LsWarning]:
        # -R lists each directory below an operand as the walk reaches it,
        # in pre-order, so a reader that stops early stops the walk; what
        # the walk reports goes out where the walk meets it.
        real = links.resolve if deref and links is not None else None
        if real is not None and not chain:
            chain = (real(path.virtual),)
        for entry in entries:
            if entry.type != FileType.DIRECTORY:
                continue
            child_path = _child_spec(path, entry.name)
            if mounts is not None and mounts.is_root(child_path.virtual):
                # A nested mount's root. Its row belongs here, but its
                # listing is another backend's, which this walk cannot
                # read: the cross-mount fan-out renders that group.
                continue
            if budget is not None and not budget.opens(child_path.virtual):
                continue
            under = chain
            if real is not None:
                # Under -L a directory is the one it resolves to, and one
                # open above this one is never listed again (exit 2).
                here = real(child_path.virtual)
                if here in chain:
                    yield LsWarning(
                        f"ls: {spell(child_path.virtual)}: "
                        "not listing already-listed directory",
                        True,
                    )
                    continue
                under = (*chain, here)
            child, child_ws = await probe(
                child_path,
                command_line_arg=False,
                spell=spell,
                budget=budget,
            )
            for warning in (*child_ws, *(note for _, note in child.notes)):
                yield warning
            for dir_spec, listed in child.groups:
                yield dir_spec, listed
                async for item in below(
                    dir_spec, listed, under, spell, budget
                ):
                    yield item

    finished: set[int] = set()

    async def groups(
        operand: Operand,
    ) -> AsyncIterator[tuple[PathSpec, list[FileStat]] | LsWarning]:
        spell = functools.partial(
            respell_one,
            original=operand.path.virtual,
            raw=operand.path.raw_path,
        )
        budget = budgets.get(id(operand))
        for _, note in operand.notes:
            yield note
        for dir_spec, entries in operand.groups:
            yield dir_spec, entries
            if recursive:
                async for item in below(dir_spec, entries, (), spell, budget):
                    yield item
        if budget is not None:
            for line in budget.stopped:
                yield LsWarning(f"ls: {line}", False)
        finished.add(id(operand))

    async def with_dots(
        dir_spec: PathSpec, entries: list[FileStat], found: list[LsWarning]
    ) -> list[FileStat]:
        dots = []
        prefix = mount_prefix_of(dir_spec.virtual, dir_spec.vfs_path)
        for name in (".", ".."):
            if ignored(ignore, name):
                continue
            target = posixpath.normpath(posixpath.join(dir_spec.virtual, name))
            row = FileStat(name=name, type=FileType.DIRECTORY)
            # Only the namespace can stat a parent outside this mount;
            # otherwise keep the synthetic directory row.
            if needed and (
                stat_path is not None or under_path(target, prefix)
            ):
                try:
                    if stat_path is not None:
                        found_row = await stat_path(target)
                    else:
                        found_row = await stat(
                            PathSpec(
                                virtual=target,
                                directory=target,
                                vfs_path=rekey(
                                    dir_spec.virtual,
                                    dir_spec.vfs_path,
                                    target,
                                ),
                            ),
                        )
                    if found_row is not None:
                        row = replace(found_row, name=name)
                except (OSError, ValueError) as exc:
                    logger.debug("ls: stat %s: %r", target, exc)
                    row = _stat_failed_row(name)
                    found.append(
                        LsWarning(
                            f"ls: cannot access '{name}': {_err_text(exc)}",
                            False,
                        )
                    )
            dots.append(row)
        return sort_stats(
            dots + entries,
            sort_by,
            reverse,
            time_kind=time_kind,
            group_dirs_first=group_dirs_first,
            quote=quote,
        )

    async def pieces() -> AsyncGenerator[bytes | LsWarning, None]:
        # The listing a block at a time, each warning the walk meets
        # between the blocks it falls between.
        # ls names every listed directory once there is more than one
        # operand (or under -R); a lone directory operand is listed bare.
        headed = recursive or len(paths) > 1
        rows = [o.row for o in operands if o.row is not None]
        row_paths = [o.path.virtual for o in operands if o.row is not None]
        render(
            rows,
            hrefs=row_paths if hyperlink else None,
            targets=await link_targets(
                rows, row_paths, links, long, indicator
            ),
        )
        printed = bool(rows)
        if results:
            yield format_records(results)
            results.clear()
        for operand in operands:
            async for item in groups(operand):
                if isinstance(item, LsWarning):
                    yield item
                    continue
                dir_spec, entries = item
                if show_dot_entries:
                    found: list[LsWarning] = []
                    entries = await with_dots(dir_spec, entries, found)
                    for warning in found:
                        yield warning
                if headed:
                    if printed:
                        results.append("")
                    header = respell_one(
                        dir_spec.virtual,
                        operand.path.virtual,
                        operand.path.raw_path,
                    )
                    results.append(
                        f"{header if quote is None else quote(header)}:"
                    )
                # ls prints allocated blocks here; VFS has no allocation
                # metadata, so report unknown instead of inventing a block
                # count.
                if long or columns.blocks:
                    results.append("total ?" if entries else "total 0")
                entry_paths = [
                    posixpath.join(dir_spec.virtual, e.name) for e in entries
                ]
                render(
                    entries,
                    hrefs=entry_paths if hyperlink else None,
                    targets=await link_targets(
                        entries, entry_paths, links, long, indicator
                    ),
                )
                printed = True
                if results:
                    yield format_records(results)
                    results.clear()

    # GNU looks at every operand before it lists one, so what that found
    # goes first; the rest goes where the walk met it.
    reported = list(warnings)
    pending = [*notices, *(w.message for w in warnings)]
    if recursive:
        io = IOResult()

        async def stream() -> AsyncIterator[bytes]:
            try:
                async with aclosing(pieces()) as walked:
                    async for piece in walked:
                        if isinstance(piece, LsWarning):
                            reported.append(piece)
                            pending.append(piece.message)
                            continue
                        if pending:
                            await say(io, format_records(pending))
                            pending.clear()
                        yield piece
            finally:
                # A reader that stops early still gets what was found for
                # the operands it never finished, after what it read.
                seen = {id(warning) for warning in reported}
                for operand in operands:
                    if id(operand) in finished:
                        continue
                    budget = budgets.get(id(operand))
                    stopped = budget.stopped if budget is not None else ()
                    for warning in (
                        *(note for _, note in operand.notes),
                        *(LsWarning(f"ls: {line}", False) for line in stopped),
                    ):
                        if id(warning) not in seen:
                            seen.add(id(warning))
                            reported.append(warning)
                            pending.append(warning.message)
                if pending:
                    await say(io, format_records(pending))
                io.exit_code = exit_status_for(reported)

        return stream(), io
    body: list[bytes] = []
    notes: list[tuple[int, bytes]] = []
    offset = 0
    async for piece in pieces():
        if isinstance(piece, LsWarning):
            reported.append(piece)
            pending.append(piece.message)
            continue
        if pending:
            notes.append((offset, format_records(pending)))
            pending.clear()
        body.append(piece)
        offset += len(piece)
    out = b"".join(body)
    io = IOResult(exit_code=exit_status_for(reported))
    if not out:
        io.stderr = format_optional_records(pending)
        return out, io
    if pending:
        notes.append((offset, format_records(pending)))
    return at_offsets(out, notes, io), io


async def ls_generic(
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
    readdir: ReaddirFn,
    stat: StatFn,
    options: Mapping[str, Any] | None = None,
) -> tuple[ByteSource, IOResult]:
    """Run ls over resolved operands, GNU semantics; mirrors lsGeneric.

    The wiring resolves globs, defaults the operands from the cwd, and
    binds the backend ops (including the stat overlay); flag semantics
    live here, and the namespace facts (links, child mounts), the
    and the identity the owner columns render ride ``ctx``. GNU looks at
    every operand before it lists one, so what it reports comes before
    what it lists (``ls d missing 2>&1``), all but a directory it does
    not list (one that will not open, one ``-L`` already listed),
    reported where that listing would have printed.

    Args:
        paths (list[PathSpec]): Glob-resolved operands, cwd-defaulted.
        texts (list[str]): Non-path words, unused by ls.
        ctx (Context): Flags and namespace facts from the
            dispatcher.
        readdir (ReaddirFn): Bound readdir called as ``readdir(p)``.
        stat (StatFn): Bound (overlaid) stat called as ``stat(p)``.
        options (Mapping[str, Any] | None): ``ls_options`` the caller read
            before it resolved the operands; None reads them here.
    """
    return await ls(
        paths,
        readdir=readdir,
        stat=stat,
        links=links_of(ctx),
        child_mounts=(
            functools.partial(owed_names, ctx.vfs)
            if ctx.vfs is not None
            else None
        ),
        mounts=mounts_of(ctx),
        stat_path=vfs_stat_path(ctx.vfs),
        identity=identity_of(ctx),
        **(ls_options(ctx.flags, ctx.env) if options is None else options),
    )


__all__ = [
    "LS_FAILURE",
    "LS_MINOR_PROBLEM",
    "LS_OK",
    "LsWarning",
    "Operand",
    "exit_status_for",
    "facts",
    "format_simple",
    "ignored",
    "laid_out",
    "ls",
    "ls_generic",
    "probe_operand",
    "sort_stats",
]
