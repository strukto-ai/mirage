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
import os
from collections.abc import Iterator

import boto3
import pytest
from moto.server import ThreadedMotoServer

from mirage import MountMode, Workspace
from mirage.vfs.ram import RAMVFS
from mirage.vfs.s3.config import S3Config

CREDS = dict(
    aws_access_key_id="testing",
    aws_secret_access_key="testing",
    region_name="us-east-1",
)


@pytest.fixture()
def store() -> Iterator[S3Config]:
    server = ThreadedMotoServer(ip_address="127.0.0.1", port=0, verbose=False)
    server.start()
    host, port = server.get_host_and_port()
    endpoint = f"http://{host}:{port}"
    boto3.client("s3", endpoint_url=endpoint, **CREDS).create_bucket(
        Bucket="snaps"
    )
    yield S3Config(
        bucket="snaps",
        region="us-east-1",
        endpoint_url=endpoint,
        aws_access_key_id="testing",
        aws_secret_access_key="testing",
        path_style=True,
        key_prefix="team/",
    )
    server.stop()


async def _written() -> Workspace:
    ws = Workspace({"/": (RAMVFS(), MountMode.WRITE)})
    await ws.shell("echo kept > /f")
    return ws


async def _cat(ws: Workspace) -> str:
    return await (await ws.shell("cat /f")).stdout_str()


@pytest.mark.asyncio
async def test_the_size_counts_only_the_tar(tmp_path):
    ws = await _written()
    buffer = io.BytesIO(b"head")
    buffer.seek(0, io.SEEK_END)
    size = await ws.snapshot(buffer)
    assert size == len(buffer.getvalue()) - len(b"head")
    path = tmp_path / "w.tar"
    assert await ws.snapshot(path) == path.stat().st_size


@pytest.mark.asyncio
@pytest.mark.parametrize("compress", [None, "gz"])
async def test_a_snapshot_streams_to_a_pipe(compress):
    read, write = os.pipe()
    with os.fdopen(write, "wb") as out:
        size = await (await _written()).snapshot(out, compress=compress)
    with os.fdopen(read, "rb") as source:
        data = source.read()
    assert size == len(data) > 0
    assert await _cat(await Workspace.load(io.BytesIO(data))) == "kept\n"


class _Trickle(io.RawIOBase):
    """A raw stream that takes at most three bytes per write."""

    def __init__(self) -> None:
        self.data = bytearray()

    def writable(self) -> bool:
        return True

    def write(self, b) -> int:
        taken = bytes(b[:3])
        self.data += taken
        return len(taken)


@pytest.mark.asyncio
async def test_a_target_that_takes_part_of_a_write_gets_the_rest():
    out = _Trickle()
    size = await (await _written()).snapshot(out)
    assert size == len(out.data) > 0
    loaded = await Workspace.load(io.BytesIO(bytes(out.data)))
    assert await _cat(loaded) == "kept\n"


class _Full(io.RawIOBase):
    """A raw stream that takes nothing."""

    def writable(self) -> bool:
        return True

    def write(self, b) -> int:
        return 0


@pytest.mark.asyncio
async def test_a_target_that_takes_nothing_fails_the_snapshot():
    with pytest.raises(OSError, match="took none"):
        await asyncio.wait_for((await _written()).snapshot(_Full()), 10)


@pytest.mark.asyncio
async def test_a_snapshot_round_trips_through_bytes():
    buffer = io.BytesIO()
    size = await (await _written()).snapshot(buffer)
    assert size == len(buffer.getvalue()) > 0
    buffer.seek(0)
    assert await _cat(await Workspace.load(buffer)) == "kept\n"


@pytest.mark.asyncio
async def test_a_snapshot_round_trips_through_an_s3_store(store):
    size = await (await _written()).snapshot("a.tar", s3=store)
    head = boto3.client(
        "s3", endpoint_url=store.endpoint_url, **CREDS
    ).head_object(Bucket="snaps", Key="team/a.tar")
    assert head["ContentLength"] == size
    assert await _cat(await Workspace.load("a.tar", s3=store)) == "kept\n"


@pytest.mark.asyncio
async def test_a_missing_key_is_file_not_found(store):
    with pytest.raises(FileNotFoundError):
        await Workspace.load("nope.tar", s3=store)


@pytest.mark.asyncio
async def test_io_buffer_limit_survives_copy_and_snapshot():
    ws = Workspace({}, io={"buffer_bytes": 262144}, runtimes=["workspace"])
    copies = []
    try:
        copies.append(await ws.copy())
        snapshot = io.BytesIO()
        await ws.snapshot(snapshot)
        snapshot.seek(0)
        copies.append(await Workspace.load(snapshot))
        for restored in copies:
            assert restored.io.buffer_bytes == 262144
            assert restored.registry.io is restored.io
    finally:
        for restored in copies:
            await restored.close()
        await ws.close()
