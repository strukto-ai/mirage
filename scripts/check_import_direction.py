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

import argparse
import ast
import json
import re
import sys
from collections import Counter, defaultdict
from collections.abc import Iterable
from pathlib import Path
from typing import NamedTuple

from check_layout_parity import test_only_modules

ROOT = Path(__file__).resolve().parent.parent
PY_ROOT = ROOT / "python" / "mirage"
TS_ROOT = ROOT / "typescript" / "packages"
EXCEPTIONS = ROOT / "scripts" / "parity" / "import_exceptions.json"

# Backends and what they are built from sit below the shell: a backend
# never reaches a command or the workspace that runs one.
LOW = ("accessor", "cache", "core", "utils", "view", "vfs")
HIGH = ("commands", "workspace")

# The packages that share core's layout; cli, server and agents sit
# above all of it.
TS_PACKAGES = ("core", "node", "browser")

# A command reaches files only through ctx.vfs. To a command a VFS object
# is a VFS module, the mount table, the caches, or one of these names
# from wherever it is re-exported, in either host's spelling.
VFS_OBJECTS = (
    "BaseVFS",
    "IndexCacheStore",
    "MountEntry",
    "MountRegistry",
    "namespaceOf",
    "namespace_of",
)

# Each CLI tree and the services whose accessor and core modules it may
# import: its own. A CLI may still run another (`gh repo clone` runs
# git) through commands/, which no rule here forbids.
CLI_ROOT = "commands/cli/builtin"
CLI_SERVICES: dict[str, tuple[str, ...]] = {
    "airtable": ("airtable",),
    "discord": ("discord",),
    "gh": ("github",),
    "git": (),
    "gws": ("google_api", "google", "gdocs", "gmail", "gsheets"),
    "hf": ("hf_hub", "hf_buckets"),
    "himalaya": ("email",),
    "linear": ("linear",),
    "ntn": ("notion",),
    "slack": ("slack",),
    "trello": ("trello",),
}
# The modules under accessor/ and core/ that serve no one service.
SHARED_CLIENTS = ("accessor/base", "core/jq", "core/render")


class Rule(NamedTuple):
    """No module under ``sources`` imports a module under ``targets``, or
    a name in ``names`` from any module, unless ``shared`` or ``allowed``
    lets it.

    Paths are package-relative and the same on both hosts: Python's
    ``mirage.<path>``, TypeScript's ``<package>/src/<path>`` in core,
    node and browser. A path names a module and everything below it.

    Args:
        key (str): the rule's short name, which the summary counts by.
        title (str): how a break of it is reported.
        sources (tuple[str, ...]): the modules it binds.
        targets (tuple[str, ...]): what they may not import.
        names (tuple[str, ...]): what they may not import by name.
        shared (tuple[str, ...]): paths under ``targets`` that every
            source may import all the same.
        allowed (tuple[tuple[str, str], ...]): ``(source, path or name)``
            pairs: what the sources under one path may import all the
            same.
    """

    key: str
    title: str
    sources: tuple[str, ...]
    targets: tuple[str, ...]
    names: tuple[str, ...] = ()
    shared: tuple[str, ...] = ()
    allowed: tuple[tuple[str, str], ...] = ()


RULES: tuple[Rule, ...] = (
    Rule("direction", "low imports high", LOW, HIGH),
    Rule(
        "A",
        "a command touches a VFS object",
        ("commands",),
        ("cache", "vfs", "workspace/mount"),
        names=VFS_OBJECTS,
        # The link and mount views are built from the namespace here, and
        # only here, until they hide in one place.
        allowed=(
            ("commands/builtin/utils/links", "namespace_of"),
            ("commands/builtin/utils/links", "namespaceOf"),
        ),
    ),
    *(
        Rule(
            "B",
            f"the {cli} CLI imports another service's client",
            (f"{CLI_ROOT}/{cli}",),
            ("accessor", "core"),
            shared=SHARED_CLIENTS
            + tuple(
                f"{layer}/{name}"
                for name in own
                for layer in ("accessor", "core")
            ),
        )
        for cli, own in CLI_SERVICES.items()
    ),
)

