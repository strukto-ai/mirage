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

from unittest.mock import AsyncMock, patch

import pytest

from mirage.accessor.mongodb import MongoDBAccessor
from mirage.core.mongodb._schema_json import build_collection_schema_json
from mirage.resource.mongodb.config import MongoDBConfig


@pytest.fixture
def accessor():
    return MongoDBAccessor(config=MongoDBConfig(
        uri="mongodb://localhost:27017"))


@pytest.mark.asyncio
async def test_build_collection_schema_json_assembles_all_sections(accessor):
    fields = [{"path": "title", "presence": 1.0, "types": {"string": 1.0}}]
    indexes = [{"name": "_id_", "key": {"_id": 1}}]
    stats = {"_id_": {"ops": 42, "since": "2026-03-01T00:00:00Z"}}
    with (
            patch("mirage.core.mongodb._schema_json.get_validator",
                  new=AsyncMock(return_value={"bsonType": "object"})),
            patch("mirage.core.mongodb._schema_json.sample_field_types",
                  new=AsyncMock(return_value=fields)),
            patch("mirage.core.mongodb._schema_json.get_indexes",
                  new=AsyncMock(return_value=indexes)),
            patch("mirage.core.mongodb._schema_json.get_index_stats",
                  new=AsyncMock(return_value=stats)),
            patch("mirage.core.mongodb._schema_json.count_documents",
                  new=AsyncMock(return_value=999)),
            patch("mirage.core.mongodb._schema_json.is_view",
                  new=AsyncMock(return_value=False)),
    ):
        out = await build_collection_schema_json(accessor, "db1", "movies")
    assert out["database"] == "db1"
    assert out["name"] == "movies"
    assert out["kind"] == "collection"
    assert out["validator"] == {"bsonType": "object"}
    assert out["fields"] == fields
    assert out["primary_key"] == "_id"
    assert out["document_count"] == 999
    assert out["sampled"] == 100
    assert len(out["indexes"]) == 1
    enriched = out["indexes"][0]
    assert enriched["name"] == "_id_"
    assert enriched["keys"] == {"_id": 1}
    assert enriched["type"] == "btree"
    assert enriched["stats"] == {"ops": 42, "since": "2026-03-01T00:00:00Z"}


@pytest.mark.asyncio
async def test_build_collection_schema_json_text_index_tagged(accessor):
    indexes = [{
        "name": "title_text",
        "key": {
            "_fts": "text",
            "_ftsx": 1
        },
        "textIndexVersion": 3,
    }]
    with (
            patch("mirage.core.mongodb._schema_json.get_validator",
                  new=AsyncMock(return_value=None)),
            patch("mirage.core.mongodb._schema_json.sample_field_types",
                  new=AsyncMock(return_value=[])),
            patch("mirage.core.mongodb._schema_json.get_indexes",
                  new=AsyncMock(return_value=indexes)),
            patch("mirage.core.mongodb._schema_json.get_index_stats",
                  new=AsyncMock(return_value={})),
            patch("mirage.core.mongodb._schema_json.count_documents",
                  new=AsyncMock(return_value=0)),
            patch("mirage.core.mongodb._schema_json.is_view",
                  new=AsyncMock(return_value=False)),
    ):
        out = await build_collection_schema_json(accessor, "db1", "articles")
    assert out["indexes"][0]["type"] == "text"
    assert out["indexes"][0]["stats"] == {}


@pytest.mark.asyncio
async def test_build_collection_schema_json_view_skips_indexes(accessor):
    fields = [{"path": "title", "presence": 1.0, "types": {"string": 1.0}}]
    with (
            patch("mirage.core.mongodb._schema_json.get_validator",
                  new=AsyncMock(return_value=None)),
            patch("mirage.core.mongodb._schema_json.sample_field_types",
                  new=AsyncMock(return_value=fields)),
            patch("mirage.core.mongodb._schema_json.get_indexes",
                  new=AsyncMock(side_effect=AssertionError(
                      "get_indexes must not be called for views"))),
            patch("mirage.core.mongodb._schema_json.get_index_stats",
                  new=AsyncMock(side_effect=AssertionError(
                      "get_index_stats must not be called for views"))),
            patch("mirage.core.mongodb._schema_json.count_documents",
                  new=AsyncMock(return_value=40)),
            patch("mirage.core.mongodb._schema_json.is_view",
                  new=AsyncMock(return_value=True)),
    ):
        out = await build_collection_schema_json(accessor, "db1", "myview")
    assert out["kind"] == "view"
    assert out["indexes"] == []
    assert out["validator"] is None
    assert out["document_count"] == 40
    assert out["fields"] == fields
