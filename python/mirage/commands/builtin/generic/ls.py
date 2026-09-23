import functools
import posixpath
import string
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, field, fields
from typing import Any

from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.commands.builtin.utils import formatting
from mirage.commands.builtin.utils.identity import Identity, identity_of
from mirage.commands.builtin.utils.output import (format_optional_records,
                                                  format_records)
from mirage.commands.config import CommandOpts
from mirage.commands.errors import UsageError
from mirage.commands.spec import SPECS
from mirage.commands.spec.argmatch import ArgmatchKind, ArgmatchMatch, argmatch
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import FlagValue
from mirage.commands.spec.usage import (argmatch_error, argmatch_line,
                                        usage_hint)
from mirage.io.types import IOResult
from mirage.ops.types import ChildMounts, LinkView, MountView, StatPath
from mirage.types import FileStat, FileType, LsSortBy, LsTimeKind, PathSpec
from mirage.utils.errors import fs_strerror
from mirage.utils.key_prefix import rekey
from mirage.utils.path import CycleError, respell_one
from mirage.utils.width import char_width

Readdir = Callable[[PathSpec, IndexCacheStore | None], Awaitable[list[str]]]
Stat = Callable[[PathSpec, IndexCacheStore | None], Awaitable[FileStat]]

LS_OK = 0
LS_MINOR_PROBLEM = 1
LS_FAILURE = 2


@dataclass(frozen=True, slots=True)
class LsFlags:
    long: bool = False
    all_files: bool = False
    human: bool = False
    sort_by: LsSortBy = LsSortBy.NAME
    reverse: bool = False
    recursive: bool = False
    list_dir: bool = False
    classify: bool = False
    deref: bool = False
    time_kind: LsTimeKind = LsTimeKind.MTIME
    group_dirs_first: bool = False
    columns: formatting.LsColumns = formatting.DEFAULT_COLUMNS
    hyperlink: bool = False


# GNU's own `sort_args`, in its own order, which is what `--sort=x`
# lists back. `name` is deliberately absent: coreutils 9.4 refuses
# `ls --sort=name` (name order is what no `--sort` at all means), and a
# word mirage accepted but GNU did not was also a word missing from the
# list GNU prints.
_SORT_WORDS = {
    "none": LsSortBy.NONE,
    "time": LsSortBy.TIME,
    "size": LsSortBy.SIZE,
    "extension": LsSortBy.EXTENSION,
    "version": LsSortBy.VERSION,
    "width": LsSortBy.WIDTH,
}
_SORT_FLAGS = {
    "t": LsSortBy.TIME,
    "S": LsSortBy.SIZE,
    "X": LsSortBy.EXTENSION,
    "v": LsSortBy.VERSION,
    "U": LsSortBy.NONE,
}
_TIME_GROUPS = (("atime", "access", "use"), ("ctime", "status"),
                ("mtime", "modification"), ("birth", "creation"))
_TIME_KINDS = {
    "atime": LsTimeKind.ATIME,
    "ctime": LsTimeKind.CTIME,
    "mtime": LsTimeKind.MTIME,
    "birth": LsTimeKind.BIRTH,
}
_HYPERLINK_GROUPS = (("always", "yes", "force"), ("never", "no", "none"),
                     ("auto", "tty", "if-tty"))


def _grouped_argument_error(option: str, value: str,
                            groups: tuple[tuple[str, ...], ...],
                            kind: ArgmatchKind) -> UsageError:
    """GNU's ARGMATCH refusal for an option whose values have aliases,
    listed one group per line (``--time``, ``--hyperlink``); exit 1, as
    ls answers it.

    Args:
        option (str): the option's long spelling.
        value (str): the rejected value, as typed; the shared renderer
            escapes it.
        groups (tuple[tuple[str, ...], ...]): the valid values, aliases
            grouped.
        kind (ArgmatchKind): the wording the match answered with --
            ``ls --hyperlink=a`` spans three values and is ambiguous,
            ``--hyperlink=zzz`` spans none and is invalid.
    """
    return argmatch_error("ls", option, value, groups, 1, kind)


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
    match = argmatch(word, words)
    if not isinstance(match, ArgmatchMatch):
        raise argmatch_error("ls", "--sort", word, words, 1, match.kind)
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
    match = argmatch(word, _TIME_GROUPS)
    if not isinstance(match, ArgmatchMatch):
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
    match = argmatch(style, formatting.LS_TIME_STYLES)
    if isinstance(match, ArgmatchMatch):
        return match.word
    # ls hand-writes this block rather than letting argmatch print
    # `time_style_args`, so it is the one ARGMATCH refusal in the repo
    # whose candidates are neither quoted nor a subset of the words it
    # accepts -- and the one that exits 2, ls's own `usage (LS_FAILURE)`.
    # The first line is still argmatch's, so `--time-style=lo` spans
    # long-iso and locale and reads `ambiguous argument 'lo'`.
    raise UsageError(
        f"{argmatch_line('ls', 'time style', style, match.kind)}\n"
        "Valid arguments are:\n"
        "  - [posix-]full-iso\n"
        "  - [posix-]long-iso\n"
        "  - [posix-]iso\n"
        "  - [posix-]locale\n"
        "  - +FORMAT (e.g., +%H:%M) for a 'date'-style format\n"
        f"{usage_hint('ls')}", 2)


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
    match = argmatch(word, _HYPERLINK_GROUPS)
    if not isinstance(match, ArgmatchMatch):
        raise _grouped_argument_error("--hyperlink", word, _HYPERLINK_GROUPS,
                                      match.kind)
    return match.word == "always"


