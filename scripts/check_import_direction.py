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
from collections import defaultdict
from pathlib import Path

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

TS_SPEC = re.compile(
    r"""^\s*(import|export)\s+(type\s+)?([^'"]*?)\s*from\s*['"]([^'"]+)['"]"""
    r"""|\bimport\(\s*['"]([^'"]+)['"]\s*\)""",
    re.M,
)
CORE_PACKAGE = "@struktoai/mirage-core/"


def python_edges() -> set[str]:
    """Each import of a high package from a low one, as `file -> module`."""
    edges: set[str] = set()
    for low in LOW:
        for path in sorted((PY_ROOT / low).rglob("*.py")):
            tree = ast.parse(path.read_text())
            for node in ast.walk(tree):
                modules: list[str] = []
                if isinstance(node, ast.ImportFrom) and node.level == 0:
                    modules = [node.module or ""]
                elif isinstance(node, ast.Import):
                    modules = [alias.name for alias in node.names]
                for module in modules:
                    parts = module.split(".")
                    if parts[0] == "mirage" and len(parts) > 1:
                        if parts[1] in HIGH:
                            rel = path.relative_to(ROOT).as_posix()
                            edges.add(f"{rel} -> {module}")
    return edges


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


def _imports(path: Path) -> list[tuple[str, bool]]:
    """Each specifier `path` imports and whether only types come of it."""
    found: list[tuple[str, bool]] = []
    for match in TS_SPEC.finditer(path.read_text()):
        spec = match.group(4) or match.group(5)
        clause = (match.group(3) or "").strip()
        typed = bool(match.group(2)) or (
            clause.startswith("{")
            and all(
                name.strip().startswith("type ")
                for name in clause.strip("{}").split(",")
                if name.strip()
            )
        )
        found.append((spec, typed))
    return found


def typescript_edges() -> set[str]:
    """Each import of a high directory from a low one, as `file -> module`."""
    edges: set[str] = set()
    for package in TS_PACKAGES:
        src = TS_ROOT / package / "src"
        for low in LOW:
            if not (src / low).is_dir():
                continue
            for path in _ts_files(src / low):
                for spec, _ in _imports(path):
                    target = _resolve(src, path, spec)
                    if target is None:
                        continue
                    if target.relative_to(TS_ROOT).parts[2] in HIGH:
                        rel = path.relative_to(ROOT).as_posix()
                        edges.add(
                            f"{rel} -> {target.relative_to(ROOT).as_posix()}"
                        )
    return edges


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
            for spec, types_only in _imports(path):
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


def main() -> int:
    # A low package importing a high one predates the gate in a few
    # places, each excused with its reason in import_exceptions.json.
    # --strict fails on a new edge, on an excuse whose edge is gone, on
    # any runtime import cycle, and when the files on type-only cycles
    # move off their baseline in either direction.
    parser = argparse.ArgumentParser()
    parser.add_argument("--strict", action="store_true")
    args = parser.parse_args()
    exceptions = json.loads(EXCEPTIONS.read_text())
    excused: dict[str, str] = exceptions["edges"]
    edges = python_edges() | typescript_edges()
    unexcused = sorted(edges - set(excused))
    stale = sorted(set(excused) - edges)
    runtime, typed = typescript_cycles()
    baseline = exceptions["type_cycle_files"]
    for edge in unexcused:
        print(f"  low imports high: {edge}")
    for edge in stale:
        print(f"  stale excuse (edge is gone, drop it): {edge}")
    for path in sorted(runtime):
        print(f"  on a runtime import cycle: {path}")
    print(f"\nunexcused low-to-high imports: {len(unexcused)} (baseline 0)")
    print(f"files on runtime import cycles: {len(runtime)} (baseline 0)")
    print(
        f"files on type-only import cycles: {len(typed)} (baseline {baseline})"
    )
    failed = bool(unexcused or stale or runtime or len(typed) != baseline)
    return 1 if args.strict and failed else 0


if __name__ == "__main__":
    sys.exit(main())