# A static import or re-export, a bare import run for its side effects,
# and a dynamic import, which is a type query when `typeof` precedes it or
# a member other than a promise method follows it.
TS_SPEC = re.compile(
    r"""^\s*(?:import|export)\s+(?P<type>type\s+)?(?P<clause>[^'"]*?)\s*"""
    r"""from\s*['"](?P<spec>[^'"]+)['"]"""
    r"""|^\s*import\s+['"](?P<bare>[^'"]+)['"]"""
    r"""|(?P<query>\btypeof\s+)?\bimport\(\s*['"](?P<dynamic>[^'"]+)['"]\s*\)"""
    r"""(?P<member>\.(?!then\b|catch\b|finally\b)[A-Za-z_$])?""",
    re.M,
)
# What a dynamic import is awaited into: a module object or names
# destructured off it, matched against the text just before `import(`.
TS_AWAITED = re.compile(
    r"""(?:const|let|var)\s+(?:(?P<module>[A-Za-z_$][\w$]*)|\{(?P<names>[^}]*)\})"""
    r"""\s*=\s*await\s+$"""
)
CORE_PACKAGE = "@struktoai/mirage-core/"


class Import(NamedTuple):
    """One TypeScript import: its specifier, whether only types come of
    it, and the names it binds; for a namespace import or a dynamic one
    awaited into a module object, the members read off that object (none
    for a default, bare or unbound dynamic import)."""

    spec: str
    typed: bool
    names: tuple[str, ...] = ()


def _within(path: str, prefixes: Iterable[str]) -> bool:
    """Whether ``path`` is one of ``prefixes`` or below one."""
    return any(path == p or path.startswith(f"{p}/") for p in prefixes)


def _breaks(
    rule: Rule, source: str, target: str, names: Iterable[str]
) -> list[str | None]:
    """What of one import breaks ``rule``: None for the module itself,
    else each forbidden name it imports.

    Args:
        rule (Rule): the rule.
        source (str): the importing module's package-relative path.
        target (str): the imported module's package-relative path.
        names (Iterable[str]): the names the import binds.
    """
    if not _within(source, rule.sources):
        return []
    allowed = {
        item for owner, item in rule.allowed if _within(source, [owner])
    }
    if (
        _within(target, rule.targets)
        and not _within(target, rule.shared)
        and not _within(target, allowed)
    ):
        return [None]
    return [n for n in names if n in rule.names and n not in allowed]


def _judge(
    source: str, target: str, names: Iterable[str], edge: str
) -> dict[str, str]:
    """Every break of one import, keyed by its edge, with the rule's title.

    Args:
        source (str): the importing module's package-relative path.
        target (str): the imported module's package-relative path.
        names (Iterable[str]): the names the import binds.
        edge (str): ``file -> module`` for the import.
    """
    found: dict[str, str] = {}
    names = tuple(names)
    for rule in RULES:
        for name in _breaks(rule, source, target, names):
            found[edge if name is None else f"{edge}:{name}"] = rule.title
    return found


def _absolute(path: Path, node: ast.ImportFrom) -> str:
    """The module a from-import names, a relative one resolved at `path`."""
    if node.level == 0:
        return node.module or ""
    parts = path.relative_to(PY_ROOT.parent).with_suffix("").parts
    base = parts[: len(parts) - node.level]
    return ".".join(base + ((node.module,) if node.module else ()))


def _python_path(module: str) -> str | None:
    """A mirage module's package-relative path, None outside mirage."""
    parts = module.split(".")
    return "/".join(parts[1:]) if parts[0] == "mirage" else None


def _python_module(module: str) -> bool:
    """Whether ``module`` is a mirage module or package on disk."""
    rel = _python_path(module)
    if not rel:
        return False
    base = PY_ROOT / rel
    return (
        base.with_suffix(".py").is_file() or (base / "__init__.py").is_file()
    )


