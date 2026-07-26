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
from mirage.core.jaeger.stat import stat
from mirage.resource.jaeger.config import JaegerConfig
from mirage.types import FileType, PathSpec

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


def known_service():
    return patch("mirage.core.jaeger.readdir.fetch_services",
                 new_callable=AsyncMock,
                 return_value=["checkout"])


def listed_traces(ids):
    return patch("mirage.core.jaeger.readdir.fetch_traces",
                 new_callable=AsyncMock,
                 return_value=[{
                     "traceID": tid
                 } for tid in ids])


@pytest.mark.asyncio
async def test_stat_root(accessor, index):
    result = await stat(accessor, spec(""), index)
    assert result.type == FileType.DIRECTORY


@pytest.mark.asyncio
async def test_stat_services_dir(accessor, index):
    result = await stat(accessor, spec("services"), index)
    assert result.type == FileType.DIRECTORY
    assert result.name == "services"


@pytest.mark.asyncio
async def test_stat_service_dir(accessor, index):
    with known_service():
        result = await stat(accessor, spec("services/checkout"), index)
    assert result.type == FileType.DIRECTORY
    assert result.extra["service"] == "checkout"


@pytest.mark.asyncio
async def test_stat_unknown_service_raises(accessor, index):
    with known_service():
        with pytest.raises(FileNotFoundError):
            await stat(accessor, spec("services/nope"), index)


@pytest.mark.asyncio
async def test_stat_operations_file(accessor, index):
    with known_service():
        result = await stat(accessor,
                            spec("services/checkout/operations.json"), index)
    assert result.type == FileType.JSON


@pytest.mark.asyncio
async def test_stat_listed_trace(accessor, index):
    with known_service():
        with listed_traces([TRACE_A]):
            result = await stat(
                accessor, spec(f"services/checkout/traces/{TRACE_A}.json"),
                index)
    assert result.type == FileType.JSON
    assert result.extra["trace_id"] == TRACE_A


@pytest.mark.asyncio
async def test_stat_unlisted_trace_raises(accessor, index):
    # A well-formed id is not evidence the trace exists.
    with known_service():
        with listed_traces([TRACE_A]):
            with pytest.raises(FileNotFoundError):
                await stat(accessor,
                           spec(f"services/checkout/traces/{TRACE_B}.json"),
                           index)


@pytest.mark.asyncio
async def test_stat_malformed_trace_id_raises(accessor, index):
    with known_service():
        with pytest.raises(FileNotFoundError):
            await stat(accessor, spec("services/checkout/traces/zzz.json"),
                       index)


@pytest.mark.asyncio
async def test_stat_dotfile_raises(accessor, index):
    with pytest.raises(FileNotFoundError):
        await stat(accessor, spec("services/.hidden"), index)
