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

from collections.abc import Iterable
from dataclasses import replace

from mirage.core.generic.types import (
    Access,
    Action,
    And,
    Count,
    Effects,
    Empty,
    FindArgs,
    FindEntry,
    Lname,
    Mtime,
    Name,
    NoOwner,
    Not,
    Or,
    Owner,
    Path,
    Perm,
    PredNode,
    Prune,
    Quit,
    Regex,
    Size,
    TrueNode,
    Type,
    Used,
    XType,
)
from mirage.rs.regex import posix_regex
from mirage.shell.bytes import byte_view
from mirage.types import (
    LINK_TARGET_KEY,
    FileStat,
    FileType,
    FindType,
    PathSpec,
)
from mirage.utils.dates import in_mtime_window, iso_timestamp
from mirage.utils.fnmatch import fnmatch
from mirage.utils.path import respell_one
from mirage.utils.stat_view import DIR_SIZE, posix_mode

_ACCESS_BITS = {"r": 0o400, "w": 0o200, "x": 0o100}
_PERMISSION_BITS = 0o7777

_TYPE_LETTER = {
    FileType.DIRECTORY: "d",
    FileType.SYMLINK: "l",
    FileType.CHAR_DEVICE: "c",
    FileType.BLOCK_DEVICE: "b",
    FileType.FIFO: "p",
    FileType.SOCKET: "s",
}


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


def display_path(prefix: str, key: str) -> str:
    """Display path for a mount-relative key, as ``find`` prints it: the
    mount root maps to the bare prefix, everything else joins with one
    slash.

    Args:
        prefix (str): Mount prefix ("" for a root mount).
        key (str): Mount-relative key with a leading slash.
    """
    if not prefix:
        return key
    rel = key.lstrip("/")
    return prefix if not rel else prefix + "/" + rel


def bind_tree(
    node: PredNode, prefix: str, root: str = "", raw: str = ""
) -> PredNode:
    """Copy of a predicate tree bound to one start point.

    ``-path`` matches the row as printed, but backend find ops evaluate
    entries by mount-relative key; stamping the prefix and the operand's
    spelling onto the tree keeps the evaluation site prefix-free
    (#396).

    Args:
        node (PredNode): Predicate tree to rewrite.
        prefix (str): Mount prefix ("" for a root mount).
        root (str): the start point's resolved absolute path.
        raw (str): the start point as typed.
    """
    if isinstance(node, Path):
        return replace(node, prefix=prefix, root=root, raw=raw)
    if isinstance(node, Regex):
        return replace(node, prefix=prefix, root=root, raw=raw, hits={})
    if isinstance(node, Quit):
        return Quit()
    if isinstance(node, Not):
        return Not(bind_tree(node.kid, prefix, root, raw))
    if isinstance(node, And):
        return And([bind_tree(kid, prefix, root, raw) for kid in node.kids])
    if isinstance(node, Or):
        return Or([bind_tree(kid, prefix, root, raw) for kid in node.kids])
    return node


def shown_path(node: Path | Regex, key: str) -> str:
    """The path ``-path`` and ``-regex`` read: the entry as ``find``
    prints it under the start point the node was bound to.

    Args:
        node (Path | Regex): the bound node.
        key (str): the entry's mount-relative key.
    """
    shown = display_path(node.prefix, key)
    return respell_one(shown, node.root, node.raw) if node.root else shown


def _glob(text: str, pattern: str, icase: bool) -> bool:
    if icase:
        return fnmatch(text.lower(), pattern.lower())
    return fnmatch(text, pattern)


def _link_target(st: FileStat | None) -> str | None:
    if st is None or st.type is not FileType.SYMLINK:
        return None
    target = st.extra.get(LINK_TARGET_KEY)
    return target if isinstance(target, str) else None


SECONDS_PER_DAY = 86400


def _stamp(entry: FindEntry, field: str) -> float | None:
    """The time one test reads: the walk's mtime, or the access or
    change time the entry's stat holds, which falls back to the mtime
    as ``stat``'s does for a backend that keeps only that one.

    Args:
        entry (FindEntry): the entry under test.
        field (str): ``m``, ``a`` or ``c``.
    """
    if field == "m":
        return entry.mtime
    if entry.stat is None:
        return None
    other = entry.stat.atime if field == "a" else entry.stat.ctime
    return iso_timestamp(other) if other else entry.mtime


