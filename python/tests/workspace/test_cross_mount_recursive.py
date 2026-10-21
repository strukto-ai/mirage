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

from mirage.types import MountMode
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace
from tests.fixtures.vfs_io import run_text

pytestmark = pytest.mark.asyncio


def _make_ws():
    src = RAMVFS()
    dst = RAMVFS()
    src._store.dirs.update({"/dir", "/dir/sub", "/dir/empty"})
    src._store.files["/dir/a.txt"] = b"aaa\n"
    src._store.files["/dir/sub/b.txt"] = b"bbb\n"
    ws = Workspace(
        {
            "/a": (src, MountMode.WRITE),
            "/b": (dst, MountMode.WRITE),
        },
    )
    return ws, src, dst


async def test_cp_recursive_copies_tree():
    ws, _src, dst = _make_ws()
    code, _out, _err = await run_text(ws, "cp -r /a/dir /b/copied")
    assert code == 0
    assert dst._store.files["/copied/a.txt"] == b"aaa\n"
    assert dst._store.files["/copied/sub/b.txt"] == b"bbb\n"
    assert "/copied/sub" in dst._store.dirs
    assert "/copied/empty" in dst._store.dirs


async def test_cp_recursive_into_existing_dir():
    ws, _src, dst = _make_ws()
    dst._store.dirs.add("/into")
    code, _out, _err = await run_text(ws, "cp -r /a/dir /b/into")
    assert code == 0
    assert dst._store.files["/into/dir/a.txt"] == b"aaa\n"
    assert dst._store.files["/into/dir/sub/b.txt"] == b"bbb\n"


async def test_cp_directory_without_recursive_fails():
    ws, _src, dst = _make_ws()
    code, _out, err = await run_text(ws, "cp /a/dir /b/copied")
    assert code == 1
    assert "omitting directory" in err
    assert "/copied" not in dst._store.dirs
    assert not any(k.startswith("/copied") for k in dst._store.files)


async def test_mv_recursive_moves_tree_and_removes_source():
    ws, src, dst = _make_ws()
    code, _out, _err = await run_text(ws, "mv /a/dir /b/moved")
    assert code == 0
    assert dst._store.files["/moved/a.txt"] == b"aaa\n"
    assert dst._store.files["/moved/sub/b.txt"] == b"bbb\n"
    assert "/dir" not in src._store.dirs
    assert "/dir/a.txt" not in src._store.files
    assert "/dir/sub/b.txt" not in src._store.files


async def test_cp_recursive_no_clobber_skips_existing():
    # /b/into exists, so `cp -r /a/dir /b/into` maps to /b/into/dir. Pre-seed
    # that mapped tree with an existing a.txt so -n must skip it.
    ws, _src, dst = _make_ws()
    dst._store.dirs.update({"/into", "/into/dir"})
    dst._store.files["/into/dir/a.txt"] = b"keep\n"
    code, _out, _err = await run_text(ws, "cp -rn /a/dir /b/into")
    assert code == 0
    assert dst._store.files["/into/dir/a.txt"] == b"keep\n"
    assert dst._store.files["/into/dir/sub/b.txt"] == b"bbb\n"
