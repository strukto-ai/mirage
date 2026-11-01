from dataclasses import dataclass, field
from typing import Literal

from mirage.types import FindType

# find's row actions: -print, -print0, -ls and -delete.
RowActionKind = Literal["print", "print0", "ls", "delete"]


@dataclass(frozen=True, slots=True)
class FindEntry:
    """One walked entry, as the predicate tree sees it: a mount-relative
    key, the basename (the start point's own name at depth 0) and the
    kind ``f``, ``d``, ``l`` or ``c``.
    """

    key: str
    name: str
    kind: str
    depth: int
    is_empty: bool | None = None
    mtime: float | None = None


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
    ``root`` leaves the row as the display path.
    """

    pattern: str
    prefix: str = ""
    root: str = ""
    raw: str = ""


@dataclass(frozen=True, slots=True)
class Type:
    kind: str


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
    epoch-second window over the entry's modification time.

    The same bounds fold into the expression's flat window
    (``FindExpr.mtime_min``/``mtime_max``), which is what a backend pushes
    down and the generic post-filters with, so an entry whose mtime the
    walk did not fetch passes here and meets the window afterwards. The
    node's own job is its position: a ``-prune`` after it fires only for
    a directory the test holds for, and one before it fires regardless,
    as GNU orders them. A prune reached past an undecided test is
    recorded as pending (``PendingPrune``) for the caller to settle once
    it has statted the directory.
    """

    lo: float | None
    hi: float | None


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
    | Type
    | Empty
    | Not
    | And
    | Or
    | TrueNode
    | Action
    | Prune
    | Mtime
)


@dataclass(slots=True)
class Effects:
    """What evaluating an expression on one entry did besides answer:
    whether an action was reached, whether a prune node recorded the
    entry (firm or pending), and the time tests the entry carried no
    mtime for on the path that decided the answer so far; a branch whose
    outcome they could not have changed drops them again.
    """

    acted: bool = False
    pruned: bool = False
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