def _count(st: FileStat, field: str) -> int | None:
    if field == "inum":
        # No backend here numbers its files, as `stat %i` says.
        return None
    if field == "links":
        # One name per entry, as ls -l counts it: mirage has no hard
        # links, and a directory's own entries are not counted.
        return 1
    value = st.uid if field == "uid" else st.gid
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value.isdigit():
        return int(value)
    return None


def _owns(node: Owner, st: FileStat) -> bool:
    value = st.gid if node.group else st.uid
    if value is None:
        return node.profile is not None and node.name == node.profile
    if str(value) == node.name:
        return True
    return (
        node.name.isdigit()
        and isinstance(value, int)
        and value == int(node.name)
    )


def _test(node: PredNode, entry: FindEntry) -> bool | None:
    """The answer of a test that reads only the entry, None for a node
    that is not one."""
    if isinstance(node, Name):
        return _glob(entry.name, node.pattern, node.icase)
    if isinstance(node, Path):
        return _glob(shown_path(node, entry.key), node.pattern, node.icase)
    if isinstance(node, Regex):
        return node.hits.get(entry.key, False)
    if isinstance(node, Type):
        return entry.kind == node.kind
    if isinstance(node, XType):
        return (entry.xkind or entry.kind) == node.kind
    if isinstance(node, Lname):
        target = _link_target(entry.stat)
        return target is not None and _glob(target, node.pattern, node.icase)
    st = entry.stat
    if isinstance(node, Perm):
        if st is None:
            return False
        mode = posix_mode(st) & _PERMISSION_BITS
        if node.bits == "exact":
            return mode == node.mode
        if node.bits == "all":
            return mode & node.mode == node.mode
        return node.mode == 0 or mode & node.mode != 0
    if isinstance(node, Count):
        value = _count(st, node.field) if st is not None else None
        if value is None:
            return False
        if node.cmp == "+":
            return value > node.count
        if node.cmp == "-":
            return value < node.count
        return value == node.count
    if isinstance(node, Used):
        if st is None:
            return False
        accessed = iso_timestamp(st.atime or st.modified)
        changed = iso_timestamp(st.ctime or st.modified)
        if accessed is None or changed is None:
            return False
        days = (accessed - changed) / SECONDS_PER_DAY
        if node.cmp == "+":
            return days > node.days
        if node.cmp == "-":
            return days < node.days
        return node.days - 1 < days < node.days
    if isinstance(node, Owner):
        return st is not None and _owns(node, st)
    if isinstance(node, NoOwner):
        owner = None if st is None else st.gid if node.group else st.uid
        return isinstance(owner, int) or (
            isinstance(owner, str) and owner.isdigit()
        )
    if isinstance(node, Access):
        # access(2) follows a link: a live one answers with what it
        # leads to, which the walk read as the entry's target.
        held = (
            entry.target
            if st is not None and st.type is FileType.SYMLINK
            else st
        )
        if held is None:
            return False
        return posix_mode(held) & _ACCESS_BITS[node.mode] != 0
    if isinstance(node, Size):
        # An entry the walk could not stat has no size to compare.
        if entry.kind != "d" and st is None:
            return False
        size = DIR_SIZE if entry.kind == "d" or st is None else st.size or 0
        return not (
            (node.min is not None and size < node.min)
            or (node.max is not None and size > node.max)
        )
    if isinstance(node, Empty):
        return entry.is_empty is True
    return None


def evaluate(node: PredNode, entry: FindEntry, effects: Effects) -> bool:
    """Whether the expression holds for one entry, recording what it did.

    Evaluation short-circuits the way GNU's does (``-a`` stops at the
    first false, ``-o`` at the first true), so an action or a prune is
    reached exactly when the reference would reach it, and nothing runs after a
    ``-quit``. The tests and connectives every entry meets are told
    apart first.

    Args:
        node (PredNode): the predicate tree.
        entry (FindEntry): the entry under test.
        effects (Effects): filled in as actions are reached.
    """
    answer = _test(node, entry)
    if answer is not None:
        return answer
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
            if effects.quit:
                return True
        return True
    if isinstance(node, Or):
        mark = len(effects.deferred)
        for kid in node.kids:
            before = len(effects.deferred)
            if evaluate(kid, entry, effects):
                del effects.deferred[mark:before]
                return True
            if effects.quit:
                return False
        return False
    if isinstance(node, Quit):
        node.fired.append(entry.key)
        effects.quit = True
        return True
    if isinstance(node, TrueNode):
        return True
    if isinstance(node, Action):
        effects.acted = True
        return True
    if isinstance(node, Prune):
        # Only a directory has contents to skip; a file key that is also
        # a directory prefix (an object store allows both) must not
        # drop what sits under the directory.
        effects.pruned = effects.pruned or entry.kind == "d"
        return True
    if isinstance(node, Mtime):
        # An entry the walk fetched no time for passes here and meets
        # the expression's flat window afterwards; the test is recorded
        # so a -prune skipped on its strength still counts.
        stamp = _stamp(entry, node.field)
        if stamp is None:
            effects.deferred.append(node)
            return True
        return in_mtime_window(stamp, node.lo, node.hi)
    raise TypeError(f"unknown predicate node: {node!r}")