def _python_members(tree: ast.AST, bound: str | None) -> tuple[str, ...]:
    """The attributes a module read off the name ``bound``."""
    if bound is None:
        return ()
    return tuple(
        dict.fromkeys(
            node.attr
            for node in ast.walk(tree)
            if isinstance(node, ast.Attribute)
            and isinstance(node.value, ast.Name)
            and node.value.id == bound
        )
    )


def python_imports(path: Path, text: str) -> list[tuple[str, tuple[str, ...]]]:
    """Each module ``text`` imports at ``path`` with the names it binds.

    A from-import of a submodule (``from mirage.workspace import mount``)
    imports that submodule. A module bound to a name binds what is read
    off it: ``files.namespace_of`` after ``from mirage.workspace import
    files`` imports ``namespace_of`` as surely as naming it does.

    Args:
        path (Path): the file under ``python/mirage``.
        text (str): its source.
    """
    found: list[tuple[str, tuple[str, ...]]] = []
    tree = ast.parse(text)
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            found.extend(
                (alias.name, _python_members(tree, alias.asname))
                for alias in node.names
            )
        elif isinstance(node, ast.ImportFrom):
            module = _absolute(path, node)
            names: list[str] = []
            for alias in node.names:
                sub = f"{module}.{alias.name}"
                if _python_module(sub):
                    bound = alias.asname or alias.name
                    found.append((sub, _python_members(tree, bound)))
                else:
                    names.append(alias.name)
            if names:
                found.append((module, tuple(names)))
    return found


def python_file_edges(path: Path, text: str) -> dict[str, str]:
    """Each rule break of one Python file, as ``file -> module`` (or
    ``file -> module:name``) to the rule's title.

    Args:
        path (Path): the file under ``python/mirage``.
        text (str): its source.
    """
    rel = path.relative_to(PY_ROOT).with_suffix("")
    parts = rel.parts[:-1] if rel.name == "__init__" else rel.parts
    source = "/".join(parts)
    shown = path.relative_to(ROOT).as_posix()
    found: dict[str, str] = {}
    for module, names in python_imports(path, text):
        target = _python_path(module)
        if target is not None:
            found |= _judge(source, target, names, f"{shown} -> {module}")
    return found


def python_edges() -> dict[str, str]:
    """Every rule break in ``python/mirage``."""
    found: dict[str, str] = {}
    for path in sorted(PY_ROOT.rglob("*.py")):
        found |= python_file_edges(path, path.read_text())
    return found


def _ts_files(src: Path) -> list[Path]:
    return sorted(
        path
        for path in src.rglob("*.ts")
        if not path.name.endswith((".test.ts", ".d.ts"))
        and "fixtures" not in path.relative_to(src).parts
    )


def _resolve(src: Path, path: Path, spec: str) -> Path | None:
    """The src-relative module a specifier names, None outside `src`."""
    if spec.startswith(CORE_PACKAGE):
        target = TS_ROOT / "core" / "src" / spec[len(CORE_PACKAGE) :]
    elif spec.startswith("."):
        target = (path.parent / spec).resolve()
    else:
        return None
    for candidate in (target, target.with_suffix(".ts"), target / "index.ts"):
        if candidate.suffix == ".ts" and candidate.is_file():
            return candidate
    return None


def _bound(clause: str) -> tuple[str, ...]:
    """The names an import or export clause binds from its module."""
    if "{" not in clause:
        return ()
    names: list[str] = []
    for part in clause[clause.index("{") + 1 : clause.rindex("}")].split(","):
        name = part.strip().removeprefix("type ").strip()
        if name:
            names.append(name.split(" as ")[0].strip())
    return tuple(names)


