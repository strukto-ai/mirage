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

BY_VFS = "_meta.by_vfs"
BY_VFS_KEYS = "_meta.by_vfs.keys"


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
    """Every ``_meta`` key either side emits, ``by_vfs`` excluded.

    Args:
        py_meta (dict[str, Any]): the python ``_meta`` block.
        ts_meta (dict[str, Any]): the typescript ``_meta`` block.
    """
    return sorted((set(py_meta) | set(ts_meta)) - {"by_vfs"})


def load_vfs_trees() -> dict[str, dict[str, Any]]:
    """The three ``vfs.json`` payloads, or a SystemExit naming the
    generator that has not been run."""
    trees = {
        "python": SPEC / "python" / "vfs.json",
        "node": SPEC / "typescript" / "node" / "vfs.json",
        "browser": SPEC / "typescript" / "browser" / "vfs.json",
    }
    loaded: dict[str, dict[str, Any]] = {}
    for tree, path in trees.items():
        if not path.is_file():
            raise SystemExit(f"missing {path}\nrun scripts/gen_specs.py and "
                             "typescript/scripts/gen-specs.ts first")
        loaded[tree] = json.loads(path.read_text())
    return loaded


def merge_variants(loaded: dict[str, dict[str, Any]], key: str,
                   language_only: set[str]) -> dict[str, Any]:
    """One typescript view of ``key``, node's entry winning over browser's.

    Where only one runtime carries a real entry — the browser registers
    ``lancedb`` and ``email`` solely to explain that it cannot serve them,
    so their capabilities dump as null — the runtime that can actually
    mount the backend is the one worth comparing against python.

    Preferring node is only safe because ``check_variant_facts`` has
    already failed on any name the two runtimes describe differently.
    Without it the preference silently hid a divergence rather than
    resolving one: the fifteen browser S3-family VFS declared
    neither ``sizes_always_known`` nor ``storage_id`` while their node
    twins declared both, and python matched node, so the whole
    python-versus-typescript comparison passed.

    Args:
        loaded (dict[str, dict[str, Any]]): the three VFS trees.
        key (str): the payload key to merge, e.g. ``"capabilities"``.
        language_only (set[str]): names with no counterpart to compare.
    """
    out: dict[str, Any] = {}
    for tree in ("node", "browser"):
        for name, entry in loaded[tree].get(key, {}).items():
            if name in language_only:
                continue
            if out.get(name) is None:
                out[name] = entry
    return out


def check_variant_facts(loaded: dict[str, dict[str, Any]], key: str,
                        allowed: dict[str, dict[str, str]],
                        used: set[str]) -> list[str]:
    """Node against browser for one VFS-fact table.

    A backend both runtimes register is one backend, and it should not
    behave differently depending on which package mounted it. Nothing
    compared the two: ``compare_variants`` only sees the command specs,
    and ``merge_variants`` resolves the tables by preferring node, which
    turns a divergence into a silently discarded value.

    A ``null`` entry is a runtime declining to serve the backend at all,
    which is a membership fact ``check_vfs_names`` already covers.

    Args:
        loaded (dict[str, dict[str, Any]]): the three VFS trees.
        key (str): the payload key to compare, e.g. ``"capabilities"``.
        allowed (dict[str, dict[str, str]]): per-VFS keys whose
            divergence is documented, each mapped to its reason.
        used (set[str]): collects the exemptions that fired.
    """
    node = loaded["node"].get(key, {})
    browser = loaded["browser"].get(key, {})
    failures: list[str] = []
    for name in sorted(set(node) & set(browser)):
        a, b = node[name], browser[name]
        if a is None or b is None:
            continue
        exempt = allowed.get(name, {})
        for field in sorted(set(a) | set(b)):
            if a.get(field) == b.get(field):
                continue
            if field in exempt:
                used.add(f"{key}:{name}:{field}")
                continue
            failures.append(f"{key}[{name}].{field}: typescript node="
                            f"{a.get(field)!r} browser={b.get(field)!r}")
    return failures


