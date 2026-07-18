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

import tempfile
from unittest.mock import AsyncMock, patch

import pandas as pd
import pytest

from mirage.accessor.gdrive import GDriveAccessor
from mirage.cache.index.config import IndexEntry
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.core.filetype.hdf5 import cat as hdf5_cat
from mirage.ops.gdrive import OPS
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key

read_hdf5 = next(o.fn for o in OPS
                 if o.name == "read" and o.filetype == ".hdf5")


def _make_hdf5() -> bytes:
    df = pd.DataFrame({"name": ["alice", "bob"], "score": [1, 2]})
    with tempfile.NamedTemporaryFile(suffix=".h5", delete=False) as f:
        df.to_hdf(f.name, key="data", mode="w")
        tmp = f.name
    with open(tmp, "rb") as fh:
        return fh.read()


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
async def test_read_hdf5_renders_through_cat(accessor, index):
    raw = _make_hdf5()
    await index.put(
        "/data/file.hdf5",
        IndexEntry(
            id="h1",
            name="file",
            resource_type="gdrive/file",
            remote_time="2026-04-01T00:00:00Z",
            vfs_name="file.hdf5",
        ))
    with patch(
            "mirage.core.gdrive.read.download_file",
            new_callable=AsyncMock,
            return_value=raw,
    ) as mock:
        result = await read_hdf5(accessor,
                                 _scope("/data/file.hdf5"),
                                 index=index)
        mock.assert_called_once_with(accessor.token_manager, "h1")
        assert result == hdf5_cat(raw)
