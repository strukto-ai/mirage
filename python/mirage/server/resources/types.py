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


from enum import StrEnum
from typing import Literal, NotRequired, TypeAlias, TypedDict


class ResourceStoreBackend(StrEnum):
    """Where the daemon keeps saved configs: files under the mirage home,
    or memory for tests."""

    FILES = "files"
    MEMORY = "memory"


FieldType: TypeAlias = Literal["string", "number", "boolean", "list"]


class Field(TypedDict):
    """One field of a type's config, as a config file writes it and as
    a ``/types`` route answers it."""

    name: str
    type: FieldType
    secret: bool
    required: bool
    options: NotRequired[list[str]]
    description: NotRequired[str]
    default: NotRequired[str | int | float | bool]
    group: NotRequired[str]


TypeTable: TypeAlias = dict[str, list[Field]]
"""Each type of a kind with its fields, by type name."""
