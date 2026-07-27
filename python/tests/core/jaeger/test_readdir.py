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
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.core.jaeger.readdir import readdir
from mirage.resource.jaeger.config import JaegerConfig
from mirage.types import PathSpec

TRACE_A = "a" * 32
TRACE_B = "b" * 32


@pytest.fixture
def accessor():
    return JaegerAccessor(config=JaegerConfig())


@pytest.fixture
def index():
    return RAMIndexCacheStore()


def spec(path: str) -> PathSpec:
    virtual = f"/{path}" if path else "/"
    return PathSpec(resource_path=path, virtual=virtual, directory=virtual)


@pytest.mark.asyncio
async def test_readdir_root(accessor, index):
    assert await readdir(accessor, spec(""), index) == ["/services"]


@pytest.mark.asyncio
async def test_readdir_services(accessor, index):
    with patch("mirage.core.jaeger.readdir.fetch_services",
               new_callable=AsyncMock,
               return_value=["checkout", "search"]):
        result = await readdir(accessor, spec("services"), index)
    assert result == ["/services/checkout", "/services/search"]


@pytest.mark.asyncio
async def test_readdir_service_children(accessor, index):
    with patch("mirage.core.jaeger.readdir.fetch_services",
               new_callable=AsyncMock,
               return_value=["checkout"]):
        result = await readdir(accessor, spec("services/checkout"), index)
    assert result == [
        "/services/checkout/operations.json",
        "/services/checkout/traces",
    ]


@pytest.mark.asyncio
async def test_readdir_unknown_service_raises(accessor, index):
    # The operations endpoint answers 200 with an empty list for a service
    # that was never seen, so existence has to come from the service list.
    with patch("mirage.core.jaeger.readdir.fetch_services",
               new_callable=AsyncMock,
               return_value=["checkout"]):
        with pytest.raises(FileNotFoundError):
            await readdir(accessor, spec("services/nope"), index)


@pytest.mark.asyncio
async def test_readdir_traces(accessor, index):
    with patch("mirage.core.jaeger.readdir.fetch_services",
               new_callable=AsyncMock,
               return_value=["checkout"]):
        with patch("mirage.core.jaeger.readdir.fetch_traces",
                   new_callable=AsyncMock,
                   return_value=[{
                       "traceID": TRACE_A
                   }, {
                       "traceID": TRACE_B
                   }]):
            result = await readdir(accessor, spec("services/checkout/traces"),
                                   index)
    assert result == [
        f"/services/checkout/traces/{TRACE_A}.json",
        f"/services/checkout/traces/{TRACE_B}.json",
    ]


@pytest.mark.asyncio
async def test_readdir_traces_skips_malformed_ids(accessor, index):
    with patch("mirage.core.jaeger.readdir.fetch_services",
               new_callable=AsyncMock,
               return_value=["checkout"]):
        with patch("mirage.core.jaeger.readdir.fetch_traces",
                   new_callable=AsyncMock,
                   return_value=[{
                       "traceID": TRACE_A
                   }, {
                       "traceID": "not-a-trace-id"
                   }, {}]):
            result = await readdir(accessor, spec("services/checkout/traces"),
                                   index)
    assert result == [f"/services/checkout/traces/{TRACE_A}.json"]


@pytest.mark.asyncio
async def test_readdir_traces_threads_configured_window(index):
    configured = JaegerAccessor(config=JaegerConfig(
        default_trace_limit=5,
        default_from_timestamp="2026-01-01T00:00:00Z",
    ))
    fake = AsyncMock(return_value=[])
    with patch("mirage.core.jaeger.readdir.fetch_services",
               new_callable=AsyncMock,
               return_value=["checkout"]):
        with patch("mirage.core.jaeger.readdir.fetch_traces", fake):
            await readdir(configured, spec("services/checkout/traces"), index)
    assert fake.await_args.kwargs["limit"] == 5
    assert fake.await_args.kwargs["from_timestamp"] == "2026-01-01T00:00:00Z"


@pytest.mark.asyncio
async def test_readdir_dotfile_raises(accessor, index):
    with pytest.raises(FileNotFoundError):
        await readdir(accessor, spec("services/.hidden"), index)


@pytest.mark.asyncio
async def test_readdir_unknown_path_raises(accessor, index):
    with pytest.raises(FileNotFoundError):
        await readdir(accessor, spec("traces"), index)
