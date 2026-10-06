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
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from mirage.accessor.postgres import PostgresAccessor
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.core.postgres.read import read
from mirage.errors.types import FileTooLargeError
from mirage.types import PathSpec
from mirage.vfs.postgres.config import PostgresConfig


@asynccontextmanager
async def _fake_acquire():
    yield MagicMock()


def _accessor(
    max_read_rows: int = 10_000,
    max_read_bytes: int = 10 * 1024 * 1024,
    default_row_limit: int = 1000,
    schemas: list[str] | None = None,
) -> PostgresAccessor:
    a = PostgresAccessor(
        PostgresConfig(
            dsn="postgres://localhost/db",
            max_read_rows=max_read_rows,
            max_read_bytes=max_read_bytes,
            default_row_limit=default_row_limit,
            schemas=schemas,
        )
    )
    pool = MagicMock()
    pool.acquire = lambda: _fake_acquire()
    a.pool = AsyncMock(return_value=pool)
    return a


@pytest.fixture
def index():
    return RAMIndexCacheStore()


async def _catalog_schemas(conn, allowlist):
    # `client.list_schemas`'s contract over a catalog holding two schemas.
    return [
        s for s in ("public", "secret") if allowlist is None or s in allowlist
    ]


@pytest.fixture(autouse=True)
def catalog():
    # A read proves the entity directory first, through the guards stat
    # runs, so the entity has to exist in a schema the mount can see.
    with (
        patch(
            "mirage.core.postgres.client.list_schemas",
            AsyncMock(side_effect=_catalog_schemas),
        ),
        patch(
            "mirage.core.postgres.client.list_tables",
            AsyncMock(return_value=["users"]),
        ),
        patch(
            "mirage.core.postgres.client.list_views",
            AsyncMock(return_value=["v1"]),
        ),
        patch(
            "mirage.core.postgres.client.list_matviews",
            AsyncMock(return_value=[]),
        ),
    ):
        yield


@pytest.mark.asyncio
async def test_read_database_json():
    accessor = _accessor()
    fake_doc = {
        "database": "db",
        "schemas": ["public"],
        "tables": [],
        "views": [],
        "relationships": [],
    }
    with patch(
        "mirage.core.postgres.read.build_database_json",
        new_callable=AsyncMock,
        return_value=fake_doc,
    ):
        out = await read(
            accessor,
            PathSpec(
                vfs_path="database.json",
                virtual="/database.json",
                directory="/database.json",
            ),
        )
    parsed = json.loads(out)
    assert parsed == fake_doc


@pytest.mark.asyncio
async def test_read_entity_schema_json_table():
    accessor = _accessor()
    fake_doc = {"schema": "public", "name": "users", "kind": "table"}
    with patch(
        "mirage.core.postgres.read.build_entity_schema_json",
        new_callable=AsyncMock,
        return_value=fake_doc,
    ) as mock_fn:
        out = await read(
            accessor,
            PathSpec(
                vfs_path="public/tables/users/schema.json",
                virtual="/public/tables/users/schema.json",
                directory="/public/tables/users/schema.json",
            ),
        )
    parsed = json.loads(out)
    assert parsed == fake_doc
    mock_fn.assert_awaited_once_with(accessor, "public", "users", "table")


@pytest.mark.asyncio
async def test_read_entity_schema_json_view_kind():
    accessor = _accessor()
    fake_doc = {"schema": "public", "name": "v1", "kind": "view"}
    with patch(
        "mirage.core.postgres.read.build_entity_schema_json",
        new_callable=AsyncMock,
        return_value=fake_doc,
    ) as mock_fn:
        await read(
            accessor,
            PathSpec(
                vfs_path="public/views/v1/schema.json",
                virtual="/public/views/v1/schema.json",
                directory="/public/views/v1/schema.json",
            ),
        )
    mock_fn.assert_awaited_once_with(accessor, "public", "v1", "view")


@pytest.mark.asyncio
async def test_read_rows_returns_jsonl():
    accessor = _accessor()
    rows = [{"id": 1, "name": "a"}, {"id": 2, "name": "b"}]
    with patch("mirage.core.postgres.read.client") as mc:
        mc.estimate_size = AsyncMock(return_value=(2, 80))
        mc.fetch_bounded_rows = AsyncMock(return_value=rows)
        out = await read(
            accessor,
            PathSpec(
                vfs_path="public/tables/users/rows.jsonl",
                virtual="/public/tables/users/rows.jsonl",
                directory="/public/tables/users/rows.jsonl",
            ),
        )
    lines = out.decode().strip().split("\n")
    assert len(lines) == 2
    assert json.loads(lines[0]) == {"id": 1, "name": "a"}


