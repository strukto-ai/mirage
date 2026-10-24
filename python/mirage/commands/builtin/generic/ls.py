import functools
import logging
import posixpath
import string
import sys
from collections import deque
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass, fields
from typing import Any

from mirage.commands.builtin.generic.sort import stream_config
from mirage.commands.builtin.sort_keys import Key, KeyMods, SortConfig
from mirage.commands.builtin.utils import formatting
from mirage.commands.builtin.utils.identity import Identity, identity_of
from mirage.commands.builtin.utils.links import (
    links_of,
    mounts_of,
    owed_names,
)
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
from mirage.commands.spec.usage import (
    usage_hint,
    word_refusal_error,
    word_refusal_line,
)
from mirage.commands.spec.word_choice import (
    WordMatch,
    WordRefusalKind,
    match_word,
)
from mirage.errors.classify import failure_text, is_entry_error
from mirage.errors.constants import MISS_ERRORS
from mirage.errors.fs import fs_strerror
from mirage.errors.posix import posix_phrase
from mirage.errors.types import DotWalkError, DotWalkLoop, FsCondition
from mirage.io.types import IOResult
from mirage.rs import open_stream
from mirage.types import (
    LINK_TARGET_KEY,
    FileStat,
    FileType,
    JsonValue,
    LsIndicator,
    LsLinkMode,
    LsSortBy,
    LsTimeKind,
    PathSpec,
)
from mirage.utils.key_prefix import mount_prefix_of, rekey, under_path
from mirage.utils.path import respell_one
from mirage.utils.quote import escape_name
from mirage.utils.stat_view import content_size
from mirage.utils.width import char_width
from mirage.view.namespace_view import followed_stat
from mirage.view.types import ChildMounts, LinkView, MountView, StatPath

logger = logging.getLogger(__name__)

Readdir = Callable[[PathSpec], Awaitable[list[str]]]
Stat = Callable[[PathSpec], Awaitable[FileStat]]

LS_OK = 0
LS_MINOR_PROBLEM = 1
LS_FAILURE = 2


@dataclass(frozen=True, slots=True)
class LsFlags:
    long: bool = False
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
    escape: bool = False
    hyperlink: bool = False


# The words GNU 9.7's `--sort` takes, in the order `ls --sort=x` lists them
# back. 9.7 added `name`, the order no `--sort` at all means, so
# `--sort=n` is ambiguous between it and `none`.
_SORT_WORDS = {
    "none": LsSortBy.NONE,
    "size": LsSortBy.SIZE,
    "time": LsSortBy.TIME,
    "version": LsSortBy.VERSION,
    "extension": LsSortBy.EXTENSION,
    "name": LsSortBy.NAME,
    "width": LsSortBy.WIDTH,
}
_SORT_FLAGS = {
    "t": LsSortBy.TIME,
    "S": LsSortBy.SIZE,
    "X": LsSortBy.EXTENSION,
    "v": LsSortBy.VERSION,
    "U": LsSortBy.NONE,
}
_TIME_GROUPS = (
    ("atime", "access", "use"),
    ("ctime", "status"),
    ("mtime", "modification"),
    ("birth", "creation"),
)
_TIME_KINDS = {
    "atime": LsTimeKind.ATIME,
    "ctime": LsTimeKind.CTIME,
    "mtime": LsTimeKind.MTIME,
    "birth": LsTimeKind.BIRTH,
}
# GNU's `when` words, shared by --hyperlink and --classify.
_WHEN_GROUPS = (
    ("always", "yes", "force"),
    ("never", "no", "none"),
    ("auto", "tty", "if-tty"),
)
_INDICATOR_GROUPS = tuple((style.value,) for style in LsIndicator)
# The four spellings of an indicator style; the last one typed wins.
_INDICATOR_DESTS = ("classify", "file_type", "p", "indicator_style")
# The three spellings of a command-line link policy; the last one wins.
_DEREF_DESTS = (
    "dereference",
    "dereference_command_line",
    "dereference_command_line_symlink_to_dir",
)


def _grouped_argument_error(
    option: str,
    value: str,
    groups: tuple[tuple[str, ...], ...],
    kind: WordRefusalKind,
) -> UsageError:
    """The refusal of an ambiguous or invalid choice word for an option
    whose values have aliases, the valid words listed one group per line
    (``--time``, ``--hyperlink``); exit 1, as GNU 9.7's ls answers it.

    Args:
        option (str): the option's long spelling.
        value (str): the rejected value, as typed; the shared renderer
            escapes it.
        groups (tuple[tuple[str, ...], ...]): the valid values, aliases
            grouped.
        kind (WordRefusalKind): the wording the match answered with --
            ``ls --hyperlink=a`` spans three values and is ambiguous,
            ``--hyperlink=zzz`` spans none and is invalid.
    """
    return word_refusal_error("ls", option, value, groups, 1, kind)


