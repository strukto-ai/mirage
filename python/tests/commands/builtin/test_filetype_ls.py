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

import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from mirage.resource.ram import RAMResource
from mirage.types import MountMode
from mirage.workspace import Workspace


def _make_parquet():
    df = pd.DataFrame({"name": ["alice", "bob"], "score": [95, 80]})
    buf = io.BytesIO()
    pq.write_table(pa.Table.from_pandas(df), buf)
    return buf.getvalue()


async def _ws():
    ws = Workspace(
        {"/data/": RAMResource()},
        mode=MountMode.WRITE,
    )
    await ws.ops.write("/data/test.parquet", _make_parquet())
    await ws.ops.write("/data/notes.txt", b"hello world\n")
    return ws


@pytest.mark.asyncio
async def test_ls_l_no_parquet_enrichment():
    ws = await _ws()
    ws._cwd = "/"
    io = await ws.execute("ls -l /data/")
    out = await io.stdout_str()
    assert "test.parquet" in out
    assert "rows" not in out


@pytest.mark.asyncio
async def test_ls_l_txt_unchanged():
    ws = await _ws()
    ws._cwd = "/"
    io = await ws.execute("ls -l /data/")
    assert "notes.txt" in (await io.stdout_str())


@pytest.mark.asyncio
async def test_ls_without_l_no_enrichment():
    ws = await _ws()
    ws._cwd = "/"
    io = await ws.execute("ls /data/")
    out = await io.stdout_str()
    assert "rows" not in out
    assert "test.parquet" in out
