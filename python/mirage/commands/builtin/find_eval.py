# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, field, replace
from typing import Literal

from mirage.commands.builtin.types import RowActionKind
from mirage.ops.types import LinkView
from mirage.types import FindType, PathSpec
from mirage.utils.dates import in_mtime_window
from mirage.utils.fnmatch import fnmatch
from mirage.utils.path import respell_one


def start_basename(path: PathSpec) -> str:
    """Basename of a find start path, as GNU would print and match it.

    Single source of truth for the start path's own name across every
    backend find op. Reads ``path.virtual`` (the path as written, with
    its mount prefix) so the name is correct whether the start is the
    mount root or a nested directory.

    Args:
        path (PathSpec): The find start path.

    Returns:
        str: The start path's basename, or "" for the bare root "/".
    """
    return path.virtual.rstrip("/").rsplit("/", 1)[-1]


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


PredNode = (Name | Path | Type | Empty | Not | And | Or | TrueNode | Action
            | Prune | Mtime)


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


def display_path(prefix: str, key: str) -> str:
    """Display path for a mount-relative key, as ``find`` prints it.

    Mirrors ``apply_mount_prefix`` for a single key: the mount root maps
    to the bare prefix, everything else joins with one slash.

    Args:
        prefix (str): Mount prefix ("" for a root mount).
        key (str): Mount-relative key with a leading slash.
    """
    if not prefix:
        return key
    rel = key.lstrip("/")
    return prefix if not rel else prefix + "/" + rel


def bind_tree(node: PredNode,
              prefix: str,
              root: str = "",
              raw: str = "") -> PredNode:
    """Copy of a predicate tree bound to one start point.

    ``-path`` matches the row as printed, but backend find ops evaluate
    entries by mount-relative key; stamping the prefix and the operand's
    spelling onto the tree keeps the evaluation site prefix-free
    (#396). Every ``Prune`` comes back with an empty ledger, so what one
    start point pruned never drops rows from the next (``find
    a/skip/inner a -path a/skip -prune -o -print`` lists the first
    operand in full, as GNU does).

    Args:
        node (PredNode): Predicate tree to rewrite.
        prefix (str): Mount prefix ("" for a root mount).
        root (str): the start point's resolved absolute path.
        raw (str): the start point as typed.
    """
    if isinstance(node, Path):
        return Path(node.pattern, prefix=prefix, root=root, raw=raw)
    if isinstance(node, Prune):
        return Prune()
    if isinstance(node, Not):
        return Not(bind_tree(node.kid, prefix, root, raw))
    if isinstance(node, And):
        return And([bind_tree(kid, prefix, root, raw) for kid in node.kids])
    if isinstance(node, Or):
        return Or([bind_tree(kid, prefix, root, raw) for kid in node.kids])
    return node


def eval_predicate(node: PredNode, entry: FindEntry) -> bool:
    return evaluate(node, entry, Effects())


def evaluate(node: PredNode, entry: FindEntry, effects: Effects) -> bool:
    """Whether the expression holds for one entry, recording what it did.

    Evaluation short-circuits the way GNU's does (``-a`` stops at the
    first false, ``-o`` at the first true), so an action or a prune is
    reached exactly when GNU would reach it.

    Args:
        node (PredNode): the predicate tree.
        entry (FindEntry): the entry under test.
        effects (Effects): filled in as actions are reached.
    """
    if isinstance(node, TrueNode):
        return True
    if isinstance(node, Action):
        effects.acted = True
        return True
    if isinstance(node, Prune):
        # Only a directory has contents to skip; a file key that is also
        # a directory prefix (an object store allows both) must not
        # drop what sits under the directory.
        if entry.kind == "d" and effects.deferred:
            node.pending.append(PendingPrune(entry))
        elif entry.kind == "d":
            node.pruned.append(entry.key)
        effects.pruned = effects.pruned or entry.kind == "d"
        return True
    if isinstance(node, Mtime):
        # An entry the walk fetched no time for passes here and meets
        # the expression's flat window afterwards; the test is recorded
        # so a -prune reached past it is only pending.
        if entry.mtime is None:
            effects.deferred.append(node)
            return True
        return in_mtime_window(entry.mtime, node.lo, node.hi)
    if isinstance(node, Empty):
        return entry.is_empty is True
    if isinstance(node, Name):
        if node.icase:
            return fnmatch(entry.name.lower(), node.pattern.lower())
        return fnmatch(entry.name, node.pattern)
    if isinstance(node, Path):
        shown = display_path(node.prefix, entry.key)
        if node.root:
            shown = respell_one(shown, node.root, node.raw)
        return fnmatch(shown, node.pattern)
    if isinstance(node, Type):
        return entry.kind == node.kind
    if isinstance(node, Not):
        return not evaluate(node.kid, entry, effects)
    if isinstance(node, And):
        mark = len(effects.deferred)
        for kid in node.kids:
            before = len(effects.deferred)
            if not evaluate(kid, entry, effects):
                # Had an earlier factor's undecided test failed, the
                # chain would have ended there with this same answer, so
                # those tests decide nothing; the failing factor's own
                # may (`! -mtime 1` flips with its mtime).
                del effects.deferred[mark:before]
                return False
        return True
    if isinstance(node, Or):
        mark = len(effects.deferred)
        for kid in node.kids:
            before = len(effects.deferred)
            if evaluate(kid, entry, effects):
                del effects.deferred[mark:before]
                return True
        return False
    raise TypeError(f"unknown predicate node: {node!r}")


