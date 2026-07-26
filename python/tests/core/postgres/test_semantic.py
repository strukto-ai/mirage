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

from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, MagicMock

import pytest

from mirage.accessor.postgres import PostgresAccessor
from mirage.core.postgres.semantic import (SAMPLE_VALUES_LIMIT,
                                           build_column_entry,
                                           build_entity_semantic_json,
                                           build_relationships,
                                           classify_column)
from mirage.resource.postgres.config import PostgresConfig

COLUMNS = [
    {
        "name": "order_id",
        "type": "integer",
        "nullable": False
    },
    {
        "name": "customer_id",
        "type": "integer",
        "nullable": True
    },
    {
        "name": "status",
        "type": "USER-DEFINED",
        "nullable": True
    },
    {
        "name": "channel",
        "type": "text",
        "nullable": True
    },
    {
        "name": "total_amount",
        "type": "numeric",
        "nullable": True
    },
    {
        "name": "placed_at",
        "type": "timestamp with time zone",
        "nullable": True
    },
]

FOREIGN_KEYS = [{
    "columns": ["customer_id"],
    "references": {
        "schema": "public",
        "table": "customers",
        "columns": ["id"],
    },
}]


@asynccontextmanager
async def _fake_acquire():
    yield MagicMock()


def _accessor() -> PostgresAccessor:
    a = PostgresAccessor(PostgresConfig(dsn="postgres://localhost/db"))
    pool = MagicMock()
    pool.acquire = lambda: _fake_acquire()
    a.pool = AsyncMock(return_value=pool)
    return a


@pytest.fixture
def accessor():
    return _accessor()


@pytest.fixture
def client(monkeypatch):
    fakes = {
        "fetch_columns":
        AsyncMock(return_value=COLUMNS),
        "fetch_primary_key":
        AsyncMock(return_value=["order_id"]),
        "fetch_foreign_keys":
        AsyncMock(return_value=FOREIGN_KEYS),
        "fetch_table_comment":
        AsyncMock(return_value="Customer orders."),
        "fetch_column_comments":
        AsyncMock(return_value={"total_amount": "Order total in USD."}),
        "fetch_enum_columns":
        AsyncMock(
            return_value={
                "status": {
                    "type": "order_status",
                    "labels": ["pending", "shipped", "cancelled"],
                }
            }),
        "fetch_column_stats":
        AsyncMock(
            return_value={
                "channel": {
                    "n_distinct": 3.0,
                    "most_common_vals": ["web", "retail", "partner"],
                },
                "total_amount": {
                    "n_distinct": -1.0,
                    "most_common_vals": [],
                },
            }),
    }
    for name, fake in fakes.items():
        monkeypatch.setattr(f"mirage.core.postgres._client.{name}", fake)
    return fakes


def test_classify_key_column_is_dimension_even_when_numeric():
    assert classify_column("order_id", "integer", {"order_id"}) == "dimensions"


def test_classify_numeric_non_key_is_fact():
    assert classify_column("total_amount", "numeric", set()) == "facts"


def test_classify_timestamp_is_time_dimension():
    role = classify_column("placed_at", "timestamp with time zone", set())
    assert role == "time_dimensions"


def test_classify_text_is_dimension():
    assert classify_column("channel", "text", set()) == "dimensions"


def test_column_entry_omits_absent_metadata():
    entry = build_column_entry({
        "name": "channel",
        "type": "text"
    }, None, None, None)
    assert entry == {"name": "channel", "expr": "channel", "data_type": "text"}


def test_column_entry_uses_enum_type_and_labels():
    entry = build_column_entry({
        "name": "status",
        "type": "USER-DEFINED"
    }, None, {
        "type": "order_status",
        "labels": ["pending", "shipped"]
    }, None)
    assert entry["data_type"] == "order_status"
    assert entry["is_enum"] is True
    assert entry["sample_values"] == ["pending", "shipped"]


def test_column_entry_takes_sample_values_from_stats():
    entry = build_column_entry({
        "name": "channel",
        "type": "text"
    }, None, None, {
        "n_distinct": 3.0,
        "most_common_vals": ["web", "retail"]
    })
    assert entry["sample_values"] == ["web", "retail"]
    assert "is_enum" not in entry


