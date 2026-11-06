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

from pydantic import BaseModel

from mirage.config import WorkspaceConfig
from mirage.resources.base import ResourceStore
from mirage.resources.constants import ENTRY_KINDS, STRUKTO
from mirage.resources.errors import ResourceError
from mirage.secrets.config import SecretSource
from mirage.secrets.errors import SecretsError
from mirage.secrets.types import ResolvedSecret
from mirage.types import JsonValue


class StruktoSourceConfig(BaseModel):
    """The ``strukto`` secrets source's config: each saved entry a
    workspace's config names, field by field.

    Args:
        entries (dict[str, dict[str, str]]): the fields of each entry, by
            the entry's name.
    """

    entries: dict[str, dict[str, str]]


async def fetch_strukto(
    config: StruktoSourceConfig, ref: str
) -> ResolvedSecret:
    """The fields of the saved entry ``ref``, as a workspace was handed them.

    Args:
        config (StruktoSourceConfig): the entries the workspace names.
        ref (str): the entry's name.

    Raises:
        SecretsError: the workspace was handed no entry of that name.
    """
    fields = config.entries.get(ref)
    if fields is None:
        raise SecretsError(f"no saved entry named {ref!r}")
    return ResolvedSecret(fields=fields)


def _flat(value: JsonValue) -> str:
    """A field's value as a secret's field holds it: a string as it is, a
    list joined by commas, anything else as JSON.

    Args:
        value (JsonValue): the saved value.
    """
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return ",".join(_flat(item) for item in value)
    return json.dumps(value)


async def with_entries(
    store: ResourceStore, config: WorkspaceConfig, refs: list[str]
) -> WorkspaceConfig:
    """The config with the saved entries its ``{from: strukto, ref, key}``
    pointers name declared as the ``strukto`` source, sealed fields
    opened, so mirage reads each pointer as it reads any secret's. A saved
    field never points at a store, since a save refuses one.

    Args:
        store (ResourceStore): where the entries are saved.
        config (WorkspaceConfig): the checked config.
        refs (list[str]): the entries its pointers name.

    Raises:
        ResourceError: a name is not saved as a VFS, CLI or runtime.
    """
    kinds = {
        entry.name: kind
        for kind in ENTRY_KINDS
        for entry in await store.list_entries(kind)
    }
    entries: dict[str, dict[str, str]] = {}
    for ref in refs:
        kind = kinds.get(ref)
        if kind is None:
            raise ResourceError(
                "invalid", f"{ref} is not saved as a VFS, CLI or runtime"
            )
        entry = await store.reveal_entry(kind, ref)
        entries[ref] = {
            k: _flat(v) for k, v in {**entry.fields, **entry.sealed}.items()
        }
    declared = {
        **(config.secrets or {}),
        STRUKTO: SecretSource(source=STRUKTO, config={"entries": entries}),
    }
    return config.model_copy(update={"secrets": declared})
