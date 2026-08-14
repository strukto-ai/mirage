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
from pathlib import Path

import mirage.commands
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import spec_flag_names

QUERY_METHODS = frozenset({
    "as_bool",
    "as_int",
    "as_float",
    "as_str",
    "as_list",
    "as_paths",
    "raw",
})

ROOT = Path(mirage.commands.__path__[0])


def _spec_keys(tree: ast.Module) -> set[str]:
    """Every SPECS[...] subscript with a literal key in the module."""
    keys: set[str] = set()
    for node in ast.walk(tree):
        if (isinstance(node, ast.Subscript)
                and isinstance(node.value, ast.Name)
                and node.value.id == "SPECS"
                and isinstance(node.slice, ast.Constant)
                and isinstance(node.slice.value, str)):
            keys.add(node.slice.value)
    return keys


def _literal_queries(tree: ast.Module) -> list[tuple[int, str, str]]:
    """Every `<x>.as_*("name")` / `<x>.raw("name")` call with a literal.

    Returns (lineno, method, name) triples. Non-literal names are the
    runtime KeyError's job; the static gate covers the spelled-out ones,
    which is every call today.
    """
    out: list[tuple[int, str, str]] = []
    for node in ast.walk(tree):
        if (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                and node.func.attr in QUERY_METHODS and node.args
                and isinstance(node.args[0], ast.Constant)
                and isinstance(node.args[0].value, str)):
            out.append((node.lineno, node.func.attr, node.args[0].value))
    return out


def test_flag_query_names_are_declared_by_a_spec_in_the_module():
    """A typo'd FlagView query fails here, not at the first runtime hit.

    FlagView's spec binding raises KeyError when a command queries a
    name its spec never declares — but only on the code path that runs.
    This walks every module under mirage/commands that binds a spec
    (``SPECS["x"]`` appears in it) and checks each literal query name
    against the union of those specs' dests, so an undeclared spelling
    is caught with zero coverage. Modules that query through a
    passed-in FlagView with no SPECS binding of their own are checked
    where the view is constructed. Mirrors flag_query_names.test.ts.
    """
    offenders: list[str] = []
    for path in sorted(ROOT.rglob("*.py")):
        tree = ast.parse(path.read_text())
        keys = _spec_keys(tree)
        if not keys:
            continue
        allowed: set[str] = set()
        for key in keys:
            spec = SPECS.get(key)
            if spec is not None:
                allowed |= spec_flag_names(spec)
        if not allowed:
            continue
        for lineno, method, name in _literal_queries(tree):
            if name not in allowed:
                rel = path.relative_to(ROOT.parent.parent)
                offenders.append(
                    f"{rel}:{lineno}: .{method}({name!r}) — not a dest of "
                    f"{sorted(keys)}")
    assert not offenders, (
        "these FlagView queries name a flag no spec bound in the module "
        "declares (typo, or the wrong spec):\n" + "\n".join(offenders))
