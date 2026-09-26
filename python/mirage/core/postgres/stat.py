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
from mirage.core.postgres.readdir import entity_guard, readdir, schema_guard
from mirage.core.postgres.scope import detect_scope


def _schema_extra(match: ScopeMatch) -> dict[str, str]:
    return {"schema": match.slots["schema"]}


def _kind_extra(match: ScopeMatch) -> dict[str, str]:
    return {
        "schema": match.slots["schema"],
        "kind": match.slots["kind"],
    }


def _entity_extra(match: ScopeMatch) -> dict[str, str]:
    return {
        "schema": match.slots["schema"],
        "kind": match.slots["kind"],
        "name": match.slots["entity"],
    }


stat = make_stat(
    detect_scope,
    readdir,
    guards={
        "schema": schema_guard,
        "kind": schema_guard,
        "entity": entity_guard,
        "entity_schema": entity_guard,
        "entity_semantic": entity_guard,
        "entity_rows": entity_guard,
    },
    extras={
        "schema": _schema_extra,
        "kind": _kind_extra,
        "entity": _entity_extra,
        "entity_schema": _entity_extra,
        "entity_semantic": _entity_extra,
        "entity_rows": _entity_extra,
    },
)
