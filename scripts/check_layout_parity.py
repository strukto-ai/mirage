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
import json
import re
import sys
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PY_ROOT = ROOT / "python" / "mirage"

# Where each typescript package's `src/` sits inside python's single package.
# core/node/browser are three runtime halves of one namespace -- CLAUDE.md
# puts node-only code in `node` and browser-only code in `browser`, so their
# module sets are unioned against the same python directory. cli, server and
# agents are their own npm packages whose python twins are subpackages of
# `mirage`, which is why they need a prefix rather than an empty one.
TS_PACKAGES = {
    "core": "",
    "node": "",
    "browser": "",
    "cli": "cli",
    "server": "server",
    "agents": "agents",
}

EXCEPTIONS = ROOT / "spec" / "layout_exceptions.json"


@dataclass
class Findings:
    python_only_dirs: dict[str, None] = field(default_factory=dict)
    typescript_only_dirs: dict[str, None] = field(default_factory=dict)
    python_only: dict[str, list[str]] = field(default_factory=dict)
    typescript_only: dict[str, list[str]] = field(default_factory=dict)
    renamed: dict[str, list[str]] = field(default_factory=dict)

    def total(self) -> int:
        # Directories are presentational and deliberately excluded: a one-sided
        # directory contributes its modules to `python_only`/`typescript_only`,
        # so counting the directory too would double-count it. Counting
        # directories *instead* of their modules is what made the ratchet blind
        # to new modules added under a directory already in the baseline.
        return (sum(len(v) for v in self.python_only.values()) +
                sum(len(v) for v in self.typescript_only.values()) +
                sum(len(v) for v in self.renamed.values()))


def canonical(name: str) -> str:
    """Fold a module name so a rename does not read as a missing module.

    ``findEval.ts`` and ``find_eval.py`` are the same module spelled two
    ways, and so are ``_provision.py`` and ``provision.ts``, and
    ``claude-agent-sdk`` and ``claude_agent_sdk``. Folding camelCase,
    hyphens and a leading underscore separates "spelled differently" from
    "absent", which are different pieces of work.

    Args:
        name (str): A module or directory basename with no extension.

    Returns:
        str: The folded name.
    """
    spaced = re.sub(r"(?<!^)(?=[A-Z])", "_", name)
    return spaced.replace("-", "_").lower().lstrip("_")


def canonical_dir(rel: str) -> str:
    """Fold every segment of a directory path with :func:`canonical`.

    Args:
        rel (str): A posix relative directory path.

    Returns:
        str: The folded path.
    """
    if rel in ("", "."):
        return "."
    return "/".join(canonical(part) for part in rel.split("/"))


def python_modules() -> dict[str, dict[str, str]]:
    """Every python module, keyed by directory then folded name.

    ``__init__.py`` is skipped: python requires a package file per directory
    and typescript does not, so comparing them would report a gap in most of
    the tree that no one intends to close.

    Returns:
        dict[str, dict[str, str]]: directory -> folded name -> real name.
    """
    out: dict[str, dict[str, str]] = defaultdict(dict)
    for path in PY_ROOT.rglob("*.py"):
        if "__pycache__" in path.parts or path.stem == "__init__":
            continue
        rel = canonical_dir(path.parent.relative_to(PY_ROOT).as_posix())
        out[rel][canonical(path.stem)] = path.stem
    return dict(out)


def typescript_modules() -> dict[str, dict[str, str]]:
    """Every typescript module, keyed by directory then folded name.

    The three runtime packages are unioned: python's ``resource/disk`` has
    no counterpart in ``core`` because CLAUDE.md puts node-only code in
    ``node``, and that split is the design rather than a gap. ``index.ts``
    is skipped for the same reason ``__init__.py`` is.

    Returns:
        dict[str, dict[str, str]]: directory -> folded name -> real name.
    """
    out: dict[str, dict[str, str]] = defaultdict(dict)
    for package, prefix in TS_PACKAGES.items():
        src = ROOT / "typescript" / "packages" / package / "src"
        if not src.is_dir():
            continue
        for path in src.rglob("*.ts"):
            skip = (".test.ts", ".d.ts")
            if path.name.endswith(skip) or path.stem == "index":
                continue
            inner = path.parent.relative_to(src).as_posix()
            if not prefix:
                joined = inner
            elif inner == ".":
                joined = prefix
            else:
                joined = f"{prefix}/{inner}"
            out[canonical_dir(joined)][canonical(path.stem)] = path.stem
    return dict(out)


