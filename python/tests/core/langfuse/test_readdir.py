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
from mirage.core.langfuse.readdir import readdir
from mirage.core.render.json import jsonl_bytes
from mirage.types import DirListing, PathSpec
from mirage.vfs.langfuse.config import LangfuseConfig
from mirage.vfs.langfuse.langfuse import LangfuseVFS
from tests.fixtures.vfs_io import vfs_over


def _names(listed):
    rows = listed.entries if isinstance(listed, DirListing) else listed
    return [row.name for row in rows]


@pytest.fixture
def accessor():
    config = LangfuseConfig(
        public_key="pk-test",
        secret_key="sk-test",
    )
    with patch("mirage.accessor.langfuse.Langfuse"):
        return LangfuseAccessor(config=config)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "config",
    [
        {"default_trace_limit": 2},
        {"default_from_timestamp": "2026-01-01T00:00:00Z"},
    ],
)
async def test_partial_trace_page_serves_child_stats_without_refetch(config):
    with patch("mirage.accessor.langfuse.Langfuse"):
        accessor = LangfuseAccessor(
            config=LangfuseConfig(
                public_key="pk-test", secret_key="sk-test", **config
            )
        )
    ws = Workspace({"/lf/": vfs_over(LangfuseVFS, accessor)})
    parent = PathSpec.from_str_path("/lf/traces")
    with patch(
        "mirage.core.langfuse.readdir.fetch_traces",
        new_callable=AsyncMock,
        return_value=[{"traceId": "t1"}, {"traceId": "t2"}],
    ) as fetch:
        paths, _ = await ws.dispatch("readdir", parent)
        for path in paths:
            await ws.dispatch("stat", PathSpec.from_str_path(path))
        assert fetch.await_count == 1
        # A new directory read must still refresh the bounded page.
        await ws.dispatch("readdir", parent)
        assert fetch.await_count == 2
    await ws.close()


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
            return_value=[{"traceId": "t1"}, {"traceId": "t2"}],
        ) as fetch:
            result = await ws.shell("ls -l /nested/lf/traces")
            assert result.exit_code == 0
            assert "t1.json" in await result.stdout_str()
            assert "t2.json" in await result.stdout_str()
            assert fetch.await_count == 1
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_readdir_root(accessor):
    result = await readdir(
        accessor, PathSpec(vfs_path="", virtual="/", directory="/")
    )
    assert _names(result) == ["traces", "sessions", "prompts", "datasets"]


@pytest.mark.asyncio
async def test_readdir_traces(accessor):
    with patch(
        "mirage.core.langfuse.readdir.fetch_traces",
        new_callable=AsyncMock,
        return_value=[
            {"traceId": "abc123", "name": "chat"},
            {"traceId": "def456", "name": "search"},
        ],
    ):
        result = await readdir(
            accessor,
            PathSpec(
                vfs_path="traces", virtual="/traces", directory="/traces"
            ),
        )

    assert "abc123.json" in _names(result)
    assert "def456.json" in _names(result)


@pytest.mark.asyncio
async def test_readdir_sessions(accessor):
    with patch(
        "mirage.core.langfuse.readdir.fetch_sessions",
        new_callable=AsyncMock,
        return_value=["session-1", "session-2"],
    ):
        result = await readdir(
            accessor,
            PathSpec(
                vfs_path="sessions", virtual="/sessions", directory="/sessions"
            ),
        )

    assert "session-1" in _names(result)
    assert "session-2" in _names(result)


@pytest.mark.asyncio
async def test_readdir_prompts(accessor):
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
        )

    assert "summarize" in _names(result)
    assert "translate" in _names(result)


@pytest.mark.asyncio
async def test_readdir_datasets(accessor):
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
        )

    assert "qa-eval" in _names(result)
    assert "chat-eval" in _names(result)


@pytest.mark.asyncio
async def test_readdir_dataset_contents(accessor):
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
        )
    assert _names(result) == ["items.jsonl", "runs"]
    assert result[0].size == len(jsonl_bytes(items))