_WORD_OPTIONS: dict[str, tuple[str, tuple[tuple[str, ...], ...]]] = {
    "sort": ("--sort", tuple((word,) for word in _SORT_WORDS)),
    "time": ("--time", _TIME_GROUPS),
    "hyperlink": ("--hyperlink", _WHEN_GROUPS),
    "color": ("--color", _WHEN_GROUPS),
    "classify": ("--classify", _WHEN_GROUPS),
    "indicator_style": ("--indicator-style", _INDICATOR_GROUPS),
}


def _check_option_words(fl: FlagView) -> None:
    """Refuse a bad option value where GNU does: while it reads the line.

    GNU checks each value inside its getopt loop, so the first bad one
    typed is the one it names, and a later good value of the same option
    does not rescue an earlier bad one (coreutils 9.7: ``ls --sort=bogus
    --sort=size`` and ``ls --time=x --sort=y`` both refuse, the second
    naming ``--time``). ``--time-style`` is the exception: GNU reads only
    its last value, after the loop.

    Args:
        fl (FlagView): the ls flag view.
    """
    for dest, value in fl.occurrences(*_WORD_OPTIONS, "block_size"):
        if value is True:
            continue
        word = str(value)
        if dest == "block_size":
            parsed = formatting.parse_block_size(word)
            if isinstance(parsed, formatting.BlockSizeRefusal):
                raise UsageError(_block_size_error(word, parsed), 2)
            continue
        option, groups = _WORD_OPTIONS[dest]
        match = match_word(word, groups)
        if not isinstance(match, WordMatch):
            raise _grouped_argument_error(option, word, groups, match.kind)


def _sort_flag(fl: FlagView) -> tuple[LsSortBy, bool]:
    """The sort key the line asked for, last spelling winning, and
    whether it asked at all.

    Args:
        fl (FlagView): the ls flag view.
    """
    typed = fl.typed_order("t", "S", "X", "v", "U", "sort")
    if not typed:
        return LsSortBy.NAME, False
    last = typed[-1]
    if last != "sort":
        return _SORT_FLAGS[last], True
    word = fl.as_str("sort") or ""
    words = tuple(_SORT_WORDS)
    match = match_word(word, words)
    if not isinstance(match, WordMatch):
        raise word_refusal_error("ls", "--sort", word, words, 1, match.kind)
    return _SORT_WORDS[match.word], True


def _time_flag(fl: FlagView) -> LsTimeKind:
    """Which timestamp ``-c``, ``-u`` or ``--time`` asked for, last one
    winning.

    Args:
        fl (FlagView): the ls flag view.
    """
    typed = fl.typed_order("c", "u", "time")
    if not typed:
        return LsTimeKind.MTIME
    last = typed[-1]
    if last == "c":
        return LsTimeKind.CTIME
    if last == "u":
        return LsTimeKind.ATIME
    word = fl.as_str("time") or ""
    match = match_word(word, _TIME_GROUPS)
    if not isinstance(match, WordMatch):
        raise _grouped_argument_error("--time", word, _TIME_GROUPS, match.kind)
    return _TIME_KINDS[match.word]


