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

import ast
import pathlib

SRC = pathlib.Path(__file__).resolve().parents[2] / "mirage"

# The namespace's own link table answers for every session at once: a
# link a session cannot see is still in it, with its row and its target.
# Above the dispatcher a link is read through the session's table
# (`Namespace.session_links`), which answers as the session sees it, so
# a link it cannot see is no link to any command. Reading the whole
# table there is how `readlink -f` came to go quiet on a hidden link, a
# hard link came to copy one, and `touch -h` came to touch one, each
# while the same name truly absent answered otherwise.
#
# The dispatcher is the one reader of the whole table: it decides what a
# session sees, and refuses a write over a name it cannot see.
WHOLE_TABLE = "mirage/workspace/dispatcher/dispatcher.py"

MEMBERS = frozenset(
    {
        "follow",
        "follow_parent",
        "is_link",
        "readlink",
        "link_stat_at",
        "symlink_targets",
        "link_stats_below",
        "link_names_under",
    }
)

RECEIVERS = frozenset({"namespace", "_namespace"})


def _receiver(node: ast.expr) -> str | None:
    """The name a member is read off: ``namespace`` in
    ``namespace.follow`` and in ``self._namespace.follow``.

    Args:
        node (ast.expr): the expression the attribute is read from.
    """
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return node.attr
    return None


def _links_slots(trees: dict[str, ast.Module]) -> dict[str, set[int]]:
    """Where each function takes a link table: the positions, ``self``
    aside, of a parameter named ``links``, by function name.

    Args:
        trees (dict[str, ast.Module]): every module, parsed.
    """
    slots: dict[str, set[int]] = {}
    for tree in trees.values():
        for node in ast.walk(tree):
            if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            names = [
                a.arg
                for a in node.args.posonlyargs + node.args.args
                if a.arg not in ("self", "cls")
            ]
            if "links" in names:
                slots.setdefault(node.name, set()).add(names.index("links"))
    return slots


def _callee(call: ast.Call) -> str | None:
    """A call's function name, ``f`` in ``f(x)`` and in ``o.f(x)``.

    Args:
        call (ast.Call): the call.
    """
    if isinstance(call.func, ast.Name):
        return call.func.id
    if isinstance(call.func, ast.Attribute):
        return call.func.attr
    return None


def _whole_table_reads() -> set[tuple[str, str, int]]:
    """Every read of the namespace's link table, and every hand-off of
    the namespace as a link table (``links=namespace``, or the namespace
    in the place of a ``links`` parameter), as (module path, enclosing
    function, line).

    Returns:
        set[tuple[str, str, int]]: repo-relative path, function, line.
    """
    trees = {
        path.relative_to(SRC.parent).as_posix(): ast.parse(path.read_text())
        for path in sorted(SRC.rglob("*.py"))
    }
    slots = _links_slots(trees)
    found: set[tuple[str, str, int]] = set()
    for rel, tree in trees.items():
        if rel == WHOLE_TABLE:
            continue
        for node in ast.walk(tree):
            if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            for sub in ast.walk(node):
                if (
                    isinstance(sub, ast.Attribute)
                    and sub.attr in MEMBERS
                    and _receiver(sub.value) in RECEIVERS
                ):
                    found.add((rel, node.name, sub.lineno))
                if isinstance(sub, ast.keyword) and (
                    sub.arg == "links" and _receiver(sub.value) in RECEIVERS
                ):
                    found.add((rel, node.name, sub.value.lineno))
                if isinstance(sub, ast.Call):
                    for slot in slots.get(_callee(sub) or "", ()):
                        if (
                            slot < len(sub.args)
                            and _receiver(sub.args[slot]) in RECEIVERS
                        ):
                            found.add((rel, node.name, sub.lineno))
    return found


def test_links_above_the_dispatcher_are_the_sessions():
    reads = _whole_table_reads()
    assert not reads, (
        "the namespace's whole link table read above the dispatcher: "
        f"{sorted(reads)}. Read the session's instead "
        "(`namespace.session_links(session)`), which answers as the "
        "session sees each link."
    )
