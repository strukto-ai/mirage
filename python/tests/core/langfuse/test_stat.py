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
from langfuse.api.core.api_error import ApiError

from mirage.accessor.langfuse import LangfuseAccessor
from mirage.core.langfuse.stat import stat
from mirage.core.render.json import json_bytes, jsonl_bytes
from mirage.types import ContentType, FileStat, FileType, PathSpec
from mirage.vfs.langfuse.config import LangfuseConfig
from mirage.vfs.langfuse.langfuse import LangfuseVFS
from mirage.workspace import Workspace
from tests.fixtures.vfs_io import vfs_over


@pytest.fixture
def accessor():
    config = LangfuseConfig(
        public_key="pk-test",
        secret_key="sk-test",
    )
    with patch("mirage.accessor.langfuse.Langfuse"):
        return LangfuseAccessor(config=config)


def _path(virtual: str) -> PathSpec:
    return PathSpec(
        vfs_path=virtual.lstrip("/"), virtual=virtual, directory=virtual
    )


async def mounted_stat(accessor: LangfuseAccessor, path: str) -> FileStat:
    """``path``'s stat through a mount, which lists its parent to hand
    the backend the row there.

    Args:
        accessor (LangfuseAccessor): the mount's accessor.
        path (str): the path below the mount.
    """
    ws = Workspace({"/lf/": vfs_over(LangfuseVFS, accessor)})
    try:
        row, _ = await ws.dispatch(
            "stat", PathSpec.from_str_path(f"/lf{path}")
        )
        return row
    finally:
        await ws.close()


def listed(fetch: str, rows: list[dict[str, object]]):
    return patch(
        f"mirage.core.langfuse.readdir.{fetch}",
        new_callable=AsyncMock,
        return_value=rows,
    )


@pytest.mark.asyncio
async def test_stat_root(accessor):
    result = await stat(accessor, _path("/"))
    assert result.type == FileType.DIRECTORY
    assert result.name == "/"


@pytest.mark.asyncio
async def test_stat_traces_dir(accessor):
    result = await stat(accessor, _path("/traces"))
    assert result.type == FileType.DIRECTORY
    assert result.name == "traces"


@pytest.mark.asyncio
async def test_stat_trace_file(accessor):
    with listed("fetch_traces", [{"id": "abc"}]):
        result = await mounted_stat(accessor, "/traces/abc.json")
    assert result.content == ContentType.JSON
    assert result.name == "abc.json"


@pytest.mark.asyncio
async def test_stat_session_dir(accessor):
    with listed("fetch_sessions", [{"id": "sid1"}]):
        result = await mounted_stat(accessor, "/sessions/sid1")
    assert result.type == FileType.DIRECTORY
    assert result.extra["session_id"] == "sid1"


@pytest.mark.asyncio
async def test_stat_prompt_version_file(accessor):
    with listed("fetch_prompts", [{"name": "summarize", "versions": [1]}]):
        result = await mounted_stat(accessor, "/prompts/summarize/1.json")
    assert result.content == ContentType.JSON
    assert result.name == "1.json"


@pytest.mark.asyncio
async def test_stat_dataset_items(accessor):
    items = [{"id": "i-1", "input": "a"}]
    with (
        listed("fetch_datasets", [{"name": "qa-eval"}]),
        listed("fetch_dataset_items", items),
    ):
        result = await mounted_stat(accessor, "/datasets/qa-eval/items.jsonl")
    assert result.content == ContentType.TEXT
    assert result.name == "items.jsonl"
    assert result.size == len(jsonl_bytes(items))


@pytest.mark.asyncio
async def test_stat_dotfile_raises(accessor):
    with pytest.raises(FileNotFoundError):
        await stat(accessor, _path("/.hidden"))


@pytest.mark.asyncio
async def test_stat_dataset_runs_dir(accessor):
    with (
        listed("fetch_datasets", [{"name": "qa-eval"}]),
        listed("fetch_dataset_items", []),
    ):
        result = await mounted_stat(accessor, "/datasets/qa-eval/runs")
    assert result.type == FileType.DIRECTORY
    assert result.name == "runs"


@pytest.mark.asyncio
async def test_stat_unlisted_trace_raises(accessor):
    # A recognizable path shape is not evidence the trace exists: an id
    # absent from the parent listing is asked of the API (the listing is
    # bounded), and the API's 404 is ENOENT, not a confident stat.
    with (
        listed("fetch_traces", [{"id": "present"}]),
        patch(
            "mirage.core.langfuse.read.fetch_trace",
            new_callable=AsyncMock,
            side_effect=ApiError(status_code=404, body={"message": "nope"}),
        ),
    ):
        with pytest.raises(FileNotFoundError):
            await mounted_stat(accessor, "/traces/absent.json")


@pytest.mark.asyncio
async def test_stat_unlisted_prompt_version_raises(accessor):
    with listed("fetch_prompts", [{"name": "summarize", "versions": [1]}]):
        with pytest.raises(FileNotFoundError):
            await mounted_stat(accessor, "/prompts/summarize/9.json")


@pytest.mark.asyncio
async def test_stat_finds_a_trace_the_bounded_listing_left_out():
    """read fetches a trace by id whatever the listing holds, so stat
    must too: the listing is one page of default_trace_limit traces."""
    config = LangfuseConfig(
        public_key="pk-test", secret_key="sk-test", default_trace_limit=1
    )
    with patch("mirage.accessor.langfuse.Langfuse"):
        accessor = LangfuseAccessor(config=config)
    trace = {"id": "t_old", "name": "chat"}
    with (
        listed("fetch_traces", [{"id": "t_new"}]),
        patch(
            "mirage.core.langfuse.read.fetch_trace",
            new_callable=AsyncMock,
            return_value=trace,
        ) as fetch,
    ):
        shown = await mounted_stat(accessor, "/traces/t_new.json")
        fetch.assert_not_awaited()
        older = await mounted_stat(accessor, "/traces/t_old.json")
    assert shown.type == FileType.FILE and shown.size is None
    assert older.type == FileType.FILE
    assert older.content == ContentType.JSON
    assert older.size == len(json_bytes(trace))


@pytest.mark.asyncio
async def test_stat_of_a_trace_the_api_does_not_have_is_enoent(accessor):
    with (
        listed("fetch_traces", []),
        patch(
            "mirage.core.langfuse.read.fetch_trace",
            new_callable=AsyncMock,
            side_effect=ApiError(status_code=404, body={"message": "nope"}),
        ),
    ):
        with pytest.raises(FileNotFoundError):
            await mounted_stat(accessor, "/traces/gone.json")


@pytest.mark.asyncio
async def test_stat_refuses_another_sessions_trace(accessor):
    with (
        listed("fetch_sessions", [{"id": "s1"}]),
        listed("fetch_traces", []),
        patch(
            "mirage.core.langfuse.read.fetch_trace",
            new_callable=AsyncMock,
            return_value={"id": "t1", "sessionId": "s2"},
        ),
    ):
        with pytest.raises(FileNotFoundError):
            await mounted_stat(accessor, "/sessions/s1/t1.json")