def _time_style_flag(fl: FlagView) -> str:
    """``--time-style``, validated the way GNU words it (exit 2).

    A ``posix-`` prefix short-circuits the whole option: GNU's loop
    strips each one and, outside a hard LC_TIME locale, jumps straight
    to the locale style without looking at what follows. mirage has no
    other locale, so every ``posix-`` spelling is the locale style and
    none of them is ever refused -- measured on coreutils 9.4, where
    ``posix-full-iso``, ``posix-l``, ``posix-zzz``, ``posix-`` and
    ``posix-+%H:%M`` all exit 0 and all print what ``locale`` prints.
    The matcher therefore has to run after that check, not before: the
    remainder is not a candidate word at all.

    Args:
        fl (FlagView): the ls flag view.
    """
    style = fl.as_str("time_style")
    if style is None:
        return "locale"
    if style.startswith("posix-"):
        return "locale"
    if style.startswith("+"):
        return style
    match = match_word(style, formatting.LS_TIME_STYLES)
    if isinstance(match, WordMatch):
        return match.word
    # GNU 9.7 lists the styles as patterns here, so it is the one such
    # refusal in the repo whose candidates are neither quoted nor a subset
    # of the words it accepts -- and the one that exits 2, as `ls -l
    # --time-style=x` does. The first line is still the usual one, so
    # `--time-style=lo` spans long-iso and locale and reads `ambiguous
    # argument 'lo'`.
    raise UsageError(
        f"{word_refusal_line('ls', 'time style', style, match.kind)}\n"
        "Valid arguments are:\n"
        "  - [posix-]full-iso\n"
        "  - [posix-]long-iso\n"
        "  - [posix-]iso\n"
        "  - [posix-]locale\n"
        "  - +FORMAT (e.g., +%H:%M) for a 'date'-style format\n"
        f"{usage_hint('ls')}",
        2,
    )


def _hyperlink_flag(fl: FlagView) -> bool:
    """Whether ``--hyperlink`` asked for OSC 8 links: ``always`` does,
    ``never`` does not, and ``auto`` does not either, since command
    output here is never a terminal.

    Args:
        fl (FlagView): the ls flag view.
    """
    raw = fl.raw("hyperlink")
    if raw is None or raw is False:
        return False
    if raw is True:
        return True
    word = str(raw)
    match = match_word(word, _WHEN_GROUPS)
    if not isinstance(match, WordMatch):
        raise _grouped_argument_error(
            "--hyperlink", word, _WHEN_GROUPS, match.kind
        )
    return match.word == "always"


def _indicator_word(dest: str, raw: FlagValue) -> LsIndicator:
    """The style one indicator option asks for, checked as GNU checks it.

    ``-F`` and a bare ``--classify`` classify; ``--classify=WHEN`` does
    for ``always`` and never otherwise, since output here is never a
    terminal. An ambiguous or invalid choice word is refused with the
    valid words listed, exit 1.

    Args:
        dest (str): one of the indicator options' dests.
        raw (FlagValue): the value this occurrence was typed with.
    """
    if dest == "p":
        return LsIndicator.SLASH
    if dest == "file_type":
        return LsIndicator.FILE_TYPE
    if dest == "classify" and raw is True:
        return LsIndicator.CLASSIFY
    word = str(raw)
    option = "--classify" if dest == "classify" else "--indicator-style"
    groups = _WHEN_GROUPS if dest == "classify" else _INDICATOR_GROUPS
    match = match_word(word, groups)
    if not isinstance(match, WordMatch):
        raise _grouped_argument_error(option, word, groups, match.kind)
    if dest == "indicator_style":
        return LsIndicator(match.word)
    return (
        LsIndicator.CLASSIFY if match.word == "always" else (LsIndicator.NONE)
    )


def indicator_flag(fl: FlagView) -> LsIndicator:
    """The indicator style a line asks for.

    The last of ``-F``/``--classify[=WHEN]``, ``-p``, ``--file-type`` and
    ``--indicator-style`` wins, and every one is checked on the way, as
    GNU checks each value while it reads the options (coreutils 9.7).

    Args:
        fl (FlagView): the ls flag view.
    """
    style = LsIndicator.NONE
    for dest, raw in fl.occurrences(*_INDICATOR_DESTS):
        style = _indicator_word(dest, raw)
    return style


def link_mode(fl: FlagView) -> LsLinkMode:
    """Which command-line links GNU ls resolves before it lists them.

    GNU settles it once: the last of ``-L``, ``-H`` and
    ``--dereference-command-line-symlink-to-dir`` wins, and with none of
    them ``-d``, a long format or the classify style resolve no link
    while anything else resolves one that leads to a directory
    (coreutils 9.7). A value the command refuses leaves the style
    unclassified, since that line fails before it lists anything.

    Args:
        fl (FlagView): the ls flag view.
    """
    typed = fl.typed_order(*_DEREF_DESTS)
    if typed:
        return (
            LsLinkMode.DIRECTORY
            if typed[-1] == "dereference_command_line_symlink_to_dir"
            else LsLinkMode.ALL
        )
    long = any(
        fl.as_bool(dest) for dest in ("args_l", "g", "o", "numeric_uid_gid")
    )
    try:
        classify = indicator_flag(fl) is LsIndicator.CLASSIFY
    except UsageError as exc:
        logger.debug("ls: the command refuses this line itself: %s", exc)
        classify = False
    if fl.as_bool("directory") or long or classify:
        return LsLinkMode.NONE
    return LsLinkMode.DIRECTORY


