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

from mirage import Workspace
from mirage.accessor.langfuse import LangfuseAccessor
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.core.langfuse.readdir import readdir
from mirage.core.langfuse.stat import stat
from mirage.core.render.json import jsonl_bytes
from mirage.types import PathSpec
from mirage.vfs.langfuse.config import LangfuseConfig
from mirage.vfs.langfuse.langfuse import LangfuseVFS
from tests.fixtures.index_spy import WindowSpy
from tests.fixtures.vfs_io import vfs_over


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
@pytest.mark.parametrize(
    "config",
    [
        {"default_trace_limit": 2},
        {"default_from_timestamp": "2026-01-01T00:00:00Z"},
    ],
)
async def test_partial_trace_page_serves_child_stats_without_refetch(
    config, index
):
    with patch("mirage.accessor.langfuse.Langfuse"):
        accessor = LangfuseAccessor(
            config=LangfuseConfig(
                public_key="pk-test", secret_key="sk-test", **config
            )
        )
    parent = PathSpec(
        vfs_path="traces", virtual="/traces", directory="/traces"
    )
    with patch(
        "mirage.core.langfuse.readdir.fetch_traces",
        new_callable=AsyncMock,
        return_value=[{"id": "t1"}, {"id": "t2"}],
    ) as fetch:
        paths = await readdir(accessor, parent, index)
        for path in paths:
            await stat(
                accessor,
                PathSpec(
                    vfs_path=path.lstrip("/"), virtual=path, directory=path
                ),
                index,
            )
        assert fetch.await_count == 1
        # A new directory read must still refresh the bounded page.
        await readdir(accessor, parent, index)
        assert fetch.await_count == 2


@pytest.mark.asyncio
async def test_workspace_long_listing_fetches_a_full_trace_page_once():
    with patch("mirage.accessor.langfuse.Langfuse"):
        accessor = LangfuseAccessor(
            config=LangfuseConfig(
                public_key="pk-test",
                secret_key="sk-test",
                default_trace_limit=2,
            )
        )
    ws = Workspace({"/nested/lf/": vfs_over(LangfuseVFS, accessor)})
    try:
        with patch(
            "mirage.core.langfuse.readdir.fetch_traces",
            new_callable=AsyncMock,
            return_value=[{"id": "t1"}, {"id": "t2"}],
        ) as fetch:
            result = await ws.shell("ls -l /nested/lf/traces")
            assert result.exit_code == 0
            assert "t1.json" in await result.stdout_str()
            assert "t2.json" in await result.stdout_str()
            assert fetch.await_count == 1
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_readdir_root(accessor, index):
    result = await readdir(
        accessor, PathSpec(vfs_path="", virtual="/", directory="/"), index
    )
    assert result == ["/traces", "/sessions", "/prompts", "/datasets"]


@pytest.mark.asyncio
async def test_readdir_traces(accessor, index):
    with patch(
        "mirage.core.langfuse.readdir.fetch_traces",
        new_callable=AsyncMock,
        return_value=[
            {"id": "abc123", "name": "chat"},
            {"id": "def456", "name": "search"},
        ],
    ):
        result = await readdir(
            accessor,
            PathSpec(
                vfs_path="traces", virtual="/traces", directory="/traces"
            ),
            index,
        )

    assert "/traces/abc123.json" in result
    assert "/traces/def456.json" in result


@pytest.mark.asyncio
async def test_readdir_sessions(accessor, index):
    with patch(
        "mirage.core.langfuse.readdir.fetch_sessions",
        new_callable=AsyncMock,
        return_value=[{"id": "session-1"}, {"id": "session-2"}],
    ):
        result = await readdir(
            accessor,
            PathSpec(
                vfs_path="sessions", virtual="/sessions", directory="/sessions"
            ),
            index,
        )

    assert "/sessions/session-1" in result
    assert "/sessions/session-2" in result