def _members(text: str, bound: str) -> tuple[str, ...]:
    """The members `text` reads off the module object named `bound`."""
    read = re.findall(
        rf"(?<![\w$.]){re.escape(bound)}\s*\??\.\s*([A-Za-z_$][\w$]*)", text
    )
    return tuple(dict.fromkeys(read))


def _module_names(text: str, match: re.Match[str]) -> tuple[str, ...]:
    """What a namespace or awaited dynamic import binds off its module:
    the members read off the object, or the names destructured from it."""
    namespace = re.fullmatch(
        r"\*\s+as\s+([A-Za-z_$][\w$]*)", (match["clause"] or "").strip()
    )
    if namespace:
        return _members(text, namespace[1])
    if not match["dynamic"] or match["query"] or match["member"]:
        return ()
    awaited = TS_AWAITED.search(text[: match.start()])
    if awaited is None:
        return ()
    if awaited["module"]:
        return _members(text, awaited["module"])
    return tuple(
        part.split(":")[0].strip()
        for part in awaited["names"].split(",")
        if part.strip()
    )


def _imports(text: str) -> list[Import]:
    """Each specifier `text` imports, whether only types come of it, and
    the names it binds."""
    found: list[Import] = []
    for match in TS_SPEC.finditer(text):
        spec = match["spec"] or match["bare"] or match["dynamic"]
        clause = (match["clause"] or "").strip()
        typed = bool(match["type"] or match["query"] or match["member"]) or (
            clause.startswith("{")
            and all(
                name.strip().startswith("type ")
                for name in clause.strip("{}").split(",")
                if name.strip()
            )
        )
        names = _bound(clause) or _module_names(text, match)
        found.append(Import(spec, typed, names))
    return found


def _ts_path(path: Path) -> str:
    """A TypeScript module's package-relative path, a package's
    ``index.ts`` named by its directory."""
    parts = path.relative_to(TS_ROOT).with_suffix("").parts[2:]
    return "/".join(parts[:-1] if parts and parts[-1] == "index" else parts)


def typescript_file_edges(path: Path, text: str) -> dict[str, str]:
    """Each rule break of one TypeScript file, as ``file -> module`` (or
    ``file -> module:name``) to the rule's title.

    Args:
        path (Path): the file under ``typescript/packages/<pkg>/src``.
        text (str): its source.
    """
    src = TS_ROOT.joinpath(*path.relative_to(TS_ROOT).parts[:2])
    source = _ts_path(path)
    shown = path.relative_to(ROOT).as_posix()
    found: dict[str, str] = {}
    for spec, _, names in _imports(text):
        target = _resolve(src, path, spec)
        if target is None:
            continue
        edge = f"{shown} -> {target.relative_to(ROOT).as_posix()}"
        found |= _judge(source, _ts_path(target), names, edge)
    return found


def typescript_edges() -> dict[str, str]:
    """Every rule break in core, node and browser, tests, fixtures and
    the helpers only tests import left out."""
    helpers = test_only_modules()
    found: dict[str, str] = {}
    for package in TS_PACKAGES:
        for path in _ts_files(TS_ROOT / package / "src"):
            if path.resolve() not in helpers:
                found |= typescript_file_edges(path, path.read_text())
    return found


def cli_drift(names: set[str]) -> tuple[list[str], list[str]]:
    """The CLI trees ``CLI_SERVICES`` misses, and the entries it holds for
    a tree neither host has.

    Args:
        names (set[str]): the CLI trees the hosts have.
    """
    return sorted(names - set(CLI_SERVICES)), sorted(set(CLI_SERVICES) - names)


def cli_trees() -> set[str]:
    """Every CLI tree on either host."""
    roots = [PY_ROOT / CLI_ROOT] + [
        TS_ROOT / package / "src" / CLI_ROOT for package in TS_PACKAGES
    ]
    return {
        child.name
        for root in roots
        if root.is_dir()
        for child in root.iterdir()
        if child.is_dir() and not child.name.startswith("__")
    }


