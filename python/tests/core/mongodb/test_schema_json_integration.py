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

import os
from pathlib import Path

import pytest
from dotenv import load_dotenv

from mirage.accessor.mongodb import MongoDBAccessor
from mirage.core.mongodb._schema_json import build_collection_schema_json
from mirage.resource.mongodb.config import MongoDBConfig

pytestmark = pytest.mark.skipif(
    os.environ.get("MIRAGE_RUN_INTEGRATION_MONGO") != "1",
    reason="integration test (set MIRAGE_RUN_INTEGRATION_MONGO=1 to enable)",
)


def _load_env() -> str:
    repo_root = Path(__file__).resolve().parents[4]
    load_dotenv(repo_root / ".env.development")
    uri = os.environ.get("MONGODB_URI")
    if not uri:
        pytest.skip("MONGODB_URI not set in .env.development")
    return uri


@pytest.fixture
def accessor():
    return MongoDBAccessor(config=MongoDBConfig(uri=_load_env()))


@pytest.mark.asyncio
async def test_schema_captures_jsonschema_validator(accessor):
    s = await build_collection_schema_json(accessor, "mirage_test",
                                           "with_validator")
    assert s["kind"] == "collection"
    assert s["validator"]["bsonType"] == "object"
    assert "title" in s["validator"]["required"]
    assert "year" in s["validator"]["required"]


@pytest.mark.asyncio
async def test_schema_recognizes_fixed_length_embedding_array(accessor):
    s = await build_collection_schema_json(accessor, "mirage_test",
                                           "embeddings")
    vec = next(f for f in s["fields"] if f["path"] == "vector")
    assert vec["types"] == {"array<double>(1024)": 1.0}


@pytest.mark.asyncio
async def test_schema_tags_text_index_and_returns_indexstats(accessor):
    s = await build_collection_schema_json(accessor, "mirage_test",
                                           "text_indexed")
    by_name = {idx["name"]: idx for idx in s["indexes"]}
    assert by_name["title_body_text"]["type"] == "text"
    assert "ops" in by_name["title_body_text"]["stats"]
    assert by_name["_id_"]["type"] == "btree"


@pytest.mark.asyncio
async def test_schema_view_marks_kind_and_skips_indexes(accessor):
    s = await build_collection_schema_json(accessor, "mirage_test",
                                           "high_rated_films")
    assert s["kind"] == "view"
    assert s["indexes"] == []
    assert s["document_count"] == 40


@pytest.mark.asyncio
async def test_schema_heterogeneous_collection_surfaces_mixed_types(accessor):
    s = await build_collection_schema_json(accessor,
                                           "mirage_test",
                                           "heterogeneous",
                                           sample_size=200)
    by_path = {f["path"]: f for f in s["fields"]}
    assert "metadata.tag" in by_path
    score = by_path["score"]
    assert set(score["types"].keys()).issubset({"string", "int", "null"})
    assert sum(score["types"].values()) == pytest.approx(score["presence"])
