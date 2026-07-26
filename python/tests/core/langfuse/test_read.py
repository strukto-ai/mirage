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
from langfuse.api.core.api_error import ApiError

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
            PathSpec(resource_path="traces/abc123.json",
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
            PathSpec(resource_path="prompts/summarize/1.json",
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
            PathSpec(resource_path="datasets/qa-eval/items.jsonl",
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
            PathSpec(resource_path="not_a_valid_path",
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
            PathSpec(resource_path="sessions/sid1/tid1.json",
                     virtual="/sessions/sid1/tid1.json",
                     directory="/sessions/sid1/tid1.json"), index)

    parsed = json.loads(result)
    assert parsed["id"] == "tid1"


@pytest.mark.asyncio
async def test_read_dataset_run_renders_jsonl(accessor, index):
    # The path ends in .jsonl, so it must be one compact JSON object per line
    # with a trailing newline, not an indented document.
    runs = [{"name": "run-a", "metadata": {}}, {"name": "run-b"}]
    with patch(
            "mirage.core.langfuse.read.fetch_dataset_runs",
            new_callable=AsyncMock,
            return_value=runs,
    ):
        result = await read(
            accessor,
            PathSpec(resource_path="datasets/qa-eval/runs/run-a.jsonl",
                     virtual="/datasets/qa-eval/runs/run-a.jsonl",
                     directory="/datasets/qa-eval/runs/run-a.jsonl"), index)

    text = result.decode()
    assert text.endswith("\n")
    assert text.count("\n") == 1
    assert json.loads(text)["name"] == "run-a"


@pytest.mark.asyncio
async def test_read_trace_not_found_is_enoent(accessor, index):
    # A 404 from the API is a missing file, not a leaked SDK error string.
    with patch(
            "mirage.core.langfuse.read.fetch_trace",
            new_callable=AsyncMock,
            side_effect=ApiError(status_code=404, body={"message": "nope"}),
    ):
        with pytest.raises(FileNotFoundError):
            await read(
                accessor,
                PathSpec(resource_path="traces/gone.json",
                         virtual="/traces/gone.json",
                         directory="/traces/gone.json"), index)


@pytest.mark.asyncio
async def test_read_trace_server_error_propagates(accessor, index):
    # Only 404 maps to ENOENT; a 500 must not be disguised as a missing file.
    with patch(
            "mirage.core.langfuse.read.fetch_trace",
            new_callable=AsyncMock,
            side_effect=ApiError(status_code=500, body={"message": "boom"}),
    ):
        with pytest.raises(ApiError):
            await read(
                accessor,
                PathSpec(resource_path="traces/tid1.json",
                         virtual="/traces/tid1.json",
                         directory="/traces/tid1.json"), index)
