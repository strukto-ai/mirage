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
from contextlib import ExitStack

import pytest

from mirage.resource.gdrive import GoogleDriveConfig, GoogleDriveResource
from mirage.resource.ram import RAMResource
from mirage.types import MountMode
from mirage.workspace import Workspace
from tests.e2e.gdrive_mock import FakeGDrive, patch_gdrive


def _resource() -> GoogleDriveResource:
    return GoogleDriveResource(config=GoogleDriveConfig(
        client_id="fake",
        client_secret="fake",
        refresh_token="fake",
    ))


@pytest.fixture
def cold():
    """A gdrive tree the index has never seen.

    The cross-mount matrix seeds through the workspace, which primes the
    index on the way in, so it cannot reach the cold path #270 is about.
    Seeding straight into the fake Drive leaves the index empty, which is
    the state where the walk used to stop at the top level.
    """
    fake = FakeGDrive()
    fake.add_file("tree/a.txt", b"aaa\n")
    fake.add_file("tree/sub/b.txt", b"bbb\n")
    fake.add_file("tree/sub/deep/c.txt", b"ccc\n")
    gdrive = _resource()
    stack = ExitStack()
    stack.enter_context(patch_gdrive((gdrive.config, fake)))
    try:
        yield Workspace({
            "/gdrive/": (gdrive, MountMode.WRITE),
            "/ram/": (RAMResource(), MountMode.WRITE),
        })
    finally:
        stack.close()


def _run(ws: Workspace, cmd: str) -> tuple[str, int]:

    async def _inner():
        io = await ws.execute(cmd)
        return await io.stdout_str(), io.exit_code

    return asyncio.run(_inner())


def test_cold_readdir_descends_into_a_nested_subdirectory(cold):
    """A cold listing must not need a prior ls to resolve children."""
    out, code = _run(cold, "ls /gdrive/tree/sub/deep")
    assert code == 0
    assert out == "c.txt\n"


def test_cold_cross_mount_cp_r_keeps_nested_entries(cold):
    """#270: the walk copied the top level and dropped everything under it."""
    _, code = _run(cold, "cp -r /gdrive/tree /ram/copied")
    assert code == 0
    assert _run(cold, "cat /ram/copied/a.txt")[0] == "aaa\n"
    assert _run(cold, "cat /ram/copied/sub/b.txt")[0] == "bbb\n"
    assert _run(cold, "cat /ram/copied/sub/deep/c.txt")[0] == "ccc\n"


def test_cold_cross_mount_move_carries_nested_entries_to_the_destination(cold):
    """The move's copy phase walks the same tree as cp -r.

    Only the destination side is asserted: the fake Drive patches reads,
    not writes, so deleting the source would reach the real API. The
    source-removal half is out of scope here and for #270, which is about
    entries the walk never visited.
    """
    _run(cold, "mv /gdrive/tree /ram/moved")
    assert _run(cold, "cat /ram/moved/a.txt")[0] == "aaa\n"
    assert _run(cold, "cat /ram/moved/sub/b.txt")[0] == "bbb\n"
    assert _run(cold, "cat /ram/moved/sub/deep/c.txt")[0] == "ccc\n"
