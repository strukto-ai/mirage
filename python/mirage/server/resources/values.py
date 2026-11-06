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
from dataclasses import dataclass
from typing import TypeGuard
from urllib.parse import urlparse

from mirage.resources.constants import STRUKTO
from mirage.resources.errors import ResourceError
from mirage.resources.types import EntryKind, Fields
from mirage.server.resources.types import Field, TypeTable
from mirage.types import JsonValue

MAX_BYTES = 16 * 1024

POINTER_KEYS = frozenset({"from", "ref", "key"})

TYPEOF: dict[str, tuple[type, ...]] = {
    "string": (str,),
    "number": (int, float),
    "boolean": (bool,),
}


@dataclass(frozen=True)
class Checked:
    """An entry's values split as they are kept: ``config`` plain,
    ``sealed`` write-only."""

    config: Fields
    sealed: Fields


def invalid(message: str) -> ResourceError:
    return ResourceError("invalid", message)


def is_pointer(value: JsonValue) -> TypeGuard[dict[str, JsonValue]]:
    """Whether a value is a ``{from, ref, key}`` pointer to a store's
    secret: a mapping of exactly those keys, so an ordinary field that
    holds a ``from`` is left alone.

    Args:
        value (JsonValue): the value.
    """
    if not isinstance(value, dict) or not set(value) <= POINTER_KEYS:
        return False
    source, key, ref = value.get("from"), value.get("key"), value.get("ref")
    return (
        isinstance(source, str)
        and source != ""
        and isinstance(key, str)
        and key != ""
        and (ref is None or isinstance(ref, str))
    )


def stores_of(config: Fields) -> list[str]:
    """The stores an entry's fields point at, each once, in order.

    Args:
        config (Fields): the entry's plain fields.
    """
    found: list[str] = []
    for value in config.values():
        if is_pointer(value) and value["from"] not in found:
            found.append(str(value["from"]))
    return found


def fields_of(kind: EntryKind, type: str, types: TypeTable) -> list[Field]:
    fields = types.get(type)
    if fields is None:
        raise invalid(f"type must be a {kind}: {', '.join(types)}")
    return fields


def text_of(value: JsonValue) -> str:
    """A value as JavaScript's ``String`` writes it, to match an option.

    Args:
        value (JsonValue): the value.
    """
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def pointer_of(field: Field, raw: dict[str, JsonValue], at: str) -> Fields:
    if raw["from"] == STRUKTO:
        raise invalid(f"{at} must be a value or a secret store")
    if "options" in field:
        raise invalid(f"{at} must be one of {', '.join(field['options'])}")
    ref = raw.get("ref")
    ref = ref.strip() if isinstance(ref, str) else ""
    if ref == "":
        raise invalid(f"{at} must be a pointer with a ref")
    key = str(raw["key"]).strip()
    if key == "":
        raise invalid(f"{at} must be a pointer with a key")
    return {"from": raw["from"], "ref": ref, "key": key}


def value_of(
    kind: EntryKind, field: Field, raw: JsonValue, at: str
) -> JsonValue:
    """One field's value checked against its type. A string field of a
    VFS, CLI or runtime may instead point at a store; a store's own keys
    come from no other store.

    Args:
        kind (EntryKind): the entry's kind.
        field (Field): the field.
        raw (JsonValue): the value given.
        at (str): the field's name, for the error.
    """
    if is_pointer(raw) and kind != "store" and field["type"] == "string":
        return pointer_of(field, raw, at)
    if field["type"] == "list":
        if not isinstance(raw, list) or not all(
            isinstance(v, str) and v != "" for v in raw
        ):
            raise invalid(f"{at} must be a list of strings")
    elif not isinstance(raw, TYPEOF[field["type"]]) or (
        field["type"] == "number" and isinstance(raw, bool)
    ):
        raise invalid(f"{at} must be a {field['type']}")
    options = field.get("options")
    if options is not None and text_of(raw) not in options:
        raise invalid(f"{at} must be one of {', '.join(options)}")
    return raw


def check_rules(kind: EntryKind, type: str, config: Fields) -> None:
    """The checks a type needs beyond its fields' types.

    Args:
        kind (EntryKind): the entry's kind.
        type (str): its type.
        config (Fields): its plain fields.
    """
    url = config.get("url")
    if kind == "cli" and type == "mcp" and isinstance(url, str):
        parsed = urlparse(url)
        if parsed.scheme != "https" or not parsed.netloc:
            raise invalid("url must be the MCP server's https URL")


def check_values(
    kind: EntryKind,
    type: str,
    given: JsonValue,
    types: TypeTable,
    kept: frozenset[str] = frozenset(),
) -> Checked:
    """A body's fields checked against the type's, split into the plain
    and the sealed. Empty values are left out; ``kept`` names the sealed
    fields an edit keeps, which count as given.

    Args:
        kind (EntryKind): the entry's kind.
        type (str): its type.
        given (JsonValue): the body's ``fields``.
        types (TypeTable): the kind's types.
        kept (frozenset[str]): the sealed fields an edit keeps.

    Raises:
        ResourceError: ``invalid``, naming what is wrong.
    """
    fields = fields_of(kind, type, types)
    if not isinstance(given, dict):
        raise invalid("fields must be an object")
    config: Fields = {}
    sealed: Fields = {}
    for name, raw in given.items():
        if raw is None or raw == "":
            continue
        field = next((f for f in fields if f["name"] == name), None)
        if field is None:
            names = ", ".join(f["name"] for f in fields)
            raise invalid(f"{type} has no field {name}; it takes {names}")
        value = value_of(kind, field, raw, name)
        if field["secret"] and not is_pointer(value):
            sealed[name] = value
        else:
            config[name] = value
    named = {*config, *sealed, *kept}
    for f in fields:
        group = f.get("group")
        used = group is None or any(
            g.get("group") == group and g["name"] in named for g in fields
        )
        if f["required"] and used and f["name"] not in named:
            raise invalid(f"{f['name']} is required")
    check_rules(kind, type, config)
    size = len(
        json.dumps(
            {"config": config, "sealed": sealed},
            separators=(",", ":"),
            ensure_ascii=False,
        ).encode()
    )
    if size > MAX_BYTES:
        raise invalid("fields are larger than 16 KB")
    return Checked(config=config, sealed=sealed)