def check_capabilities(loaded: dict[str, dict[str, Any]],
                       expansions: dict[str,
                                        list[str]], language_only: set[str],
                       allowed: dict[str,
                                     dict[str,
                                          str]], used: set[str]) -> list[str]:
    """Per-VFS behavior values: TTLs, caching, snapshot support.

    Registry membership says a backend can be built; these say what it
    does once mounted, and they are just as hand-maintained. Python kept
    the 600 s ``index_ttl`` default for postgres and mongodb where
    typescript pins 0, so a python mount could serve a ten-minute-stale
    listing of a live schema while its typescript twin was exact.

    Args:
        loaded (dict[str, dict[str, Any]]): the three VFS trees.
        expansions (dict[str, list[str]]): python alias table.
        language_only (set[str]): names present in one runtime only.
        allowed (dict[str, dict[str, str]]): per-VFS keys whose
            divergence is documented, each mapped to its reason.
        used (set[str]): collects the exemptions that fired.
    """
    py: dict[str, Any] = {}
    for name, entry in loaded["python"].get("capabilities", {}).items():
        for alias in expansions.get(name, [name]):
            py[alias] = entry
    ts = merge_variants(loaded, "capabilities", language_only)
    failures = _membership(py, ts, language_only, "capabilities")
    for name in sorted(set(py) & set(ts)):
        a, b = py[name], ts[name]
        if b is None:
            failures.append(f"capabilities[{name}]: python builds it, no "
                            f"typescript runtime does")
            continue
        exempt = allowed.get(name, {})
        for key in sorted(set(a) | set(b)):
            if a.get(key) == b.get(key):
                continue
            if key in exempt:
                used.add(f"{name}:{key}")
                continue
            failures.append(f"capabilities[{name}].{key}: "
                            f"python={a.get(key)!r} typescript={b.get(key)!r}")
    return failures


def check_command_io(loaded: dict[str, dict[str, Any]], aliases: dict[str,
                                                                      str],
                     language_only: set[str], allowed: dict[str, dict[str,
                                                                      str]],
                     used: set[str]) -> list[str]:
    """The wired ``CommandIO`` slots per backend.

    The adapter's slot set is a hand-filled literal that nothing else
    reads, so a backend can omit ``du`` or ``find`` and quietly fall back
    to the capped readdir walk — a partial total and an exit 1 past the
    cap — while its twin pushes the same query down to the API.

    Args:
        loaded (dict[str, dict[str, Any]]): the three VFS trees.
        aliases (dict[str, str]): python command-package name to the
            typescript one where the directories differ.
        language_only (set[str]): backends present in one runtime only.
        allowed (dict[str, dict[str, str]]): per-backend keys whose
            divergence is documented, each mapped to its reason.
        used (set[str]): collects the exemptions that fired.
    """
    py = {
        aliases.get(name, name): entry
        for name, entry in loaded["python"].get("command_io", {}).items()
    }
    ts = merge_variants(loaded, "command_io", language_only)
    failures = _membership(py, ts, language_only, "command_io")
    for name in sorted(set(py) & set(ts)):
        a, b = py[name], ts[name]
        exempt = allowed.get(name, {})
        for key in sorted(set(a) | set(b)):
            if a.get(key) == b.get(key):
                continue
            if key in exempt:
                used.add(f"{name}:{key}")
                continue
            if key == "slots":
                only_py = sorted(set(a["slots"]) - set(b["slots"]))
                only_ts = sorted(set(b["slots"]) - set(a["slots"]))
                failures.append(f"command_io[{name}].slots: "
                                f"python-only={only_py} "
                                f"typescript-only={only_ts}")
                continue
            failures.append(f"command_io[{name}].{key}: "
                            f"python={a.get(key)!r} typescript={b.get(key)!r}")
    return failures


def snake_to_camel(snake: str) -> str:
    """Reimplement ``snakeToCamel`` from ``utils/normalize.ts``.

    Args:
        snake (str): the python-side wire name.

    Returns:
        str: the camelCase spelling ``normalizeFields`` produces by default.
    """
    parts = snake.split("_")
    return parts[0] + "".join(part[:1].upper() + part[1:]
                              for part in parts[1:])


def _fold(name: str) -> str:
    return name.replace("_", "").lower()