@pytest.mark.asyncio
async def test_read_rows_too_many_rows_raises():
    accessor = _accessor(max_read_rows=100)
    with patch("mirage.core.postgres.read.client") as mc:
        mc.estimate_size = AsyncMock(return_value=(1_000_000, 50))
        with pytest.raises(FileTooLargeError, match="rows.jsonl"):
            await read(
                accessor,
                PathSpec(
                    vfs_path="public/tables/users/rows.jsonl",
                    virtual="/public/tables/users/rows.jsonl",
                    directory="/public/tables/users/rows.jsonl",
                ),
            )


@pytest.mark.asyncio
async def test_read_rows_too_many_bytes_raises():
    accessor = _accessor(max_read_rows=10_000_000, max_read_bytes=1024)
    with patch("mirage.core.postgres.read.client") as mc:
        mc.estimate_size = AsyncMock(return_value=(100, 100))
        with pytest.raises(FileTooLargeError, match="rows.jsonl"):
            await read(
                accessor,
                PathSpec(
                    vfs_path="public/tables/users/rows.jsonl",
                    virtual="/public/tables/users/rows.jsonl",
                    directory="/public/tables/users/rows.jsonl",
                ),
            )


@pytest.mark.asyncio
async def test_read_rows_with_explicit_limit_bypasses_guard():
    accessor = _accessor(max_read_rows=10)
    rows = [{"id": i} for i in range(5)]
    with patch("mirage.core.postgres.read.client") as mc:
        mc.fetch_rows = AsyncMock(return_value=rows)
        out = await read(
            accessor,
            PathSpec(
                vfs_path="public/tables/users/rows.jsonl",
                virtual="/public/tables/users/rows.jsonl",
                directory="/public/tables/users/rows.jsonl",
            ),
            limit=5,
            offset=0,
        )
        mc.estimate_size.assert_not_called()
    lines = out.decode().strip().split("\n")
    assert len(lines) == 5


@pytest.mark.asyncio
async def test_read_rows_with_only_offset_bypasses_guard():
    accessor = _accessor(max_read_rows=10)
    rows = [{"id": i} for i in range(3)]
    with patch("mirage.core.postgres.read.client") as mc:
        mc.fetch_rows = AsyncMock(return_value=rows)
        await read(
            accessor,
            PathSpec(
                vfs_path="public/tables/users/rows.jsonl",
                virtual="/public/tables/users/rows.jsonl",
                directory="/public/tables/users/rows.jsonl",
            ),
            offset=10,
        )
        mc.estimate_size.assert_not_called()


@pytest.mark.asyncio
async def test_read_rows_empty_returns_empty_bytes():
    accessor = _accessor()
    with patch("mirage.core.postgres.read.client") as mc:
        mc.estimate_size = AsyncMock(return_value=(0, 50))
        mc.fetch_bounded_rows = AsyncMock(return_value=[])
        out = await read(
            accessor,
            PathSpec(
                vfs_path="public/tables/users/rows.jsonl",
                virtual="/public/tables/users/rows.jsonl",
                directory="/public/tables/users/rows.jsonl",
            ),
        )
    assert out == b""


@pytest.mark.asyncio
async def test_read_invalid_path_raises():
    # A probed directory shape is no proof the node exists, so the read
    # reports absence rather than EISDIR.
    accessor = _accessor()
    with pytest.raises(FileNotFoundError):
        await read(
            accessor,
            PathSpec(
                vfs_path="public/tables",
                virtual="/public/tables",
                directory="/public/tables",
            ),
        )


@pytest.mark.asyncio
async def test_read_view_rows_names_the_view_in_the_refusal():
    """The refusal names the view's own path, not a table's."""
    accessor = _accessor(max_read_rows=10)
    with patch("mirage.core.postgres.read.client") as mc:
        mc.estimate_size = AsyncMock(return_value=(10000, 100))
        with pytest.raises(FileTooLargeError, match="views/v1/rows.jsonl"):
            await read(
                accessor,
                PathSpec(
                    vfs_path="public/views/v1/rows.jsonl",
                    virtual="/public/views/v1/rows.jsonl",
                    directory="/public/views/v1/rows.jsonl",
                ),
            )


