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
from typing import TypedDict

from check_layout_parity import (
    PY_ROOT,
    ROOT,
    TS_PACKAGES,
    canonical,
    canonical_dir,
)

EXCEPTIONS = ROOT / "spec" / "symbol_exceptions.json"


class Exceptions(TypedDict, total=False):
    baseline: int
    modules: dict[str, dict[str, dict[str, str]]]


# JavaScript's TextEncoder/TextDecoder singletons; a Python str encodes
# itself, so these have no counterpart to mirror.
TS_CODECS = {"ENC", "DEC", "ENCODER", "DECODER", "encoder", "decoder"}
TYPE_VARS = ("TypeVar", "ParamSpec", "TypeVarTuple")

TS_DECL = re.compile(
    r"^(?:export\s+)?(?:declare\s+)?(?:default\s+)?(?:abstract\s+)?"
    r"(?:async\s+)?(?:function\*?|class|const|let|var|interface|type|enum)"
    r"\s+\*?\s*([A-Za-z_$][\w$]*)",
    re.M,
)
TS_EXPORT_LIST = re.compile(
    r"^export\s+(?:type\s+)?\{([^}]*)\}(?!\s*from)", re.M
)
TS_DESTRUCTURE = re.compile(
    r"^(?:export\s+)?(?:const|let|var)\s*[{\[]([^}\]]*)[}\]]\s*=", re.M
)


# A TypeScript command module registers its handler as a const built by
# command(); Python's @command decorates the handler itself, so the
# registration has no name of its own there.
TS_REGISTRATION = re.compile(
    r"^export\s+const\s+([A-Z][A-Z0-9_]*)\b[^=\n]*=\s*command\b", re.M
)

ALL_CAPS = re.compile(r"[A-Z0-9_]+")


def fold(name: str) -> str:
    """Fold a top-level name so a spelling convention is not a divergence.

    camelCase and snake_case fold together, and so do the two spellings
    of an acronym (``dispatchIO`` and ``dispatch_io``, ``WCFlags`` and
    ``WcFlags``) and of a digit run (``absentOn404`` and
    ``absent_on_404``). An ALL_CAPS constant stays as typed, so one side
    spelling a module constant as a camelCase value still counts.

    Args:
        name (str): the name as declared, a leading underscore included.
    """
    bare = name.lstrip("_")
    if ALL_CAPS.fullmatch(bare):
        return bare
    spaced = re.sub(r"([A-Z]+)([A-Z][a-z])", r"\1_\2", bare)
    spaced = re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", spaced)
    spaced = re.sub(r"([A-Za-z])(\d)", r"\1_\2", spaced)
    return spaced.lower()


def python_names(path: Path) -> dict[str, str]:
    """Top-level names a python module defines, keyed by folded name.

    Functions, classes and assignments, unpacked ones included, as
    typescript counts every top-level const. A TypeVar is skipped because
    typescript declares generics inline, a module logger because
    typescript has none, and a dunder because it is python's own.

    Args:
        path (Path): the module.
    """
    names: dict[str, str] = {}
    for node in ast.parse(path.read_text()).body:
        if isinstance(
            node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)
        ):
            names[fold(node.name)] = node.name
        elif isinstance(node, (ast.Assign, ast.AnnAssign)):
            value = node.value
            if isinstance(value, ast.Call) and (
                (
                    isinstance(value.func, ast.Name)
                    and value.func.id in TYPE_VARS
                )
                or ast.unparse(value.func) == "logging.getLogger"
            ):
                continue
            targets = (
                node.targets if isinstance(node, ast.Assign) else [node.target]
            )
            for target in targets:
                if isinstance(target, (ast.Tuple, ast.List)):
                    leaves = target.elts
                else:
                    leaves = [target]
                for leaf in leaves:
                    if isinstance(leaf, ast.Name) and not (
                        leaf.id.startswith("__") and leaf.id.endswith("__")
                    ):
                        names[fold(leaf.id)] = leaf.id
    return names


def typescript_names(paths: list[Path]) -> dict[str, str]:
    """Top-level names the typescript twins of one module declare.

    Exported or not, since python marks the same split with a leading
    underscore that folding drops.

    Args:
        paths (list[Path]): the core, node and browser files for one module.
    """
    names: dict[str, str] = {}
    for path in paths:
        text = path.read_text()
        found = set(TS_DECL.findall(text))
        for body in TS_EXPORT_LIST.findall(text):
            for part in body.split(","):
                part = re.sub(r"^type\s+", "", part.strip())
                if part:
                    found.add(part.split(" as ")[-1].strip())
        for body in TS_DESTRUCTURE.findall(text):
            for part in body.split(","):
                name = part.split(":")[-1].split("=")[0].strip(" .\n")
                if name:
                    found.add(name)
        found -= set(TS_REGISTRATION.findall(text))
        for name in sorted(found - TS_CODECS):
            names[fold(name)] = name
    return names


