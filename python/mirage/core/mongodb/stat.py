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

from mirage.core.hierarchy.scope import ScopeMatch
from mirage.core.hierarchy.stat import make_stat
from mirage.core.mongodb.readdir import database_guard, entity_guard, readdir
from mirage.core.mongodb.scope import detect_scope, entity_kind


def _database_extra(match: ScopeMatch) -> dict[str, str]:
    return {"database": match.slots["database"]}


def _kind_dir_extra(match: ScopeMatch) -> dict[str, str]:
    return {
        "database": match.slots["database"],
        "kind": entity_kind(match),
    }


def _entity_extra(match: ScopeMatch) -> dict[str, str]:
    return {
        "database": match.slots["database"],
        "kind": entity_kind(match),
        "name": match.slots["name"],
    }


stat = make_stat(
    detect_scope,
    readdir,
    guards={
        "database": database_guard,
        "kind_dir": database_guard,
        "database_json": database_guard,
        "schema_json": entity_guard,
        "entity": entity_guard,
        "documents": entity_guard,
    },
    extras={
        "database": _database_extra,
        "kind_dir": _kind_dir_extra,
        "database_json": _database_extra,
        "schema_json": _entity_extra,
        "entity": _entity_extra,
        "documents": _entity_extra,
    },
)