@pytest.mark.asyncio
async def test_a_table_under_a_schema_outside_schemas_is_enoent_to_read():
    """``schemas`` hid the schema from ``ls`` while ``cat`` of a table
    under it fetched its rows: the read addressed the database by the
    names in the path and never asked whether the mount could see them."""
    accessor = _accessor(schemas=["public"])
    with patch("mirage.core.postgres.read.client") as mc:
        mc.estimate_size = AsyncMock(return_value=(1, 10))
        mc.fetch_bounded_rows = AsyncMock(return_value=[{"id": 1}])
        for name in ("rows.jsonl", "schema.json"):
            with pytest.raises(FileNotFoundError):
                await read(
                    accessor,
                    PathSpec(
                        vfs_path=f"secret/tables/users/{name}",
                        virtual=f"/secret/tables/users/{name}",
                        directory="/secret/tables/users",
                    ),
                )
        mc.fetch_bounded_rows.assert_not_awaited()
        out = await read(
            accessor,
            PathSpec(
                vfs_path="public/tables/users/rows.jsonl",
                virtual="/public/tables/users/rows.jsonl",
                directory="/public/tables/users",
            ),
        )
    assert json.loads(out) == {"id": 1}


def _table(n: int):
    rows = [{"id": i} for i in range(n)]

    async def fetch_rows(conn, schema, entity, *, limit, max_bytes):
        offset = 0
        return rows[offset : offset + limit]

    return fetch_rows


@pytest.mark.asyncio
async def test_a_whole_read_is_not_truncated_by_a_stale_estimate():
    """The estimate is planner statistics and lags the table; it used to
    be the LIMIT, so a table loaded since the last ANALYZE read back as
    only the rows the statistics knew about."""
    accessor = _accessor(max_read_rows=100)
    with patch("mirage.core.postgres.read.client") as mc:
        mc.estimate_size = AsyncMock(return_value=(2, 10))
        mc.fetch_bounded_rows = AsyncMock(side_effect=_table(40))
        out = await read(
            accessor,
            PathSpec(
                vfs_path="public/tables/users/rows.jsonl",
                virtual="/public/tables/users/rows.jsonl",
                directory="/public/tables/users",
            ),
        )
    assert len(out.decode().splitlines()) == 40


@pytest.mark.asyncio
async def test_a_table_the_estimate_undercounted_is_refused_on_its_rows():
    accessor = _accessor(max_read_rows=10)
    with patch("mirage.core.postgres.read.client") as mc:
        mc.estimate_size = AsyncMock(return_value=(2, 10))
        mc.fetch_bounded_rows = AsyncMock(side_effect=_table(40))
        with pytest.raises(FileTooLargeError, match="rows.jsonl"):
            await read(
                accessor,
                PathSpec(
                    vfs_path="public/tables/users/rows.jsonl",
                    virtual="/public/tables/users/rows.jsonl",
                    directory="/public/tables/users",
                ),
            )
    assert mc.fetch_bounded_rows.await_args.kwargs["limit"] == 11


@pytest.mark.asyncio
async def test_whole_read_refuses_bytes_before_serializing():
    accessor = _accessor(max_read_bytes=100)
    with (
        patch("mirage.core.postgres.read.client") as mc,
        patch("mirage.core.postgres.read.row_line") as render,
    ):
        mc.estimate_size = AsyncMock(return_value=(1, 10))
        mc.fetch_bounded_rows = AsyncMock(return_value=None)
        with pytest.raises(FileTooLargeError, match="rows.jsonl"):
            await read(
                accessor,
                PathSpec.from_str_path("/public/tables/users/rows.jsonl"),
            )
        render.assert_not_called()
        mc.fetch_rows.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.parametrize("budget, refuses", [(10, True), (11, False)])
async def test_whole_read_checks_rendered_utf8_bytes(budget, refuses):
    accessor = _accessor(max_read_bytes=budget)
    with patch("mirage.core.postgres.read.client") as mc:
        mc.estimate_size = AsyncMock(return_value=(1, 1))
        mc.fetch_bounded_rows = AsyncMock(return_value=[{"x": "é"}])
        path = PathSpec.from_str_path("/public/tables/users/rows.jsonl")
        if refuses:
            with pytest.raises(FileTooLargeError, match="rows.jsonl"):
                await read(accessor, path)
        else:
            assert await read(accessor, path) == '{"x":"é"}\n'.encode()