def _block_size_error(text: str, refusal: formatting.BlockSizeRefusal) -> str:
    """GNU's three ``--block-size`` refusals, worded as ls words them.

    Measured on coreutils 9.7: ``ls: invalid --block-size argument
    'x'``, ``ls: invalid suffix in --block-size argument '1x'`` and
    ``ls: --block-size argument '99999999999999999999' too large``. The
    word is quoted but NOT escaped, which is GNU's own split (xstrtol's
    fatal path prints the argument as is, where argmatch's runs it
    through ``quote()``): ``ls --block-size=1é`` reports the two UTF-8
    bytes intact.

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
    sort_by, sorted_explicitly = _sort_flag(fl)
    time_kind = _time_flag(fl)
    no_owner = fl.as_bool("g")
    no_group = fl.as_bool("o")
    long = (fl.as_bool("args_l") or no_owner or no_group
            or fl.as_bool("numeric_uid_gid"))
    if (not sorted_explicitly and time_kind is not LsTimeKind.MTIME
            and not long):
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
        if fl.typed_order("human_readable",
                          "block_size")[-1] == "human_readable":
            block = None
    columns = formatting.LsColumns(owner=not no_owner,
                                   group=not no_group,
                                   inode=fl.as_bool("inode"),
                                   context=fl.as_bool("context"),
                                   time_kind=time_kind,
                                   time_style=_time_style_flag(fl),
                                   block_size=block)
    return LsFlags(
        long=long,
        all_files=fl.as_bool("all") or fl.as_bool("almost_all"),
        human=fl.as_bool("human_readable"),
        sort_by=sort_by,
        reverse=fl.as_bool("reverse"),
        recursive=fl.as_bool("recursive"),
        list_dir=fl.as_bool("directory"),
        classify=fl.as_bool("classify"),
        deref=fl.as_bool("dereference"),
        time_kind=time_kind,
        group_dirs_first=fl.as_bool("group_directories_first"),
        columns=columns,
        hyperlink=_hyperlink_flag(fl),
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


@dataclass(frozen=True, slots=True)
class WalkResult:
    """Outcome of listing one directory.

    Args:
        entries (list[FileStat]): The stats to render for this directory.
        warnings (list[LsWarning]): Diagnostics collected at or below this
            directory.
        listed (bool): False when the directory itself could not be opened, so
            callers skip emitting a `dir:` header for it.
    """

    entries: list[FileStat] = field(default_factory=list)
    warnings: list[LsWarning] = field(default_factory=list)
    listed: bool = True


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


# GNU -F suffixes: a directory gets "/", a symlink "@". The link mark
# rides the row's type, so it needs no separate lookup.
_CLASSIFY_SUFFIX = {FileType.DIRECTORY: "/", FileType.SYMLINK: "@"}


def format_simple(entries: list[FileStat],
                  *,
                  classify: bool = False,
                  columns: formatting.LsColumns = formatting.DEFAULT_COLUMNS,
                  names: list[str] | None = None) -> list[str]:
    """Short rows: the name, ``-F``'s mark, and ``-i``/``-Z``'s lead.

    Args:
        entries (list[FileStat]): the rows.
        classify (bool): ``-F``.
        columns (formatting.LsColumns): the requested columns.
        names (list[str] | None): the name per row when the caller
            decorated it (``--hyperlink``), else the row's own.
    """
    lead = formatting.ls_prefix(columns)
    out: list[str] = []
    for i, e in enumerate(entries):
        suffix = ""
        if classify and e.type is not None:
            suffix = _CLASSIFY_SUFFIX.get(e.type, "")
        out.append(lead + (names[i] if names is not None else e.name) + suffix)
    return out


def _is_digit(c: int) -> bool:
    """Whether a byte is an ASCII digit.

    Args:
        c (int): one byte.
    """
    return 0x30 <= c <= 0x39


def _is_alpha(c: int) -> bool:
    """Whether a byte is an ASCII letter.

    Args:
        c (int): one byte.
    """
    return 0x41 <= c <= 0x5A or 0x61 <= c <= 0x7A


def _version_order(c: int) -> int:
    """gnulib ``filevercmp``'s byte order: a tilde sorts before the end
    of the string, ASCII letters by code, and every other byte after the
    letters. gnulib classifies in the C locale one byte at a time, so a
    multibyte letter such as ``é`` is two bytes past the letters, not a
    letter.

    Args:
        c (int): one byte.
    """
    if _is_digit(c):
        return 0
    if _is_alpha(c):
        return c
    if c == 0x7E:
        return -1
    return c + 256


def _verrevcmp(a: bytes, b: bytes) -> int:
    """Debian's version comparison as gnulib's ``verrevcmp`` runs it:
    alternating non-digit and digit runs, the digit runs compared as
    numbers.

    Args:
        a (bytes): left operand.
        b (bytes): right operand.
    """
    i = j = 0
    while i < len(a) or j < len(b):
        while ((i < len(a) and not _is_digit(a[i]))
               or (j < len(b) and not _is_digit(b[j]))):
            ac = _version_order(a[i]) if i < len(a) else 0
            bc = _version_order(b[j]) if j < len(b) else 0
            if ac != bc:
                return ac - bc
            i += 1
            j += 1
        while i < len(a) and a[i] == 0x30:
            i += 1
        while j < len(b) and b[j] == 0x30:
            j += 1
        first_diff = 0
        while (i < len(a) and j < len(b) and _is_digit(a[i])
               and _is_digit(b[j])):
            if not first_diff:
                first_diff = a[i] - b[j]
            i += 1
            j += 1
        if i < len(a) and _is_digit(a[i]):
            return 1
        if j < len(b) and _is_digit(b[j]):
            return -1
        if first_diff:
            return first_diff
    return 0


def _version_prefix_len(s: bytes) -> int:
    """How much of a name ``filevercmp`` compares first: everything but
    a trailing run of suffixes (``.txt``, ``.tar.gz``, ``~``).

    Args:
        s (bytes): the name.
    """
    n = len(s)
    i = 0
    prefix = 0
    while True:
        if i == n:
            return prefix
        i += 1
        prefix = i
        while i + 1 < n and s[i] == 0x2E and (_is_alpha(s[i + 1])
                                              or s[i + 1] == 0x7E):
            i += 2
            while i < n and (_is_alpha(s[i]) or _is_digit(s[i])
                             or s[i] == 0x7E):
                i += 1


def filevercmp(a: str, b: str) -> int:
    """gnulib's ``filevercmp``, the order behind ``ls -v``: the empty
    name, ``.`` and ``..`` first, then hidden names, then the names
    compared as versions with their suffixes set aside, the suffixes
    breaking a tie. The comparison runs over the names' UTF-8 bytes,
    which is what GNU sees; a lone surrogate maps back to the byte it
    was decoded from.

    Args:
        a (str): left name.
        b (str): right name.
    """
    if a == b:
        return 0
    for special in ("", ".", ".."):
        if a == special:
            return -1
        if b == special:
            return 1
    a_hidden, b_hidden = a.startswith("."), b.startswith(".")
    if a_hidden != b_hidden:
        return -1 if a_hidden else 1
    ab = a.encode("utf-8", "surrogateescape")
    bb = b.encode("utf-8", "surrogateescape")
    result = _verrevcmp(ab[:_version_prefix_len(ab)],
                        bb[:_version_prefix_len(bb)])
    if result == 0:
        result = _verrevcmp(ab, bb)
    if result == 0:
        result = (ab > bb) - (ab < bb)
    return result


def name_width(name: str) -> int:
    """The columns a name occupies, the key ``--sort=width`` compares:
    GNU measures the rendered width, so a wide character counts two
    and a combining mark none.

    Args:
        name (str): the entry name.
    """
    return sum(char_width(ch) for ch in name)


def _extension(name: str) -> str:
    """The key ``ls -X`` compares first: the name from its last dot,
    empty for a name without one.

    Args:
        name (str): the entry name.
    """
    dot = name.rfind(".")
    return name[dot:] if dot >= 0 else ""


def _primary_value(entry: FileStat, sort_by: LsSortBy,
                   time_kind: LsTimeKind) -> str | int:
    if sort_by is LsSortBy.TIME:
        return formatting.time_of(entry, time_kind) or ""
    if sort_by is LsSortBy.SIZE:
        return entry.size or 0
    return entry.name


def _order_rows(rows: list[FileStat],
                sort_by: LsSortBy,
                reverse: bool,
                *,
                time_kind: LsTimeKind = LsTimeKind.MTIME,
                group_dirs_first: bool = False) -> list[int]:
    """Indices of ``rows`` in GNU ls order.

    GNU's `-t`/`-S` comparators fall back to the name when the timestamps or
    sizes tie, and `-r` negates the whole comparison, tie-break included. A
    stable name sort followed by the primary key reproduces the first half;
    reversing the finished order reproduces the second. `-X` and
    `--sort=width` are stable sorts over the name order too; `-v` is
    gnulib's version order; `-U` keeps the listing order, and `-r` does
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

        def by_version(i: int, j: int) -> int:
            return filevercmp(rows[i].name, rows[j].name)

        order = sorted(range(len(rows)), key=functools.cmp_to_key(by_version))
    else:
        order = sorted(range(len(rows)), key=lambda i: rows[i].name)
        if sort_by is LsSortBy.EXTENSION:
            order.sort(key=lambda i: _extension(rows[i].name))
        elif sort_by is LsSortBy.WIDTH:
            order.sort(key=lambda i: name_width(rows[i].name))
        elif sort_by is not LsSortBy.NAME:
            # -t and -S list newest/largest first.
            order.sort(
                key=lambda i: _primary_value(rows[i], sort_by, time_kind),
                reverse=True)
    if reverse and sort_by is not LsSortBy.NONE:
        order.reverse()
    if group_dirs_first and sort_by is not LsSortBy.NONE:
        order = ([i for i in order if rows[i].type is FileType.DIRECTORY] +
                 [i for i in order if rows[i].type is not FileType.DIRECTORY])
    return order


