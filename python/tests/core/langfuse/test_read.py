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
from unittest.mock import AsyncMock, patch

import pytest

from mirage.accessor.langfuse import LangfuseAccessor
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.core.langfuse.read import read
from mirage.resource.langfuse.config import LangfuseConfig
from mirage.types import PathSpec


@pytest.fixture
def accessor():
    config = LangfuseConfig(
        public_key="pk-test",
        secret_key="sk-test",
    )
    with patch("mirage.accessor.langfuse.Langfuse"):
        return LangfuseAccessor(config=config)


@pytest.fixture
def index():
    return RAMIndexCacheStore()


@pytest.mark.asyncio
async def test_read_trace(accessor, index):
    trace_data = {"id": "abc123", "name": "chat", "input": "hello"}
    with patch(
            "mirage.core.langfuse.read.fetch_trace",
            new_callable=AsyncMock,
            return_value=trace_data,
    ):
        result = await read(
            accessor,
            PathSpec(resource_path=("/traces/abc123.json").strip("/"),
                     virtual="/traces/abc123.json",
                     directory="/traces/abc123.json"), index)

    parsed = json.loads(result)
    assert parsed["id"] == "abc123"
    assert parsed["name"] == "chat"


@pytest.mark.asyncio
async def test_read_prompt_version(accessor, index):
    prompt_data = {"name": "summarize", "version": 1, "prompt": "Summarize:"}
    with patch(
            "mirage.core.langfuse.read.fetch_prompt",
            new_callable=AsyncMock,
            return_value=prompt_data,
    ):
        result = await read(
            accessor,
            PathSpec(resource_path=("/prompts/summarize/1.json").strip("/"),
                     virtual="/prompts/summarize/1.json",
                     directory="/prompts/summarize/1.json"), index)

    parsed = json.loads(result)
    assert parsed["name"] == "summarize"
    assert parsed["version"] == 1


@pytest.mark.asyncio
async def test_read_dataset_items(accessor, index):
    items = [
        {
            "id": "item1",
            "input": "q1",
            "output": "a1"
        },
        {
            "id": "item2",
            "input": "q2",
            "output": "a2"
        },
    ]
    with patch(
            "mirage.core.langfuse.read.fetch_dataset_items",
            new_callable=AsyncMock,
            return_value=items,
    ):
        result = await read(
            accessor,
            PathSpec(
                resource_path=("/datasets/qa-eval/items.jsonl").strip("/"),
                virtual="/datasets/qa-eval/items.jsonl",
                directory="/datasets/qa-eval/items.jsonl"), index)

    lines = result.decode().strip().split("\n")
    assert len(lines) == 2
    assert json.loads(lines[0])["id"] == "item1"
    assert json.loads(lines[1])["id"] == "item2"


@pytest.mark.asyncio
async def test_read_invalid_path_raises(accessor, index):
    with pytest.raises(FileNotFoundError):
        await read(
            accessor,
            PathSpec(resource_path=("/not_a_valid_path").strip("/"),
                     virtual="/not_a_valid_path",
                     directory="/not_a_valid_path"), index)


@pytest.mark.asyncio
async def test_read_session_trace(accessor, index):
    trace_data = {"id": "tid1", "session_id": "sid1"}
    with patch(
            "mirage.core.langfuse.read.fetch_trace",
            new_callable=AsyncMock,
            return_value=trace_data,
    ):
        result = await read(
            accessor,
            PathSpec(resource_path=("/sessions/sid1/tid1.json").strip("/"),
                     virtual="/sessions/sid1/tid1.json",
                     directory="/sessions/sid1/tid1.json"), index)

    parsed = json.loads(result)
    assert parsed["id"] == "tid1"
