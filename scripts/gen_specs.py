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

import importlib
import json
import logging
import pkgutil
import sys
from dataclasses import MISSING, Field, asdict, fields
from pathlib import Path
from typing import Any

import mirage.commands.builtin
from mirage.commands.config import RegisteredCommand
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import CommandSpec, Operand, Option
from mirage.resource.registry import REGISTRY

logger = logging.getLogger(__name__)

OUT = Path(__file__).resolve().parent.parent / "spec" / "python" / "general"


def _walk_pkg(pkg: Any) -> list[str]:
    """Import every builtin command module, reporting the ones that failed.

    A module that will not import registers nothing, so its resources
    silently vanish from the dump. That reads as a legitimate deletion in
    the committed spec rather than as the under-provisioned environment it
    actually is, so the caller turns any failure into a hard error.

    Args:
        pkg (Any): the package to walk.
    """
    failed: list[str] = []
    for _finder, name, _ispkg in pkgutil.walk_packages(pkg.__path__,
                                                       pkg.__name__ + "."):
        try:
            importlib.import_module(name)
        except ImportError as e:
            logger.debug("skip %s: %s", name, e)
            failed.append(f"{name}: {e}")
    return failed


def _collect_registrations() -> dict[str, list[RegisteredCommand]]:
    out: dict[str, list[RegisteredCommand]] = {}
    seen: set[int] = set()
    for mod_name, mod in list(sys.modules.items()):
        if mod is None or not mod_name.startswith("mirage.commands."):
            continue
        candidates = list(vars(mod).values())
        commands = getattr(mod, "COMMANDS", None)
        if isinstance(commands, list):
            candidates.extend(commands)
        for attr in candidates:
            if not callable(attr) or id(attr) in seen:
                continue
            seen.add(id(attr))
            rcs = getattr(attr, "_registered_commands", None)
            if not rcs:
                continue
            for rc in rcs:
                out.setdefault(rc.name, []).append(rc)
    return out


def _by_resource(rcs: list[RegisteredCommand]) -> dict[str, Any]:
    """Per-registration metadata, keyed by resource.

    The union flags below cannot say *which* resource carries a provision,
    an aggregate, the write flag or a filetype, so dropping one backend's
    provision while another keeps it leaves every union unchanged. Key the
    same facts by resource so the parity check sees that difference.

    Args:
        rcs (list[RegisteredCommand]): every registration for one command.
    """
    out: dict[str, Any] = {}
    for rc in rcs:
        entry = out.setdefault(
            rc.resource if rc.resource is not None else "", {
                "has_provision": False,
                "has_aggregate": False,
                "has_write": False,
                "filetypes": set(),
            })
        entry["has_provision"] |= rc.provision_fn is not None
        entry["has_aggregate"] |= rc.aggregate is not None
        entry["has_write"] |= bool(rc.write)
        if rc.filetype is not None:
            entry["filetypes"].add(rc.filetype)
    return out


def _meta_for(rcs: list[RegisteredCommand]) -> dict[str, Any]:
    resources = sorted({rc.resource for rc in rcs if rc.resource is not None})
    filetypes = sorted({rc.filetype for rc in rcs if rc.filetype is not None})
    return {
        "has_provision": any(rc.provision_fn is not None for rc in rcs),
        "has_aggregate": any(rc.aggregate is not None for rc in rcs),
        "has_write": any(rc.write for rc in rcs),
        "resources": resources,
        "filetypes": filetypes,
        "by_resource": _by_resource(rcs),
    }


def _default(o: object) -> object:
    if isinstance(o, (set, frozenset)):
        return sorted(o)
    raise TypeError(f"unserializable: {type(o)}")


def _default_of(f: Field) -> Any:
    if f.default_factory is not MISSING:
        return f.default_factory()
    return f.default


def _prune(payload: dict[str, Any], cls: type) -> dict[str, Any]:
    """``payload`` without the fields ``cls`` would have defaulted anyway.

    A spec dump is a cross-language contract, and restating every
    default in all 93 files buries the handful of facts each command
    actually declares. The defaults come from the dataclass rather than
    a second table, so a field added to a spec type cannot fall out of
    step with this. ``type`` survives even at its default, because what
    a token *is* is the first thing a reader looks for.

    The typescript side prunes against a default-constructed instance
    for the same reason; the two must drop exactly the same keys or the
    parity gate reports every command.

    Args:
        payload (dict[str, Any]): one ``asdict`` level, every key
            present.
        cls (type): the dataclass the payload came from.
    """
    kept: dict[str, Any] = {}
    for f in fields(cls):
        value = payload[f.name]
        if f.name != "type" and value == _default_of(f):
            continue
        kept[f.name] = value
    return kept


def _spec_payload(spec: Any) -> dict[str, Any]:
    payload = _prune(asdict(spec), CommandSpec)
    if "options" in payload:
        payload["options"] = [_prune(o, Option) for o in payload["options"]]
    if "positional" in payload:
        payload["positional"] = [
            _prune(p, Operand) for p in payload["positional"]
        ]
    if payload.get("rest") is not None:
        payload["rest"] = _prune(payload["rest"], Operand)
    return payload


def _emit_one(name: str, spec: Any, rcs: list[RegisteredCommand]) -> None:
    payload = _spec_payload(spec)
    payload["_meta"] = _meta_for(rcs)
    path = OUT / f"{name}.json"
    path.write_text(
        json.dumps(payload, indent=2, sort_keys=True, default=_default) + "\n")


def _emit_resources(registry: dict[str, list[RegisteredCommand]]) -> None:
    """Dump the two resource-name sets the parity gate compares.

    ``registry`` is what ``build_resource`` can construct by name — the
    hand-maintained table workspace YAML and snapshots go through.
    ``command_resources`` is what the spec tree already knew: every
    resource registering at least one builtin command. A name in the
    second but not the first registers commands yet cannot be mounted by
    name, which is how SharePoint stayed unconstructible in python while
    appearing in every command's ``_meta``.

    Args:
        registry (dict[str, list[RegisteredCommand]]): registrations keyed
            by command name, as collected for the spec dump.
    """
    command_resources: set[str] = set()
    for rcs in registry.values():
        for rc in rcs:
            if rc.resource is not None:
                command_resources.add(str(rc.resource))
    payload = {
        "registry": sorted(REGISTRY),
        "command_resources": sorted(command_resources),
    }
    path = OUT.parent / "resources.json"
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n")
    print(f"emitted {len(payload['registry'])} registry names to {path}")


def main() -> None:
    failed = _walk_pkg(mirage.commands.builtin)
    if failed:
        raise SystemExit(
            "command modules failed to import, so their registrations would "
            "be missing from the dump:\n  " + "\n  ".join(failed) +
            "\n\nInstall the optional dependencies first:\n"
            "  cd python && uv sync --all-extras --no-extra camel")
    registry = _collect_registrations()
    OUT.mkdir(parents=True, exist_ok=True)
    for name, spec in sorted(SPECS.items()):
        _emit_one(name, spec, registry.get(name, []))
    print(f"emitted {len(SPECS)} specs to {OUT}")
    _emit_resources(registry)


if __name__ == "__main__":
    main()
