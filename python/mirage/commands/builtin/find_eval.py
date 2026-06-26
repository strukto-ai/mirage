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

from dataclasses import dataclass
from fnmatch import fnmatch

from mirage.types import FindType, PathSpec


def start_basename(path: PathSpec | str) -> str:
    """Basename of a find start path, as GNU would print and match it.

    Single source of truth for the start path's own name across every
    backend find op. Reads ``path.original`` (the path as written, with
    its mount prefix) so the name is correct whether the start is the
    mount root or a nested directory.

    Args:
        path (PathSpec | str): The find start path.

    Returns:
        str: The start path's basename, or "" for the bare root "/".
    """
    original = path.original if isinstance(path, PathSpec) else str(path)
    return original.rstrip("/").rsplit("/", 1)[-1]


@dataclass(frozen=True, slots=True)
class FindEntry:
    key: str
    name: str
    kind: str
    depth: int
    is_empty: bool | None = None


@dataclass(frozen=True, slots=True)
class Name:
    pattern: str
    icase: bool = False


@dataclass(frozen=True, slots=True)
class Path:
    pattern: str


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


PredNode = Name | Path | Type | Empty | Not | And | Or | TrueNode


def eval_predicate(node: PredNode, entry: FindEntry) -> bool:
    if isinstance(node, TrueNode):
        return True
    if isinstance(node, Empty):
        return entry.is_empty is True
    if isinstance(node, Name):
        if node.icase:
            return fnmatch(entry.name.lower(), node.pattern.lower())
        return fnmatch(entry.name, node.pattern)
    if isinstance(node, Path):
        return fnmatch(entry.key, node.pattern)
    if isinstance(node, Type):
        return entry.kind == node.kind
    if isinstance(node, Not):
        return not eval_predicate(node.kid, entry)
    if isinstance(node, And):
        return all(eval_predicate(kid, entry) for kid in node.kids)
    if isinstance(node, Or):
        return any(eval_predicate(kid, entry) for kid in node.kids)
    raise TypeError(f"unknown predicate node: {node!r}")


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


def keep(entry: FindEntry, tree: PredNode, min_depth: int | None) -> bool:
    if min_depth is not None and entry.depth < min_depth:
        return False
    return eval_predicate(tree, entry)


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

    Size filtering applies only to a file start path; directory roots
    pass ``size=None`` and skip it. Backends whose start path can be a
    file (ram/redis/chroma/dify/notion) pass the start's size so
    ``find <file> -size`` filters the start like GNU does.

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
    if kind == "f" and size is not None:
        if min_size is not None and size < min_size:
            return
        if max_size is not None and size > max_size:
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