def _nodes(node: PredNode) -> list[PredNode]:
    if isinstance(node, Not):
        return [node, *_nodes(node.kid)]
    if isinstance(node, (And, Or)):
        return [node, *(n for kid in node.kids for n in _nodes(kid))]
    return [node]


def tree_has(node: PredNode, kinds: tuple[type, ...]) -> bool:
    """Whether the tree holds a node of one of ``kinds``.

    Args:
        node (PredNode): the predicate tree.
        kinds (tuple[type, ...]): the node classes looked for.
    """
    return any(isinstance(n, kinds) for n in _nodes(node))


def tree_has_action(node: PredNode) -> bool:
    """Whether the tree holds an action, ``-quit`` among them: the reference prints
    no row of its own for an expression that has one.

    Args:
        node (PredNode): the predicate tree.
    """
    return tree_has(node, (Action, Quit))


def tree_has_time(node: PredNode) -> bool:
    return tree_has(node, (Mtime,))


def tree_reads_stat(node: PredNode) -> bool:
    """Whether a test reads the entry's stat: a time, its size, mode,
    links, owner or a link's target.

    Args:
        node (PredNode): the predicate tree.
    """
    return tree_has(
        node, (Mtime, Size, Perm, Count, Used, Owner, NoOwner, Access, Lname)
    )


def tree_reads_link(node: PredNode) -> bool:
    """Whether a test reads what is on the other side of a link
    (``-xtype``, and the access tests a live link answers through).

    Args:
        node (PredNode): the predicate tree.
    """
    return tree_has(node, (XType, Access))


def quit_fired(node: PredNode) -> bool:
    """Whether a ``-quit`` in the evaluated tree was reached.

    Args:
        node (PredNode): the predicate tree, after evaluation.
    """
    return any(isinstance(n, Quit) and n.fired for n in _nodes(node))


async def prime_regexes(node: PredNode, keys: Iterable[str]) -> None:
    """Answer every ``-regex`` in the tree for the entries named, ahead of
    the evaluation that reads them.

    Each node's expression is compiled once (``posix_regex`` caches it)
    and must match the whole printed path: the leftmost-longest match
    from its first byte reaches its last. An entry already answered is
    not searched again.

    Args:
        node (PredNode): the bound predicate tree.
        keys (Iterable[str]): the entries' mount-relative keys.
    """
    regexes = [n for n in _nodes(node) if isinstance(n, Regex)]
    if not regexes:
        return
    wanted = list(keys)
    for rx in regexes:
        compiled = posix_regex(
            byte_view(rx.pattern, rx.utf8),
            rx.extended,
            rx.dialect,
            rx.icase,
            rx.utf8,
        )
        for key in wanted:
            if key in rx.hits:
                continue
            subject = byte_view(shown_path(rx, key), rx.utf8)
            groups = await compiled.search(subject)
            rx.hits[key] = groups is not None and groups[0] == (
                0,
                len(subject),
            )


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


def time_tests_failing(node: PredNode) -> PredNode:
    """The tree with every time test false.

    An entry that reports no mtime once asked passes no time test, the
    way the flat window admits no such row, so it matches and reaches
    the prunes it would with every test false.

    Args:
        node (PredNode): the predicate tree.
    """
    if isinstance(node, Mtime):
        return Not(TrueNode())
    if isinstance(node, Not):
        return Not(time_tests_failing(node.kid))
    if isinstance(node, And):
        return And([time_tests_failing(kid) for kid in node.kids])
    if isinstance(node, Or):
        return Or([time_tests_failing(kid) for kid in node.kids])
    return node


