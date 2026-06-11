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
from collections.abc import Iterator

import boto3
import pytest
from moto.server import ThreadedMotoServer

from mirage.resource.s3.s3 import S3Config, S3Resource
from mirage.types import MountMode
from mirage.workspace import Workspace

CREDS = dict(aws_access_key_id="testing",
             aws_secret_access_key="testing",
             region_name="us-east-1")


@pytest.fixture()
def s3_endpoint() -> Iterator[str]:
    server = ThreadedMotoServer(ip_address="127.0.0.1", port=0, verbose=False)
    server.start()
    host, port = server.get_host_and_port()
    yield f"http://{host}:{port}"
    server.stop()


def _s3_workspace(endpoint: str, bucket: str) -> Workspace:
    boto3.client("s3", endpoint_url=endpoint,
                 **CREDS).create_bucket(Bucket=bucket)
    s3 = S3Resource(
        S3Config(bucket=bucket,
                 region="us-east-1",
                 endpoint_url=endpoint,
                 aws_access_key_id="testing",
                 aws_secret_access_key="testing",
                 path_style=True))
    return Workspace({"/data": s3}, mode=MountMode.WRITE)


async def _exec(ws: Workspace, cmd: str) -> tuple[int, str, str]:
    result = await ws.execute(cmd)
    out = await result.stdout_str()
    err = await result.stderr_str()
    return result.exit_code, out, err


async def _gzip_roundtrip_interleaved_ls(
        ws: Workspace) -> tuple[int, str, str]:
    cmd = ("echo two | tee /data/arch/h.txt > /dev/null"
           " && gzip /data/arch/h.txt"
           " && ls /data/arch"
           " && gunzip /data/arch/h.txt.gz"
           " && cat /data/arch/h.txt")
    return await _exec(ws, cmd)


def test_gzip_roundtrip_with_interleaved_ls(s3_endpoint):
    ws = _s3_workspace(s3_endpoint, "bucket-gzip-ls")
    code, out, err = asyncio.run(_gzip_roundtrip_interleaved_ls(ws))
    assert code == 0, f"exit {code}, stderr: {err!r}"
    assert "two" in out


async def _overwrite_then_ls(ws: Workspace) -> tuple[int, str, str]:
    setup = await _exec(
        ws, "echo one | tee /data/arch/a.txt > /dev/null"
        " && ls /data/arch")
    assert setup[0] == 0, setup
    code, out, err = await _exec(
        ws, "echo two | tee /data/arch/b.txt > /dev/null && ls /data/arch")
    return code, out, err


def test_ls_sees_file_created_after_listing(s3_endpoint):
    ws = _s3_workspace(s3_endpoint, "bucket-ls-create")
    code, out, err = asyncio.run(_overwrite_then_ls(ws))
    assert code == 0, f"exit {code}, stderr: {err!r}"
    assert "b.txt" in out


async def _rm_then_stat(ws: Workspace) -> tuple[int, str, str]:
    setup = await _exec(
        ws, "echo gone | tee /data/arch/c.txt > /dev/null"
        " && ls /data/arch")
    assert setup[0] == 0, setup
    rm = await _exec(ws, "rm /data/arch/c.txt")
    assert rm[0] == 0, rm
    return await _exec(ws, "ls /data/arch")


def test_ls_does_not_show_removed_file(s3_endpoint):
    ws = _s3_workspace(s3_endpoint, "bucket-rm-stat")
    code, out, err = asyncio.run(_rm_then_stat(ws))
    assert code == 0, f"exit {code}, stderr: {err!r}"
    assert "c.txt" not in out