def check_configs(loaded: dict[str, dict[str, Any]],
                  expansions: dict[str, list[str]], language_only: set[str],
                  allowed: dict[str, dict[str,
                                          str]], used: set[str]) -> list[str]:
    """Per-VFS config field sets: what a mount can be told.

    Python dumps its pydantic wire names; TypeScript dumps the zod shape
    behind each ``normalize*Config`` door plus the rename map the door
    applies, and whether the door validates at all. A python wire name has
    to land on a TypeScript field through the rename map or
    ``snakeToCamel`` with the same requiredness, every TypeScript field has
    to be reachable from some python name, and every door has to parse.
    Node against browser is deliberately not compared here: the browser
    S3 family authenticates with a presigned-URL provider where node holds
    credentials, so the two runtimes' configs differ by design and the
    node entry -- the one that mirrors python -- is the one compared.

    Exemptions are keyed by VFS then by field, spelled either way
    (``refreshFn`` or ``refresh_fn``); ``validates`` exempts a door that
    does not parse.

    Args:
        loaded (dict[str, dict[str, Any]]): the three VFS trees.
        expansions (dict[str, list[str]]): python alias table.
        language_only (set[str]): names present in one runtime only.
        allowed (dict[str, dict[str, str]]): per-VFS keys whose
            divergence is documented, each mapped to its reason.
        used (set[str]): collects the exemptions that fired.
    """
    py: dict[str, Any] = {}
    for name, entry in loaded["python"].get("configs", {}).items():
        for alias in expansions.get(name, [name]):
            py[alias] = entry
    ts = merge_variants(loaded, "configs", language_only)
    failures = _membership(py, ts, language_only, "configs")

    def exempt(name: str, key: str) -> bool:
        table = {_fold(k): k for k in allowed.get(name, {})}
        hit = table.get(_fold(key))
        if hit is None:
            return False
        used.add(f"configs:{name}:{hit}")
        return True

    for name in sorted(set(py) & set(ts)):
        a, b = py[name], ts[name]
        if a is None and b is None:
            continue
        if a is None or b is None:
            if exempt(name, "door"):
                continue
            side = "python" if a is None else "typescript"
            failures.append(f"configs[{name}]: {side} declares no config "
                            "class while the other side validates one")
            continue
        if not b.get("validates", False) and not exempt(name, "validates"):
            failures.append(f"configs[{name}]: the typescript normalizer "
                            "does not parse its schema")
        rename: dict[str, str] = b.get("rename", {})
        ts_fields: dict[str, Any] = b.get("fields", {})
        reached: set[str] = set()
        for wire, meta in sorted(a["fields"].items()):
            target = rename.get(wire, snake_to_camel(wire))
            reached.add(target)
            if target not in ts_fields:
                if exempt(name, wire):
                    continue
                failures.append(f"configs[{name}].{wire}: python declares it, "
                                f"no typescript field answers to {target!r}")
                continue
            if bool(meta["required"]) != bool(ts_fields[target]["required"]):
                if exempt(name, wire):
                    continue
                failures.append(f"configs[{name}].{wire}: required python="
                                f"{meta['required']!r} typescript="
                                f"{ts_fields[target]['required']!r}")
        for field in sorted(set(ts_fields) - reached):
            if exempt(name, field):
                continue
            failures.append(
                f"configs[{name}].{field}: typescript declares it, "
                "no python wire name reaches it")
    return failures


def _membership(py: dict[str, Any], ts: dict[str, Any],
                language_only: set[str], label: str) -> list[str]:
    only_py = sorted(set(py) - set(ts) - language_only)
    only_ts = sorted(set(ts) - set(py) - language_only)
    failures: list[str] = []
    if only_py:
        failures.append(f"{label} only in python: {only_py}")
    if only_ts:
        failures.append(f"{label} only in typescript: {only_ts}")
    return failures


def check_vfs_names(loaded: dict[str, dict[str, Any]], language_only: set[str],
                    expansions: dict[str, list[str]],
                    unconstructible: dict[str, dict[str, str]]) -> list[str]:
    """Registry membership, the surface the command specs cannot see.

    A VFS's ``_meta`` entries say it registers commands; nothing said
    it could be *built* by name. The two sets drifted five times — python
    had no ``sharepoint`` factory and the typescript registries had no
    chroma/dify/lancedb/qdrant — while every command spec stayed identical,
    because registering a command and being constructible are different
    tables.

    Args:
        loaded (dict[str, dict[str, Any]]): the three VFS trees.
        language_only (set[str]): VFS that exist in one runtime only.
        expansions (dict[str, list[str]]): python alias table, so one
            python name can stand for several typescript ones.
        unconstructible (dict[str, dict[str, str]]): per-tree names that
            register commands on purpose without a registry factory.
    """
    failures: list[str] = []
    for tree, payload in loaded.items():
        registry = set(payload["registry"])
        allowed = unconstructible.get(tree, {})
        orphans = sorted(set(payload["command_vfs_names"]) - registry)
        unexpected = [r for r in orphans if r not in allowed]
        if unexpected:
            failures.append(
                f"{tree}: these VFS register builtin commands but "
                f"cannot be built by name: {unexpected}\n"
                f"    add a registry factory, or document the omission in "
                f"{EXCEPTIONS.name} under unconstructible_vfs_names.{tree}")
        stale = sorted(set(allowed) - set(orphans))
        if stale:
            failures.append(f"stale unconstructible_vfs_names.{tree} entries "
                            f"in {EXCEPTIONS.name}: {stale}")

    py_registry: set[str] = set()
    for name in loaded["python"]["registry"]:
        py_registry.update(expansions.get(name, [name]))
    ts_registry = set(loaded["node"]["registry"]) | set(
        loaded["browser"]["registry"])
    only_py = sorted(py_registry - ts_registry - language_only)
    only_ts = sorted(ts_registry - py_registry - language_only)
    if only_py:
        failures.append(f"VFS constructible only in python: {only_py}")
    if only_ts:
        failures.append(f"VFS constructible only in typescript: {only_ts}")
    return failures