def sort_stats(entries: list[FileStat],
               sort_by: LsSortBy,
               reverse: bool,
               *,
               time_kind: LsTimeKind = LsTimeKind.MTIME,
               group_dirs_first: bool = False) -> list[FileStat]:
    return [
        entries[i] for i in _order_rows(entries,
                                        sort_by,
                                        reverse,
                                        time_kind=time_kind,
                                        group_dirs_first=group_dirs_first)
    ]


async def _file_entry(
    path: PathSpec,
    stat: Stat,
    index: IndexCacheStore,
) -> FileStat | None:
    try:
        s = await stat(path, index)
    except (OSError, ValueError):
        return None
    if s.type == FileType.DIRECTORY:
        return None
    # GNU ls prints a file operand as given (`ls sub/x.txt` shows
    # sub/x.txt, not x.txt); the row carries the operand spelling.
    return s.model_copy(update={"name": path.raw_path})


async def _deref_entry(
    directory: PathSpec,
    link: FileStat,
    links: LinkView,
    stat: Stat,
    index: IndexCacheStore,
) -> FileStat | None:
    """The target's stat for a link child under -L, or None if unreadable.

    GNU ``ls -L`` reports the referenced file while keeping the link's
    own name, so a dangling link falls back to the link row rather than
    dropping out of the listing.

    Args:
        directory (PathSpec): the directory being listed.
        link (FileStat): the link's own row, whose name is kept.
        links (LinkView): the namespace's symlink facts.
        stat (Stat): backend stat.
        index (IndexCacheStore): listing cache.
    """
    child = directory.virtual.rstrip("/") + "/" + link.name
    try:
        target = links.resolve(child)
    except CycleError:
        return None
    spec = PathSpec(virtual=target,
                    directory=target,
                    resolved=False,
                    vfs_path=rekey(directory.virtual, directory.vfs_path,
                                   target))
    try:
        return (await stat(spec, index)).model_copy(update={"name": link.name})
    except (OSError, ValueError):
        return None


