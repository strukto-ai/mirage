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

from collections.abc import Mapping

from mirage.types import JsonValue


def field_value(row: Mapping[str, JsonValue], field: str | None) -> JsonValue:
    """Read a Qdrant payload field, including dotted nested keys.

    Qdrant spells nested payload paths with dots in filters. Mirroring that
    spelling in config means ``metadata.source`` addresses
    ``{"metadata": {"source": ...}}`` everywhere the mount reads a field.

    Args:
        row (Mapping[str, JsonValue]): payload plus synthetic fields.
        field (str | None): configured payload path.
    """
    if not field:
        return None
    head, *tail = field.split(".")
    value = row.get(head)
    for part in tail:
        if not isinstance(value, Mapping) or part not in value:
            return None
        value = value[part]
    return value


def without_field(
    row: Mapping[str, JsonValue], field: str | None
) -> dict[str, JsonValue]:
    """Copy a payload while removing one dotted field path.

    Args:
        row (Mapping[str, JsonValue]): payload plus synthetic fields.
        field (str | None): configured payload path to drop.
    """
    copied = dict(row)
    if not field:
        return copied
    parts = field.split(".")
    if len(parts) == 1:
        copied.pop(field, None)
        return copied
    source: Mapping[str, JsonValue] = row
    target: dict[str, JsonValue] = copied
    for part in parts[:-1]:
        if not isinstance(source, Mapping):
            return copied
        child = source.get(part)
        if not isinstance(child, Mapping):
            return copied
        cloned = dict(child)
        target[part] = cloned
        source = child
        target = cloned
    target.pop(parts[-1], None)
    return copied
