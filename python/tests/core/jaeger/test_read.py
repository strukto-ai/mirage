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

from mirage.accessor.jaeger import JaegerAccessor
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.core.jaeger._client import JaegerApiError
from mirage.core.jaeger.read import read
from mirage.resource.jaeger.config import JaegerConfig
from mirage.types import PathSpec

TRACE_A = "a" * 32


@pytest.fixture
def accessor():
    return JaegerAccessor(config=JaegerConfig())


@pytest.fixture
def index():
    return RAMIndexCacheStore()


def spec(path: str) -> PathSpec:
    virtual = f"/{path}"
    return PathSpec(resource_path=path, virtual=virtual, directory=virtual)


def known_service():
    return patch("mirage.core.jaeger.readdir.fetch_services",
                 new_callable=AsyncMock,
                 return_value=["checkout"])


@pytest.mark.asyncio
async def test_read_trace(accessor, index):
    doc = {"traceID": TRACE_A, "spans": [{"operationName": "POST /checkout"}]}
    with known_service():
        with patch("mirage.core.jaeger.read.fetch_trace",
                   new_callable=AsyncMock,
                   return_value=doc):
            raw = await read(accessor,
                             spec(f"services/checkout/traces/{TRACE_A}.json"),
                             index)
    assert json.loads(raw) == doc


@pytest.mark.asyncio
async def test_read_operations(accessor, index):
    ops = [{"name": "POST /checkout", "spanKind": "server"}]
    with known_service():
        with patch("mirage.core.jaeger.read.fetch_operations",
                   new_callable=AsyncMock,
                   return_value=ops):
            raw = await read(accessor,
                             spec("services/checkout/operations.json"), index)
    assert json.loads(raw) == ops


@pytest.mark.asyncio
async def test_read_malformed_trace_id_is_enoent(accessor, index):
    # A malformed id cannot name an existing trace, so it must not reach the
    # API and come back as a 400.
    fake = AsyncMock()
    with known_service():
        with patch("mirage.core.jaeger.read.fetch_trace", fake):
            with pytest.raises(FileNotFoundError):
                await read(accessor, spec("services/checkout/traces/zzz.json"),
                           index)
    fake.assert_not_awaited()


@pytest.mark.asyncio
async def test_read_missing_trace_is_enoent(accessor, index):
    with known_service():
        with patch("mirage.core.jaeger.read.fetch_trace",
                   new_callable=AsyncMock,
                   side_effect=JaegerApiError("trace not found", 404)):
            with pytest.raises(FileNotFoundError):
                await read(accessor,
                           spec(f"services/checkout/traces/{TRACE_A}.json"),
                           index)


@pytest.mark.asyncio
async def test_read_server_error_propagates(accessor, index):
    # A server fault must not read as "this trace does not exist".
    with known_service():
        with patch("mirage.core.jaeger.read.fetch_trace",
                   new_callable=AsyncMock,
                   side_effect=JaegerApiError("boom", 500)):
            with pytest.raises(JaegerApiError):
                await read(accessor,
                           spec(f"services/checkout/traces/{TRACE_A}.json"),
                           index)


@pytest.mark.asyncio
async def test_read_unknown_service_is_enoent(accessor, index):
    with known_service():
        with pytest.raises(FileNotFoundError):
            await read(accessor, spec("services/nope/operations.json"), index)


@pytest.mark.asyncio
async def test_read_directory_is_enoent(accessor, index):
    with pytest.raises(FileNotFoundError):
        await read(accessor, spec("services"), index)