def _cycle_files(graph: dict[Path, set[Path]]) -> set[Path]:
    """Every file on an import cycle (Tarjan's strongly connected parts)."""
    index: dict[Path, int] = {}
    low: dict[Path, int] = {}
    stack: list[Path] = []
    on_stack: set[Path] = set()
    cyclic: set[Path] = set()
    counter = 0
    for root in list(graph):
        if root in index:
            continue
        work = [(root, iter(graph.get(root, ())))]
        index[root] = low[root] = counter
        counter += 1
        stack.append(root)
        on_stack.add(root)
        while work:
            node, children = work[-1]
            advanced = False
            for child in children:
                if child not in index:
                    index[child] = low[child] = counter
                    counter += 1
                    stack.append(child)
                    on_stack.add(child)
                    work.append((child, iter(graph.get(child, ()))))
                    advanced = True
                    break
                if child in on_stack:
                    low[node] = min(low[node], index[child])
            if advanced:
                continue
            work.pop()
            if work:
                parent = work[-1][0]
                low[parent] = min(low[parent], low[node])
            if low[node] == index[node]:
                part = []
                while True:
                    member = stack.pop()
                    on_stack.discard(member)
                    part.append(member)
                    if member == node:
                        break
                if len(part) > 1:
                    cyclic.update(part)
    return cyclic


def typescript_cycles() -> tuple[set[str], set[str]]:
    """Files on a runtime import cycle, and on any cycle types included."""
    runtime: set[str] = set()
    typed: set[str] = set()
    for package in TS_PACKAGES:
        src = TS_ROOT / package / "src"
        values: dict[Path, set[Path]] = defaultdict(set)
        every: dict[Path, set[Path]] = defaultdict(set)
        for path in _ts_files(src):
            for spec, types_only, _ in _imports(path.read_text()):
                if spec.startswith(CORE_PACKAGE):
                    continue
                target = _resolve(src, path, spec)
                if target is None:
                    continue
                every[path].add(target)
                if not types_only:
                    values[path].add(target)
        runtime |= {
            p.relative_to(ROOT).as_posix() for p in _cycle_files(values)
        }
        typed |= {p.relative_to(ROOT).as_posix() for p in _cycle_files(every)}
    return runtime, typed


SELFTEST_TS = [
    ("import { a } from './a.ts'", [("./a.ts", False, ("a",))]),
    ("import type { A } from './a.ts'", [("./a.ts", True, ("A",))]),
    (
        "import { type A, type B } from './a.ts'",
        [("./a.ts", True, ("A", "B"))],
    ),
    ("import { a as b, c } from './a.ts'", [("./a.ts", False, ("a", "c"))]),
    ("import d, { e } from './a.ts'", [("./a.ts", False, ("e",))]),
    ("import * as m from './a.ts'", [("./a.ts", False, ())]),
    (
        "import * as m from './a.ts'\nm.b(m.c, m.b)",
        [("./a.ts", False, ("b", "c"))],
    ),
    ("export * from './a.ts'", [("./a.ts", False, ())]),
    ("export { f } from './a.ts'", [("./a.ts", False, ("f",))]),
    ("import './a.ts'", [("./a.ts", False, ())]),
    ("const m = await import('./a.ts')", [("./a.ts", False, ())]),
    (
        "const m = await import('./a.ts')\nm.b()",
        [("./a.ts", False, ("b",))],
    ),
    (
        "const { b, c: d } = await import('./a.ts')",
        [("./a.ts", False, ("b", "c"))],
    ),
    ("import('./a.ts').then(load)", [("./a.ts", False, ())]),
    ("type M = typeof import('./a.ts')", [("./a.ts", True, ())]),
    ("type T = import('./a.ts').T", [("./a.ts", True, ())]),
]

