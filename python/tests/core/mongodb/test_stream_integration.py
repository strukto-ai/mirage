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
import os
import time
from pathlib import Path

import pytest
from dotenv import load_dotenv

from mirage.accessor.mongodb import MongoDBAccessor
from mirage.core.mongodb.stream import read_stream
from mirage.resource.mongodb.config import MongoDBConfig
from mirage.types import PathSpec

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
    uri = _load_env()
    return MongoDBAccessor(config=MongoDBConfig(uri=uri))


async def _collect_lines(gen) -> list[str]:
    chunks = []
    async for chunk in gen:
        chunks.append(chunk)
    text = b"".join(chunks).decode()
    return [line for line in text.split("\n") if line]


@pytest.mark.asyncio
async def test_extended_json_for_bson_types(accessor):
    path = PathSpec(resource_path=("/mirage_test/bson_types.jsonl").strip("/"),
                    virtual="/mirage_test/bson_types.jsonl",
                    directory="/mirage_test/bson_types.jsonl")
    lines = await _collect_lines(read_stream(accessor, path))
    assert len(lines) == 5
    by_label = {json.loads(line)["label"]: json.loads(line) for line in lines}
    scalars = by_label["scalars"]
    assert scalars["_id"] == {"$oid": "65f0000000000000000000a1"}
    assert scalars["decimal"] == {"$numberDecimal": "123456789.987654321"}
    assert scalars["int64"] == 1099511627776
    assert scalars["null"] is None
    temporal = by_label["temporal"]
    assert "$date" in temporal["date_utc"]
    binary_and_regex = by_label["binary_and_regex"]
    assert "$binary" in binary_and_regex["binary"]
    nested = by_label["nested"]
    assert nested["metadata"]["nested"]["leaf"] == {
        "$oid": "65f0000000000000000000b1"
    }


@pytest.mark.asyncio
async def test_streams_full_5000_docs_without_cap(accessor):
    path = PathSpec(
        resource_path=("/mirage_test/streaming_large.jsonl").strip("/"),
        virtual="/mirage_test/streaming_large.jsonl",
        directory="/mirage_test/streaming_large.jsonl")
    count = 0
    async for chunk in read_stream(accessor, path, batch_size=500):
        count += chunk.count(b"\n")
    assert count == 5000


@pytest.mark.asyncio
async def test_short_circuit_when_only_first_doc_consumed(accessor):
    path = PathSpec(
        resource_path=("/mirage_test/streaming_large.jsonl").strip("/"),
        virtual="/mirage_test/streaming_large.jsonl",
        directory="/mirage_test/streaming_large.jsonl")
    start = time.monotonic()
    gen = read_stream(accessor, path, batch_size=100)
    first = await gen.__anext__()
    await gen.aclose()
    elapsed = time.monotonic() - start
    assert first
    assert elapsed < 5.0
