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

from mirage.core.postgres.scope import detect_scope
from mirage.types import PathSpec


def _ps(p: str) -> PathSpec:
    return PathSpec(virtual=p, directory=p, resource_path=p.strip("/"))


def test_root():
    s = detect_scope(_ps("/"))
    assert s.level == "root"
    assert s.schema == ""
    assert s.resource_path == "/"


def test_root_empty_path():
    s = detect_scope(_ps(""))
    assert s.level == "root"


def test_database_json():
    s = detect_scope(_ps("/database.json"))
    assert s.level == "database_json"
    assert s.file == "database.json"


def test_schema():
    s = detect_scope(_ps("/public"))
    assert s.level == "schema"
    assert s.schema == "public"


def test_schema_with_trailing_slash():
    s = detect_scope(_ps("/public/"))
    assert s.level == "schema"
    assert s.schema == "public"


def test_kind_tables():
    s = detect_scope(_ps("/public/tables"))
    assert s.level == "kind"
    assert s.schema == "public"
    assert s.kind == "tables"


def test_kind_views():
    s = detect_scope(_ps("/analytics/views"))
    assert s.level == "kind"
    assert s.schema == "analytics"
    assert s.kind == "views"


def test_entity_table():
    s = detect_scope(_ps("/public/tables/users"))
    assert s.level == "entity"
    assert s.schema == "public"
    assert s.kind == "tables"
    assert s.entity == "users"


def test_entity_view():
    s = detect_scope(_ps("/analytics/views/daily_revenue"))
    assert s.level == "entity"
    assert s.kind == "views"
    assert s.entity == "daily_revenue"


def test_entity_schema_file():
    s = detect_scope(_ps("/public/tables/users/schema.json"))
    assert s.level == "entity_schema"
    assert s.schema == "public"
    assert s.kind == "tables"
    assert s.entity == "users"
    assert s.file == "schema.json"


def test_entity_rows_file():
    s = detect_scope(_ps("/public/tables/users/rows.jsonl"))
    assert s.level == "entity_rows"
    assert s.schema == "public"
    assert s.entity == "users"
    assert s.file == "rows.jsonl"


def test_view_entity_schema_file():
    s = detect_scope(_ps("/analytics/views/daily_revenue/schema.json"))
    assert s.level == "entity_schema"
    assert s.kind == "views"


def test_invalid_kind_segment():
    s = detect_scope(_ps("/public/sequences"))
    assert s.level == "invalid"


def test_invalid_too_deep():
    s = detect_scope(_ps("/public/tables/users/extra/foo"))
    assert s.level == "invalid"


def test_invalid_unknown_file():
    s = detect_scope(_ps("/public/tables/users/data.jsonl"))
    assert s.level == "invalid"


def test_invalid_kind_in_third_position():
    s = detect_scope(_ps("/public/wrong_kind/foo"))
    assert s.level == "invalid"