# Planted imports, each with the targets the rules must report for it.
SELFTEST_PY = [
    (
        "commands/builtin/planted.py",
        "from mirage.vfs.base import BaseVFS",
        ["mirage.vfs.base"],
    ),
    (
        "commands/builtin/planted.py",
        "import mirage.cache.context",
        ["mirage.cache.context"],
    ),
    (
        "commands/builtin/planted.py",
        "from ...cache import context",
        ["mirage.cache.context"],
    ),
    (
        "commands/builtin/planted.py",
        "from mirage.workspace import mount",
        ["mirage.workspace.mount"],
    ),
    (
        "commands/builtin/planted.py",
        "from mirage import BaseVFS",
        ["mirage:BaseVFS"],
    ),
    (
        "commands/builtin/planted.py",
        "from mirage.workspace.files import Files, namespace_of",
        ["mirage.workspace.files:namespace_of"],
    ),
    (
        "commands/builtin/planted.py",
        "from mirage.workspace import files\nfiles.namespace_of(files.Files)",
        ["mirage.workspace.files:namespace_of"],
    ),
    (
        "commands/builtin/planted.py",
        "import mirage.workspace.files as files\nfiles.namespace_of(vfs)",
        ["mirage.workspace.files:namespace_of"],
    ),
    (
        "commands/builtin/utils/links.py",
        "from mirage.workspace.files import namespace_of",
        [],
    ),
    (
        "commands/cli/builtin/gh/planted.py",
        "from mirage.core.slack.client import post",
        ["mirage.core.slack.client"],
    ),
    (
        "commands/cli/builtin/gh/planted.py",
        "from mirage.accessor import Accessor",
        ["mirage.accessor"],
    ),
    (
        "commands/cli/builtin/gh/planted.py",
        "from mirage.accessor.base import Accessor\n"
        "from mirage.core import render\n"
        "from mirage.core.github.client import get\n"
        "from mirage.commands.cli.builtin.git import GIT",
        [],
    ),
    (
        "core/planted.py",
        "from mirage.commands.config import Context",
        ["mirage.commands.config"],
    ),
]
SELFTEST_TS_RULES = [
    (
        "core/src/commands/builtin/generic/planted.ts",
        "import { namespaceOf } from '../../../workspace/files.ts'",
        ["typescript/packages/core/src/workspace/files.ts:namespaceOf"],
    ),
    (
        "core/src/commands/builtin/generic/planted.ts",
        "import * as files from '../../../workspace/files.ts'\n"
        "files.namespaceOf(ctx.vfs)",
        ["typescript/packages/core/src/workspace/files.ts:namespaceOf"],
    ),
    (
        "core/src/commands/builtin/generic/planted.ts",
        "const files = await import('../../../workspace/files.ts')\n"
        "files.namespaceOf(ctx.vfs)",
        ["typescript/packages/core/src/workspace/files.ts:namespaceOf"],
    ),
    (
        "core/src/commands/builtin/utils/links.ts",
        "import { namespaceOf } from '../../../workspace/files.ts'",
        [],
    ),
    (
        "core/src/commands/builtin/generic/planted.ts",
        "import type { BaseVFS } from '../../../vfs/base.ts'",
        ["typescript/packages/core/src/vfs/base.ts"],
    ),
    (
        "node/src/commands/planted.ts",
        "import { RAMVFS } from '@struktoai/mirage-core/vfs/ram/ram'",
        ["typescript/packages/core/src/vfs/ram/ram.ts"],
    ),
    (
        "core/src/commands/cli/builtin/gh/planted.ts",
        "import { post } from '../../../../core/slack/client.ts'",
        ["typescript/packages/core/src/core/slack/client.ts"],
    ),
    (
        "core/src/commands/cli/builtin/trello/planted.ts",
        "import { jsonBytes } from '../../../../core/render/json.ts'",
        [],
    ),
    (
        "core/src/vfs/planted.ts",
        "import { Command } from '../commands/config.ts'",
        ["typescript/packages/core/src/commands/config.ts"],
    ),
]


def _targets(edges: dict[str, str]) -> list[str]:
    return sorted(edge.split(" -> ", 1)[1] for edge in edges)


