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

from mirage.resources.constants import STRUKTO
from mirage.resources.types import Template
from mirage.types import JsonValue


def walk_refs(value: JsonValue, found: list[str]) -> None:
    if isinstance(value, list):
        for item in value:
            walk_refs(item, found)
        return
    if not isinstance(value, dict):
        return
    if value.get("from") == STRUKTO and isinstance(value.get("ref"), str):
        if value["ref"] not in found:
            found.append(str(value["ref"]))
        return
    for item in value.values():
        walk_refs(item, found)


def secret_refs(config: JsonValue) -> list[str]:
    """The saved entries a config names through ``{from: strukto, ref}``,
    each once, in order.

    Args:
        config (JsonValue): a workspace config.
    """
    found: list[str] = []
    walk_refs(config, found)
    return found


def uses_of(templates: list[Template]) -> dict[str, list[str]]:
    """The templates whose config names each entry, by the entry's name.

    Args:
        templates (list[Template]): the saved templates.
    """
    out: dict[str, list[str]] = {}
    for template in templates:
        for ref in secret_refs(template.config):
            names = out.setdefault(ref, [])
            if template.name not in names:
                names.append(template.name)
    return out