@pytest.mark.asyncio
async def test_readdir_dataset_runs_sized(accessor):
    runs = [{"name": "run-a", "metadata": {"k": "v"}}, {"name": "run-b"}]
    with patch(
        "mirage.core.langfuse.readdir.fetch_dataset_runs",
        new_callable=AsyncMock,
        return_value=runs,
    ):
        listed = await readdir(
            accessor,
            PathSpec(
                vfs_path="datasets/qa-eval/runs",
                virtual="/datasets/qa-eval/runs",
                directory="/datasets/qa-eval/runs",
            ),
        )
    assert listed.entries[0].name == "run-a.jsonl"
    assert listed.entries[0].size == len(jsonl_bytes([runs[0]]))


@pytest.mark.asyncio
async def test_readdir_dotfile_raises(accessor):
    with pytest.raises(FileNotFoundError):
        await readdir(
            accessor,
            PathSpec(
                vfs_path=".hidden", virtual="/.hidden", directory="/.hidden"
            ),
        )


@pytest.mark.asyncio
async def test_readdir_dotfile_nested_raises(accessor):
    with pytest.raises(FileNotFoundError):
        await readdir(
            accessor,
            PathSpec(
                vfs_path="traces/.DS_Store",
                virtual="/traces/.DS_Store",
                directory="/traces/.DS_Store",
            ),
        )


@pytest.mark.asyncio
async def test_readdir_prompt_versions(accessor):
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
        )

    assert _names(result) == ["1.json", "2.json", "10.json"]


@pytest.mark.asyncio
async def test_readdir_traces_applies_no_window_by_default(accessor):
    # An implicit rolling window would hide traces that read() serves, so an
    # unset default_from_timestamp must not narrow the listing.
    fake = AsyncMock(return_value=[{"traceId": "old-trace"}])
    with patch("mirage.core.langfuse.readdir.fetch_traces", fake):
        result = await readdir(
            accessor,
            PathSpec(
                vfs_path="traces", virtual="/traces", directory="/traces"
            ),
        )

    assert _names(result) == ["old-trace.json"]
    assert fake.await_args.kwargs["from_timestamp"] is None


@pytest.mark.asyncio
async def test_readdir_traces_passes_explicit_window():
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
        )

    assert fake.await_args.kwargs["from_timestamp"] == "2026-01-01T00:00:00Z"


def _bounded_accessor(**knobs) -> LangfuseAccessor:
    config = LangfuseConfig(
        public_key="pk-test", secret_key="sk-test", **knobs
    )
    with patch("mirage.accessor.langfuse.Langfuse"):
        return LangfuseAccessor(config=config)


async def _list_traces_dir(accessor, traces):
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
async def test_a_bounded_trace_listing_is_not_cached_as_the_directory(knobs):
    """A full page or a set window leaves older traces out, so the
    listing must not become the index's proof that they are absent."""
    accessor = _bounded_accessor(**knobs)
    traces = [{"traceId": "t1"}, {"traceId": "t2"}]
    result = await _list_traces_dir(accessor, traces)
    assert _names(result) == ["t1.json", "t2.json"]
    assert result.partial is True


@pytest.mark.asyncio
async def test_a_trace_listing_short_of_the_limit_is_the_directory():
    accessor = _bounded_accessor(default_trace_limit=3)
    result = await _list_traces_dir(
        accessor, [{"traceId": "t1"}, {"traceId": "t2"}]
    )
    assert result.partial is False


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "path, fetch, rows",
    [
        ("/sessions", "fetch_sessions", ["session-1"]),
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
    with patch(
        f"mirage.core.langfuse.readdir.{fetch}",
        new_callable=AsyncMock,
        return_value=rows,
    ):
        listed = await readdir(
            accessor,
            PathSpec(vfs_path=path.lstrip("/"), virtual=path, directory=path),
        )
    assert listed.window is True
