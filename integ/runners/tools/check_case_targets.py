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
import collections
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
CASE_ROOT = ROOT / "integ"
EXCEPTIONS = CASE_ROOT / "target_exceptions.json"

# Directories whose files are one scenario each rather than one command
# family, so the modal set across them means nothing: integ/cli holds a
# separate program per file and integ/vfs holds a separate backend
# per file, and in both a file naming fewer targets is the point.
UNRELATED_DIRS = ("integ/cli", "integ/vfs", "integ/runtime")


def case_files() -> list[Path]:
    return sorted(p for p in CASE_ROOT.rglob("*.json")
                  if "node_modules" not in p.parts)


def case_targets(paths: list[Path]) -> dict[str, set[str]]:
    """Collect the target set each individual case exercises.

    Keyed per case, never per file: a sequence-style file states the same
    scenario across prep/act/verify cases, so a backend dropped from only
    the verifying one still runs every step that cannot fail and skips the
    assertion. A union over the file would show that backend as covered
    and the gate would read as green over the exact hole it exists to
    find.

    Args:
        paths (list[Path]): every candidate json file under ``integ/``.

    Returns:
        dict[str, set[str]]: ``<path> :: <case id>`` to the targets it
            names.
    """
    out: dict[str, set[str]] = {}
    for path in paths:
        try:
            loaded = json.loads(path.read_text())
        except ValueError:
            continue
        if not isinstance(loaded, dict) or "cases" not in loaded:
            continue
        rel = str(path.relative_to(ROOT))
        for case in loaded["cases"]:
            names = set(case.get("targets", []))
            if names:
                out[f"{rel} :: {case['id']}"] = names
    return out


def modal_set(sets: list[set[str]]) -> set[str]:
    """The target set a directory's cases most often agree on.

    Ties are broken toward the larger set and then lexicographically, so
    the answer never depends on which case happened to sort first: a tie
    settled by input order would move the whole report when an unrelated
    case is added or renamed.

    Args:
        sets (list[set[str]]): one target set per case.

    Returns:
        set[str]: the modal target set.
    """
    counts = collections.Counter(frozenset(s) for s in sets)
    best = max(counts.items(),
               key=lambda kv: (kv[1], len(kv[0]), sorted(kv[0])))
    return set(best[0])


def collect(targets: dict[str, set[str]]) -> dict[str, list[str]]:
    """Report every target a case drops that its siblings still test.

    The comparison is against the modal target set of the case's own
    directory, not the whole roster: a command family's cases agree on
    which backends they exercise, so one quietly naming fewer is a
    divergence parked as an omission. Comparing against the roster instead
    would flag every deliberately narrow case in the battery.

    Args:
        targets (dict[str, set[str]]): per-case target sets.

    Returns:
        dict[str, list[str]]: case key to the targets it is missing.
    """
    by_dir: dict[str, list[tuple[str,
                                 set[str]]]] = collections.defaultdict(list)
    for rel, names in targets.items():
        parent = str(Path(rel.split(" :: ", 1)[0]).parent)
        if parent.startswith(UNRELATED_DIRS):
            continue
        by_dir[parent].append((rel, names))
    found: dict[str, list[str]] = {}
    for entries in by_dir.values():
        if len(entries) < 2:
            continue
        modal = modal_set([names for _, names in entries])
        for rel, names in entries:
            missing = modal - names
            if missing:
                found[rel] = sorted(missing)
    return found


def load_exceptions() -> dict[str, object]:
    if not EXCEPTIONS.is_file():
        return {"baseline": 0, "files": {}, "entries": {}}
    loaded: dict[str, object] = json.loads(EXCEPTIONS.read_text())
    return loaded


def excuse(
        found: dict[str, list[str]],
        exceptions: dict[str,
                         object]) -> tuple[dict[str, list[str]], list[str]]:
    """Drop excused gaps and name any exception that no longer applies.

    A stale entry is the failure mode every hand-maintained allowlist in
    this repo has already hit, so it is reported as loudly as a new gap.

    Args:
        found (dict[str, list[str]]): every gap.
        exceptions (dict[str, object]): the committed excuses.

    Returns:
        tuple[dict[str, list[str]], list[str]]: unexcused gaps and stale
            exception keys.
    """
    files = exceptions.get("files")
    excused_files = files if isinstance(files, dict) else {}
    entries = exceptions.get("entries")
    excused_entries = entries if isinstance(entries, dict) else {}
    remaining: dict[str, list[str]] = {}
    stale: list[str] = []
    seen_files: set[str] = set()
    for rel, missing in found.items():
        # A "files" excuse covers every case in that file, since the usual
        # reason (this command is backend-independent) is a property of the
        # file rather than of one step in it.
        path = rel.split(" :: ", 1)[0]
        seen_files.add(path)
        if path in excused_files:
            continue
        per_case = excused_entries.get(rel)
        excused = set(per_case) if isinstance(per_case, dict) else set()
        left = [name for name in missing if name not in excused]
        for name in excused:
            if name not in missing:
                stale.append(f"{rel} :: {name}")
        if left:
            remaining[rel] = left
    for path in excused_files:
        if path not in seen_files:
            stale.append(path)
    for rel in excused_entries:
        if rel not in found:
            stale.append(rel)
    return remaining, sorted(set(stale))


def total(remaining: dict[str, list[str]]) -> int:
    return sum(len(v) for v in remaining.values())


def report(remaining: dict[str, list[str]], stale: list[str],
           baseline: int) -> None:
    for rel, missing in sorted(remaining.items()):
        print(f"  {rel}: drops {missing}")
    if stale:
        print()
        for entry in stale:
            print(f"  STALE exception (the gap is gone): {entry}")
    print()
    print(f"unexcused dropped targets: {total(remaining)} "
          f"(baseline {baseline})")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Find backends a case drops that its siblings test.")
    # Advisory by default because the existing gaps predate the gate and
    # each needs its own decision. --strict does not demand zero: it fails
    # only when the count moves off the baseline, in either direction, so
    # new omissions are blocked and a closed one has to be locked in.
    parser.add_argument("--strict", action="store_true")
    parser.add_argument("--json", dest="as_json", action="store_true")
    args = parser.parse_args()

    exceptions = load_exceptions()
    baseline_value = exceptions.get("baseline", 0)
    baseline = baseline_value if isinstance(baseline_value, int) else 0
    found = collect(case_targets(case_files()))
    remaining, stale = excuse(found, exceptions)

    if args.as_json:
        print(
            json.dumps(
                {
                    "baseline": baseline,
                    "total": total(remaining),
                    "stale": stale,
                    "dropped": remaining,
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
              "delete them or restore the omission they describe.")
        return 1
    if total(remaining) > baseline:
        print(f"\nFAIL: dropped targets rose from {baseline} to "
              f"{total(remaining)}. Add the target to the case, or add it "
              f"to {EXCEPTIONS.name} with a reason.")
        return 1
    if total(remaining) < baseline:
        print(f"\nFAIL: dropped targets fell from {baseline} to "
              f"{total(remaining)}. Lower the baseline in "
              f"{EXCEPTIONS.name} to lock the improvement in.")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