def modules() -> dict[str, tuple[Path, list[Path]]]:
    """Every module both languages have, keyed by its folded path.

    Returns:
        dict[str, tuple[Path, list[Path]]]: module -> (python, typescript).
    """
    py: dict[str, Path] = {}
    for path in PY_ROOT.rglob("*.py"):
        if "__pycache__" in path.parts or path.stem == "__init__":
            continue
        rel = canonical_dir(path.parent.relative_to(PY_ROOT).as_posix())
        py[f"{rel}/{canonical(path.stem)}"] = path
    ts: dict[str, list[Path]] = defaultdict(list)
    for package, prefix in TS_PACKAGES.items():
        src = ROOT / "typescript" / "packages" / package / "src"
        for path in src.rglob("*.ts"):
            if (
                path.name.endswith((".test.ts", ".d.ts"))
                or path.stem == "index"
            ):
                continue
            inner = path.parent.relative_to(src).as_posix()
            if prefix:
                inner = prefix if inner == "." else f"{prefix}/{inner}"
            ts[f"{canonical_dir(inner)}/{canonical(path.stem)}"].append(path)
    return {
        key.removeprefix("./"): (py[key], sorted(ts[key]))
        for key in sorted(py.keys() & ts.keys())
    }


def divergences() -> dict[str, dict[str, list[str]]]:
    """Names one language's twin of a module has and the other lacks.

    Returns:
        dict[str, dict[str, list[str]]]: module -> side -> names.
    """
    found: dict[str, dict[str, list[str]]] = {}
    for module, (py_path, ts_paths) in modules().items():
        py, ts = python_names(py_path), typescript_names(ts_paths)
        sides = {
            "python_only": sorted(py[k] for k in py.keys() - ts.keys()),
            "typescript_only": sorted(ts[k] for k in ts.keys() - py.keys()),
        }
        sides = {side: names for side, names in sides.items() if names}
        if sides:
            found[module] = sides
    return found


def excuse(
    found: dict[str, dict[str, list[str]]], exceptions: Exceptions
) -> tuple[dict[str, dict[str, list[str]]], list[str]]:
    """Drop excused names and list the exceptions nothing matches any more.

    Args:
        found (dict[str, dict[str, list[str]]]): every divergence.
        exceptions (Exceptions): the committed exceptions payload.
    """
    excused = exceptions.get("modules", {})
    remaining: dict[str, dict[str, list[str]]] = {}
    stale: list[str] = []
    for module, allowed in excused.items():
        for side, reasons in allowed.items():
            for name, reason in reasons.items():
                if not isinstance(reason, str) or not reason.strip():
                    stale.append(f"{module}: {side} {name} (no reason)")
                elif name not in found.get(module, {}).get(side, []):
                    stale.append(f"{module}: {side} {name}")
    for module, sides in found.items():
        for side, names in sides.items():
            keep = [
                n
                for n in names
                if n not in excused.get(module, {}).get(side, {})
            ]
            if keep:
                remaining.setdefault(module, {})[side] = keep
    return remaining, stale


def total(found: dict[str, dict[str, list[str]]]) -> int:
    return sum(
        len(names) for sides in found.values() for names in sides.values()
    )


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Diff the top-level names of each python/typescript module pair."
    )
    # Like the layout gate, --strict holds the count at the committed
    # baseline: a new divergence fails, and so does a fixed one until the
    # baseline is lowered to lock it in.
    parser.add_argument("--strict", action="store_true")
    parser.add_argument("--json", dest="as_json", action="store_true")
    args = parser.parse_args()

    exceptions: Exceptions = (
        json.loads(EXCEPTIONS.read_text()) if EXCEPTIONS.is_file() else {}
    )
    baseline = exceptions.get("baseline", 0)
    remaining, stale = excuse(divergences(), exceptions)
    count = total(remaining)
    if args.as_json:
        print(
            json.dumps(
                {
                    "baseline": baseline,
                    "total": count,
                    "stale": stale,
                    "modules": remaining,
                },
                indent=2,
            )
        )
    else:
        for module, sides in sorted(remaining.items()):
            for side, names in sides.items():
                print(f"  {module}: {side.replace('_', '-')} {names}")
        for entry in stale:
            print(f"  STALE exception: {entry}")
        print(f"\nunexcused divergences: {count} (baseline {baseline})")
    if not args.strict:
        return 0
    if stale:
        print(f"\nFAIL: {len(stale)} stale entries in {EXCEPTIONS.name}.")
        return 1
    if count != baseline:
        verb = "rose" if count > baseline else "fell"
        print(
            f"\nFAIL: name divergence {verb} from {baseline} to {count}. "
            + (
                "Name it as the other language does, or excuse it in "
                f"{EXCEPTIONS.name} with a reason."
                if count > baseline
                else f"Lower the baseline in {EXCEPTIONS.name}."
            )
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
