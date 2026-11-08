from dataclasses import dataclass, field
from typing import Literal

from mirage.types import FileStat, FindType

# find's row actions: -print, -print0, -ls and -delete.
RowActionKind = Literal["print", "print0", "ls", "delete"]


@dataclass(frozen=True, slots=True)
class FindEntry:
    """One walked entry, as the predicate tree sees it: a mount-relative
    key, the basename (the start point's own name at depth 0) and the
    kind ``f``, ``d``, ``l`` or ``c``.

    ``stat`` is the stat the walk took when a test reads one (``-perm``,
    ``-user``, ``-lname``, ``-atime``...), the link itself unless the
    walk follows links. ``xkind`` is ``-xtype``'s kind: what a link
    leads to when the walk keeps links, ``l`` for a link the walk
    followed, and the kind itself for anything else. ``target`` is the
    stat of what a live link the walk keeps leads to, which the access
    tests answer through.
    """

    key: str
    name: str
    kind: str
    depth: int
    is_empty: bool | None = None
    mtime: float | None = None
    stat: FileStat | None = None
    xkind: str | None = None
    target: FileStat | None = None


@dataclass(frozen=True, slots=True)
class Name:
    pattern: str
    icase: bool = False


@dataclass(frozen=True, slots=True)
class Path:
    """``-path``: a glob over the path as ``find`` prints it.

    The row is the mount prefix plus the entry's key, respelled under
    the operand as typed (``find . -path ./skip`` prints and matches
    ``./skip``), so ``bind_tree`` stamps all three onto the node before
    evaluation and entry keys stay mount-relative (#396). An empty
    ``root`` leaves the row as the display path. ``icase`` is
    ``-ipath``.
    """

    pattern: str
    prefix: str = ""
    root: str = ""
    raw: str = ""
    icase: bool = False


@dataclass(frozen=True, slots=True)
class Regex:
    """``-regex`` and ``-iregex``: an expression that must match the
    whole path as ``find`` prints it.

    The path is spelled as ``Path`` spells it, from the same three
    fields ``bind_tree`` stamps. Evaluation is synchronous and a search
    is not, so the walk asks every entry's answer before it evaluates
    (``prime_regexes``) and the node keeps them by entry key.

    Args:
        pattern (str): the expression as typed.
        icase (bool): ``-iregex``.
        dialect (str): ``emacs`` or ``posix``, as ``-regextype`` chose.
        extended (bool): an extended expression rather than a basic one.
        utf8 (bool): the session's locale reads paths as UTF-8.
    """

    pattern: str
    icase: bool = False
    dialect: Literal["emacs", "posix"] = "emacs"
    extended: bool = False
    utf8: bool = False
    prefix: str = ""
    root: str = ""
    raw: str = ""
    hits: dict[str, bool] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class Lname:
    """``-lname`` and ``-ilname``: a glob over a link's target text; no
    entry that is not a link matches."""

    pattern: str
    icase: bool = False


@dataclass(frozen=True, slots=True)
class Type:
    kind: str


@dataclass(frozen=True, slots=True)
class XType:
    """``-xtype``: the entry's kind on the other side of a link (see
    ``FindEntry.xkind``)."""

    kind: str


@dataclass(frozen=True, slots=True)
class Perm:
    """``-perm``: the entry's permission bits against ``mode``, exactly,
    with every bit of it set (``all``) or with any (``any``, which an
    empty mode always holds for).
    """

    mode: int
    bits: Literal["exact", "all", "any"] = "exact"


@dataclass(frozen=True, slots=True)
class Count:
    """``-links``, ``-uid`` and ``-gid``: a number compared more than
    (``+``), less than (``-``) or equal to (``=``) ``count``."""

    field: Literal["links", "uid", "gid"]
    cmp: Literal["+", "-", "="]
    count: int


@dataclass(frozen=True, slots=True)
class Owner:
    """``-user`` and ``-group``: the owner or group as ``ls -l`` names
    it. mirage keeps any name ``chown`` was given, so every name is a
    user and none is refused; a number also matches the id it spells.
    ``profile`` is the session's own name, which owns an entry that
    reports none.
    """

    name: str
    group: bool = False
    profile: str | None = None


@dataclass(frozen=True, slots=True)
class NoOwner:
    """``-nouser`` and ``-nogroup``: an owner or group known only by its
    number. mirage keeps no user database, so a number names no one, as
    ``ls -l`` shows it; a name ``chown`` stored, or the session owning an
    entry that reports none, is someone."""

    group: bool = False


@dataclass(frozen=True, slots=True)
class Access:
    """``-readable``, ``-writable`` and ``-executable``: the owner's
    bits of the entry's mode, the session owning what it sees; a
    directory is searchable through its ``x`` bit as the reference's is."""

    mode: Literal["r", "w", "x"]


@dataclass(frozen=True, slots=True)
class Quit:
    """``-quit``: true, and nothing after it runs, for this entry or any
    other. The walk reads ``fired`` after each entry to stop."""

    fired: list[str] = field(default_factory=list)


@dataclass(frozen=True, slots=True)
class Not:
    kid: "PredNode"


