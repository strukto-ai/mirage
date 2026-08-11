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
from mirage.cache.index import IndexEntry
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.core.langfuse.render import jsonl_bytes
from mirage.core.langfuse.stat import stat
from mirage.resource.langfuse.config import LangfuseConfig
from mirage.types import FileType, PathSpec


async def seed_dir(index, virtual_key: str, names: list[str]) -> None:
    await index.set_dir(
        virtual_key,
        [(name,
          IndexEntry(
              id=name, name=name, resource_type="langfuse/x", vfs_name=name))
         for name in names])


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
async def test_stat_root(accessor, index):
    result = await stat(accessor,
                        PathSpec(resource_path="", virtual="/", directory="/"),
                        index)
    assert result.type == FileType.DIRECTORY
    assert result.name == "/"


@pytest.mark.asyncio
async def test_stat_traces_dir(accessor, index):
    result = await stat(
        accessor,
        PathSpec(resource_path="traces",
                 virtual="/traces",
                 directory="/traces"), index)
    assert result.type == FileType.DIRECTORY
    assert result.name == "traces"


@pytest.mark.asyncio
async def test_stat_trace_file(accessor, index):
    await seed_dir(index, "/traces", ["abc.json"])
    result = await stat(
        accessor,
        PathSpec(resource_path="traces/abc.json",
                 virtual="/traces/abc.json",
                 directory="/traces/abc.json"), index)
    assert result.type == FileType.JSON
    assert result.name == "abc.json"


@pytest.mark.asyncio
async def test_stat_session_dir(accessor, index):
    await seed_dir(index, "/sessions", ["sid1"])
    result = await stat(
        accessor,
        PathSpec(resource_path="sessions/sid1",
                 virtual="/sessions/sid1",
                 directory="/sessions/sid1"), index)
    assert result.type == FileType.DIRECTORY
    assert result.extra["session_id"] == "sid1"


@pytest.mark.asyncio
async def test_stat_prompt_version_file(accessor, index):
    await seed_dir(index, "/prompts/summarize", ["1.json"])
    result = await stat(
        accessor,
        PathSpec(resource_path="prompts/summarize/1.json",
                 virtual="/prompts/summarize/1.json",
                 directory="/prompts/summarize/1.json"), index)
    assert result.type == FileType.JSON
    assert result.name == "1.json"


@pytest.mark.asyncio
async def test_stat_dataset_items(accessor, index):
    items = [{"id": "i-1", "input": "a"}]
    with patch(
            "mirage.core.langfuse.readdir.fetch_dataset_items",
            new_callable=AsyncMock,
            return_value=items,
    ):
        result = await stat(
            accessor,
            PathSpec(resource_path="datasets/qa-eval/items.jsonl",
                     virtual="/datasets/qa-eval/items.jsonl",
                     directory="/datasets/qa-eval/items.jsonl"), index)
    assert result.type == FileType.TEXT
    assert result.name == "items.jsonl"
    assert result.size == len(jsonl_bytes(items))


@pytest.mark.asyncio
async def test_stat_dotfile_raises(accessor, index):
    with pytest.raises(FileNotFoundError):
        await stat(
            accessor,
            PathSpec(resource_path=".hidden",
                     virtual="/.hidden",
                     directory="/.hidden"), index)


@pytest.mark.asyncio
async def test_stat_dataset_runs_dir(accessor, index):
    with patch(
            "mirage.core.langfuse.readdir.fetch_dataset_items",
            new_callable=AsyncMock,
            return_value=[],
    ):
        result = await stat(
            accessor,
            PathSpec(resource_path="datasets/qa-eval/runs",
                     virtual="/datasets/qa-eval/runs",
                     directory="/datasets/qa-eval/runs"), index)
    assert result.type == FileType.DIRECTORY
    assert result.name == "runs"


@pytest.mark.asyncio
async def test_stat_unlisted_trace_raises(accessor, index):
    # A recognizable path shape is not evidence the trace exists: an id absent
    # from the parent listing must be ENOENT, not a confident stat.
    await seed_dir(index, "/traces", ["present.json"])
    with pytest.raises(FileNotFoundError):
        await stat(
            accessor,
            PathSpec(resource_path="traces/absent.json",
                     virtual="/traces/absent.json",
                     directory="/traces/absent.json"), index)


@pytest.mark.asyncio
async def test_stat_unlisted_prompt_version_raises(accessor, index):
    await seed_dir(index, "/prompts/summarize", ["1.json"])
    with pytest.raises(FileNotFoundError):
        await stat(
            accessor,
            PathSpec(resource_path="prompts/summarize/9.json",
                     virtual="/prompts/summarize/9.json",
                     directory="/prompts/summarize/9.json"), index)
