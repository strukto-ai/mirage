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

from mirage.accessor.langfuse import LangfuseAccessor
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.core.langfuse.readdir import readdir
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
async def test_readdir_root(accessor, index):
    result = await readdir(
        accessor, PathSpec(resource_path="", virtual="/", directory="/"),
        index)
    assert result == ["/traces", "/sessions", "/prompts", "/datasets"]


@pytest.mark.asyncio
async def test_readdir_traces(accessor, index):
    with patch(
            "mirage.core.langfuse.readdir.fetch_traces",
            new_callable=AsyncMock,
            return_value=[
                {
                    "id": "abc123",
                    "name": "chat"
                },
                {
                    "id": "def456",
                    "name": "search"
                },
            ],
    ):
        result = await readdir(
            accessor,
            PathSpec(resource_path="traces",
                     virtual="/traces",
                     directory="/traces"), index)

    assert "/traces/abc123.json" in result
    assert "/traces/def456.json" in result


@pytest.mark.asyncio
async def test_readdir_sessions(accessor, index):
    with patch(
            "mirage.core.langfuse.readdir.fetch_sessions",
            new_callable=AsyncMock,
            return_value=[{
                "id": "session-1"
            }, {
                "id": "session-2"
            }],
    ):
        result = await readdir(
            accessor,
            PathSpec(resource_path="sessions",
                     virtual="/sessions",
                     directory="/sessions"), index)

    assert "/sessions/session-1" in result
    assert "/sessions/session-2" in result


@pytest.mark.asyncio
async def test_readdir_prompts(accessor, index):
    with patch(
            "mirage.core.langfuse.readdir.fetch_prompts",
            new_callable=AsyncMock,
            return_value=[
                {
                    "name": "summarize",
                    "version": 1
                },
                {
                    "name": "translate",
                    "version": 1
                },
            ],
    ):
        result = await readdir(
            accessor,
            PathSpec(resource_path="prompts",
                     virtual="/prompts",
                     directory="/prompts"), index)

    assert "/prompts/summarize" in result
    assert "/prompts/translate" in result


@pytest.mark.asyncio
async def test_readdir_datasets(accessor, index):
    with patch(
            "mirage.core.langfuse.readdir.fetch_datasets",
            new_callable=AsyncMock,
            return_value=[{
                "name": "qa-eval"
            }, {
                "name": "chat-eval"
            }],
    ):
        result = await readdir(
            accessor,
            PathSpec(resource_path="datasets",
                     virtual="/datasets",
                     directory="/datasets"), index)

    assert "/datasets/qa-eval" in result
    assert "/datasets/chat-eval" in result


@pytest.mark.asyncio
async def test_readdir_dataset_contents(accessor, index):
    result = await readdir(
        accessor,
        PathSpec(resource_path="datasets/qa-eval",
                 virtual="/datasets/qa-eval",
                 directory="/datasets/qa-eval"), index)
    assert "/datasets/qa-eval/items.jsonl" in result
    assert "/datasets/qa-eval/runs" in result


@pytest.mark.asyncio
async def test_readdir_dotfile_raises(accessor, index):
    with pytest.raises(FileNotFoundError):
        await readdir(
            accessor,
            PathSpec(resource_path=".hidden",
                     virtual="/.hidden",
                     directory="/.hidden"), index)


@pytest.mark.asyncio
async def test_readdir_dotfile_nested_raises(accessor, index):
    with pytest.raises(FileNotFoundError):
        await readdir(
            accessor,
            PathSpec(resource_path="traces/.DS_Store",
                     virtual="/traces/.DS_Store",
                     directory="/traces/.DS_Store"), index)