def test_column_entry_skips_sample_values_when_stats_empty():
    entry = build_column_entry({
        "name": "total_amount",
        "type": "numeric"
    }, None, None, {
        "n_distinct": -1.0,
        "most_common_vals": []
    })
    assert "sample_values" not in entry


def test_column_entry_caps_sample_values():
    many = [str(i) for i in range(SAMPLE_VALUES_LIMIT + 5)]
    entry = build_column_entry({
        "name": "channel",
        "type": "text"
    }, None, None, {
        "n_distinct": 15.0,
        "most_common_vals": many
    })
    assert len(entry["sample_values"]) == SAMPLE_VALUES_LIMIT


def test_build_relationships_pairs_columns():
    rels = build_relationships(FOREIGN_KEYS, "public", "orders")
    assert rels == [{
        "left_table":
        "public.orders",
        "right_table":
        "public.customers",
        "relationship_columns": [{
            "left_column": "customer_id",
            "right_column": "id",
        }],
    }]


def test_build_relationships_empty_without_foreign_keys():
    assert build_relationships([], "public", "orders") == []


@pytest.mark.asyncio
async def test_semantic_json_splits_roles(accessor, client):
    doc = await build_entity_semantic_json(accessor, "public", "orders",
                                           "table")
    assert [d["name"] for d in doc["dimensions"]
            ] == ["order_id", "customer_id", "status", "channel"]
    assert [d["name"] for d in doc["time_dimensions"]] == ["placed_at"]
    assert [d["name"] for d in doc["facts"]] == ["total_amount"]


@pytest.mark.asyncio
async def test_semantic_json_carries_comments(accessor, client):
    doc = await build_entity_semantic_json(accessor, "public", "orders",
                                           "table")
    assert doc["description"] == "Customer orders."
    total = next(f for f in doc["facts"] if f["name"] == "total_amount")
    assert total["description"] == "Order total in USD."


@pytest.mark.asyncio
async def test_semantic_json_carries_enum_and_samples(accessor, client):
    doc = await build_entity_semantic_json(accessor, "public", "orders",
                                           "table")
    status = next(d for d in doc["dimensions"] if d["name"] == "status")
    assert status["data_type"] == "order_status"
    assert status["sample_values"] == ["pending", "shipped", "cancelled"]
    channel = next(d for d in doc["dimensions"] if d["name"] == "channel")
    assert channel["sample_values"] == ["web", "retail", "partner"]


@pytest.mark.asyncio
async def test_semantic_json_head_fields(accessor, client):
    doc = await build_entity_semantic_json(accessor, "public", "orders",
                                           "table")
    assert doc["name"] == "orders"
    assert doc["schema"] == "public"
    assert doc["kind"] == "table"
    assert doc["primary_key"] == ["order_id"]
    assert doc["relationships"][0]["right_table"] == "public.customers"


@pytest.mark.asyncio
async def test_semantic_json_omits_empty_sections(accessor, monkeypatch,
                                                  client):
    monkeypatch.setattr(
        "mirage.core.postgres._client.fetch_columns",
        AsyncMock(return_value=[{
            "name": "note",
            "type": "text",
            "nullable": True
        }]))
    monkeypatch.setattr("mirage.core.postgres._client.fetch_primary_key",
                        AsyncMock(return_value=[]))
    monkeypatch.setattr("mirage.core.postgres._client.fetch_foreign_keys",
                        AsyncMock(return_value=[]))
    monkeypatch.setattr("mirage.core.postgres._client.fetch_table_comment",
                        AsyncMock(return_value=None))
    doc = await build_entity_semantic_json(accessor, "public", "notes",
                                           "table")
    assert "facts" not in doc
    assert "time_dimensions" not in doc
    assert "relationships" not in doc
    assert "primary_key" not in doc
    assert "description" not in doc


@pytest.mark.asyncio
async def test_semantic_json_survives_missing_pg_stats(accessor, monkeypatch,
                                                       client):
    monkeypatch.setattr("mirage.core.postgres._client.fetch_column_stats",
                        AsyncMock(return_value={}))
    doc = await build_entity_semantic_json(accessor, "public", "orders",
                                           "table")
    channel = next(d for d in doc["dimensions"] if d["name"] == "channel")
    assert "sample_values" not in channel
