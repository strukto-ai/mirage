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

from mirage.accessor.jaeger import JaegerAccessor
from mirage.core.jaeger.readdir import readdir
from mirage.core.render.json import json_bytes
from mirage.types import DirListing, FileType, PathSpec
from mirage.vfs.jaeger.config import JaegerConfig

TRACE_A = "a" * 32
TRACE_B = "b" * 32


def _names(listed):
    rows = listed.entries if isinstance(listed, DirListing) else listed
    return [row.name for row in rows]


@pytest.fixture
def accessor():
    return JaegerAccessor(config=JaegerConfig())


def spec(path: str) -> PathSpec:
    virtual = f"/{path}" if path else "/"
    return PathSpec(vfs_path=path, virtual=virtual, directory=virtual)


@pytest.mark.asyncio
async def test_readdir_root(accessor):
    assert _names(await readdir(accessor, spec(""))) == ["services"]


@pytest.mark.asyncio
async def test_readdir_services(accessor):
    with patch(
        "mirage.core.jaeger.readdir.fetch_services",
        new_callable=AsyncMock,
        return_value=["checkout", "search"],
    ):
        result = await readdir(accessor, spec("services"))
    assert _names(result) == ["checkout", "search"]


@pytest.mark.asyncio
async def test_readdir_service_children(accessor):
    operations = ["GET /cart", "POST /cart"]
    with (
        patch(
            "mirage.core.jaeger.readdir.fetch_services",
            new_callable=AsyncMock,
            return_value=["checkout"],
        ),
        patch(
            "mirage.core.jaeger.readdir.fetch_operations",
            new_callable=AsyncMock,
            return_value=operations,
        ),
    ):
        result = await readdir(accessor, spec("services/checkout"))
    assert _names(result) == ["operations.json", "traces"]
    assert result[0].size == len(json_bytes(operations))
    assert result[1].type is FileType.DIRECTORY


@pytest.mark.asyncio
async def test_readdir_unknown_service_raises(accessor):
    # The operations endpoint answers 200 with an empty list for a service
    # that was never seen, so existence has to come from the service list.
    with patch(
        "mirage.core.jaeger.readdir.fetch_services",
        new_callable=AsyncMock,
        return_value=["checkout"],
    ):
        with pytest.raises(FileNotFoundError):
            await readdir(accessor, spec("services/nope"))


@pytest.mark.asyncio
async def test_readdir_traces(accessor):
    with patch(
        "mirage.core.jaeger.readdir.fetch_services",
        new_callable=AsyncMock,
        return_value=["checkout"],
    ):
        with patch(
            "mirage.core.jaeger.readdir.fetch_traces",
            new_callable=AsyncMock,
            return_value=[{"traceID": TRACE_A}, {"traceID": TRACE_B}],
        ):
            result = await readdir(accessor, spec("services/checkout/traces"))
    assert _names(result) == [f"{TRACE_A}.json", f"{TRACE_B}.json"]


@pytest.mark.asyncio
async def test_readdir_traces_stores_rendered_size(accessor):
    trace = {
        "traceID": TRACE_A,
        "spans": [{"spanID": "s1", "operationName": "GET /pay"}],
        "processes": {"p1": {"serviceName": "checkout"}},
    }
    with patch(
        "mirage.core.jaeger.readdir.fetch_services",
        new_callable=AsyncMock,
        return_value=["checkout"],
    ):
        with patch(
            "mirage.core.jaeger.readdir.fetch_traces",
            new_callable=AsyncMock,
            return_value=[trace],
        ):
            listed = await readdir(accessor, spec("services/checkout/traces"))
    assert listed.entries[0].size == len(json_bytes(trace))
    assert listed.entries[0].extra == {"trace_id": TRACE_A}


@pytest.mark.asyncio
async def test_readdir_traces_skips_malformed_ids(accessor):
    with patch(
        "mirage.core.jaeger.readdir.fetch_services",
        new_callable=AsyncMock,
        return_value=["checkout"],
    ):
        with patch(
            "mirage.core.jaeger.readdir.fetch_traces",
            new_callable=AsyncMock,
            return_value=[
                {"traceID": TRACE_A},
                {"traceID": "not-a-trace-id"},
                {},
            ],
        ):
            result = await readdir(accessor, spec("services/checkout/traces"))
    assert _names(result) == [f"{TRACE_A}.json"]


@pytest.mark.asyncio
async def test_readdir_traces_threads_configured_window():
    configured = JaegerAccessor(
        config=JaegerConfig(
            default_trace_limit=5,
            default_from_timestamp="2026-01-01T00:00:00Z",
        )
    )
    fake = AsyncMock(return_value=[])
    with patch(
        "mirage.core.jaeger.readdir.fetch_services",
        new_callable=AsyncMock,
        return_value=["checkout"],
    ):
        with patch("mirage.core.jaeger.readdir.fetch_traces", fake):
            await readdir(configured, spec("services/checkout/traces"))
    assert fake.await_args.kwargs["limit"] == 5
    assert fake.await_args.kwargs["from_timestamp"] == "2026-01-01T00:00:00Z"


@pytest.mark.asyncio
async def test_readdir_dotfile_raises(accessor):
    with pytest.raises(FileNotFoundError):
        await readdir(accessor, spec("services/.hidden"))


@pytest.mark.asyncio
async def test_readdir_unknown_path_raises(accessor):
    with pytest.raises(FileNotFoundError):
        await readdir(accessor, spec("traces"))


@pytest.mark.asyncio
async def test_a_trace_listing_is_written_as_a_window(accessor):
    # The listing is the newest default_trace_limit traces; an older trace
    # that falls off it is still in Jaeger.
    with patch(
        "mirage.core.jaeger.readdir.fetch_services",
        new_callable=AsyncMock,
        return_value=["checkout"],
    ):
        with patch(
            "mirage.core.jaeger.readdir.fetch_traces",
            new_callable=AsyncMock,
            return_value=[{"traceID": TRACE_A}],
        ):
            listed = await readdir(accessor, spec("services/checkout/traces"))
    assert isinstance(listed, DirListing)
    assert listed.window is True
