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

BY_RESOURCE = "_meta.by_resource"
BY_RESOURCE_KEYS = "_meta.by_resource.keys"


def spec_fields(py: dict[str, Any], ts: dict[str, Any]) -> list[str]:
    """Every top-level spec key either side emits, ``_meta`` excluded.

    A union rather than a fixed allowlist: python dumps with
    ``asdict(spec)``, so a new ``CommandSpec`` field appears on its own,
    while the typescript side serializes through hand-written literals and
    would not. An allowlist hid that asymmetry — both spec-drift gates
    still pass, because each tree regenerates byte-identically, and parity
    never looked at the new key.

    Args:
        py (dict[str, Any]): the python spec payload.
        ts (dict[str, Any]): the typescript spec payload.
    """
    return sorted((set(py) | set(ts)) - {"_meta"})


def meta_fields(py_meta: dict[str, Any], ts_meta: dict[str, Any]) -> list[str]:
    """Every ``_meta`` key either side emits, ``by_resource`` excluded.

    Args:
        py_meta (dict[str, Any]): the python ``_meta`` block.
        ts_meta (dict[str, Any]): the typescript ``_meta`` block.
    """
    return sorted((set(py_meta) | set(ts_meta)) - {"by_resource"})


def check_resources(language_only: set[str], expansions: dict[str, list[str]],
                    unconstructible: dict[str, dict[str, str]]) -> list[str]:
    """Registry membership, the surface the command specs cannot see.

    A resource's ``_meta`` entries say it registers commands; nothing said
    it could be *built* by name. The two sets drifted five times — python
    had no ``sharepoint`` factory and the typescript registries had no
    chroma/dify/lancedb/qdrant — while every command spec stayed identical,
    because registering a command and being constructible are different
    tables.

    Args:
        language_only (set[str]): resources that exist in one runtime only.
        expansions (dict[str, list[str]]): python alias table, so one
            python name can stand for several typescript ones.
        unconstructible (dict[str, dict[str, str]]): per-tree names that
            register commands on purpose without a registry factory.
    """
    failures: list[str] = []
    trees = {
        "python": SPEC / "python" / "resources.json",
        "node": SPEC / "typescript" / "node" / "resources.json",
        "browser": SPEC / "typescript" / "browser" / "resources.json",
    }
    loaded: dict[str, dict[str, list[str]]] = {}
    for tree, path in trees.items():
        if not path.is_file():
            return [
                f"missing {path}\nrun scripts/gen_specs.py and "
                "typescript/scripts/gen-specs.ts first"
            ]
        loaded[tree] = json.loads(path.read_text())

    for tree, payload in loaded.items():
        registry = set(payload["registry"])
        allowed = unconstructible.get(tree, {})
        orphans = sorted(set(payload["command_resources"]) - registry)
        unexpected = [r for r in orphans if r not in allowed]
        if unexpected:
            failures.append(
                f"{tree}: these resources register builtin commands but "
                f"cannot be built by name: {unexpected}\n"
                f"    add a registry factory, or document the omission in "
                f"{EXCEPTIONS.name} under unconstructible_resources.{tree}")
        stale = sorted(set(allowed) - set(orphans))
        if stale:
            failures.append(f"stale unconstructible_resources.{tree} entries "
                            f"in {EXCEPTIONS.name}: {stale}")

    py_registry: set[str] = set()
    for name in loaded["python"]["registry"]:
        py_registry.update(expansions.get(name, [name]))
    ts_registry = set(loaded["node"]["registry"]) | set(
        loaded["browser"]["registry"])
    only_py = sorted(py_registry - ts_registry - language_only)
    only_ts = sorted(ts_registry - py_registry - language_only)
    if only_py:
        failures.append(f"resources constructible only in python: {only_py}")
    if only_ts:
        failures.append(
            f"resources constructible only in typescript: {only_ts}")
    return failures


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
    for field in spec_fields(py, ts):
        if py.get(field) != ts.get(field):
            diffs.append(field)
    if set(py_by_resource) != set(ts_by_resource):
        diffs.append(BY_RESOURCE_KEYS)
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
        for field in meta_fields(py["_meta"], ts["_meta"]):
            # `resources` denormalizes by_resource's keys, so it carries the
            # raw names and needs the same alias expansion and
            # language-only filtering before the two lists can be compared.
            if field == "resources":
                if set(py_by_resource) != set(ts_by_resource):
                    diffs.append("_meta.resources")
                continue
            if py["_meta"].get(field) != ts["_meta"].get(field):
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
    if diff in (BY_RESOURCE_KEYS, "_meta.resources"):
        a, b = set(py_by_resource), set(ts_by_resource)
        return (f"    {diff}: python-only={sorted(a - b)} "
                f"typescript-only={sorted(b - a)}")
    if diff.startswith("_meta."):
        key = diff.split(".", 1)[1]
        return (f"    {diff}: python={py['_meta'].get(key)!r} "
                f"typescript={ts['_meta'].get(key)!r}")
    if diff == "options":
        # An option that declares only one spelling carries only that
        # key, since the dumps omit anything left at its default.
        py_by_name = {
            o.get("long") or o.get("short"): o
            for o in py.get("options", [])
        }
        ts_by_name = {
            o.get("long") or o.get("short"): o
            for o in ts.get("options", [])
        }
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
    return f"    {diff}: python={py.get(diff)!r} typescript={ts.get(diff)!r}"


def compare_variants(variants: list[dict[str, Any]]) -> list[str]:
    """Divergences between the typescript variants' own spec payloads.

    ``by_resource`` and its denormalized ``resources`` key legitimately
    differ — a backend registers in only one runtime — but everything else
    describes the command itself and must match. Python is compared against
    the node variant, so without this check nothing ever reads
    ``spec/typescript/browser`` beyond its per-resource metadata.

    Args:
        variants (list[dict[str, Any]]): one loaded spec tree per variant,
            node first.
    """
    failures: list[str] = []
    node, browser = variants[0], variants[1]
    for name in sorted(set(node) & set(browser)):
        a, b = node[name], browser[name]
        diffs = [f for f in spec_fields(a, b) if a.get(f) != b.get(f)]
        diffs += [
            f"_meta.{f}" for f in meta_fields(a["_meta"], b["_meta"])
            if f != "resources" and a["_meta"].get(f) != b["_meta"].get(f)
        ]
        if diffs:
            failures.append(f"typescript node and browser disagree on "
                            f"{name}: {diffs}")
    return failures


def main() -> int:
    exceptions = json.loads(EXCEPTIONS.read_text())
    expansions: dict[str,
                     list[str]] = exceptions["resource_expansions"]["python"]
    language_only = set(exceptions["language_only_resources"])
    unconstructible: dict[str,
                          dict[str,
                               str]] = exceptions["unconstructible_resources"]
    allowed: dict[str, Any] = exceptions["commands"]

    py_specs = load_dir(PYTHON)
    ts_variants = [load_dir(p) for p in TYPESCRIPT]

    failures: list[str] = []
    used: set[str] = set()

    # Python has no runtime split, so its command set must equal the union
    # of the two typescript variants; comparing against node alone would
    # miss a command only the browser tree registers.
    ts_names: set[str] = set()
    for variant in ts_variants:
        ts_names |= set(variant)
    only_py = sorted(set(py_specs) - ts_names)
    only_ts = sorted(ts_names - set(py_specs))
    if only_py:
        failures.append(f"commands only in python: {only_py}")
    if only_ts:
        failures.append(f"commands only in typescript: {only_ts}")

    failures.extend(compare_variants(ts_variants))
    failures.extend(check_resources(language_only, expansions,
                                    unconstructible))

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
