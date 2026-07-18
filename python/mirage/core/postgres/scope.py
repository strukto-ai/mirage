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
from typing import Literal, TypeAlias

from mirage.types import PathSpec

PostgresKind: TypeAlias = Literal["tables", "views"]


@dataclass(frozen=True)
class PostgresRootScope:
    resource_path: str = "/"
    level: Literal["root"] = field(default="root", init=False)


@dataclass(frozen=True)
class PostgresDatabaseJSONScope:
    resource_path: str
    file: Literal["database.json"] = field(default="database.json", init=False)
    level: Literal["database_json"] = field(default="database_json",
                                            init=False)


@dataclass(frozen=True)
class PostgresSchemaScope:
    schema: str
    resource_path: str
    level: Literal["schema"] = field(default="schema", init=False)


@dataclass(frozen=True)
class PostgresKindScope:
    schema: str
    kind: PostgresKind
    resource_path: str
    level: Literal["kind"] = field(default="kind", init=False)


@dataclass(frozen=True)
class PostgresEntityScope:
    schema: str
    kind: PostgresKind
    entity: str
    resource_path: str
    level: Literal["entity"] = field(default="entity", init=False)


@dataclass(frozen=True)
class PostgresEntitySchemaScope:
    schema: str
    kind: PostgresKind
    entity: str
    resource_path: str
    file: Literal["schema.json"] = field(default="schema.json", init=False)
    level: Literal["entity_schema"] = field(default="entity_schema",
                                            init=False)


@dataclass(frozen=True)
class PostgresEntityRowsScope:
    schema: str
    kind: PostgresKind
    entity: str
    resource_path: str
    file: Literal["rows.jsonl"] = field(default="rows.jsonl", init=False)
    level: Literal["entity_rows"] = field(default="entity_rows", init=False)


@dataclass(frozen=True)
class PostgresInvalidScope:
    resource_path: str
    level: Literal["invalid"] = field(default="invalid", init=False)


PostgresScope: TypeAlias = (PostgresRootScope | PostgresDatabaseJSONScope
                            | PostgresSchemaScope | PostgresKindScope
                            | PostgresEntityScope | PostgresEntitySchemaScope
                            | PostgresEntityRowsScope | PostgresInvalidScope)


def detect_scope(path: PathSpec) -> PostgresScope:
    raw = path.mount_path
    key = raw.strip("/")

    if not key:
        return PostgresRootScope(resource_path="/")

    if key == "database.json":
        return PostgresDatabaseJSONScope(resource_path=raw)

    parts = key.split("/")

    if len(parts) == 1:
        return PostgresSchemaScope(schema=parts[0], resource_path=raw)

    if len(parts) == 2 and parts[1] in ("tables", "views"):
        kind: PostgresKind = "tables" if parts[1] == "tables" else "views"
        return PostgresKindScope(schema=parts[0], kind=kind, resource_path=raw)

    if len(parts) == 3 and parts[1] in ("tables", "views"):
        kind = "tables" if parts[1] == "tables" else "views"
        return PostgresEntityScope(schema=parts[0],
                                   kind=kind,
                                   entity=parts[2],
                                   resource_path=raw)

    if len(parts) == 4 and parts[1] in ("tables", "views") and parts[3] in (
            "schema.json", "rows.jsonl"):
        kind = "tables" if parts[1] == "tables" else "views"
        if parts[3] == "schema.json":
            return PostgresEntitySchemaScope(schema=parts[0],
                                             kind=kind,
                                             entity=parts[2],
                                             resource_path=raw)
        return PostgresEntityRowsScope(schema=parts[0],
                                       kind=kind,
                                       entity=parts[2],
                                       resource_path=raw)

    return PostgresInvalidScope(resource_path=raw)