def load_dir(path: Path) -> dict[str, Any]:
    if not path.is_dir():
        raise SystemExit(f"missing spec directory: {path}\n"
                         "run scripts/gen_specs.py and "
                         "typescript/scripts/gen-specs.ts first")
    return {f.stem: json.loads(f.read_text()) for f in path.glob("*.json")}


def expand_by_vfs(by_vfs: dict[str, Any],
                  expansions: dict[str, list[str]]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for name, entry in by_vfs.items():
        for alias in expansions.get(name, [name]):
            out[alias] = entry
    return out


def merge_by_vfs(variants: list[dict[str, Any]]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for variant in variants:
        for name, entry in variant.items():
            if name in out and out[name] != entry:
                raise SystemExit(f"typescript variants disagree on the "
                                 f"metadata for VFS {name!r}")
            out[name] = entry
    return out


def compare_command(py: dict[str, Any], ts: dict[str, Any],
                    py_by_vfs: dict[str, Any],
                    ts_by_vfs: dict[str, Any]) -> list[str]:
    """Every divergence between one command's two specs, before exemptions.

    Per-VFS metadata differences are reported one key at a time as
    ``_meta.by_vfs:<VFS>:<key>`` so an exemption can name exactly
    the fact it covers instead of muting the whole field.

    Args:
        py (dict[str, Any]): the python spec payload.
        ts (dict[str, Any]): the typescript spec payload.
        py_by_vfs (dict[str, Any]): python per-VFS metadata,
            already expanded through the alias table.
        ts_by_vfs (dict[str, Any]): typescript per-VFS metadata,
            already stripped of language-only VFS.
    """
    diffs: list[str] = []
    for field in spec_fields(py, ts):
        if py.get(field) != ts.get(field):
            diffs.append(field)
    if set(py_by_vfs) != set(ts_by_vfs):
        diffs.append(BY_VFS_KEYS)
        return diffs
    for name in sorted(py_by_vfs):
        a, b = py_by_vfs[name], ts_by_vfs[name]
        for key in sorted(set(a) | set(b)):
            if a.get(key) != b.get(key):
                diffs.append(f"{BY_VFS}:{name}:{key}")
    # The union flags are derived from the per-VFS entries, so they
    # only add signal once those agree; otherwise they restate the same
    # divergence in a coarser form.
    if not any(d.startswith(BY_VFS) for d in diffs):
        for field in meta_fields(py["_meta"], ts["_meta"]):
            # `vfs_names` denormalizes by_vfs's keys, so it carries the
            # raw names and needs the same alias expansion and
            # language-only filtering before the two lists can be compared.
            if field == "vfs_names":
                if set(py_by_vfs) != set(ts_by_vfs):
                    diffs.append("_meta.vfs_names")
                continue
            if py["_meta"].get(field) != ts["_meta"].get(field):
                diffs.append(f"_meta.{field}")
    return diffs


def exempted(diff: str, fields: set[str], by_vfs: dict[str,
                                                       list[str]]) -> bool:
    if diff in fields:
        return True
    if not diff.startswith(f"{BY_VFS}:"):
        return False
    _, name, key = diff.split(":", 2)
    return key in by_vfs.get(name, [])


def describe(diff: str, py: dict[str, Any], ts: dict[str, Any],
             py_by_vfs: dict[str, Any], ts_by_vfs: dict[str, Any]) -> str:
    if diff.startswith(f"{BY_VFS}:"):
        _, name, key = diff.split(":", 2)
        return (f"    {BY_VFS}[{name}].{key}: "
                f"python={py_by_vfs[name].get(key)!r} "
                f"typescript={ts_by_vfs[name].get(key)!r}")
    if diff in (BY_VFS_KEYS, "_meta.vfs_names"):
        a, b = set(py_by_vfs), set(ts_by_vfs)
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
            py_opt, ts_opt = py_by_name.get(key), ts_by_name.get(key)
            if py_opt == ts_opt:
                continue
            if py_opt is None:
                lines.append(f"      {key}: typescript-only")
            elif ts_opt is None:
                lines.append(f"      {key}: python-only")
            else:
                for k in sorted(set(py_opt) | set(ts_opt)):
                    if py_opt.get(k) != ts_opt.get(k):
                        lines.append(f"      {key}.{k}: "
                                     f"python={py_opt.get(k)!r} "
                                     f"typescript={ts_opt.get(k)!r}")
        return "\n".join(lines)
    return f"    {diff}: python={py.get(diff)!r} typescript={ts.get(diff)!r}"


def compare_variants(variants: list[dict[str, Any]]) -> list[str]:
    """Divergences between the typescript variants' own spec payloads.

    ``by_vfs`` and its denormalized ``vfs_names`` key legitimately
    differ — a backend registers in only one runtime — but everything else
    describes the command itself and must match. Python is compared against
    the node variant, so without this check nothing ever reads
    ``spec/typescript/browser`` beyond its per-VFS metadata.

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
            if f != "vfs_names" and a["_meta"].get(f) != b["_meta"].get(f)
        ]
        if diffs:
            failures.append(f"typescript node and browser disagree on "
                            f"{name}: {diffs}")
    return failures


def main() -> int:
    exceptions = json.loads(EXCEPTIONS.read_text())
    expansions: dict[str, list[str]] = exceptions["vfs_expansions"]["python"]
    language_only = set(exceptions["language_only_vfs_names"])
    unconstructible: dict[str,
                          dict[str,
                               str]] = exceptions["unconstructible_vfs_names"]
    allowed: dict[str, Any] = exceptions["commands"]
    capability_exempt: dict[str, dict[str,
                                      str]] = exceptions["vfs_capabilities"]
    io_exempt: dict[str, dict[str, str]] = exceptions["command_io"]
    io_aliases: dict[str, str] = exceptions["command_io_aliases"]["python"]
    variant_exempt: dict[str,
                         dict[str,
                              dict[str,
                                   str]]] = exceptions["variant_vfs_facts"]
    config_exempt: dict[str, dict[str, str]] = exceptions["config_fields"]

    py_specs = load_dir(PYTHON)
    ts_variants = [load_dir(p) for p in TYPESCRIPT]

    failures: list[str] = []
    used: set[str] = set()
    used_facts: set[str] = set()

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

    trees = load_vfs_trees()
    failures.extend(compare_variants(ts_variants))
    failures.extend(
        check_vfs_names(trees, language_only, expansions, unconstructible))
    # Before python is compared against the merged typescript view, since
    # that merge prefers node and would otherwise discard the difference.
    for table in ("capabilities", "command_io"):
        failures.extend(
            check_variant_facts(trees, table, variant_exempt.get(table, {}),
                                used_facts))
    failures.extend(
        check_capabilities(trees, expansions, language_only, capability_exempt,
                           used_facts))
    failures.extend(
        check_command_io(trees, io_aliases, language_only, io_exempt,
                         used_facts))
    failures.extend(
        check_configs(trees, expansions, language_only, config_exempt,
                      used_facts))
    declared = {
        f"{name}:{key}"
        for table in (capability_exempt, io_exempt)
        for name, keys in table.items()
        for key in keys
    }
    declared |= {
        f"configs:{name}:{key}"
        for name, keys in config_exempt.items()
        for key in keys
    }
    declared |= {
        f"{table}:{name}:{key}"
        for table, entries in variant_exempt.items()
        for name, keys in entries.items()
        for key in keys
    }
    stale_facts = sorted(declared - used_facts)
    if stale_facts:
        failures.append(f"stale VFS-fact exemptions in "
                        f"{EXCEPTIONS.name}, the divergence they cover is "
                        f"gone: {stale_facts}")

    for name in sorted(set(py_specs) & set(ts_variants[0])):
        py, ts = py_specs[name], ts_variants[0][name]
        py_by_vfs = expand_by_vfs(py["_meta"]["by_vfs"], expansions)
        ts_by_vfs = {
            k: v
            for k, v in merge_by_vfs(
                [v[name]["_meta"]["by_vfs"] for v in ts_variants]).items()
            if k not in language_only
        }
        diffs = compare_command(py, ts, py_by_vfs, ts_by_vfs)
        if not diffs:
            continue
        exempt = allowed.get(name, {})
        fields = set(exempt.get("fields", []))
        by_vfs: dict[str, list[str]] = exempt.get("by_vfs", {})
        real = [d for d in diffs if not exempted(d, fields, by_vfs)]
        # An exemption earns its keep only by suppressing a live divergence.
        if len(real) < len(diffs):
            used.add(name)
        if not real:
            continue
        detail = "\n".join(
            describe(d, py, ts, py_by_vfs, ts_by_vfs) for d in real)
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
