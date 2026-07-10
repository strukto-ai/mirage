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
from dataclasses import asdict
from pathlib import Path
from typing import Any

import mirage.commands.builtin
from mirage.commands.config import RegisteredCommand
from mirage.commands.spec import SPECS

logger = logging.getLogger(__name__)

OUT = Path(__file__).resolve().parent.parent / "spec" / "python" / "general"


def _walk_pkg(pkg: Any) -> None:
    for _finder, name, _ispkg in pkgutil.walk_packages(pkg.__path__,
                                                       pkg.__name__ + "."):
        try:
            importlib.import_module(name)
        except ImportError as e:
            logger.debug("skip %s: %s", name, e)


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


def _meta_for(rcs: list[RegisteredCommand]) -> dict[str, Any]:
    resources = sorted({rc.resource for rc in rcs if rc.resource is not None})
    filetypes = sorted({rc.filetype for rc in rcs if rc.filetype is not None})
    return {
        "has_provision": any(rc.provision_fn is not None for rc in rcs),
        "has_aggregate": any(rc.aggregate is not None for rc in rcs),
        "has_write": any(rc.write for rc in rcs),
        "resources": resources,
        "filetypes": filetypes,
    }


def _default(o: object) -> object:
    if isinstance(o, (set, frozenset)):
        return sorted(o)
    raise TypeError(f"unserializable: {type(o)}")


def _emit_one(name: str, spec: Any, rcs: list[RegisteredCommand]) -> None:
    payload = asdict(spec)
    payload["_meta"] = _meta_for(rcs)
    path = OUT / f"{name}.json"
    path.write_text(
        json.dumps(payload, indent=2, sort_keys=True, default=_default) + "\n")


def main() -> None:
    _walk_pkg(mirage.commands.builtin)
    registry = _collect_registrations()
    OUT.mkdir(parents=True, exist_ok=True)
    for name, spec in sorted(SPECS.items()):
        _emit_one(name, spec, registry.get(name, []))
    print(f"emitted {len(SPECS)} specs to {OUT}")


if __name__ == "__main__":
    main()