@pytest.mark.asyncio
async def test_readdir_prompts(accessor, index):
    with patch(
        "mirage.core.langfuse.readdir.fetch_prompts",
        new_callable=AsyncMock,
        return_value=[
            {"name": "summarize", "versions": [1]},
            {"name": "translate", "versions": [1]},
        ],
    ):
        result = await readdir(
            accessor,
            PathSpec(
                vfs_path="prompts", virtual="/prompts", directory="/prompts"
            ),
            index,
        )

    assert "/prompts/summarize" in result
    assert "/prompts/translate" in result


@pytest.mark.asyncio
async def test_readdir_datasets(accessor, index):
    with patch(
        "mirage.core.langfuse.readdir.fetch_datasets",
        new_callable=AsyncMock,
        return_value=[{"name": "qa-eval"}, {"name": "chat-eval"}],
    ):
        result = await readdir(
            accessor,
            PathSpec(
                vfs_path="datasets", virtual="/datasets", directory="/datasets"
            ),
            index,
        )

    assert "/datasets/qa-eval" in result
    assert "/datasets/chat-eval" in result


@pytest.mark.asyncio
async def test_readdir_dataset_contents(accessor, index):
    items = [{"id": "i-1", "input": "a"}, {"id": "i-2", "input": "b"}]
    with patch(
        "mirage.core.langfuse.readdir.fetch_dataset_items",
        new_callable=AsyncMock,
        return_value=items,
    ):
        result = await readdir(
            accessor,
            PathSpec(
                vfs_path="datasets/qa-eval",
                virtual="/datasets/qa-eval",
                directory="/datasets/qa-eval",
            ),
            index,
        )
    assert "/datasets/qa-eval/items.jsonl" in result
    assert "/datasets/qa-eval/runs" in result
    lookup = await index.get("/datasets/qa-eval/items.jsonl")
    assert lookup.entry.size == len(jsonl_bytes(items))


@pytest.mark.asyncio
async def test_readdir_dataset_runs_sized(accessor, index):
    runs = [{"name": "run-a", "metadata": {"k": "v"}}, {"name": "run-b"}]
    with patch(
        "mirage.core.langfuse.readdir.fetch_dataset_runs",
        new_callable=AsyncMock,
        return_value=runs,
    ):
        await readdir(
            accessor,
            PathSpec(
                vfs_path="datasets/qa-eval/runs",
                virtual="/datasets/qa-eval/runs",
                directory="/datasets/qa-eval/runs",
            ),
            index,
        )
    lookup = await index.get("/datasets/qa-eval/runs/run-a.jsonl")
    assert lookup.entry.size == len(jsonl_bytes([runs[0]]))


@pytest.mark.asyncio
async def test_readdir_dotfile_raises(accessor, index):
    with pytest.raises(FileNotFoundError):
        await readdir(
            accessor,
            PathSpec(
                vfs_path=".hidden", virtual="/.hidden", directory="/.hidden"
            ),
            index,
        )


@pytest.mark.asyncio
async def test_readdir_dotfile_nested_raises(accessor, index):
    with pytest.raises(FileNotFoundError):
        await readdir(
            accessor,
            PathSpec(
                vfs_path="traces/.DS_Store",
                virtual="/traces/.DS_Store",
                directory="/traces/.DS_Store",
            ),
            index,
        )


@pytest.mark.asyncio
async def test_readdir_prompt_versions(accessor, index):
    # PromptMeta carries every version in a `versions` array; a scalar
    # `version` read would collapse the directory to a single 0.json.
    with patch(
        "mirage.core.langfuse.readdir.fetch_prompts",
        new_callable=AsyncMock,
        return_value=[
            {"name": "summarize", "versions": [2, 1, 10]},
            {"name": "translate", "versions": [1]},
        ],
    ):
        result = await readdir(
            accessor,
            PathSpec(
                vfs_path="prompts/summarize",
                virtual="/prompts/summarize",
                directory="/prompts/summarize",
            ),
            index,
        )

    assert result == [
        "/prompts/summarize/1.json",
        "/prompts/summarize/2.json",
        "/prompts/summarize/10.json",
    ]


