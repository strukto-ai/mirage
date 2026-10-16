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

import asyncio
from unittest.mock import AsyncMock

import pytest

from mirage.accessor.postgres import (
    SESSION,
    TEXT_TYPES,
    PostgresAccessor,
    read_as_text,
)
from mirage.vfs.postgres.config import PostgresConfig


@pytest.mark.asyncio
async def test_concurrent_initialization_and_close(monkeypatch):
    entered, release = asyncio.Event(), asyncio.Event()
    pool = AsyncMock()

    async def connect(*args, **kwargs):
        entered.set()
        await release.wait()
        return pool

    factory = AsyncMock(side_effect=connect)
    monkeypatch.setattr(
        "mirage.accessor.postgres.asyncpg.create_pool", factory
    )
    accessor = PostgresAccessor(PostgresConfig(dsn="postgresql://unused"))
    first = asyncio.create_task(accessor.pool())
    await entered.wait()
    second = asyncio.create_task(accessor.pool())
    release.set()
    assert await first is await second is pool
    await asyncio.gather(accessor.close(), accessor.close())
    factory.assert_awaited_once()
    pool.close.assert_awaited_once()


@pytest.mark.asyncio
async def test_pool_pins_the_session_and_reads_times_as_text(monkeypatch):
    factory = AsyncMock(return_value=AsyncMock())
    monkeypatch.setattr(
        "mirage.accessor.postgres.asyncpg.create_pool", factory
    )
    await PostgresAccessor(PostgresConfig(dsn="postgresql://unused")).pool()
    kwargs = factory.await_args.kwargs
    assert kwargs["server_settings"] == {
        "default_transaction_read_only": "on",
        "DateStyle": "ISO",
        "IntervalStyle": "postgres",
        "TimeZone": "UTC",
    }
    assert kwargs["server_settings"] is SESSION
    assert kwargs["init"] is read_as_text


@pytest.mark.asyncio
async def test_read_as_text_keeps_each_date_and_time_type_as_text():
    conn = AsyncMock()
    await read_as_text(conn)
    calls = conn.set_type_codec.await_args_list
    assert [c.args for c in calls] == [(name,) for name in TEXT_TYPES]
    assert TEXT_TYPES == (
        "date",
        "time",
        "timetz",
        "timestamp",
        "timestamptz",
        "interval",
    )
    for c in calls:
        assert c.kwargs == {
            "schema": "pg_catalog",
            "encoder": str,
            "decoder": str,
            "format": "text",
        }
