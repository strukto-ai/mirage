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


from dataclasses import dataclass, field
from typing import Literal, Protocol, TypeAlias

from mirage.types import JsonValue

EntryKind: TypeAlias = Literal["vfs", "cli", "runtime", "machine", "store"]
"""A kind whose entries hold a type's fields, some of them sealed."""

ResourceKind: TypeAlias = Literal[
    "vfs", "cli", "runtime", "machine", "store", "policy", "template"
]
"""Every kind of saved config a store keeps."""

Fields: TypeAlias = dict[str, JsonValue]


@dataclass(frozen=True)
class Entry:
    """A vfs, cli, runtime, machine or store entry as the API answers it:
    sealed fields by name only, sorted."""

    name: str
    type: str
    fields: Fields
    sealed: list[str]


@dataclass(frozen=True)
class RevealedEntry:
    """An entry with its sealed values in the clear, for building a
    workspace, never for an answer."""

    name: str
    type: str
    fields: Fields
    sealed: Fields


@dataclass(frozen=True)
class EntryInput:
    """An entry to save. ``fields`` replaces the plain fields. A sealed
    field left out of ``sealed`` keeps its value, one given as None is
    removed, and one named in ``fields`` is replaced by that plain
    value."""

    name: str
    type: str
    fields: Fields
    sealed: "dict[str, JsonValue | None]" = field(default_factory=dict)


@dataclass(frozen=True)
class Policy:
    name: str
    source: str


@dataclass(frozen=True)
class Template:
    name: str
    description: str | None
    config: Fields


@dataclass(frozen=True)
class TemplateInput:
    name: str
    config: Fields
    description: str | None = None


class ResourceRecords(Protocol):
    """Plain records by folder and name: what a backend stores in the
    open."""

    async def read(self, folder: str, name: str) -> Fields | None: ...

    async def write(self, folder: str, name: str, record: Fields) -> None: ...

    async def remove(self, folder: str, name: str) -> bool: ...

    async def names(self, folder: str) -> list[str]: ...


class Sealer(Protocol):
    """Where a backend keeps an entry's sealed values, apart from its
    record. ``read`` answers ``{}`` when there are none; ``write`` with
    none is the same as ``wipe``."""

    async def read(self, kind: EntryKind, name: str) -> Fields: ...

    async def write(
        self, kind: EntryKind, name: str, values: Fields
    ) -> None: ...

    async def wipe(self, kind: EntryKind, name: str) -> None: ...
