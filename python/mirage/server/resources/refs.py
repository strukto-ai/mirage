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
from mirage.resources.constants import ENTRY_KINDS
from mirage.server.resources.values import STRUKTO, is_pointer, stores_of
from mirage.types import JsonValue


def walk_refs(value: JsonValue, found: list[str], entries: bool) -> None:
    if isinstance(value, list):
        for item in value:
            walk_refs(item, found, entries)
        return
    if not isinstance(value, dict):
        return
    source = value.get("from")
    if entries and source == STRUKTO and isinstance(value.get("ref"), str):
        if value["ref"] not in found:
            found.append(str(value["ref"]))
        return
    if not entries and is_pointer(value):
        if source != STRUKTO and source not in found:
            found.append(str(source))
        return
    for item in value.values():
        walk_refs(item, found, entries)


def secret_refs(config: JsonValue) -> list[str]:
    """The ``{from: strukto, ref}`` entries a config names, each once, in
    order. Mirrors the console's ``secretRefs``.

    Args:
        config (JsonValue): a workspace config.
    """
    found: list[str] = []
    walk_refs(config, found, entries=True)
    return found


def store_refs(config: JsonValue) -> list[str]:
    """The stores a config's ``{from: <store>, ref, key}`` pointers name,
    each once, in order. Mirrors the console's ``storeRefs``.

    Args:
        config (JsonValue): a workspace config.
    """
    found: list[str] = []
    walk_refs(config, found, entries=False)
    return found


async def entry_stores(store: ResourceStore) -> dict[str, list[str]]:
    """The stores each entry's fields point at, by the entry's name.

    Args:
        store (ResourceStore): the saved configs.
    """
    return {
        entry.name: stores_of(entry.fields)
        for kind in ENTRY_KINDS
        for entry in await store.list_entries(kind)
    }


async def uses(store: ResourceStore) -> dict[str, list[str]]:
    """The saved templates whose config names each entry, by the entry's
    name: a store's are those naming it, or naming an entry whose fields
    point at it. The daemon keeps no live workspace to count, so a saved
    template is what refers to an entry.

    Args:
        store (ResourceStore): the saved configs.
    """
    through = await entry_stores(store)
    out: dict[str, list[str]] = {}

    def add(entry: str, template: str) -> None:
        names = out.setdefault(entry, [])
        if template not in names:
            names.append(template)

    for template in await store.list_templates():
        for ref in secret_refs(template.config):
            add(ref, template.name)
            for source in through.get(ref, []):
                add(source, template.name)
        for source in store_refs(template.config):
            add(source, template.name)
    return out
