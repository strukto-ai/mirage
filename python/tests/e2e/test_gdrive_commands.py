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
import pytest_asyncio

from mirage.types import MountMode, ReadPolicy, ReadSpec
from mirage.vfs.gdrive import GoogleDriveConfig, GoogleDriveVFS
from mirage.workspace import Workspace
from tests.fixtures.google_account import GoogleAccount


@pytest_asyncio.fixture
async def gdrive_ws(google_account: GoogleAccount):
    await google_account.put("hello.txt", b"hello world\n")
    await google_account.put("data/numbers.txt", b"one\ntwo\nthree\n")
    vfs = GoogleDriveVFS(google_account.config(GoogleDriveConfig))
    ws = Workspace({"/gd": vfs}, mode=MountMode.READ)
    try:
        yield ws
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_gdrive_cat(gdrive_ws):
    await gdrive_ws.shell("ls /gd")
    r = await gdrive_ws.shell("cat /gd/hello.txt")
    assert (await r.stdout_str()) == "hello world\n", (
        f"exit={r.exit_code} stderr={await r.stderr_str()!r}"
    )


@pytest.mark.asyncio
async def test_gdrive_ls(gdrive_ws):
    r = await gdrive_ws.shell("ls /gd")
    out = await r.stdout_str()
    assert "hello.txt" in out
    assert "data" in out


@pytest.mark.asyncio
async def test_gdrive_grep(gdrive_ws):
    await gdrive_ws.shell("ls /gd")
    await gdrive_ws.shell("ls /gd/data")
    r = await gdrive_ws.shell("grep two /gd/data/numbers.txt")
    assert "two" in (await r.stdout_str())


@pytest.mark.asyncio
async def test_gdrive_find_directory(gdrive_ws):
    """`find` over gdrive walks a folder (#684).

    find resolves its start point through ``resolve_key`` and walks with
    ``iter_tree``, each with a listing of its own besides readdir's.
    """
    r = await gdrive_ws.shell("find /gd/data")
    assert r.exit_code == 0, f"stderr={await r.stderr_str()!r}"
    assert (await r.stdout_str()) == "/gd/data\n/gd/data/numbers.txt\n"


@pytest.mark.asyncio
async def test_gdrive_find_file_start_point(gdrive_ws):
    """A file start point is reported, never walked.

    GNU findutils 4.10.0: `find <file>` prints the file and exits 0, and
    `-type f` matches it while `-type d` does not.
    """
    r = await gdrive_ws.shell("find /gd/hello.txt")
    assert r.exit_code == 0, f"stderr={await r.stderr_str()!r}"
    assert (await r.stdout_str()) == "/gd/hello.txt\n"
    r = await gdrive_ws.shell("find /gd/hello.txt -type f")
    assert (await r.stdout_str()) == "/gd/hello.txt\n"
    r = await gdrive_ws.shell("find /gd/hello.txt -type d")
    assert (await r.stdout_str()) == ""
    assert r.exit_code == 0


@pytest.mark.asyncio
async def test_gdrive_find_missing_start_point(gdrive_ws):
    """A missing start point yields nothing.

    GNU names it and exits 1, which mirage only does where a backend
    wires a stat cheap enough to spend on every result. gdrive does not,
    so absence stays silent here.
    """
    r = await gdrive_ws.shell("find /gd/nope")
    assert (await r.stdout_str()) == ""
    assert "401" not in (await r.stderr_str())


async def _dir_with_two(account: GoogleAccount) -> str:
    """A folder ``dir`` holding a.txt and b.txt; b.txt's id."""
    await account.put("dir/a.txt", b"alpha\n")
    return await account.put("dir/b.txt", b"bravo\n")


@pytest.mark.asyncio
async def test_a_stat_that_relists_the_parent_cleans_up_a_dropped_sibling(
    google_account,
):
    # The first read of an expired folder can be a stat of one child; the
    # re-list it warms still has to find the sibling that went away, which
    # it cannot if the old listing is thrown out before warming.
    b_txt = await _dir_with_two(google_account)
    vfs = GoogleDriveVFS(google_account.config(GoogleDriveConfig))
    ws = Workspace({"/gd": vfs}, mode=MountMode.READ)
    try:
        await ws.shell("ls /gd/dir")
        cat = await ws.shell("cat /gd/dir/b.txt")
        assert await cat.stdout_str() == "bravo\n"
        await ws.namespace.set_attrs("/gd/dir/b.txt", mode=0o600)
        assert await ws.cache.exists("/gd/dir/b.txt")
        await google_account.delete(b_txt)
        await ws._registry.mount_for("/gd/dir").index.invalidate()
        stat = await ws.shell("stat -c %n /gd/dir/a.txt")
        assert await stat.stdout_str() == "/gd/dir/a.txt\n"
        assert ws.namespace.meta_for("/gd/dir/b.txt") is None
        assert not await ws.cache.exists("/gd/dir/b.txt")
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_under_fresh_a_stat_relists_and_cleans_up_a_dropped_sibling(
    google_account,
):
    # Under fresh the next command re-lists on its own; its first read is
    # a stat of a sibling, and that re-list still has to find b.txt gone.
    b_txt = await _dir_with_two(google_account)
    vfs = GoogleDriveVFS(google_account.config(GoogleDriveConfig))
    ws = Workspace(
        {"/gd": vfs},
        mode=MountMode.READ,
        read=ReadSpec(policy=ReadPolicy.FRESH),
    )
    try:
        await ws.shell("ls /gd/dir")
        cat = await ws.shell("cat /gd/dir/b.txt")
        assert await cat.stdout_str() == "bravo\n"
        await ws.namespace.set_attrs("/gd/dir/b.txt", mode=0o600)
        await google_account.delete(b_txt)
        stat = await ws.shell("stat -c %n /gd/dir/a.txt")
        assert await stat.stdout_str() == "/gd/dir/a.txt\n"
        assert ws.namespace.meta_for("/gd/dir/b.txt") is None
        assert not await ws.cache.exists("/gd/dir/b.txt")
    finally:
        await ws.close()