def _link_row(path: PathSpec, links: LinkView | None) -> FileStat | None:
    """The row for an operand that is itself a symlink, else None.

    A link has no backend inode, so readdir and stat both fail on one;
    without this a link operand reads as a missing file, and a dangling
    link fails the whole listing (GNU prints its row and exits 0).
    Named with the operand's own spelling, like every other ls row.

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
    return PathSpec(virtual=child,
                    directory=child,
                    resolved=False,
                    vfs_path=rekey(path.virtual, path.vfs_path, child))


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


async def _stat_entries(
    path: PathSpec,
    names: list[str],
    *,
    stat: Stat,
    all_files: bool,
    index: IndexCacheStore,
    links: LinkView | None = None,
    deref: bool = False,
    child_mounts: ChildMounts | None = None,
    stat_path: StatPath | None = None,
) -> tuple[list[FileStat], list[LsWarning]]:
    """Stat every name in a directory, plus the symlinks living there.

    Args:
        path (PathSpec): the directory being listed.
        names (list[str]): entry paths from the backend readdir.
        stat (Stat): backend stat.
        all_files (bool): keep dotfiles.
        index (IndexCacheStore): listing cache.
        links (LinkView | None): the namespace's symlink facts. Links
            have no backend inode, so readdir never names them; merging
            here means every caller (plain, -R, -F, -l, sorting) sees
            them without knowing they are special.
        deref (bool): -L, report the target's stat under the link's own
            name instead of the link row. A dereferenced directory link
            then carries FileType.DIRECTORY, which is what makes -R
            descend it.
        child_mounts (ChildMounts | None): session-filtered child-mount
            names under a directory. A nested mount is namespace
            structure the backend readdir cannot name, merged here like
            a link row. GNU lists a mountpoint as an ordinary entry of
            its parent, so the merge is unconditional: withholding it
            under ``-R`` dropped the row whenever the parent's backend
            held no key of that name.
        stat_path (StatPath | None): dispatcher-backed stat, which is
            the only way to learn a child mount's real type. See
            ``_mount_row``.
    """
    stats: list[FileStat] = []
    warnings: list[LsWarning] = []
    for entry in names:
        entry_spec = PathSpec(virtual=entry,
                              directory=entry,
                              resolved=False,
                              vfs_path=rekey(path.virtual, path.vfs_path,
                                             entry))
        try:
            s = await stat(entry_spec, index)
        except (OSError, ValueError) as exc:
            # An entry below an operand is never a command-line arg, so
            # GNU treats it as a minor problem (exit 1).
            warnings.append(
                LsWarning(
                    f"ls: cannot access '{entry}': {fs_strerror(exc) or exc}",
                    False))
            continue
        if not all_files and s.name.startswith("."):
            continue
        stats.append(s)
    seen = {s.name for s in stats}
    for link in (links.children(path.virtual) if links is not None else []):
        if link.name in seen:
            continue
        if not all_files and link.name.startswith("."):
            continue
        seen.add(link.name)
        resolved = (await _deref_entry(path, link, links, stat, index)
                    if deref and links is not None else None)
        stats.append(resolved if resolved is not None else link)
    for name in (child_mounts(path.virtual)
                 if child_mounts is not None else []):
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
    index: IndexCacheStore = NULL_INDEX,
    links: LinkView | None = None,
    deref: bool = False,
    child_mounts: ChildMounts | None = None,
    mounts: MountView | None = None,
    stat_path: StatPath | None = None,
    time_kind: LsTimeKind = LsTimeKind.MTIME,
    group_dirs_first: bool = False,
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
        index (IndexCacheStore): listing cache.
        links (LinkView | None): the namespace's symlink facts.
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
    """
    warnings: list[LsWarning] = []
    structure_only = False
    try:
        names = await readdir(path, index)
    except (OSError, ValueError) as exc:
        row = await _file_entry(path, stat, index)
        if row is not None:
            return Operand(path, row, []), warnings
        link_row = _link_row(path, links)
        if link_row is not None:
            return Operand(path, link_row, []), warnings
        if child_mounts is None or not child_mounts(path.virtual):
            # GNU words a directory it may not read differently from
            # one it cannot stat: the entry is there, opening it is
            # what failed.
            verb = ("cannot open directory" if isinstance(
                exc, PermissionError) else "cannot access")
            warnings.append(
                LsWarning(
                    f"ls: {verb} '{path.raw_path}': "
                    f"{fs_strerror(exc) or exc}", command_line_arg))
            return Operand(path, None, []), warnings
        # No backend serves it, but the namespace owes it children (a
        # nested mount, a link's ancestors), so the door lists it as a
        # directory and ls must agree: the merge below renders those
        # rows from an empty backend listing.
        names = []
        structure_only = True

    if not names and not structure_only:
        row = await _file_entry(path, stat, index)
        if row is not None:
            return Operand(path, row, []), warnings
        # Backends without real directories answer readdir on a link
        # with an empty list instead of raising, so the link operand has
        # to be caught here too or it renders as an empty directory.
        link_row = _link_row(path, links)
        if link_row is not None:
            return Operand(path, link_row, []), warnings

    entries, entry_ws = await _stat_entries(path,
                                            names,
                                            stat=stat,
                                            all_files=all_files,
                                            index=index,
                                            links=links,
                                            deref=deref,
                                            child_mounts=child_mounts,
                                            stat_path=stat_path)
    warnings.extend(entry_ws)
    entries = sort_stats(entries,
                         sort_by,
                         reverse,
                         time_kind=time_kind,
                         group_dirs_first=group_dirs_first)
    groups: list[tuple[PathSpec, list[FileStat]]] = [(path, entries)]
    if recursive:
        for entry in entries:
            if entry.type != FileType.DIRECTORY:
                continue
            child_path = _child_spec(path, entry.name)
            if mounts is not None and mounts.is_root(child_path.virtual):
                # A nested mount's root. Its row belongs here, but its
                # listing is another backend's, which this walk cannot
                # read: the cross-mount fan-out renders that group.
                continue
            child, child_ws = await probe_operand(
                child_path,
                readdir=readdir,
                stat=stat,
                all_files=all_files,
                sort_by=sort_by,
                reverse=reverse,
                recursive=True,
                command_line_arg=False,
                index=index,
                links=links,
                deref=deref,
                child_mounts=child_mounts,
                mounts=mounts,
                stat_path=stat_path,
                time_kind=time_kind,
                group_dirs_first=group_dirs_first)
            groups.extend(child.groups)
            warnings.extend(child_ws)
    return Operand(path, None, groups), warnings