def _block_size_error(text: str, refusal: formatting.BlockSizeRefusal) -> str:
    """GNU's three ``--block-size`` refusals, worded as ls words them.

    Measured on coreutils 9.7: ``ls: invalid --block-size argument
    'x'``, ``ls: invalid suffix in --block-size argument '1x'`` and
    ``ls: --block-size argument '99999999999999999999' too large``. The
    word is quoted but NOT escaped, where a bad ``--sort`` word is both:
    ``ls --block-size=1é`` reports the two UTF-8 bytes intact, and
    ``ls --sort=é`` prints ``'\\303\\251'``.

    Args:
        text (str): the option value as typed.
        refusal (BlockSizeRefusal): which failure the parser reported.
    """
    quoted = f"'{text}'"
    if refusal is formatting.BlockSizeRefusal.TOO_LARGE:
        return f"ls: --block-size argument {quoted} too large"
    if refusal is formatting.BlockSizeRefusal.INVALID_SUFFIX:
        return f"ls: invalid suffix in --block-size argument {quoted}"
    return f"ls: invalid --block-size argument {quoted}"


def parse_flags(flags: Mapping[str, FlagValue]) -> LsFlags:
    """Parse the ls flag bag once into a frozen struct.

    GNU's rules that are easy to get wrong: ``-g``, ``-o`` and ``-n``
    imply the long format, and ``-1`` never undoes it in either order
    (GNU ignores ``-1`` beside ``-l``, and with no terminal there are
    never columns, so ``-1`` has nothing else to do); ``-n`` prints the
    same columns as ``-l``,
    because a mirage owner is already the id (an agent, a profile) and
    never a name looked up from one; the last of ``-t``, ``-S``, ``-X``,
    ``-v``, ``-U`` and ``--sort`` wins, as does the last of ``-c``, ``-u``
    and ``--time``; and ``-c`` or ``-u`` with neither ``-l`` nor a sort
    sorts by that time; and the later of ``-h`` and ``--block-size``
    wins. Raises ``UsageError`` for a value GNU refuses, with GNU's
    exit status for that option.

    Args:
        flags (Mapping[str, FlagValue]): flags for the shared ls spec.
    """
    fl = FlagView(flags, spec=SPECS["ls"])
    _check_option_words(fl)
    sort_by, sorted_explicitly = _sort_flag(fl)
    time_kind = _time_flag(fl)
    no_owner = fl.as_bool("g")
    no_group = fl.as_bool("o")
    long = (
        fl.as_bool("args_l")
        or no_owner
        or no_group
        or fl.as_bool("numeric_uid_gid")
    )
    if (
        not sorted_explicitly
        and time_kind is not LsTimeKind.MTIME
        and not long
    ):
        sort_by = LsSortBy.TIME
    block = None
    block_text = fl.as_str("block_size")
    if block_text is not None:
        parsed_block = formatting.parse_block_size(block_text)
        if isinstance(parsed_block, formatting.BlockSizeRefusal):
            raise UsageError(_block_size_error(block_text, parsed_block), 2)
        block = parsed_block
        # The later of -h and --block-size wins (GNU: `--block-size=1 -h`
        # prints 1.5K, `-h --block-size=1` prints 1536); the value is
        # still checked either way.
        if (
            fl.typed_order("human_readable", "block_size")[-1]
            == "human_readable"
        ):
            block = None
    columns = formatting.LsColumns(
        owner=not no_owner,
        group=not no_group,
        inode=fl.as_bool("inode"),
        context=fl.as_bool("context"),
        time_kind=time_kind,
        time_style=_time_style_flag(fl),
        block_size=block,
    )
    return LsFlags(
        long=long,
        all_files=fl.as_bool("all") or fl.as_bool("almost_all"),
        show_dot_entries=fl.as_bool("all"),
        human=fl.as_bool("human_readable"),
        sort_by=sort_by,
        reverse=fl.as_bool("reverse"),
        recursive=fl.as_bool("recursive"),
        list_dir=fl.as_bool("directory"),
        indicator=indicator_flag(fl),
        # -L alone dereferences what a listing finds; -H and its sibling
        # stop at the command line, and the last of the three wins.
        deref=fl.typed_order(*_DEREF_DESTS)[-1:] == ["dereference"],
        follow_args=link_mode(fl) is LsLinkMode.ALL,
        time_kind=time_kind,
        group_dirs_first=fl.as_bool("group_directories_first"),
        columns=columns,
        hyperlink=_hyperlink_flag(fl),
        escape=fl.as_bool("escape"),
    )


