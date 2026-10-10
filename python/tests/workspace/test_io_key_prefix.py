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
import io
import zipfile
from collections.abc import Iterator

import boto3
import pytest
from moto.server import ThreadedMotoServer

from mirage.types import MountMode
from mirage.vfs.ram import RAMVFS
from mirage.vfs.s3.config import S3Config
from mirage.vfs.s3.s3 import S3VFS
from mirage.workspace import Workspace

CREDS = dict(
    aws_access_key_id="testing",
    aws_secret_access_key="testing",
    region_name="us-east-1",
)


@pytest.fixture()
def s3_endpoint() -> Iterator[str]:
    server = ThreadedMotoServer(ip_address="127.0.0.1", port=0, verbose=False)
    server.start()
    host, port = server.get_host_and_port()
    yield f"http://{host}:{port}"
    server.stop()


def _s3_workspace(endpoint: str, bucket: str) -> Workspace:
    boto3.client("s3", endpoint_url=endpoint, **CREDS).create_bucket(
        Bucket=bucket
    )
    s3 = S3VFS(
        S3Config(
            bucket=bucket,
            region="us-east-1",
            endpoint_url=endpoint,
            aws_access_key_id="testing",
            aws_secret_access_key="testing",
            path_style=True,
        )
    )
    return Workspace({"/data": s3}, mode=MountMode.WRITE)


def _zip_bytes() -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("inner/z.txt", "zip content\n")
    return buf.getvalue()


@pytest.mark.parametrize(
    "cmd,stdin",
    [
        ("tee /data/t.txt > /dev/null", b"x\ny\n"),
        ("csplit -f /data/cs_ /data/seed.txt 2", None),
        ("csplit /data/seed.txt 2", None),
        ("split -l 1 /data/seed.txt", None),
        ("cd /data && split -l 1", b"x\ny\n"),
        ("cd /data && csplit - 2", b"x\ny\n"),
        ("unzip /data/a.zip -d /data/exout", None),
        ("cp /data/seed.txt /data/copy.txt", None),
        ("mkdir /data/newdir", None),
        ("mv /data/seed.txt /data/moved.txt", None),
        ("rm -r /data/d", None),
        ("grep x /data/seed.txt > /data/red.txt", None),
        ("cat /data/seed.txt >> /data/app.txt", None),
        ("cat /data/seed.txt | tee /data/piped.txt > /dev/null", None),
        (
            "sed s/x/z/ /data/seed.txt > /data/s1.txt && cat /data/s1.txt"
            " > /data/s2.txt",
            None,
        ),
    ],
)
def test_ram_writes_land_inside_the_mount(cmd, stdin):
    ws = Workspace({"/data": RAMVFS()}, mode=MountMode.WRITE)

    async def run():
        await ws.shell("tee /data/seed.txt > /dev/null", stdin=b"x\ny\n")
        await ws.shell("tee /data/a.zip > /dev/null", stdin=_zip_bytes())
        await ws.shell("mkdir -p /data/d/sub && cp /data/seed.txt /data/d/sub")
        result = await ws.shell(cmd, stdin=stdin)
        assert result.exit_code == 0, await result.stderr_str()
        assert not await ws.vfs.exists("/data/data")
        await ws.close()

    asyncio.run(run())


def test_ram_stderr_redirect_records_mount_relative_key():
    ws = Workspace({"/data": RAMVFS()}, mode=MountMode.WRITE)

    async def run():
        result = await ws.shell("cat /data/missing.txt 2> /data/err.txt")
        assert result.exit_code != 0
        back = await ws.shell("cat /data/err.txt")
        assert back.exit_code == 0
        assert "missing.txt" in await back.stdout_str()
        await ws.close()

    asyncio.run(run())


def test_ram_csplit_writes_parts_inside_mount():
    ws = Workspace({"/data": RAMVFS()}, mode=MountMode.WRITE)

    async def run():
        await ws.shell("tee /data/seed.txt > /dev/null", stdin=b"x\ny\n")
        result = await ws.shell("csplit -f /data/cs_ /data/seed.txt 2")
        assert result.exit_code == 0, await result.stderr_str()
        part = await ws.shell("cat /data/cs_00")
        assert part.exit_code == 0
        assert await part.stdout_str() == "x\n"
        await ws.close()

    asyncio.run(run())


def test_ram_stdin_csplit_writes_its_part_inside_mount():
    ws = Workspace({"/data": RAMVFS()}, mode=MountMode.WRITE)

    async def run():
        result = await ws.shell("cd /data && csplit - 2", stdin=b"x\ny\n")
        assert result.exit_code == 0, await result.stderr_str()
        part = await ws.shell("cat /data/xx00")
        assert part.exit_code == 0
        assert await part.stdout_str() == "x\n"
        await ws.close()

    asyncio.run(run())


def test_s3_writes_land_inside_the_mount(s3_endpoint):
    ws = _s3_workspace(s3_endpoint, "key-prefix-test")

    async def run():
        await ws.shell("tee /data/t.txt > /dev/null", stdin=b"x\ny\n")
        for cmd in (
            "touch /data/new.txt",
            "mkdir -p /data/newdir",
            "csplit -f /data/cs_ /data/t.txt 2",
        ):
            result = await ws.shell(cmd)
            assert result.exit_code == 0, await result.stderr_str()
        assert not await ws.vfs.exists("/data/data")
        await ws.close()

    asyncio.run(run())


def test_s3_redirect_write_invalidates_listed_dir(s3_endpoint):
    ws = _s3_workspace(s3_endpoint, "key-redirect-test")

    async def run():
        await ws.shell("tee /data/a.txt > /dev/null", stdin=b"x\ny\n")
        await ws.shell("ls -1 /data/")
        await ws.shell("grep x /data/a.txt > /data/red.txt")
        await ws.shell("cat /data/a.txt | tee /data/piped.txt > /dev/null")
        listing = await (await ws.shell("ls -1 /data/")).stdout_str()
        assert "red.txt" in listing
        assert "piped.txt" in listing
        back = await ws.shell("cat /data/red.txt")
        assert await back.stdout_str() == "x\n"
        await ws.close()

    asyncio.run(run())


def test_s3_touch_invalidates_listed_dir(s3_endpoint):
    ws = _s3_workspace(s3_endpoint, "key-invalidate-test")

    async def run():
        await ws.shell("tee /data/a.txt > /dev/null", stdin=b"a\n")
        await ws.shell("ls -1 /data/")
        await ws.shell("touch /data/late.txt")
        result = await ws.shell("rm /data/late.txt")
        assert result.exit_code == 0, await result.stderr_str()
        gone = await ws.shell("cat /data/late.txt")
        assert gone.exit_code != 0
        await ws.close()

    asyncio.run(run())
