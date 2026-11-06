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
from mirage.secrets.sources import is_config_pointer
from mirage.types import JsonValue


def walk_refs(value: JsonValue, found: list[str]) -> None:
    if isinstance(value, list):
        for item in value:
            walk_refs(item, found)
        return
    if not isinstance(value, dict):
        return
    if is_config_pointer(value):
        ref = value.get("ref")
        if value["from"] == STRUKTO and ref and ref not in found:
            found.append(str(ref))
        return
    for item in value.values():
        walk_refs(item, found)


def secret_refs(config: JsonValue) -> list[str]:
    """The saved entries a config names through ``{from: strukto, ref,
    key}``, each once, in order. Only a pointer counts, by the rule the
    secrets layer reads one by, so a map such as an ``env`` holding
    ``from`` and ``ref`` is not one.

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