def selftest() -> int:
    """Check the import readers against each form they must tell apart,
    and every rule against imports planted to break it or not."""
    failed = 0
    for text, want in SELFTEST_TS:
        got = _imports(text)
        if got != want:
            print(f"  selftest: {text!r} read as {got}, want {want}")
            failed += 1
    node = ast.parse("from ...commands import x").body[0]
    assert isinstance(node, ast.ImportFrom)
    got_py = _absolute(PY_ROOT / "core" / "a" / "b.py", node)
    if got_py != "mirage.commands":
        print(f"  selftest: a relative import read as {got_py!r}")
        failed += 1
    planted: dict[str, str] = {}
    for rel, text, want in SELFTEST_PY:
        edges = python_file_edges(PY_ROOT / rel, text)
        planted |= edges
        if _targets(edges) != sorted(want):
            print(
                f"  selftest: {rel}: {text!r} broke {_targets(edges)}, want {want}"
            )
            failed += 1
    for rel, text, want in SELFTEST_TS_RULES:
        edges = typescript_file_edges(TS_ROOT / rel, text)
        planted |= edges
        if _targets(edges) != sorted(want):
            print(
                f"  selftest: {rel}: {text!r} broke {_targets(edges)}, want {want}"
            )
            failed += 1
    excused = json.loads(EXCEPTIONS.read_text())["edges"]
    if not set(planted) - set(excused):
        print("  selftest: --strict would pass the planted violations")
        failed += 1
    if cli_drift({"gh", "planted"}) != (
        ["planted"],
        sorted(set(CLI_SERVICES) - {"gh"}),
    ):
        print("  selftest: a CLI tree with no service map went unreported")
        failed += 1
    print(f"selftest: {failed} failed")
    return 1 if failed else 0


def main() -> int:
    # Each rule break that predates its rule is excused with its reason in
    # import_exceptions.json. --strict fails on a new break, on an excuse
    # whose edge is gone, on a CLI tree the service map misses, on any
    # runtime import cycle, and when the files on type-only cycles move
    # off their baseline in either direction.
    parser = argparse.ArgumentParser()
    parser.add_argument("--strict", action="store_true")
    parser.add_argument("--selftest", action="store_true")
    args = parser.parse_args()
    if args.selftest:
        return selftest()
    exceptions = json.loads(EXCEPTIONS.read_text())
    excused: dict[str, str] = exceptions["edges"]
    edges = python_edges() | typescript_edges()
    unexcused = sorted(set(edges) - set(excused))
    stale = sorted(set(excused) - set(edges))
    unmapped, unused = cli_drift(cli_trees())
    runtime, typed = typescript_cycles()
    baseline = exceptions["type_cycle_files"]
    for edge in unexcused:
        print(f"  {edges[edge]}: {edge}")
    for edge in stale:
        print(f"  stale excuse (edge is gone, drop it): {edge}")
    for name in unmapped:
        print(f"  CLI tree with no entry in CLI_SERVICES: {name}")
    for name in unused:
        print(f"  CLI_SERVICES entry for a tree neither host has: {name}")
    for path in sorted(runtime):
        print(f"  on a runtime import cycle: {path}")
    keys = {rule.title: rule.key for rule in RULES}
    held = Counter(keys[edges[edge]] for edge in edges if edge in excused)
    print()
    for key in dict.fromkeys(rule.key for rule in RULES):
        print(f"rule {key}: {held[key]} excused")
    print(f"unexcused rule breaks: {len(unexcused)} (baseline 0)")
    print(f"files on runtime import cycles: {len(runtime)} (baseline 0)")
    print(
        f"files on type-only import cycles: {len(typed)} (baseline {baseline})"
    )
    failed = bool(
        unexcused
        or stale
        or unmapped
        or unused
        or runtime
        or len(typed) != baseline
    )
    return 1 if args.strict and failed else 0


if __name__ == "__main__":
    sys.exit(main())
