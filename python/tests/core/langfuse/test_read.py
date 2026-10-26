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
from mirage.core.langfuse.read import read
from mirage.types import PathSpec
from mirage.vfs.langfuse.config import LangfuseConfig


@pytest.fixture
def accessor():
    config = LangfuseConfig(
        public_key="pk-test",
        secret_key="sk-test",
    )
    with patch("mirage.accessor.langfuse.Langfuse"):
        return LangfuseAccessor(config=config)


@pytest.mark.asyncio
async def test_read_trace(accessor):
    trace_data = {"id": "abc123", "name": "chat", "input": "hello"}
    with patch(
        "mirage.core.langfuse.read.fetch_trace",
        new_callable=AsyncMock,
        return_value=trace_data,
    ):
        result = await read(
            accessor,
            PathSpec(
                vfs_path="traces/abc123.json",
                virtual="/traces/abc123.json",
                directory="/traces/abc123.json",
            ),
        )

    parsed = json.loads(result)
    assert parsed["id"] == "abc123"
    assert parsed["name"] == "chat"


@pytest.mark.asyncio
async def test_read_prompt_version(accessor):
    prompt_data = {"name": "summarize", "version": 1, "prompt": "Summarize:"}
    with patch(
        "mirage.core.langfuse.read.fetch_prompt",
        new_callable=AsyncMock,
        return_value=prompt_data,
    ):
        result = await read(
            accessor,
            PathSpec(
                vfs_path="prompts/summarize/1.json",
                virtual="/prompts/summarize/1.json",
                directory="/prompts/summarize/1.json",
            ),
        )

    parsed = json.loads(result)
    assert parsed["name"] == "summarize"
    assert parsed["version"] == 1


@pytest.mark.asyncio
async def test_read_dataset_items(accessor):
    items = [
        {"id": "item1", "input": "q1", "output": "a1"},
        {"id": "item2", "input": "q2", "output": "a2"},
    ]
    with patch(
        "mirage.core.langfuse.read.fetch_dataset_items",
        new_callable=AsyncMock,
        return_value=items,
    ):
        result = await read(
            accessor,
            PathSpec(
                vfs_path="datasets/qa-eval/items.jsonl",
                virtual="/datasets/qa-eval/items.jsonl",
                directory="/datasets/qa-eval/items.jsonl",
            ),
        )

    lines = result.decode().strip().split("\n")
    assert len(lines) == 2
    assert json.loads(lines[0])["id"] == "item1"
    assert json.loads(lines[1])["id"] == "item2"


@pytest.mark.asyncio
async def test_read_invalid_path_raises(accessor):
    with pytest.raises(FileNotFoundError):
        await read(
            accessor,
            PathSpec(
                vfs_path="not_a_valid_path",
                virtual="/not_a_valid_path",
                directory="/not_a_valid_path",
            ),
        )


@pytest.mark.asyncio
async def test_read_session_trace(accessor):
    trace_data = {"id": "tid1", "sessionId": "sid1"}
    with patch(
        "mirage.core.langfuse.read.fetch_trace",
        new_callable=AsyncMock,
        return_value=trace_data,
    ):
        result = await read(
            accessor,
            PathSpec(
                vfs_path="sessions/sid1/tid1.json",
                virtual="/sessions/sid1/tid1.json",
                directory="/sessions/sid1/tid1.json",
            ),
        )

    parsed = json.loads(result)
    assert parsed["id"] == "tid1"


@pytest.mark.asyncio
async def test_read_dataset_run_renders_jsonl(accessor):
    # The path ends in .jsonl, so it must be one compact JSON object per line
    # with a trailing newline, not an indented document.
    runs = [{"name": "run-a", "metadata": {}}, {"name": "run-b"}]
    with patch(
        "mirage.core.langfuse.read.fetch_dataset_runs",
        new_callable=AsyncMock,
        return_value=runs,
    ) as fetch:
        result = await read(
            accessor,
            PathSpec(
                vfs_path="datasets/qa-eval/runs/run-a.jsonl",
                virtual="/datasets/qa-eval/runs/run-a.jsonl",
                directory="/datasets/qa-eval/runs/run-a.jsonl",
            ),
        )

    assert fetch.await_args.args[1:] == ("qa-eval", "run-a")
    text = result.decode()
    assert text.endswith("\n")
    assert text.count("\n") == 1
    assert json.loads(text)["name"] == "run-a"


@pytest.mark.asyncio
async def test_read_trace_not_found_is_enoent(accessor):
    # A 404 from the API is a missing file, not a leaked SDK error string.
    with patch(
        "mirage.core.langfuse.read.fetch_trace",
        new_callable=AsyncMock,
        side_effect=ApiError(status_code=404, body={"message": "nope"}),
    ):
        with pytest.raises(FileNotFoundError):
            await read(
                accessor,
                PathSpec(
                    vfs_path="traces/gone.json",
                    virtual="/traces/gone.json",
                    directory="/traces/gone.json",
                ),
            )


@pytest.mark.asyncio
async def test_read_trace_server_error_propagates(accessor):
    # Only 404 maps to ENOENT; a 500 must not be disguised as a missing file.
    with patch(
        "mirage.core.langfuse.read.fetch_trace",
        new_callable=AsyncMock,
        side_effect=ApiError(status_code=500, body={"message": "boom"}),
    ):
        with pytest.raises(ApiError):
            await read(
                accessor,
                PathSpec(
                    vfs_path="traces/tid1.json",
                    virtual="/traces/tid1.json",
                    directory="/traces/tid1.json",
                ),
            )


@pytest.mark.asyncio
async def test_read_refuses_another_sessions_trace(accessor):
    """sessions/<id>/<trace>.json names a trace of that session; the
    trace id alone would fetch any session's trace."""
    with patch(
        "mirage.core.langfuse.read.fetch_trace",
        new_callable=AsyncMock,
        return_value={"id": "t1", "sessionId": "s2"},
    ):
        with pytest.raises(FileNotFoundError):
            await read(
                accessor,
                PathSpec(
                    vfs_path="sessions/s1/t1.json",
                    virtual="/sessions/s1/t1.json",
                    directory="/sessions/s1/t1.json",
                ),
            )
        own = await read(
            accessor,
            PathSpec(
                vfs_path="sessions/s2/t1.json",
                virtual="/sessions/s2/t1.json",
                directory="/sessions/s2/t1.json",
            ),
        )
    assert json.loads(own)["sessionId"] == "s2"


@pytest.mark.asyncio
async def test_read_session_trace_with_a_later_root_in_that_session(accessor):
    """A trace is listed under every session one of its root
    observations names, so each of those paths must open."""
    trace = {
        "traceId": "t1",
        "sessionId": "s1",
        "isRootObservation": True,
        "observations": [
            {"id": "late", "isRootObservation": True, "sessionId": "s2"},
            {"id": "leaf", "sessionId": "s3"},
        ],
    }
    with patch(
        "mirage.core.langfuse.read.fetch_trace",
        new_callable=AsyncMock,
        return_value=trace,
    ):
        for session in ("s1", "s2"):
            own = await read(
                accessor,
                PathSpec(
                    vfs_path=f"sessions/{session}/t1.json",
                    virtual=f"/sessions/{session}/t1.json",
                    directory=f"/sessions/{session}/t1.json",
                ),
            )
            assert json.loads(own)["traceId"] == "t1"
        with pytest.raises(FileNotFoundError):
            await read(
                accessor,
                PathSpec(
                    vfs_path="sessions/s3/t1.json",
                    virtual="/sessions/s3/t1.json",
                    directory="/sessions/s3/t1.json",
                ),
            )
