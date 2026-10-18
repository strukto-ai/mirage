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

# Marshals as gh 2.85.0's types do under Go 1.25.5's encoding/json
# (MIT and BSD-3-Clause; see licenses/third_party/gh.txt and go.txt).

from dataclasses import dataclass
from typing import Any, Literal, TypeAlias

Primitive: TypeAlias = Literal[
    "string", "int", "bool", "time", "raw", "author", "reactions", "owner"
]

ZERO_TIME = "0001-01-01T00:00:00Z"


@dataclass(frozen=True, slots=True)
class Struct:
    """Ordered, zero-filled Go fields; nullable structs preserve null."""

    fields: tuple[tuple[str, "Shape", str | None], ...]
    nullable: bool


@dataclass(frozen=True, slots=True)
class ListOf:
    """A Go slice that preserves null when the answer carried none."""

    item: "Shape"


@dataclass(frozen=True, slots=True)
class OrNull:
    """A Go pointer to a shape that marshals itself."""

    item: "Shape"


# The Go type gh decodes a field into, which is what decides how it
# prints. A string prints "" for null, a number 0 and a bool false;
# "time" is a non-pointer time.Time, whose zero is the year-one
# timestamp; "raw" is a pointer (or a nullable time) and stays null.
#
# Three of gh's types marshal themselves. "author" is its Author, which
# prints a user as {id, is_bot, login, name} and an actor with no id (a
# bot, whose login the query reads without one) as "app/<login>".
# "reactions" is its ReactionGroups, which drops every group nobody
# reacted with and prints [] rather than null. "owner" is its Owner,
# whose id and name are omitempty. OrNull is a pointer to any of them.
Shape: TypeAlias = Primitive | Struct | ListOf | OrNull


def struct(*fields: tuple[str, Shape] | tuple[str, Shape, str]) -> Struct:
    return Struct(
        tuple((f[0], f[1], f[2] if len(f) > 2 else None) for f in fields),
        False,
    )


def pointer(*fields: tuple[str, Shape]) -> Struct:
    return Struct(tuple((name, shape, None) for name, shape in fields), True)


_REACTION = struct(
    ("content", "string"), ("users", struct(("totalCount", "int")))
)


def _text(value: Any) -> str:
    return value if isinstance(value, str) else ""


def _author(value: Any) -> dict[str, Any]:
    """gh's Author.MarshalJSON: a bot is the one with no id.

    Args:
        value (Any): the actor as the answer carried it.
    """
    row = value if isinstance(value, dict) else {}
    ident = _text(row.get("id"))
    if not ident:
        return {"is_bot": True, "login": f"app/{_text(row.get('login'))}"}
    return {
        "id": ident,
        "is_bot": False,
        "login": _text(row.get("login")),
        "name": _text(row.get("name")),
    }


def _reactions(value: Any) -> list[Any]:
    """gh's ReactionGroups.MarshalJSON: only the groups someone reacted
    with.

    Args:
        value (Any): the reaction groups as the answer carried them.
    """
    if not isinstance(value, list):
        return []
    kept: list[Any] = []
    for group in value:
        users = group.get("users") if isinstance(group, dict) else None
        count = users.get("totalCount") if isinstance(users, dict) else None
        if isinstance(count, int) and not isinstance(count, bool) and count:
            kept.append(exported(group, _REACTION))
    return kept


def _owner(value: Any) -> dict[str, Any]:
    """gh's Owner, whose id and name are omitempty.

    Args:
        value (Any): the owner as the answer carried it.
    """
    row = value if isinstance(value, dict) else {}
    out: dict[str, Any] = {}
    if _text(row.get("id")):
        out["id"] = row["id"]
    if _text(row.get("name")):
        out["name"] = row["name"]
    out["login"] = _text(row.get("login"))
    return out


def exported(value: Any, shape: Shape) -> Any:
    """One value as gh prints it once decoded into ``shape``.

    Args:
        value (Any): the value as the answer carried it.
        shape (Shape): the Go type gh decodes it into.
    """
    if shape == "string":
        return value if isinstance(value, str) else ""
    if shape == "int":
        return (
            value
            if isinstance(value, int) and not isinstance(value, bool)
            else 0
        )
    if shape == "bool":
        return value if isinstance(value, bool) else False
    if shape == "time":
        return value if isinstance(value, str) else ZERO_TIME
    if shape == "raw":
        return value
    if shape == "author":
        return _author(value)
    if shape == "reactions":
        return _reactions(value)
    if shape == "owner":
        return _owner(value)
    if isinstance(shape, ListOf):
        return (
            [exported(item, shape.item) for item in value]
            if isinstance(value, list)
            else None
        )
    if isinstance(shape, OrNull):
        return None if value is None else exported(value, shape.item)
    assert isinstance(shape, Struct)
    if value is None and shape.nullable:
        return None
    row = value if isinstance(value, dict) else {}
    return {
        name: exported(row.get(source or name), inner)
        for name, inner, source in shape.fields
    }