def collect(py: dict[str, dict[str, str]],
            ts: dict[str, dict[str, str]]) -> Findings:
    """Diff the two module maps.

    Args:
        py (dict[str, dict[str, str]]): the python map.
        ts (dict[str, dict[str, str]]): the typescript map.

    Returns:
        Findings: every divergence, grouped by kind.
    """
    found = Findings()
    # A one-sided directory records its modules as well as itself. Recording
    # only the directory would let it absorb any number of new modules without
    # moving the count, which is drift the ratchet is supposed to refuse.
    for rel in sorted(set(py) - set(ts)):
        found.python_only_dirs[rel] = None
        found.python_only[rel] = sorted(py[rel].values())
    for rel in sorted(set(ts) - set(py)):
        found.typescript_only_dirs[rel] = None
        found.typescript_only[rel] = sorted(ts[rel].values())
    for rel in sorted(set(py) & set(ts)):
        py_dir, ts_dir = py[rel], ts[rel]
        renamed = [
            f"{py_dir[key]}:{ts_dir[key]}"
            for key in sorted(set(py_dir) & set(ts_dir))
            if py_dir[key] != ts_dir[key]
        ]
        only_py = sorted(py_dir[k] for k in set(py_dir) - set(ts_dir))
        only_ts = sorted(ts_dir[k] for k in set(ts_dir) - set(py_dir))
        if renamed:
            found.renamed[rel] = renamed
        if only_py:
            found.python_only[rel] = only_py
        if only_ts:
            found.typescript_only[rel] = only_ts
    return found


def load_exceptions() -> dict[str, object]:
    if not EXCEPTIONS.is_file():
        return {"baseline": 0, "directories": {}, "modules": {}}
    loaded: dict[str, object] = json.loads(EXCEPTIONS.read_text())
    return loaded


def excuse(found: Findings,
           exceptions: dict[str, object]) -> tuple[Findings, list[str]]:
    """Drop excused findings and name any exception that no longer applies.

    A stale entry is the failure mode every hand-maintained allowlist in
    this repo has already hit, so it is reported as loudly as a new gap.

    Args:
        found (Findings): every divergence.
        exceptions (dict[str, object]): the committed exceptions payload.

    Returns:
        tuple[Findings, list[str]]: what is left, and the stale entries.
    """
    directories = exceptions.get("directories", {})
    modules = exceptions.get("modules", {})
    assert isinstance(directories, dict) and isinstance(modules, dict)
    stale: list[str] = []
    remaining = Findings()
    # An excused directory excuses everything inside it. That is what the
    # excuse claims -- there is no counterpart subtree to mirror -- so a new
    # module under `agents/agno` or `core/opfs` is expected growth, not drift.
    excused_dirs: dict[str, set[str]] = {"renamed": set()}

    for key, bucket in (("python_only", found.python_only_dirs),
                        ("typescript_only", found.typescript_only_dirs)):
        allowed = directories.get(key, {})
        assert isinstance(allowed, dict)
        excused_dirs[key] = set(allowed)
        target = (remaining.python_only_dirs
                  if key == "python_only" else remaining.typescript_only_dirs)
        for rel in bucket:
            if rel not in allowed:
                target[rel] = None
        stale += [
            f"directories.{key}.{rel}" for rel in allowed if rel not in bucket
        ]

    for key in ("python_only", "typescript_only", "renamed"):
        actual: dict[str, list[str]] = getattr(found, key)
        target_map: dict[str, list[str]] = getattr(remaining, key)
        for rel, names in actual.items():
            if rel in excused_dirs[key]:
                continue
            allowed_dir = modules.get(rel, {})
            assert isinstance(allowed_dir, dict)
            allowed_names = allowed_dir.get(key, {})
            assert isinstance(allowed_names, dict)
            left = [name for name in names if name not in allowed_names]
            if left:
                target_map[rel] = left
        for rel, allowed_dir in modules.items():
            assert isinstance(allowed_dir, dict)
            allowed_names = allowed_dir.get(key, {})
            assert isinstance(allowed_names, dict)
            live = set(actual.get(rel, []))
            stale += [
                f"modules.{rel}.{key}.{name}" for name in allowed_names
                if name not in live
            ]
    return remaining, sorted(set(stale))