def tree_has_action(node: PredNode) -> bool:
    if isinstance(node, Action):
        return True
    if isinstance(node, Not):
        return tree_has_action(node.kid)
    if isinstance(node, (And, Or)):
        return any(tree_has_action(kid) for kid in node.kids)
    return False


def tree_has_prune(node: PredNode) -> bool:
    if isinstance(node, Prune):
        return True
    if isinstance(node, Not):
        return tree_has_prune(node.kid)
    if isinstance(node, (And, Or)):
        return any(tree_has_prune(kid) for kid in node.kids)
    return False


def without_prune(node: PredNode) -> PredNode:
    """The tree with every ``-prune`` made inert.

    GNU: ``-prune`` does nothing when ``-depth`` is in effect, since a
    directory's contents are visited before the directory itself.

    Args:
        node (PredNode): the predicate tree.
    """
    if isinstance(node, Prune):
        return TrueNode()
    if isinstance(node, Not):
        return Not(without_prune(node.kid))
    if isinstance(node, And):
        return And([without_prune(kid) for kid in node.kids])
    if isinstance(node, Or):
        return Or([without_prune(kid) for kid in node.kids])
    return node


def pruned_keys(node: PredNode) -> list[str]:
    """Every directory key the tree's ``-prune`` nodes reached.

    A pending prune counts until ``settle_prunes`` decides it.

    Args:
        node (PredNode): the predicate tree, after evaluation.
    """
    if isinstance(node, Prune):
        return [*node.pruned, *(p.entry.key for p in node.pending)]
    if isinstance(node, Not):
        return pruned_keys(node.kid)
    if isinstance(node, (And, Or)):
        return [key for kid in node.kids for key in pruned_keys(kid)]
    return []


def pending_prunes(node: PredNode) -> list[PendingPrune]:
    """Every ``-prune`` still waiting on a time test.

    Args:
        node (PredNode): the predicate tree, after evaluation.
    """
    if isinstance(node, Prune):
        return list(node.pending)
    if isinstance(node, Not):
        return pending_prunes(node.kid)
    if isinstance(node, (And, Or)):
        return [p for kid in node.kids for p in pending_prunes(kid)]
    return []


def _prune_nodes(node: PredNode) -> list[Prune]:
    if isinstance(node, Prune):
        return [node]
    if isinstance(node, Not):
        return _prune_nodes(node.kid)
    if isinstance(node, (And, Or)):
        return [p for kid in node.kids for p in _prune_nodes(kid)]
    return []


def _time_tests_failing(node: PredNode) -> PredNode:
    """The tree with every time test false, sharing the prune ledgers.

    A directory that reports no mtime passes no time test, the way the
    flat window admits no such row, so the prunes it reaches are the
    ones reachable with every test false. The ``Prune`` nodes are the
    original objects, so what this copy records lands on the tree.

    Args:
        node (PredNode): the predicate tree.
    """
    if isinstance(node, Mtime):
        return Not(TrueNode())
    if isinstance(node, Not):
        return Not(_time_tests_failing(node.kid))
    if isinstance(node, And):
        return And([_time_tests_failing(kid) for kid in node.kids])
    if isinstance(node, Or):
        return Or([_time_tests_failing(kid) for kid in node.kids])
    return node


def settle_prunes(node: PredNode, mtimes: Mapping[str, float | None]) -> None:
    """Decide the pending prunes whose directory mtime is now known.

    Each decided directory leaves the pending ledgers and is evaluated
    again with its mtime, so the prunes it reaches are exactly GNU's,
    whichever arm the tests send it down: ``find d -newermt X -prune``
    skips only the contents of directories newer than ``X``, and
    ``( -mtime 1 -o -type d ) -prune`` skips every directory's. A key
    ``mtimes`` does not name stays pending.

    Args:
        node (PredNode): the predicate tree, after evaluation.
        mtimes (Mapping[str, float | None]): epoch-second mtime per
            directory key, None for a directory that reports none.
    """
    decided: dict[str, FindEntry] = {}
    for prune in _prune_nodes(node):
        still = [p for p in prune.pending if p.entry.key not in mtimes]
        decided.update((p.entry.key, p.entry) for p in prune.pending
                       if p.entry.key in mtimes)
        prune.pending[:] = still
    for key, entry in decided.items():
        mtime = mtimes[key]
        tree = node if mtime is not None else _time_tests_failing(node)
        evaluate(tree, replace(entry, mtime=mtime), Effects())


