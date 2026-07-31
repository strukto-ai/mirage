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
BY_RESOURCE = "_meta.by_resource"


def load_dir(path: Path) -> dict[str, Any]:
    if not path.is_dir():
        raise SystemExit(f"missing spec directory: {path}\n"
                         "run scripts/gen_specs.py and "
                         "typescript/scripts/gen-specs.ts first")
    return {f.stem: json.loads(f.read_text()) for f in path.glob("*.json")}


def expand_by_resource(by_resource: dict[str, Any],
                       expansions: dict[str, list[str]]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for name, entry in by_resource.items():
        for alias in expansions.get(name, [name]):
            out[alias] = entry
    return out


def merge_by_resource(variants: list[dict[str, Any]]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for variant in variants:
        for name, entry in variant.items():
            if name in out and out[name] != entry:
                raise SystemExit(f"typescript variants disagree on the "
                                 f"metadata for resource {name!r}")
            out[name] = entry
    return out


def compare_command(py: dict[str, Any], ts: dict[str, Any],
                    py_by_resource: dict[str, Any],
                    ts_by_resource: dict[str, Any]) -> list[str]:
    """Every divergence between one command's two specs, before exemptions.

    Per-resource metadata differences are reported one key at a time as
    ``_meta.by_resource:<resource>:<key>`` so an exemption can name exactly
    the fact it covers instead of muting the whole field.

    Args:
        py (dict[str, Any]): the python spec payload.
        ts (dict[str, Any]): the typescript spec payload.
        py_by_resource (dict[str, Any]): python per-resource metadata,
            already expanded through the alias table.
        ts_by_resource (dict[str, Any]): typescript per-resource metadata,
            already stripped of language-only resources.
    """
    diffs: list[str] = []
    for field in SPEC_FIELDS:
        if py[field] != ts[field]:
            diffs.append(field)
    if set(py_by_resource) != set(ts_by_resource):
        diffs.append("_meta.resources")
        return diffs
    for name in sorted(py_by_resource):
        a, b = py_by_resource[name], ts_by_resource[name]
        for key in sorted(set(a) | set(b)):
            if a.get(key) != b.get(key):
                diffs.append(f"{BY_RESOURCE}:{name}:{key}")
    # The union flags are derived from the per-resource entries, so they
    # only add signal once those agree; otherwise they restate the same
    # divergence in a coarser form.
    if not any(d.startswith(BY_RESOURCE) for d in diffs):
        for field in META_FIELDS:
            if py["_meta"][field] != ts["_meta"][field]:
                diffs.append(f"_meta.{field}")
    return diffs


def exempted(diff: str, fields: set[str],
             by_resource: dict[str, list[str]]) -> bool:
    if diff in fields:
        return True
    if not diff.startswith(f"{BY_RESOURCE}:"):
        return False
    _, name, key = diff.split(":", 2)
    return key in by_resource.get(name, [])


def describe(diff: str, py: dict[str, Any], ts: dict[str, Any],
             py_by_resource: dict[str, Any], ts_by_resource: dict[str,
                                                                  Any]) -> str:
    if diff.startswith(f"{BY_RESOURCE}:"):
        _, name, key = diff.split(":", 2)
        return (f"    {BY_RESOURCE}[{name}].{key}: "
                f"python={py_by_resource[name].get(key)!r} "
                f"typescript={ts_by_resource[name].get(key)!r}")
    if diff == "_meta.resources":
        a, b = set(py_by_resource), set(ts_by_resource)
        return (f"    {diff}: python-only={sorted(a - b)} "
                f"typescript-only={sorted(b - a)}")
    if diff.startswith("_meta."):
        key = diff.split(".", 1)[1]
        return (f"    {diff}: python={py['_meta'][key]!r} "
                f"typescript={ts['_meta'][key]!r}")
    if diff == "options":
        py_by_name = {o["long"] or o["short"]: o for o in py["options"]}
        ts_by_name = {o["long"] or o["short"]: o for o in ts["options"]}
        lines = [f"    {diff}:"]
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
    return f"    {diff}: python={py[diff]!r} typescript={ts[diff]!r}"


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
        py, ts = py_specs[name], ts_variants[0][name]
        py_by_resource = expand_by_resource(py["_meta"]["by_resource"],
                                            expansions)
        ts_by_resource = {
            k: v
            for k, v in merge_by_resource(
                [v[name]["_meta"]["by_resource"]
                 for v in ts_variants]).items() if k not in language_only
        }
        diffs = compare_command(py, ts, py_by_resource, ts_by_resource)
        if not diffs:
            continue
        exempt = allowed.get(name, {})
        fields = set(exempt.get("fields", []))
        by_resource: dict[str, list[str]] = exempt.get("by_resource", {})
        real = [d for d in diffs if not exempted(d, fields, by_resource)]
        # An exemption earns its keep only by suppressing a live divergence.
        if len(real) < len(diffs):
            used.add(name)
        if not real:
            continue
        detail = "\n".join(
            describe(d, py, ts, py_by_resource, ts_by_resource) for d in real)
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