async def walk(
    path: PathSpec,
    *,
    readdir: Readdir,
    stat: Stat,
    all_files: bool = False,
    sort_by: LsSortBy = LsSortBy.NAME,
    reverse: bool = False,
    recursive: bool = False,
    list_dir: bool = False,
    command_line_arg: bool = True,
    index: IndexCacheStore = NULL_INDEX,
    links: LinkView | None = None,
    deref: bool = False,
    child_mounts: ChildMounts | None = None,
    mounts: MountView | None = None,
    stat_path: StatPath | None = None,
    time_kind: LsTimeKind = LsTimeKind.MTIME,
    group_dirs_first: bool = False,
) -> WalkResult:
    """Flat listing for one operand: a directory's entries, or the operand
    itself when it is not one. ``recursive`` flattens the whole subtree in
    ``ls -R`` order.

    Args:
        path (PathSpec): the operand to list.
        readdir (Readdir): backend directory lister.
        stat (Stat): backend stat.
        all_files (bool): keep dotfiles.
        sort_by (LsSortBy): active sort key.
        reverse (bool): reverse the sort.
        recursive (bool): descend into subdirectories.
        list_dir (bool): stat the operand itself instead of listing it (-d).
        command_line_arg (bool): False below an operand, where GNU downgrades
            a failure to a minor problem (exit 1).
        index (IndexCacheStore): listing cache.
        links (LinkView | None): the namespace's symlink facts.
        child_mounts (ChildMounts | None): session-filtered child-mount
            names to merge into a directory listing.
        mounts (MountView | None): the boundaries this walk's readdir
            cannot cross, so ``-R`` lists a nested mount's root without
            descending it.
        stat_path (StatPath | None): dispatcher-backed stat, for the
            child-mount rows no backend can supply.
        time_kind (LsTimeKind): which timestamp ``-t`` compares.
        group_dirs_first (bool): ``--group-directories-first``.
    """
    if list_dir:
        link_row = _link_row(path, links)
        if link_row is not None:
            return WalkResult([link_row])
        try:
            listed = await stat(path, index)
        except (OSError, ValueError) as exc:
            if child_mounts is not None and child_mounts(path.virtual):
                # No backend serves it, but the namespace owes it
                # children, so the door stats it as a directory and -d
                # must print the same row.
                return WalkResult(
                    [FileStat(name=path.raw_path, type=FileType.DIRECTORY)])
            detail = fs_strerror(exc) or exc
            return WalkResult(warnings=[
                LsWarning(f"ls: cannot access '{path.raw_path}': {detail}",
                          command_line_arg)
            ],
                              listed=False)
        # GNU ls -d prints the operand as given.
        return WalkResult([listed.model_copy(update={"name": path.raw_path})])

    operand, warnings = await probe_operand(path,
                                            readdir=readdir,
                                            stat=stat,
                                            all_files=all_files,
                                            sort_by=sort_by,
                                            reverse=reverse,
                                            recursive=recursive,
                                            command_line_arg=command_line_arg,
                                            index=index,
                                            links=links,
                                            deref=deref,
                                            child_mounts=child_mounts,
                                            mounts=mounts,
                                            stat_path=stat_path,
                                            time_kind=time_kind,
                                            group_dirs_first=group_dirs_first)
    if operand.row is not None:
        return WalkResult([operand.row], warnings)
    entries = [e for _, group in operand.groups for e in group]
    return WalkResult(entries, warnings, listed=bool(operand.groups))