def drop_pruned(rows: list[str],
                tree: PredNode,
                prefix: str = "") -> list[str]:
    """The rows minus everything under a directory ``-prune`` reached.

    The pruned directory itself stays, the root spelled ``/`` included:
    GNU reports it when the rest of the expression does, and only its
    contents go unvisited.

    Args:
        rows (list[str]): rows spelled as the ledger's keys are, or as
            display paths when ``prefix`` is given.
        tree (PredNode): the evaluated tree holding the ledger.
        prefix (str): mount prefix the rows carry and the keys do not.
    """
    stems = [
        display_path(prefix, key).rstrip("/") + "/"
        for key in pruned_keys(tree)
    ]
    if not stems:
        return rows
    return [
        r for r in rows if not any(r.startswith(s) and r != s for s in stems)
    ]


async def settle_pending_prunes(
        node: PredNode, mtime_of: Callable[[str],
                                           Awaitable[float | None]]) -> None:
    """Decide every pending prune by asking for its directory's mtime.

    The backend judged its entries without their mtimes, so a prune
    reached past ``-newermt`` or ``-mtime`` is only pending; the caller's
    overlay-aware stat answers for the directory here, and a directory
    the test rejects keeps its contents (``find d -newermt X -prune``
    skips only the directories newer than ``X``, as GNU does).

    Args:
        node (PredNode): the evaluated tree holding the ledger.
        mtime_of (Callable): epoch-second mtime of one mount-relative
            key, None when the directory reports none or is gone.
    """
    mtimes: dict[str, float | None] = {}
    for pend in pending_prunes(node):
        mtimes[pend.entry.key] = await mtime_of(pend.entry.key)
    settle_prunes(node, mtimes)


def tree_has_type(node: PredNode) -> bool:
    if isinstance(node, Type):
        return True
    if isinstance(node, Not):
        return tree_has_type(node.kid)
    if isinstance(node, (And, Or)):
        return any(tree_has_type(kid) for kid in node.kids)
    return False


def tree_has_empty(node: PredNode) -> bool:
    if isinstance(node, Empty):
        return True
    if isinstance(node, Not):
        return tree_has_empty(node.kid)
    if isinstance(node, (And, Or)):
        return any(tree_has_empty(kid) for kid in node.kids)
    return False


def has_link_children(links: LinkView | None, virtual: str) -> bool:
    """Whether a directory holds namespace symlinks directly under it.

    ``-empty`` asks whether a directory has entries, and a symlink is one
    of them. No backend readdir can see a namespace link, so every
    emptiness probe has to add this or a directory holding only a link
    reads as empty. Shared because ``find`` asks it in two places: the
    start point's row and each directory the walk reaches.

    Args:
        links (LinkView | None): the namespace's symlink facts.
        virtual (str): absolute virtual path of the directory.
    """
    if links is None:
        return False
    return bool(links.children(virtual.rstrip("/") or "/"))


def keep(entry: FindEntry, tree: PredNode, min_depth: int | None) -> bool:
    """Whether ``find`` reports the entry.

    With no action in the tree the rows are the entries the whole
    expression holds for, GNU's implicit ``-print``. With one, they are
    the entries an action reached: ``-path ./skip -prune -o -type f
    -print`` holds for ``./skip`` but never prints it. ``-mindepth``
    applies neither tests nor actions above its level, so a shallow
    directory is not pruned either.

    Args:
        entry (FindEntry): the entry under test.
        tree (PredNode): the predicate tree.
        min_depth (int | None): ``-mindepth``.
    """
    if min_depth is not None and entry.depth < min_depth:
        return False
    effects = Effects()
    matched = evaluate(tree, entry, effects)
    if entry.kind == "d" and effects.deferred and not effects.pruned:
        # The answer passed every -prune on the strength of an undecided
        # test, and the directory's mtime may send it into one
        # (`-mtime 1 -o -prune`), so it waits with the prunes it might
        # reach, on the first of them.
        for prune in _prune_nodes(tree)[:1]:
            prune.pending.append(PendingPrune(entry))
    return effects.acted if tree_has_action(tree) else matched


