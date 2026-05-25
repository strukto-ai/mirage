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
import pyarrow.feather as feather
import pyarrow.orc as orc
import pyarrow.parquet as pq
import pytest

from mirage.resource.ram import RAMResource
from mirage.types import MountMode
from mirage.workspace import Workspace


def _make_parquet() -> bytes:
    df = pd.DataFrame({"name": ["alice", "bob"], "score": [95, 80]})
    buf = io.BytesIO()
    pq.write_table(pa.Table.from_pandas(df), buf)
    return buf.getvalue()


def _make_orc() -> bytes:
    df = pd.DataFrame({"name": ["alice", "bob"], "score": [95, 80]})
    buf = io.BytesIO()
    orc.write_table(pa.Table.from_pandas(df), buf)
    return buf.getvalue()


def _make_feather() -> bytes:
    df = pd.DataFrame({"name": ["alice", "bob"], "score": [95, 80]})
    buf = io.BytesIO()
    feather.write_feather(pa.Table.from_pandas(df), buf)
    return buf.getvalue()


async def _ws_with_files(**files):
    ws = Workspace(
        {"/data/": RAMResource()},
        mode=MountMode.WRITE,
    )
    for path, data in files.items():
        await ws.ops.write(path, data)
    return ws


@pytest.mark.asyncio
async def test_grep_parquet_returns_matching_rows():
    ws = await _ws_with_files(**{"/data/test.parquet": _make_parquet()})
    ws._cwd = "/"
    out = await (await
                 ws.execute("grep alice /data/test.parquet")).stdout_str()
    assert "alice" in out
    assert "bob" not in out


@pytest.mark.asyncio
async def test_grep_orc_returns_matching_rows():
    ws = await _ws_with_files(**{"/data/test.orc": _make_orc()})
    ws._cwd = "/"
    out = await (await ws.execute("grep alice /data/test.orc")).stdout_str()
    assert "alice" in out


@pytest.mark.asyncio
async def test_grep_feather_returns_matching_rows():
    ws = await _ws_with_files(**{"/data/test.feather": _make_feather()})
    ws._cwd = "/"
    out = await (await
                 ws.execute("grep alice /data/test.feather")).stdout_str()
    assert "alice" in out


@pytest.mark.asyncio
async def test_grep_count_flag_on_parquet():
    ws = await _ws_with_files(**{"/data/test.parquet": _make_parquet()})
    ws._cwd = "/"
    out = await (await
                 ws.execute("grep -c alice /data/test.parquet")).stdout_str()
    assert out.strip() == "1"


@pytest.mark.asyncio
async def test_grep_glob_parquet_dispatches_filetype():
    ws = await _ws_with_files(**{"/data/test.parquet": _make_parquet()})
    ws._cwd = "/"
    out = await (await ws.execute("grep alice /data/*.parquet")).stdout_str()
    assert "alice" in out


@pytest.mark.asyncio
async def test_grep_txt_uses_text_grep():
    ws = await _ws_with_files(**{"/data/test.txt": b"hello world\nbye now"})
    ws._cwd = "/"
    out = await (await ws.execute("grep hello /data/test.txt")).stdout_str()
    assert "hello world" in out
    assert "bye" not in out
