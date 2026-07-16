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

from dataclasses import dataclass

from mirage.types import PathSpec


@dataclass
class PostgresScope:
    level: str
    schema: str = ""
    kind: str = ""
    entity: str = ""
    file: str = ""
    resource_path: str = "/"


def detect_scope(path: PathSpec) -> PostgresScope:
    raw = path.mount_path if isinstance(path, PathSpec) else path
    key = raw.strip("/")

    if not key:
        return PostgresScope(level="root", resource_path="/")

    if key == "database.json":
        return PostgresScope(level="database_json",
                             file="database.json",
                             resource_path=raw)

    parts = key.split("/")

    if len(parts) == 1:
        return PostgresScope(level="schema",
                             schema=parts[0],
                             resource_path=raw)

    if len(parts) == 2 and parts[1] in ("tables", "views"):
        return PostgresScope(level="kind",
                             schema=parts[0],
                             kind=parts[1],
                             resource_path=raw)

    if len(parts) == 3 and parts[1] in ("tables", "views"):
        return PostgresScope(level="entity",
                             schema=parts[0],
                             kind=parts[1],
                             entity=parts[2],
                             resource_path=raw)

    if len(parts) == 4 and parts[1] in ("tables", "views") and parts[3] in (
            "schema.json", "rows.jsonl"):
        level = "entity_schema" if parts[3] == "schema.json" else "entity_rows"
        return PostgresScope(level=level,
                             schema=parts[0],
                             kind=parts[1],
                             entity=parts[2],
                             file=parts[3],
                             resource_path=raw)

    return PostgresScope(level="invalid", resource_path=raw)