async def _operand_key(
    operand: Operand,
    *,
    sort_by: LsSortBy,
    stat: Stat,
    index: IndexCacheStore,
) -> FileStat:
    """Sort row for one operand, named with the operand's own spelling."""
    if operand.row is not None:
        return operand.row
    if sort_by is LsSortBy.NAME:
        return FileStat(name=operand.path.raw_path, type=FileType.DIRECTORY)
    try:
        s = await stat(operand.path, index)
    except (OSError, ValueError):
        # The stat only supplies a sort key; an operand that cannot be
        # statted sorts as if it had none rather than failing the listing.
        return FileStat(name=operand.path.raw_path, type=FileType.DIRECTORY)
    return s.model_copy(update={"name": operand.path.raw_path})


async def _sorted_operands(
    operands: list[Operand],
    *,
    sort_by: LsSortBy,
    reverse: bool,
    stat: Stat,
    index: IndexCacheStore,
    time_kind: LsTimeKind = LsTimeKind.MTIME,
) -> list[Operand]:
    keys = [
        await _operand_key(o, sort_by=sort_by, stat=stat, index=index)
        for o in operands
    ]
    return [
        operands[i]
        for i in _order_rows(keys, sort_by, reverse, time_kind=time_kind)
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
    return "".join(c if c in URI_SAFE else "".join(f"%{b:02x}"
                                                   for b in c.encode())
                   for c in path)


def _decorated_names(entries: list[FileStat], hrefs: list[str] | None,
                     long: bool) -> list[str] | None:
    """The name column per row under ``--hyperlink``, None otherwise.

    Args:
        entries (list[FileStat]): the rows.
        hrefs (list[str] | None): each row's virtual path, when linking.
        long (bool): whether the long format's ``-> target`` applies.
    """
    if hrefs is None:
        return None
    out: list[str] = []
    for e, href in zip(entries, hrefs):
        linked = _hyperlinked(e.name, href)
        out.append(
            formatting.ls_name(e.model_copy(
                update={"name": linked})) if long else linked)
    return out


def _render_group(
    results: list[str],
    entries: list[FileStat],
    *,
    long: bool,
    human: bool,
    classify: bool,
    identity: Identity | None,
    columns: formatting.LsColumns = formatting.DEFAULT_COLUMNS,
    hrefs: list[str] | None = None,
) -> None:
    names = _decorated_names(entries, hrefs, long)
    if long:
        results.extend(
            formatting.format_ls_long(entries,
                                      human=human,
                                      identity=identity,
                                      columns=columns,
                                      names=names))
    else:
        results.extend(
            format_simple(entries,
                          classify=classify,
                          columns=columns,
                          names=names))


def _finish(results: list[str],
            warnings: list[LsWarning]) -> tuple[bytes, IOResult]:
    stderr = format_optional_records([w.message for w in warnings])
    return format_records(results), IOResult(
        stderr=stderr, exit_code=exit_status_for(warnings))


async def ls(
    paths: list[PathSpec],
    *,
    readdir: Readdir,
    stat: Stat,
    long: bool = False,
    all_files: bool = False,
    human: bool = False,
    sort_by: LsSortBy = LsSortBy.NAME,
    reverse: bool = False,
    recursive: bool = False,
    list_dir: bool = False,
    classify: bool = False,
    index: IndexCacheStore = NULL_INDEX,
    links: LinkView | None = None,
    deref: bool = False,
    child_mounts: ChildMounts | None = None,
    mounts: MountView | None = None,
    stat_path: StatPath | None = None,
    identity: Identity | None = None,
    time_kind: LsTimeKind = LsTimeKind.MTIME,
    group_dirs_first: bool = False,
    columns: formatting.LsColumns = formatting.DEFAULT_COLUMNS,
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
            result = await walk(p,
                                readdir=readdir,
                                stat=stat,
                                list_dir=True,
                                index=index,
                                links=links,
                                deref=deref,
                                child_mounts=child_mounts,
                                mounts=mounts,
                                stat_path=stat_path)
            rows.extend(result.entries)
            row_hrefs.extend(p.virtual for _ in result.entries)
            warnings.extend(result.warnings)
        if len(rows) > 1:
            order = _order_rows(rows,
                                sort_by,
                                reverse,
                                time_kind=time_kind,
                                group_dirs_first=group_dirs_first)
            rows = [rows[i] for i in order]
            row_hrefs = [row_hrefs[i] for i in order]
        _render_group(results,
                      rows,
                      long=long,
                      human=human,
                      classify=classify,
                      identity=identity,
                      columns=columns,
                      hrefs=row_hrefs if hyperlink else None)
        return _finish(results, warnings)

    operands: list[Operand] = []
    for p in paths:
        operand, p_ws = await probe_operand(p,
                                            readdir=readdir,
                                            stat=stat,
                                            all_files=all_files,
                                            sort_by=sort_by,
                                            reverse=reverse,
                                            recursive=recursive,
                                            index=index,
                                            links=links,
                                            deref=deref,
                                            child_mounts=child_mounts,
                                            mounts=mounts,
                                            stat_path=stat_path,
                                            time_kind=time_kind,
                                            group_dirs_first=group_dirs_first)
        warnings.extend(p_ws)
        operands.append(operand)
    if len(operands) > 1:
        operands = await _sorted_operands(operands,
                                          sort_by=sort_by,
                                          reverse=reverse,
                                          stat=stat,
                                          index=index,
                                          time_kind=time_kind)

    # GNU names every listed directory once there is more than one operand
    # (or under -R); a lone directory operand is listed bare.
    headed = recursive or len(paths) > 1
    rows = [o.row for o in operands if o.row is not None]
    _render_group(
        results,
        rows,
        long=long,
        human=human,
        classify=classify,
        identity=identity,
        columns=columns,
        hrefs=[o.path.virtual for o in operands
               if o.row is not None] if hyperlink else None)
    printed = bool(rows)
    for operand in operands:
        for dir_spec, entries in operand.groups:
            if headed:
                if printed:
                    results.append("")
                header = respell_one(dir_spec.virtual, operand.path.virtual,
                                     operand.path.raw_path)
                results.append(f"{header}:")
            _render_group(results,
                          entries,
                          long=long,
                          human=human,
                          classify=classify,
                          identity=identity,
                          columns=columns,
                          hrefs=[
                              posixpath.join(dir_spec.virtual, e.name)
                              for e in entries
                          ] if hyperlink else None)
            printed = True

    return _finish(results, warnings)


async def ls_generic(
    paths: list[PathSpec],
    texts: list[str],
    opts: CommandOpts,
    readdir: Readdir,
    stat: Stat,
) -> tuple[bytes, IOResult]:
    """Run ls over resolved operands, GNU semantics; mirrors lsGeneric.

    The wiring resolves globs, defaults the operands from the cwd, and
    binds the backend ops (including the stat overlay); flag semantics
    live here, and the namespace facts (links, child mounts), the
    identity the owner columns render, and the index ride ``opts``.

    Args:
        paths (list[PathSpec]): Glob-resolved operands, cwd-defaulted.
        texts (list[str]): Non-path words, unused by ls.
        opts (CommandOpts): Flags and namespace facts from the
            dispatcher.
        readdir (Readdir): Bound readdir called as ``readdir(p, index)``.
        stat (Stat): Bound (overlaid) stat called as ``stat(p, index)``.
    """
    return await ls(
        paths,
        readdir=readdir,
        stat=stat,
        index=opts.index,
        links=opts.ns.links if opts.ns is not None else None,
        child_mounts=opts.ns.child_mounts if opts.ns is not None else None,
        mounts=opts.ns.mounts if opts.ns is not None else None,
        stat_path=opts.stat_path,
        identity=identity_of(opts),
        **ls_options(opts.flags))


__all__ = [
    "LS_FAILURE",
    "LS_MINOR_PROBLEM",
    "LS_OK",
    "LsWarning",
    "Operand",
    "WalkResult",
    "exit_status_for",
    "format_simple",
    "ls",
    "ls_generic",
    "probe_operand",
    "sort_stats",
    "walk",
]
