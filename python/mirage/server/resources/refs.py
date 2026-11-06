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


from mirage.resources.base import ResourceStore
from mirage.server.resources.values import STRUKTO
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
    """The ``{from: strukto, ref}`` entries a config names, each once, in
    order. Mirrors the console's ``secretRefs``.

    Args:
        config (JsonValue): a workspace config.
    """
    found: list[str] = []
    walk_refs(config, found)
    return found


async def uses(store: ResourceStore) -> dict[str, list[str]]:
    """The saved templates whose config names each entry, by the entry's
    name. The daemon keeps no live workspace to count, so a saved
    template is what refers to an entry.

    Args:
        store (ResourceStore): the saved configs.
    """
    out: dict[str, list[str]] = {}
    for template in await store.list_templates():
        for ref in secret_refs(template.config):
            names = out.setdefault(ref, [])
            if template.name not in names:
                names.append(template.name)
    return out