def ls_options(flags: Mapping[str, FlagValue]) -> dict[str, Any]:
    """Parsed ls flags as the generic's own keyword arguments.

    ``LsFlags`` names every field after the ``ls`` parameter it feeds,
    so both entry points -- the single-mount ``ls_generic`` and the
    cross-mount relay -- share one mapping instead of restating it. A
    shallow view, so the nested column struct rides through whole.

    Args:
        flags (Mapping[str, FlagValue]): Flags for the shared ls spec.
    """
    parsed = parse_flags(flags)
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
    first, as one block with no header. ``groups`` holds one
    ``(dir, entries)`` pair per directory listed under the operand — one
    for a plain listing, the whole pre-order subtree under ``-R``. Both
    empty means the operand could not be accessed.
    """

    path: PathSpec
    row: FileStat | None
    groups: list[tuple[PathSpec, list[FileStat]]]


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
_VERSION_SORT: dict[str, JsonValue] = {
    **stream_config(
        SortConfig(
            keys=(Key(1, 1, False, None, None, False, KeyMods(version=True)),),
            field_sep=None,
            reverse=False,
            unique=False,
            stable=False,
        ),
        zero_terminated=True,
    ),
    "mode": "sort",
    "run_bytes": sys.maxsize,
}


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
    stream = open_stream("sort", _VERSION_SORT)
    out = bytearray(stream.feed(bytes(records)))
    out += stream.finish()
    while stream.busy():
        out += stream.drain()
    return [places[raw].popleft() for raw in bytes(out).split(b"\0")[:-1]]


def name_width(name: str) -> int:
    """The columns a name occupies, the key ``--sort=width`` compares:
    GNU measures the rendered width, so a wide character counts two
    and a combining mark none.

    Args:
        name (str): the entry name.
    """
    return sum(char_width(ch) for ch in name)


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
    escape: bool = False,
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
                key=lambda i: name_width(
                    escape_name(rows[i].name) if escape else rows[i].name
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
    escape: bool = False,
) -> list[FileStat]:
    return [
        entries[i]
        for i in _order_rows(
            entries,
            sort_by,
            reverse,
            time_kind=time_kind,
            group_dirs_first=group_dirs_first,
            escape=escape,
        )
    ]


async def _file_entry(
    path: PathSpec,
    stat: Stat,
) -> FileStat | None:
    """The row of an operand that is no directory, None for a directory
    or a path nothing is at.

    Raises:
        OSError: when its stat fails other than by absence.
    """
    try:
        s = await stat(path)
    except MISS_ERRORS:
        return None
    if s.type == FileType.DIRECTORY:
        return None
    # GNU ls prints a file operand as given (`ls sub/x.txt` shows
    # sub/x.txt, not x.txt); the row carries the operand spelling.
    return s.model_copy(update={"name": path.raw_path})


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
    return row.model_copy(update={"name": path.raw_path})


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
            return row.model_copy(update={"name": name})
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
    stat: Stat,
    all_files: bool,
    links: LinkView | None = None,
    deref: bool = False,
    child_mounts: ChildMounts | None = None,
    stat_path: StatPath | None = None,
    stat_needed: bool = True,
    spell: Callable[[str], str] = str,
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
        stat (Stat): backend stat.
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
    """
    stats: list[FileStat] = []
    warnings: list[LsWarning] = []
    entry_stat = functools.partial(
        followed_stat, stat, links if deref else None
    )
    for entry in names:
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
                    f"{failure_text(exc)}",
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
        seen.add(name)
        stats.append(await _mount_row(path, name, stat_path))
    return stats, warnings


