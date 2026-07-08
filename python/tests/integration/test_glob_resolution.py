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

import pytest

from mirage.resource.gcs import GCSConfig, GCSResource
from mirage.resource.ram import RAMResource
from mirage.types import MountMode
from mirage.workspace import Workspace

from .conftest import make_s3_ws, patch_async_session

S3_OBJECTS = {
    "data/report.txt": b"line1\nline2\nline3\n",
    "data/notes.txt": b"note1\nnote2\n",
    "data/config.json": b'{"key": "value"}\n',
    "data/metrics.csv": b"a,b\n1,2\n3,4\n",
    "archive/2026/deep.txt": b"deep\n",
}


@pytest.fixture
def s3_ws():
    return make_s3_ws(S3_OBJECTS)


@pytest.fixture
def gcs_ws():
    config = GCSConfig(
        bucket="test-bucket",
        access_key_id="GOOG_FAKE",
        secret_access_key="fake_secret",
    )
    resource = GCSResource(config)
    return Workspace(
        {"/gcs": (resource, MountMode.WRITE)},
        mode=MountMode.WRITE,
    )


@pytest.fixture
def multi_ws():
    config = GCSConfig(
        bucket="test-bucket",
        access_key_id="GOOG_FAKE",
        secret_access_key="fake_secret",
    )
    return Workspace(
        {
            "/gcs": (GCSResource(config), MountMode.WRITE),
            "/tmp": (RAMResource(), MountMode.WRITE),
        },
        mode=MountMode.WRITE,
    )


async def _run(ws, cmd):
    io = await ws.execute(cmd)
    return await io.stdout_str(), io


@pytest.mark.asyncio
async def test_s3_echo_glob_expands(s3_ws):
    with patch_async_session(S3_OBJECTS):
        out, io = await _run(s3_ws, "echo /data/data/*.txt")
    assert io.exit_code == 0
    assert "report.txt" in out
    assert "notes.txt" in out
    assert "config.json" not in out


@pytest.mark.asyncio
async def test_s3_for_loop_glob(s3_ws):
    with patch_async_session(S3_OBJECTS):
        out, io = await _run(
            s3_ws, "for f in /data/data/*.txt; do echo file:$f; done")
    assert io.exit_code == 0
    assert "file:/data/data/report.txt" in out
    assert "file:/data/data/notes.txt" in out


@pytest.mark.asyncio
async def test_s3_grep_glob(s3_ws):
    with patch_async_session(S3_OBJECTS):
        out, io = await _run(s3_ws, "grep line /data/data/*.txt")
    assert io.exit_code == 0
    assert "line1" in out


@pytest.mark.asyncio
async def test_gcs_echo_glob_expands(gcs_ws):
    with patch_async_session(S3_OBJECTS):
        out, io = await _run(gcs_ws, "echo /gcs/data/*.txt")
    assert io.exit_code == 0
    assert "report.txt" in out
    assert "notes.txt" in out


@pytest.mark.asyncio
async def test_gcs_for_loop_glob(gcs_ws):
    with patch_async_session(S3_OBJECTS):
        out, io = await _run(
            gcs_ws, "for f in /gcs/data/*.txt; do echo file:$f; done")
    assert io.exit_code == 0
    assert "report.txt" in out
    assert "notes.txt" in out


@pytest.mark.asyncio
async def test_gcs_grep_no_match_exit_code(gcs_ws):
    with patch_async_session(S3_OBJECTS):
        out, io = await _run(gcs_ws, "grep NONEXISTENT /gcs/data/report.txt")
    assert io.exit_code == 1


@pytest.mark.asyncio
async def test_gcs_grep_match_exit_code(gcs_ws):
    with patch_async_session(S3_OBJECTS):
        out, io = await _run(gcs_ws, "grep line1 /gcs/data/report.txt")
    assert io.exit_code == 0
    assert "line1" in out


@pytest.mark.asyncio
async def test_s3_glob_no_match_keeps_literal(s3_ws):
    with patch_async_session(S3_OBJECTS):
        out, io = await _run(s3_ws, "echo /data/data/*.xyz")
    assert out.strip() == "/data/data/*.xyz"


@pytest.mark.asyncio
async def test_cross_mount_cp_with_gcs(multi_ws):
    with patch_async_session(S3_OBJECTS):
        await multi_ws.execute("cp /gcs/data/report.txt /tmp/r.txt")
        out, io = await _run(multi_ws, "cat /tmp/r.txt")
    assert "line1" in out
    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_s3_cat_single_from_glob(s3_ws):
    with patch_async_session(S3_OBJECTS):
        out, io = await _run(s3_ws, "cat /data/data/*.csv")
    assert io.exit_code == 0
    assert "a,b" in out