def report(remaining: Findings, stale: list[str], baseline: int) -> None:
    # A one-sided directory is listed once, with the modules it counts for.
    # The per-module loops below skip it so it is not reported twice.
    for rel in remaining.python_only_dirs:
        names = remaining.python_only.get(rel, [])
        print(f"  python-only directory: mirage/{rel} ({len(names)} modules)")
    for rel in remaining.typescript_only_dirs:
        names = remaining.typescript_only.get(rel, [])
        print(f"  typescript-only directory: */src/{rel} "
              f"({len(names)} modules)")
    for rel, names in sorted(remaining.renamed.items()):
        for pair in names:
            py_name, ts_name = pair.split(":", 1)
            print(f"  {rel}: {py_name}.py is spelled {ts_name}.ts")
    for rel, names in sorted(remaining.python_only.items()):
        if rel not in remaining.python_only_dirs:
            print(f"  {rel}: python-only {names}")
    for rel, names in sorted(remaining.typescript_only.items()):
        if rel not in remaining.typescript_only_dirs:
            print(f"  {rel}: typescript-only {names}")
    if stale:
        print()
        for entry in stale:
            print(f"  STALE exception (the divergence is gone): {entry}")
    print()
    print(f"unexcused divergences: {remaining.total()} (baseline {baseline})")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Diff the python and typescript module layouts.")
    # Advisory by default because 200-odd divergences predate the gate and
    # each needs its own decision. --strict does not demand zero: it fails
    # only when the count rises above the committed baseline, so new drift
    # is blocked while the existing backlog stays visible and countable.
    parser.add_argument("--strict", action="store_true")
    parser.add_argument("--json", dest="as_json", action="store_true")
    args = parser.parse_args()

    exceptions = load_exceptions()
    baseline_value = exceptions.get("baseline", 0)
    baseline = baseline_value if isinstance(baseline_value, int) else 0
    found = collect(python_modules(), typescript_modules())
    remaining, stale = excuse(found, exceptions)

    if args.as_json:
        print(
            json.dumps(
                {
                    "baseline": baseline,
                    "total": remaining.total(),
                    "stale": stale,
                    "python_only_dirs": sorted(remaining.python_only_dirs),
                    "typescript_only_dirs": sorted(
                        remaining.typescript_only_dirs),
                    "renamed": remaining.renamed,
                    "python_only": remaining.python_only,
                    "typescript_only": remaining.typescript_only,
                },
                indent=2,
                sort_keys=True,
            ))
    else:
        report(remaining, stale, baseline)

    if not args.strict:
        return 0
    if stale:
        print(f"\nFAIL: {len(stale)} stale entries in {EXCEPTIONS.name}; "
              "delete them or restore the divergence they describe.")
        return 1
    if remaining.total() > baseline:
        print(f"\nFAIL: layout divergence rose from {baseline} to "
              f"{remaining.total()}. Mirror the module, or add it to "
              f"{EXCEPTIONS.name} with a reason.")
        return 1
    if remaining.total() < baseline:
        print(f"\nFAIL: layout divergence fell from {baseline} to "
              f"{remaining.total()}. Lower the baseline in "
              f"{EXCEPTIONS.name} to lock the improvement in.")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