async def probe_operand(
    path: PathSpec,
    *,
    readdir: Readdir,
    stat: Stat,
    all_files: bool = False,
    sort_by: LsSortBy = LsSortBy.NAME,
    reverse: bool = False,
    recursive: bool = False,
    command_line_arg: bool = True,
    links: LinkView | None = None,
    deref: bool = False,
    follow_args: bool = False,
    child_mounts: ChildMounts | None = None,
    mounts: MountView | None = None,
    stat_path: StatPath | None = None,
    time_kind: LsTimeKind = LsTimeKind.MTIME,
    group_dirs_first: bool = False,
    stat_needed: bool = True,
    escape: bool = False,
    chain: tuple[str, ...] = (),
    spell: Callable[[str], str] | None = None,
    budget: WalkBudget | None = None,
) -> tuple[Operand, list[LsWarning]]:
    """List one operand and report whether it turned out to be a directory.

    Args:
        path (PathSpec): the operand to list.
        readdir (Readdir): backend directory lister.
        stat (Stat): backend stat.
        all_files (bool): keep dotfiles.
        sort_by (LsSortBy): active sort key.
        reverse (bool): reverse the sort.
        recursive (bool): descend, emitting one group per directory (-R).
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
        mounts (MountView | None): the mount boundaries this walk's
            ``readdir`` cannot cross. Under ``-R`` such a root is listed
            but never descended, because that listing is another
            backend's and the cross-mount fan-out assembles the group;
            a namespace-only directory *above* one is descended, since
            no other run renders it. None for a walk that can cross --
            the relay's readdir routes per path, so it descends a
            nested mount itself.
        stat_path (StatPath | None): dispatcher-backed stat, for the
            child-mount rows no backend can supply.
        time_kind (LsTimeKind): which timestamp ``-t`` compares.
        group_dirs_first (bool): ``--group-directories-first``.
        stat_needed (bool): report an entry whose stat failed. See
            ``stat_needed``.
        chain (tuple[str, ...]): under ``-RL``, the directories open
            above this one, each as the path it resolves to.
        spell (Callable[[str], str] | None): a path below the operand as
            the operand spelled it; None at the operand itself.
        budget (WalkBudget | None): under ``-R``, the entries the walk
            may still list; a directory past it is listed in its parent
            but not opened.
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
    try:
        names = await readdir(path)
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
            warnings.append(
                LsWarning(
                    f"ls: cannot access '{path.raw_path}': {fs_strerror(exc)}",
                    command_line_arg,
                )
            )
            return Operand(path, None, []), warnings
        refused: OSError | None = None
        try:
            row = await _file_entry(path, own_stat)
        except OSError as stat_exc:
            row, refused = None, stat_exc
        if row is not None:
            return Operand(path, row, []), warnings
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
            failed = exc if refused is None else refused
            verb = (
                "cannot open directory"
                if refused is None and isinstance(exc, PermissionError)
                else "cannot access"
            )
            warnings.append(
                LsWarning(
                    f"ls: {verb} '{path.raw_path}': "
                    f"{fs_strerror(failed) or failed}",
                    command_line_arg,
                )
            )
            return Operand(path, None, []), warnings
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
    )
    warnings.extend(entry_ws)
    entries = sort_stats(
        entries,
        sort_by,
        reverse,
        time_kind=time_kind,
        group_dirs_first=group_dirs_first,
        escape=escape,
    )
    groups: list[tuple[PathSpec, list[FileStat]]] = [(path, entries)]
    if recursive:
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
            below = chain
            if real is not None:
                # Under -L a directory is the one it resolves to, and one
                # open above this one is never listed again (exit 2).
                here = real(child_path.virtual)
                if here in chain:
                    warnings.append(
                        LsWarning(
                            f"ls: {spell(child_path.virtual)}: "
                            "not listing already-listed directory",
                            True,
                        )
                    )
                    continue
                below = (*chain, here)
            child, child_ws = await probe_operand(
                child_path,
                readdir=readdir,
                stat=stat,
                all_files=all_files,
                sort_by=sort_by,
                reverse=reverse,
                recursive=True,
                command_line_arg=False,
                links=links,
                deref=deref,
                child_mounts=child_mounts,
                mounts=mounts,
                stat_path=stat_path,
                time_kind=time_kind,
                group_dirs_first=group_dirs_first,
                stat_needed=stat_needed,
                escape=escape,
                chain=below,
                spell=spell,
                budget=budget,
            )
            groups.extend(child.groups)
            warnings.extend(child_ws)
    return Operand(path, None, groups), warnings


async def _operand_row(
    path: PathSpec,
    stat: Stat,
    links: LinkView | None,
    child_mounts: ChildMounts | None,
) -> FileStat | LsWarning:
    """The row ``ls -d`` prints for one operand, or why it cannot.

    Args:
        path (PathSpec): the operand to stat.
        stat (Stat): backend stat.
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
        detail = fs_strerror(exc) or exc
        return LsWarning(
            f"ls: cannot access '{path.raw_path}': {detail}", True
        )
    # GNU ls -d prints the operand as given.
    return listed.model_copy(update={"name": path.raw_path})


