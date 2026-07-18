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

import io
from unittest.mock import AsyncMock, patch

import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from mirage.accessor.gdrive import GDriveAccessor
from mirage.cache.index.config import IndexEntry
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.core.filetype.parquet import cat as parquet_cat
from mirage.ops.gdrive import OPS
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key

read_parquet = next(o.fn for o in OPS
                    if o.name == "read" and o.filetype == ".parquet")


def _make_parquet() -> bytes:
    table = pa.table({"name": ["alice", "bob"], "score": [1, 2]})
    buf = io.BytesIO()
    pq.write_table(table, buf)
    return buf.getvalue()


def _scope(path: str, prefix: str = "") -> PathSpec:
    return PathSpec(resource_path=mount_key(path, prefix),
                    virtual=path,
                    directory=path.rsplit("/", 1)[0] or "/")


@pytest.fixture
def accessor():
    return GDriveAccessor(config=None, token_manager=None)


@pytest.fixture
def index():
    return RAMIndexCacheStore()


@pytest.mark.asyncio
async def test_read_parquet_renders_through_cat(accessor, index):
    raw = _make_parquet()
    await index.put(
        "/data/file.parquet",
        IndexEntry(
            id="p1",
            name="file",
            resource_type="gdrive/file",
            remote_time="2026-04-01T00:00:00Z",
            vfs_name="file.parquet",
        ))
    with patch(
            "mirage.core.gdrive.read.download_file",
            new_callable=AsyncMock,
            return_value=raw,
    ) as mock:
        result = await read_parquet(accessor,
                                    _scope("/data/file.parquet"),
                                    index=index)
        mock.assert_called_once_with(accessor.token_manager, "p1")
        assert result == parquet_cat(raw)
