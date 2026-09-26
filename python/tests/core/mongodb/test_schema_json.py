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
from mirage.core.mongodb._schema_json import (build_collection_schema_json,
                                              build_database_json)
from mirage.vfs.mongodb.config import MongoDBConfig


@pytest.fixture
def accessor():
    return MongoDBAccessor(config=MongoDBConfig(
        uri="mongodb://localhost:27017"))


@pytest.mark.asyncio
async def test_build_collection_schema_json_assembles_all_sections(accessor):
    fields = [{"path": "title", "presence": 1.0, "types": {"string": 1.0}}]
    indexes = [{"name": "_id_", "key": {"_id": 1}}]
    with (
            patch("mirage.core.mongodb._schema_json.get_validator",
                  new=AsyncMock(return_value={"bsonType": "object"})),
            patch("mirage.core.mongodb._schema_json.sample_field_types",
                  new=AsyncMock(return_value=fields)),
            patch("mirage.core.mongodb._schema_json.get_indexes",
                  new=AsyncMock(return_value=indexes)),
            patch("mirage.core.mongodb.client.get_index_stats",
                  new=AsyncMock(
                      side_effect=AssertionError("volatile counters"))),
            patch("mirage.core.mongodb.client.count_documents",
                  new=AsyncMock(side_effect=AssertionError("full scan"))),
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
    assert "document_count" not in out
    assert out["sampled"] == 100
    assert len(out["indexes"]) == 1
    enriched = out["indexes"][0]
    assert enriched["name"] == "_id_"
    assert enriched["keys"] == {"_id": 1}
    assert enriched["type"] == "btree"
    assert "stats" not in enriched


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
            patch("mirage.core.mongodb.client.get_index_stats",
                  new=AsyncMock(return_value={})),
            patch("mirage.core.mongodb.client.count_documents",
                  new=AsyncMock(return_value=0)),
            patch("mirage.core.mongodb._schema_json.is_view",
                  new=AsyncMock(return_value=False)),
    ):
        out = await build_collection_schema_json(accessor, "db1", "articles")
    assert out["indexes"][0]["type"] == "text"
    assert "stats" not in out["indexes"][0]


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
            patch("mirage.core.mongodb.client.get_index_stats",
                  new=AsyncMock(side_effect=AssertionError(
                      "get_index_stats must not be called for views"))),
            patch("mirage.core.mongodb.client.count_documents",
                  new=AsyncMock(return_value=40)),
            patch("mirage.core.mongodb._schema_json.is_view",
                  new=AsyncMock(return_value=True)),
    ):
        out = await build_collection_schema_json(accessor, "db1", "myview")
    assert out["kind"] == "view"
    assert out["indexes"] == []
    assert out["validator"] is None
    assert "document_count" not in out
    assert out["fields"] == fields


@pytest.mark.asyncio
async def test_database_manifest_does_not_query_each_collection(accessor):
    names = [f"collection_{n}" for n in range(5000)]
    with patch("mirage.core.mongodb._schema_json.list_collections",
               new=AsyncMock(side_effect=[names, ["view"]])) as listing:
        result = await build_database_json(accessor, "db")
    assert listing.await_count == 2
    assert len(result["collections"]) == 5000
    assert result["views"] == [{"name": "view"}]