async def _operand_key(
    operand: Operand,
    *,
    sort_by: LsSortBy,
    stat: Stat,
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
    return s.model_copy(update={"name": operand.path.raw_path})


async def _sort_operands(
    operands: list[Operand],
    *,
    sort_by: LsSortBy,
    reverse: bool,
    stat: Stat,
    time_kind: LsTimeKind = LsTimeKind.MTIME,
    escape: bool = False,
) -> list[Operand]:
    keys = [
        await _operand_key(o, sort_by=sort_by, stat=stat) for o in operands
    ]
    return [
        operands[i]
        for i in _order_rows(
            keys, sort_by, reverse, time_kind=time_kind, escape=escape
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
    entries: list[FileStat], hrefs: list[str] | None, long: bool, escape: bool
) -> list[str] | None:
    """The name column with escapes and hyperlinks, None when undecorated.

    Args:
        entries (list[FileStat]): the rows.
        hrefs (list[str] | None): each row's virtual path, when linking.
        long (bool): whether the long format's ``-> target`` applies.
        escape (bool): render names and targets with GNU ``-b`` escapes.
    """
    if hrefs is None and not escape:
        return None
    out: list[str] = []
    for i, e in enumerate(entries):
        name = escape_name(e.name) if escape else e.name
        if hrefs is not None:
            name = _hyperlinked(name, hrefs[i])
        target = e.extra.get(LINK_TARGET_KEY)
        if long and e.type is FileType.SYMLINK and isinstance(target, str):
            name += " -> " + (escape_name(target) if escape else target)
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
    or size sort, ``-i``, ``-Z`` and ``--hyperlink`` read the stat,
    and ``-R``, ``-F`` and ``--group-directories-first`` read the type,
    which a mirage listing never carries, as a readdir without d_type
    does not. A plain listing prints the names readdir gave and nothing
    else. Mirrors TS ``statNeeded``.

    Args:
        long (bool): the long format (``-l``, ``-g``, ``-o``, ``-n``).
        sort_by (LsSortBy): the active sort key.
        columns (formatting.LsColumns): ``-i`` and ``-Z`` ride here.
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
    long: bool,
    human: bool,
    indicator: LsIndicator,
    identity: Identity | None,
    columns: formatting.LsColumns = formatting.DEFAULT_COLUMNS,
    escape: bool = False,
    hrefs: list[str] | None = None,
    targets: list[FileStat | None] | None = None,
) -> None:
    names = _decorated_names(entries, hrefs, long, escape)
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
        results.extend(
            format_simple(
                entries, indicator=indicator, columns=columns, names=names
            )
        )


def _finish(
    results: list[str], warnings: list[LsWarning]
) -> tuple[bytes, IOResult]:
    stderr = format_optional_records([w.message for w in warnings])
    return format_records(results), IOResult(
        stderr=stderr, exit_code=exit_status_for(warnings)
    )


async def ls(
    paths: list[PathSpec],
    *,
    readdir: Readdir,
    stat: Stat,
    long: bool = False,
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
    escape: bool = False,
    hyperlink: bool = False,
) -> tuple[bytes, IOResult]:
    results: list[str] = []
    warnings: list[LsWarning] = []

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
                escape=escape,
            )
            rows = [rows[i] for i in order]
            row_hrefs = [row_hrefs[i] for i in order]
        _render_group(
            results,
            rows,
            long=long,
            human=human,
            indicator=indicator,
            identity=identity,
            columns=columns,
            escape=escape,
            hrefs=row_hrefs if hyperlink else None,
            targets=await link_targets(
                rows, row_hrefs, links, long, indicator
            ),
        )
        return _finish(results, warnings)

    needed = stat_needed(
        long=long,
        sort_by=sort_by,
        columns=columns,
        hyperlink=hyperlink,
        recursive=recursive,
        indicator=indicator,
        group_dirs_first=group_dirs_first,
    )
    operands: list[Operand] = []
    for p in paths:
        budget = WalkBudget(p, mounts) if recursive else None
        operand, p_ws = await probe_operand(
            p,
            readdir=readdir,
            stat=stat,
            all_files=all_files,
            sort_by=sort_by,
            reverse=reverse,
            recursive=recursive,
            links=links,
            deref=deref,
            follow_args=follow_args,
            child_mounts=child_mounts,
            mounts=mounts,
            stat_path=stat_path,
            time_kind=time_kind,
            group_dirs_first=group_dirs_first,
            stat_needed=needed,
            escape=escape,
            budget=budget,
        )
        warnings.extend(p_ws)
        if budget is not None:
            warnings.extend(
                LsWarning(f"ls: {line}", False) for line in budget.stopped
            )
        operands.append(operand)
    if len(operands) > 1:
        operands = await _sort_operands(
            operands,
            sort_by=sort_by,
            reverse=reverse,
            stat=stat,
            time_kind=time_kind,
            escape=escape,
        )

    # GNU names every listed directory once there is more than one operand
    # (or under -R); a lone directory operand is listed bare.
    headed = recursive or len(paths) > 1
    rows = [o.row for o in operands if o.row is not None]
    row_paths = [o.path.virtual for o in operands if o.row is not None]
    _render_group(
        results,
        rows,
        long=long,
        human=human,
        indicator=indicator,
        identity=identity,
        columns=columns,
        escape=escape,
        hrefs=row_paths if hyperlink else None,
        targets=await link_targets(rows, row_paths, links, long, indicator),
    )
    printed = bool(rows)
    for operand in operands:
        for dir_spec, entries in operand.groups:
            if show_dot_entries:
                dots = []
                prefix = mount_prefix_of(dir_spec.virtual, dir_spec.vfs_path)
                for name in (".", ".."):
                    target = posixpath.normpath(
                        posixpath.join(dir_spec.virtual, name)
                    )
                    row = FileStat(name=name, type=FileType.DIRECTORY)
                    # Only the namespace can stat a parent outside this
                    # mount; otherwise keep the synthetic directory row.
                    if needed and (
                        stat_path is not None or under_path(target, prefix)
                    ):
                        try:
                            if stat_path is not None:
                                found = await stat_path(target)
                            else:
                                found = await stat(
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
                            if found is not None:
                                row = found.model_copy(update={"name": name})
                        except (OSError, ValueError) as exc:
                            logger.debug("ls: stat %s: %r", target, exc)
                            row = _stat_failed_row(name)
                            warnings.append(
                                LsWarning(
                                    f"ls: cannot access '{name}': "
                                    f"{fs_strerror(exc) or exc}",
                                    False,
                                )
                            )
                    dots.append(row)
                entries = sort_stats(
                    dots + entries,
                    sort_by,
                    reverse,
                    time_kind=time_kind,
                    group_dirs_first=group_dirs_first,
                    escape=escape,
                )
            if headed:
                if printed:
                    results.append("")
                header = respell_one(
                    dir_spec.virtual,
                    operand.path.virtual,
                    operand.path.raw_path,
                )
                results.append(f"{escape_name(header) if escape else header}:")
            # GNU 9.7 prints allocated blocks here; VFS has no allocation
            # metadata, so report unknown instead of inventing a block count.
            if long:
                results.append("total ?" if entries else "total 0")
            entry_paths = [
                posixpath.join(dir_spec.virtual, e.name) for e in entries
            ]
            _render_group(
                results,
                entries,
                long=long,
                human=human,
                indicator=indicator,
                identity=identity,
                columns=columns,
                escape=escape,
                hrefs=entry_paths if hyperlink else None,
                targets=await link_targets(
                    entries, entry_paths, links, long, indicator
                ),
            )
            printed = True

    return _finish(results, warnings)


async def ls_generic(
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
    readdir: Readdir,
    stat: Stat,
) -> tuple[bytes, IOResult]:
    """Run ls over resolved operands, GNU semantics; mirrors lsGeneric.

    The wiring resolves globs, defaults the operands from the cwd, and
    binds the backend ops (including the stat overlay); flag semantics
    live here, and the namespace facts (links, child mounts), the
    and the identity the owner columns render ride ``ctx``.

    Args:
        paths (list[PathSpec]): Glob-resolved operands, cwd-defaulted.
        texts (list[str]): Non-path words, unused by ls.
        ctx (Context): Flags and namespace facts from the
            dispatcher.
        readdir (Readdir): Bound readdir called as ``readdir(p)``.
        stat (Stat): Bound (overlaid) stat called as ``stat(p)``.
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
        **ls_options(ctx.flags),
    )


__all__ = [
    "LS_FAILURE",
    "LS_MINOR_PROBLEM",
    "LS_OK",
    "LsWarning",
    "Operand",
    "exit_status_for",
    "format_simple",
    "ls",
    "ls_generic",
    "probe_operand",
    "sort_stats",
]