@dataclass(frozen=True, slots=True)
class And:
    kids: list["PredNode"]


@dataclass(frozen=True, slots=True)
class Or:
    kids: list["PredNode"]


@dataclass(frozen=True, slots=True)
class Size:
    """``-size`` as the inclusive byte bounds it rounds to; a directory
    weighs ``DIR_SIZE``, a stat of unknown size nothing, and an entry
    with no stat matches no bound."""

    min: int | None = None
    max: int | None = None


@dataclass(frozen=True, slots=True)
class Empty:
    pass


@dataclass(frozen=True, slots=True)
class TrueNode:
    pass


ActionKind = RowActionKind | Literal["exec", "printf"]


@dataclass(frozen=True, slots=True)
class Action:
    """An action the expression reached: ``-print``, ``-print0``,
    ``-ls``, ``-delete``, ``-exec`` or ``-printf``.

    True, like GNU's, and it marks the entry as acted on. A tree that
    holds one keeps the entries an action reached rather than the ones
    the whole expression held for, which is how ``-o`` short-circuits
    past a ``-print`` (``-path ./skip -prune -o -type f -print`` never
    reaches the print for ``./skip``). The executor still runs the
    action itself, once per kept row, so the parser admits one distinct
    action to a tree holding any. GNU's ``-exec ... ;`` alone is false
    when its command fails, which the executor learns only after the
    walk, so the parser lets it stand only where nothing follows it;
    ``batch`` marks ``-exec ... {} +``, true whatever the command exits.
    """

    kind: ActionKind
    batch: bool = False


@dataclass(frozen=True, slots=True)
class Mtime:
    """``-mtime``, ``-newermt`` and a resolved ``-newer``: an inclusive
    epoch-second window over the entry's modification time, or over its
    access or change time for ``-atime``, ``-ctime`` and their minute
    twins (``field`` ``a`` or ``c``, read from the entry's stat).

    Only a test in the top-level ``-a`` chain also narrows the
    expression's flat window (``FindExpr.mtime_min``/``mtime_max``),
    which is what a backend pushes down and the generic post-filters
    with; the tree decides the rest, so a walk fetches mtimes whenever
    the tree holds one of these. An entry whose mtime is unknown passes
    here. The node also orders prunes: a ``-prune`` after it fires only
    for a directory the test holds for, and one before it fires
    regardless, as GNU orders them. A prune reached past an undecided
    test is recorded as pending (``PendingPrune``) for the caller to
    settle once it has statted the directory.
    """

    lo: float | None
    hi: float | None
    field: Literal["m", "a", "c"] = "m"


@dataclass(frozen=True, slots=True)
class PendingPrune:
    """A directory whose ``-prune`` decision waited on time tests the
    walk could not decide: a prune reached past one, or every prune
    skipped on the strength of one (``-mtime 1 -o -prune``).

    The entry is kept whole: whether the prune stands is settled by
    evaluating the expression again with the directory's mtime, since a
    failing test may send GNU down another arm that prunes anyway
    (``( -mtime 1 -o -type d ) -prune``).
    """

    entry: FindEntry


@dataclass(frozen=True, slots=True)
class Prune:
    """``-prune``: true, and a directory it reaches loses its contents.

    Every backend evaluates the tree entry by entry with no say over its
    own walk, and a flat listing meets a child before its parent, so the
    node keeps the ledger of pruned directory keys and ``drop_pruned``
    applies it to what the walk returned. ``bind_tree`` hands every
    start point a fresh ledger. A prune reached past a time test the
    entry could not answer lands in ``pending``; until ``settle_prunes``
    evaluates the directory again with its mtime, it counts as pruned,
    the most a walk without times can say.
    """

    pruned: list[str] = field(default_factory=list)
    pending: list[PendingPrune] = field(default_factory=list)


PredNode = (
    Name
    | Path
    | Regex
    | Lname
    | Type
    | XType
    | Perm
    | Count
    | Owner
    | NoOwner
    | Access
    | Size
    | Empty
    | Not
    | And
    | Or
    | TrueNode
    | Action
    | Prune
    | Quit
    | Mtime
)


@dataclass(slots=True)
class Effects:
    """What evaluating an expression on one entry did besides answer:
    whether an action was reached, whether a prune node recorded the
    entry (firm or pending), whether a ``-quit`` ended the evaluation,
    and the time tests the entry carried no mtime for on the path that
    decided the answer so far; a branch whose outcome they could not
    have changed drops them again.
    """

    acted: bool = False
    pruned: bool = False
    quit: bool = False
    deferred: list[Mtime] = field(default_factory=list)


@dataclass
class FindArgs:
    name: str | None = None
    iname: str | None = None
    path_pattern: str | None = None
    type: FindType | str | None = None
    min_size: int | None = None
    max_size: int | None = None
    mtime_min: float | None = None
    mtime_max: float | None = None
    maxdepth: int | None = None
    mindepth: int | None = None
    name_exclude: str | None = None
    or_names: list[str] | None = None
    empty: bool = False
    tree: PredNode | None = None
    depth_first: bool = False
