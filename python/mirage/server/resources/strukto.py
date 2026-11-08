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
from typing import Any

from pydantic import BaseModel

from mirage.config import WorkspaceConfig
from mirage.resources.base import ResourceStore
from mirage.resources.constants import ENTRY_KINDS, STRUKTO
from mirage.resources.errors import ResourceError
from mirage.resources.types import Fields
from mirage.secrets.config import SecretSource
from mirage.secrets.errors import SecretsError
from mirage.secrets.sources import is_config_pointer
from mirage.secrets.types import ResolvedSecret
from mirage.server.schemas import check_config
from mirage.types import JsonValue


class StruktoSourceConfig(BaseModel):
    """The ``strukto`` secrets source's config: the fields of each saved
    entry a workspace's config names, the sealed ones opened.

    Args:
        entries (dict[str, dict[str, str]]): the fields of each entry, by
            the entry's name.
    """

    entries: dict[str, dict[str, str]]


async def fetch_strukto(
    config: StruktoSourceConfig, ref: str
) -> ResolvedSecret:
    """The fields of the saved entry ``ref``, as a workspace was handed
    them.

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
    """A saved value as a secret's field holds it: a string as it is,
    anything else as JSON.

    Args:
        value (JsonValue): the saved value.
    """
    if isinstance(value, str):
        return value
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False)


def _inline(value: Any, plain: dict[str, Fields]) -> Any:
    """``value`` with each ``{from: strukto, ref, key}`` that names a plain
    field replaced by the field's value, its type kept.

    Args:
        value (Any): a config, or a part of one.
        plain (dict[str, Fields]): the plain fields of each named entry.
    """
    if isinstance(value, list):
        return [_inline(item, plain) for item in value]
    if not isinstance(value, dict):
        return value
    if is_config_pointer(value):
        fields = plain.get(value.get("ref", ""), {})
        if value["from"] == STRUKTO and value["key"] in fields:
            return fields[value["key"]]
        return value
    return {k: _inline(v, plain) for k, v in value.items()}


async def with_entries(
    store: ResourceStore, written: dict[str, Any], refs: list[str]
) -> WorkspaceConfig:
    """The config to build, with the saved entries its ``{from: strukto,
    ref, key}`` pointers name filled in. A pointer at a plain field becomes
    the field's value, so a list stays a list; one at a sealed field, and a
    managed ``env`` entry at any field, reads it from the ``strukto``
    source, declared here with each entry's fields and the sealed ones
    opened, as mirage reads any secret's. A saved field never points at a
    store, since a save refuses one.

    Args:
        store (ResourceStore): where the entries are saved.
        written (dict[str, Any]): the config as written.
        refs (list[str]): the entries its pointers name.

    Raises:
        ResourceError: a name is not saved as a VFS, CLI, runtime or
            machine, or a saved value is one its field cannot take.
    """
    kinds = {
        entry.name: kind
        for kind in ENTRY_KINDS
        for entry in await store.list_entries(kind)
    }
    plain: dict[str, Fields] = {}
    opened: dict[str, dict[str, str]] = {}
    for ref in refs:
        kind = kinds.get(ref)
        if kind is None:
            raise ResourceError(
                "invalid",
                f"{ref} is not saved as a VFS, CLI, runtime or machine",
            )
        entry = await store.reveal_entry(kind, ref)
        plain[ref] = entry.fields
        every = {**entry.fields, **entry.sealed}
        opened[ref] = {k: _flat(v) for k, v in every.items()}
    try:
        config = check_config(_inline(written, plain))
    except ValueError as e:
        raise ResourceError("invalid", str(e)) from e
    declared = {
        **(config.secrets or {}),
        STRUKTO: SecretSource(source=STRUKTO, config={"entries": opened}),
    }
    return config.model_copy(update={"secrets": declared})
