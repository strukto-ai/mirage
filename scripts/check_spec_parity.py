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

import json
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
SPEC = ROOT / "spec"
PYTHON = SPEC / "python" / "general"
TYPESCRIPT = [
    SPEC / "typescript" / "node" / "general",
    SPEC / "typescript" / "browser" / "general"
]
EXCEPTIONS = SPEC / "parity_exceptions.json"

SPEC_FIELDS = ("description", "epilog", "ignore_tokens", "options",
               "positional", "rest")
META_FIELDS = ("has_provision", "has_aggregate", "has_write", "filetypes")


def load_dir(path: Path) -> dict[str, Any]:
    if not path.is_dir():
        raise SystemExit(f"missing spec directory: {path}\n"
                         "run scripts/gen_specs.py and "
                         "typescript/scripts/gen-specs.ts first")
    return {f.stem: json.loads(f.read_text()) for f in path.glob("*.json")}


def expand(resources: list[str], expansions: dict[str, list[str]]) -> set[str]:
    out: set[str] = set()
    for name in resources:
        out.update(expansions.get(name, [name]))
    return out


def compare_command(
    py: dict[str, Any],
    ts: dict[str, Any],
    ts_resources: set[str],
    expansions: dict[str, list[str]],
    language_only: set[str],
) -> list[str]:
    diffs: list[str] = []
    for field in SPEC_FIELDS:
        if py[field] != ts[field]:
            diffs.append(field)
    for field in META_FIELDS:
        if py["_meta"][field] != ts["_meta"][field]:
            diffs.append(f"_meta.{field}")
    py_resources = expand(py["_meta"]["resources"], expansions)
    if py_resources != ts_resources - language_only:
        diffs.append("_meta.resources")
    return diffs


def describe(field: str, py: dict[str, Any], ts: dict[str, Any],
             ts_resources: set[str], expansions: dict[str, list[str]],
             language_only: set[str]) -> str:
    if field == "_meta.resources":
        a = expand(py["_meta"]["resources"], expansions)
        b = ts_resources - language_only
        return (f"    {field}: python-only={sorted(a - b)} "
                f"typescript-only={sorted(b - a)}")
    if field.startswith("_meta."):
        key = field.split(".", 1)[1]
        return (f"    {field}: python={py['_meta'][key]!r} "
                f"typescript={ts['_meta'][key]!r}")
    if field == "options":
        py_by_name = {o["long"] or o["short"]: o for o in py["options"]}
        ts_by_name = {o["long"] or o["short"]: o for o in ts["options"]}
        lines = [f"    {field}:"]
        for key in sorted(set(py_by_name) | set(ts_by_name)):
            a, b = py_by_name.get(key), ts_by_name.get(key)
            if a == b:
                continue
            if a is None:
                lines.append(f"      {key}: typescript-only")
            elif b is None:
                lines.append(f"      {key}: python-only")
            else:
                for k in sorted(set(a) | set(b)):
                    if a.get(k) != b.get(k):
                        lines.append(f"      {key}.{k}: python={a.get(k)!r} "
                                     f"typescript={b.get(k)!r}")
        return "\n".join(lines)
    return f"    {field}: python={py[field]!r} typescript={ts[field]!r}"


def main() -> int:
    exceptions = json.loads(EXCEPTIONS.read_text())
    expansions: dict[str,
                     list[str]] = exceptions["resource_expansions"]["python"]
    language_only = set(exceptions["language_only_resources"])
    allowed: dict[str, Any] = exceptions["commands"]

    py_specs = load_dir(PYTHON)
    ts_variants = [load_dir(p) for p in TYPESCRIPT]

    failures: list[str] = []
    used: set[str] = set()

    only_py = sorted(set(py_specs) - set(ts_variants[0]))
    only_ts = sorted(set(ts_variants[0]) - set(py_specs))
    if only_py:
        failures.append(f"commands only in python: {only_py}")
    if only_ts:
        failures.append(f"commands only in typescript: {only_ts}")

    for name in sorted(set(py_specs) & set(ts_variants[0])):
        py = py_specs[name]
        ts = ts_variants[0][name]
        ts_resources: set[str] = set()
        for variant in ts_variants:
            ts_resources.update(variant[name]["_meta"]["resources"])
        diffs = compare_command(py, ts, ts_resources, expansions,
                                language_only)
        if not diffs:
            continue
        exempt = allowed.get(name, {})
        exempt_fields = set(exempt.get("fields", []))
        if exempt_fields:
            used.add(name)
        real = [d for d in diffs if d not in exempt_fields]
        if not real:
            continue
        detail = "\n".join(
            describe(d, py, ts, ts_resources, expansions, language_only)
            for d in real)
        failures.append(f"{name}:\n{detail}")

    stale = sorted(set(allowed) - used)
    if stale:
        failures.append(f"stale entries in {EXCEPTIONS.name}, the divergence "
                        f"they cover is gone: {stale}")

    if failures:
        print("command spec parity check FAILED\n")
        for failure in failures:
            print(failure)
        print(f"\n{len(failures)} divergence(s) between python and typescript")
        return 1

    print(f"command spec parity OK: {len(py_specs)} commands match")
    return 0


if __name__ == "__main__":
    sys.exit(main())
