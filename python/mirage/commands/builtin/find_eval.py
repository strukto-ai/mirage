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
from typing import TYPE_CHECKING

from mirage.types import FindType

if TYPE_CHECKING:
    from mirage.commands.builtin.generic.find import FindArgs


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


def args_to_tree(args: "FindArgs") -> PredNode:
    if args.tree is not None:
        return args.tree
    return build_tree(name=args.name,
                      iname=args.iname,
                      path_pattern=args.path_pattern,
                      type=args.type,
                      name_exclude=args.name_exclude,
                      or_names=args.or_names,
                      empty=args.empty)