def tree_has_empty(node: PredNode) -> bool:
    if isinstance(node, Empty):
        return True
    if isinstance(node, Not):
        return tree_has_empty(node.kid)
    if isinstance(node, (And, Or)):
        return any(tree_has_empty(kid) for kid in node.kids)
    return False


def verdict(
    entry: FindEntry,
    tree: PredNode,
    min_depth: int | None,
    acts: bool | None = None,
) -> tuple[bool, bool]:
    """Whether ``find`` reports the entry, and whether a walk stays out of
    it.

    With no action in the tree the rows are the entries the whole
    expression holds for, GNU's implicit ``-print``. With one, they are
    the entries an action reached: ``-path ./skip -prune -o -type f
    -print`` holds for ``./skip`` but never prints it. ``-mindepth``
    applies neither tests nor actions above its level, so a shallow
    directory is not pruned either. A directory is pruned when the
    evaluation reached a ``-prune``, or passed every one on the strength
    of a time test it carried no time for (``-mtime 1 -o -prune``),
    since that time may send it into one: the most a walk without it
    can say.

    Args:
        entry (FindEntry): the entry under test.
        tree (PredNode): the predicate tree.
        min_depth (int | None): ``-mindepth``.
        acts (bool | None): whether the tree holds an action, for a walk
            that works it out once for every entry; None works it out.
    """
    if min_depth is not None and entry.depth < min_depth:
        return False, False
    effects = Effects()
    matched = evaluate(tree, entry, effects)
    pruned = effects.pruned or (
        entry.kind == "d" and bool(effects.deferred) and tree_has_prune(tree)
    )
    if acts is None:
        acts = tree_has_action(tree)
    return (effects.acted if acts else matched), pruned


def keep(
    entry: FindEntry,
    tree: PredNode,
    min_depth: int | None,
    acts: bool | None = None,
) -> bool:
    """Whether ``find`` reports the entry (``verdict``).

    Args:
        entry (FindEntry): the entry under test.
        tree (PredNode): the predicate tree.
        min_depth (int | None): ``-mindepth``.
        acts (bool | None): whether the tree holds an action.
    """
    return verdict(entry, tree, min_depth, acts)[0]


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
    mtime: float | None = None,
    stat: FileStat | None = None,
) -> None:
    """Append the search start path to results when it matches.

    Shared by every backend find op so the start path is emitted
    uniformly. GNU lists the start path itself at depth 0, so bare
    ``find <dir>``, ``-type d`` on the root, ``-maxdepth 0`` (just the
    start), ``-mindepth 0`` (start included), and ``-name``/``-iname``
    against the start's own basename all behave the same everywhere.

    A directory start path contributes ``DIR_SIZE`` to ``-size``
    filtering, the size ``ls -l`` shows for it and GNU compares on
    ext4. Backends whose start path can be a file
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
        mtime (float | None): Start path epoch-second mtime for the
            tree's time tests; None if unknown.
        stat (FileStat | None): the start path's stat, for the tests that
            read one.
    """
    if not exists:
        return
    if maxdepth is not None and maxdepth < 0:
        return
    entry = FindEntry(
        key=start_key,
        name=start_name,
        kind=kind,
        depth=0,
        is_empty=is_empty,
        mtime=mtime,
        stat=stat,
    )
    if not keep(entry, tree, mindepth):
        return
    if min_size is not None or max_size is not None:
        # Unknown rendered sizes count as zero, like walked entries.
        effective = (
            (size or 0) if kind == "f" else DIR_SIZE if kind == "d" else 0
        )
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


def args_to_tree(args: FindArgs) -> PredNode:
    if args.tree is not None:
        return args.tree
    return build_tree(
        name=args.name,
        iname=args.iname,
        path_pattern=args.path_pattern,
        type=args.type,
        name_exclude=args.name_exclude,
        or_names=args.or_names,
        empty=args.empty,
    )


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
        return (virtual.rstrip("/") or "") + "/" + row[len(stem) :]
    return row


def printf_kind(st: FileStat | None) -> str:
    """The one-letter kind a -printf %y/%Y directive renders for a stat.

    Args:
        st (FileStat | None): the row's stat, None when unknown.
    """
    if st is None or st.type is None:
        return "f"
    return _TYPE_LETTER.get(st.type, "f")