@pytest.mark.asyncio
async def test_readdir_traces_applies_no_window_by_default(accessor, index):
    # An implicit rolling window would hide traces that read() serves, so an
    # unset default_from_timestamp must not narrow the listing.
    fake = AsyncMock(return_value=[{"id": "old-trace"}])
    with patch("mirage.core.langfuse.readdir.fetch_traces", fake):
        result = await readdir(
            accessor,
            PathSpec(
                vfs_path="traces", virtual="/traces", directory="/traces"
            ),
            index,
        )

    assert result == ["/traces/old-trace.json"]
    assert fake.await_args.kwargs["from_timestamp"] is None


@pytest.mark.asyncio
async def test_readdir_traces_passes_explicit_window(index):
    config = LangfuseConfig(
        public_key="pk-test",
        secret_key="sk-test",
        default_from_timestamp="2026-01-01T00:00:00Z",
    )
    with patch("mirage.accessor.langfuse.Langfuse"):
        windowed = LangfuseAccessor(config=config)
    fake = AsyncMock(return_value=[])
    with patch("mirage.core.langfuse.readdir.fetch_traces", fake):
        await readdir(
            windowed,
            PathSpec(
                vfs_path="traces", virtual="/traces", directory="/traces"
            ),
            index,
        )

    assert fake.await_args.kwargs["from_timestamp"] == "2026-01-01T00:00:00Z"


def _bounded_accessor(**knobs) -> LangfuseAccessor:
    config = LangfuseConfig(
        public_key="pk-test", secret_key="sk-test", **knobs
    )
    with patch("mirage.accessor.langfuse.Langfuse"):
        return LangfuseAccessor(config=config)


async def _list_traces_dir(accessor, index, traces):
    with patch(
        "mirage.core.langfuse.readdir.fetch_traces",
        new_callable=AsyncMock,
        return_value=traces,
    ):
        return await readdir(
            accessor,
            PathSpec(
                vfs_path="traces", virtual="/traces", directory="/traces"
            ),
            index,
        )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "knobs",
    [
        {"default_trace_limit": 2},
        {"default_from_timestamp": "2026-01-01T00:00:00Z"},
    ],
    ids=["full page", "time window"],
)
async def test_a_bounded_trace_listing_is_not_cached_as_the_directory(
    knobs, index
):
    """A full page or a set window leaves older traces out, so the
    listing must not become the index's proof that they are absent."""
    accessor = _bounded_accessor(**knobs)
    traces = [{"id": "t1"}, {"id": "t2"}]
    result = await _list_traces_dir(accessor, index, traces)
    assert result == ["/traces/t1.json", "/traces/t2.json"]
    assert (await index.list_dir("/traces")).entries is None
    assert (await index.get("/traces/t1.json")).entry is not None


@pytest.mark.asyncio
async def test_a_trace_listing_short_of_the_limit_is_the_directory(index):
    accessor = _bounded_accessor(default_trace_limit=3)
    await _list_traces_dir(accessor, index, [{"id": "t1"}, {"id": "t2"}])
    assert (await index.list_dir("/traces")).entries is not None


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "path, fetch, rows",
    [
        ("/sessions", "fetch_sessions", [{"id": "session-1"}]),
        (
            "/prompts",
            "fetch_prompts",
            [{"name": "summarize", "versions": [1]}],
        ),
        ("/datasets", "fetch_datasets", [{"name": "qa-eval"}]),
        ("/datasets/qa-eval/runs", "fetch_dataset_runs", [{"name": "run-a"}]),
    ],
)
async def test_a_single_page_listing_is_written_as_a_window(
    accessor, path, fetch, rows
):
    # Each of these is one page of the newest entries: an older one that
    # drops off the page has not been deleted.
    index = WindowSpy()
    with patch(
        f"mirage.core.langfuse.readdir.{fetch}",
        new_callable=AsyncMock,
        return_value=rows,
    ):
        await readdir(
            accessor,
            PathSpec(vfs_path=path.lstrip("/"), virtual=path, directory=path),
            index,
        )
    assert index.windows[path] is True