def emit_start_path(
    results: list[str],
    start_key: str,
    start_name: str,
    *,
    kind: str,
    is_empty: bool | None,
    exists: bool,
    tree: PredNode,
    maxdepth: int | None,
    mindepth: int | None,
    size: int | None = None,
    min_size: int | None = None,
    max_size: int | None = None,
) -> None:
    """Append the search start path to results when it matches.

    Shared by every backend find op so the start path is emitted
    uniformly. GNU lists the start path itself at depth 0, so bare
    ``find <dir>``, ``-type d`` on the root, ``-maxdepth 0`` (just the
    start), ``-mindepth 0`` (start included), and ``-name``/``-iname``
    against the start's own basename all behave the same everywhere.

    A directory start path contributes size ``0`` to ``-size``
    filtering (mirage directories have no meaningful content size; a
    documented divergence from GNU, which compares the inode size), so
    ``-size +N`` excludes directory roots and ``-size -N`` keeps them
    (#318). Backends whose start path can be a file
    (ram/redis/chroma/dify/notion) pass the start's size so
    ``find <file> -size`` filters the start like GNU does; a file start
    with an unknown size (``None``) skips the filter.

    Args:
        results (list[str]): Mount-relative result keys to append to.
        start_key (str): Mount-relative key of the start path.
        start_name (str): Basename of the start path as written.
        kind (str): "d" for a directory or "f" for a file.
        is_empty (bool | None): Emptiness for ``-empty``; None if unknown.
        exists (bool): Whether the start path exists.
        tree (PredNode): Predicate tree.
        maxdepth (int | None): ``-maxdepth`` value.
        mindepth (int | None): ``-mindepth`` value.
        size (int | None): Start path size in bytes when it is a file.
        min_size (int | None): ``-size +`` lower bound in bytes.
        max_size (int | None): ``-size -`` upper bound in bytes.
    """
    if not exists:
        return
    if maxdepth is not None and maxdepth < 0:
        return
    entry = FindEntry(key=start_key,
                      name=start_name,
                      kind=kind,
                      depth=0,
                      is_empty=is_empty)
    if not keep(entry, tree, mindepth):
        return
    if min_size is not None or max_size is not None:
        # Directories count as size 0 for -size: GNU compares the inode size
        # (e.g. 4096 on ext4); see CLAUDE.md Rules.
        effective = 0 if kind != "f" else size
        if effective is not None:
            if min_size is not None and effective < min_size:
                return
            if max_size is not None and effective > max_size:
                return
    results.append(start_key)


def _type_kind(type_arg: FindType | str | None) -> str | None:
    if type_arg is None:
        return None
    if isinstance(type_arg, FindType):
        return "d" if type_arg == FindType.DIRECTORY else "f"
    if type_arg in ("file", "directory"):
        return "f" if type_arg == "file" else "d"
    return type_arg


def build_tree(
    *,
    name: str | None = None,
    iname: str | None = None,
    path_pattern: str | None = None,
    type: FindType | str | None = None,
    name_exclude: str | None = None,
    or_names: list[str] | None = None,
    empty: bool = False,
) -> PredNode:
    kids: list[PredNode] = []
    if or_names:
        kids.append(Or([Name(pat) for pat in or_names]))
    elif name is not None:
        kids.append(Name(name))
    if iname is not None:
        kids.append(Name(iname, icase=True))
    if path_pattern is not None:
        kids.append(Path(path_pattern))
    type_kind = _type_kind(type)
    if type_kind is not None:
        kids.append(Type(type_kind))
    if name_exclude is not None:
        kids.append(Not(Name(name_exclude)))
    if empty:
        kids.append(Empty())
    if not kids:
        return TrueNode()
    if len(kids) == 1:
        return kids[0]
    return And(kids)


def compute_nonempty_dirs(keys: list[str]) -> set[str]:
    nonempty: set[str] = set()
    for k in keys:
        cut = k.rfind("/")
        parent = k[:cut] if cut > 0 else "/"
        nonempty.add(parent)
    return nonempty


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


def args_to_tree(args: FindArgs) -> PredNode:
    if args.tree is not None:
        return args.tree
    return build_tree(name=args.name,
                      iname=args.iname,
                      path_pattern=args.path_pattern,
                      type=args.type,
                      name_exclude=args.name_exclude,
                      or_names=args.or_names,
                      empty=args.empty)


def unrespell_raw(row: str, virtual: str, raw: str) -> str:
    """Map one respelled display row back to its virtual path.

    The inverse of ``respell_one``: rows were rewritten to carry the
    operand as typed, and the stat probe needs the resolved spelling
    back.

    Args:
        row (str): the display row.
        virtual (str): the operand's resolved absolute path.
        raw (str): the operand as typed.
    """
    if not raw or raw == virtual:
        return row
    if row == raw:
        return virtual
    stem = raw if raw.endswith("/") else raw + "/"
    if row.startswith(stem):
        return (virtual.rstrip("/") or "") + "/" + row[len(stem):]
    return row
