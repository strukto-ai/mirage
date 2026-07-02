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

from mirage.resource.ram import RAMResource
from mirage.types import MountMode
from mirage.workspace import Workspace


def _ws():
    return Workspace({"/data": (RAMResource(), MountMode.WRITE)},
                     mode=MountMode.WRITE)


@pytest.mark.asyncio
async def test_ln_readlink_verbatim():
    ws = _ws()
    await ws.execute("echo hi > /data/a.txt")
    r = await ws.execute("ln -s /data/a.txt /data/link.txt")
    assert r.exit_code == 0
    r = await ws.execute("readlink /data/link.txt")
    assert r.stdout.decode() == "/data/a.txt\n"


@pytest.mark.asyncio
async def test_ln_relative_target_kept_verbatim():
    ws = _ws()
    await ws.execute("echo hi > /data/a.txt")
    await ws.execute("ln -s a.txt /data/link.txt")
    r = await ws.execute("readlink /data/link.txt")
    assert r.stdout.decode() == "a.txt\n"


@pytest.mark.asyncio
async def test_ln_sf_overwrites():
    ws = _ws()
    await ws.execute("echo a > /data/a.txt")
    await ws.execute("echo b > /data/b.txt")
    await ws.execute("ln -s /data/a.txt /data/link.txt")
    await ws.execute("ln -s -f /data/b.txt /data/link.txt")
    r = await ws.execute("readlink /data/link.txt")
    assert r.stdout.decode() == "/data/b.txt\n"


@pytest.mark.asyncio
async def test_ln_no_force_refuses_existing_link():
    ws = _ws()
    await ws.execute("echo a > /data/a.txt")
    await ws.execute("ln -s /data/a.txt /data/link.txt")
    r = await ws.execute("ln -s /data/a.txt /data/link.txt")
    assert r.exit_code == 1
    assert b"File exists" in r.stderr


@pytest.mark.asyncio
async def test_cd_through_symlink():
    ws = _ws()
    await ws.execute("mkdir -p /data/real")
    await ws.execute("ln -s /data/real /data/slink")
    r = await ws.execute("cd /data/slink && pwd")
    assert r.stdout.decode() == "/data/real\n"


@pytest.mark.asyncio
async def test_cd_symlink_loop_is_eloop():
    ws = _ws()
    await ws.execute("ln -s /data/b /data/a")
    await ws.execute("ln -s /data/a /data/b")
    r = await ws.execute("cd /data/a")
    assert r.exit_code == 1
    assert b"Too many levels of symbolic links" in r.stderr


@pytest.mark.asyncio
async def test_symlink_survives_snapshot(tmp_path):
    ws = _ws()
    await ws.execute("echo hi > /data/a.txt")
    await ws.execute("ln -s /data/a.txt /data/link.txt")
    target = str(tmp_path / "snap.tar")
    await ws.snapshot(target)
    ws2 = await Workspace.load(target)
    r = await ws2.execute("readlink /data/link.txt")
    assert r.stdout.decode() == "/data/a.txt\n"


@pytest.mark.asyncio
async def test_cat_follows_link():
    ws = _ws()
    await ws.execute("echo hi > /data/a.txt")
    await ws.execute("ln -s /data/a.txt /data/link.txt")
    r = await ws.execute("cat /data/link.txt")
    assert r.exit_code == 0
    assert r.stdout.decode() == "hi\n"


@pytest.mark.asyncio
async def test_read_follows_midpath_dir_link():
    ws = _ws()
    await ws.execute("mkdir -p /data/real && echo hi > /data/real/f.txt")
    await ws.execute("ln -s /data/real /data/dirlink")
    r = await ws.execute("cat /data/dirlink/f.txt")
    assert r.stdout.decode() == "hi\n"


@pytest.mark.asyncio
async def test_read_follows_relative_target():
    ws = _ws()
    await ws.execute("mkdir -p /data/sub && echo hi > /data/sub/a.txt")
    await ws.execute("ln -s a.txt /data/sub/link.txt")
    r = await ws.execute("cat /data/sub/link.txt")
    assert r.stdout.decode() == "hi\n"


@pytest.mark.asyncio
async def test_write_through_link_updates_target():
    ws = _ws()
    await ws.execute("echo old > /data/a.txt")
    await ws.execute("ln -s /data/a.txt /data/link.txt")
    await ws.execute("echo new > /data/link.txt")
    r = await ws.execute("cat /data/a.txt")
    assert r.stdout.decode() == "new\n"


@pytest.mark.asyncio
async def test_cat_dangling_link_errors_with_typed_name():
    ws = _ws()
    await ws.execute("ln -s /data/missing /data/dangle")
    r = await ws.execute("cat /data/dangle")
    assert r.exit_code == 1
    assert b"/data/dangle" in r.stderr
    assert b"No such file" in r.stderr


@pytest.mark.asyncio
async def test_cat_loop_is_eloop_with_operand():
    ws = _ws()
    await ws.execute("ln -s /data/b /data/a")
    await ws.execute("ln -s /data/a /data/b")
    r = await ws.execute("cat /data/a")
    assert r.exit_code == 1
    assert b"cat: /data/a: Too many levels of symbolic links" in r.stderr


@pytest.mark.asyncio
async def test_ls_lists_links():
    ws = _ws()
    await ws.execute("echo hi > /data/a.txt")
    await ws.execute("ln -s /data/a.txt /data/link.txt")
    r = await ws.execute("ls /data")
    assert "link.txt" in r.stdout.decode()
    r = await ws.execute("ls -F /data")
    assert "link.txt@" in r.stdout.decode()
    r = await ws.execute("ls -l /data")
    assert "link.txt -> /data/a.txt" in r.stdout.decode()


@pytest.mark.asyncio
async def test_ls_through_dir_link():
    ws = _ws()
    await ws.execute("mkdir -p /data/real && echo hi > /data/real/f.txt")
    await ws.execute("ln -s /data/real /data/dirlink")
    r = await ws.execute("ls /data/dirlink")
    assert r.stdout.decode() == "f.txt\n"


@pytest.mark.asyncio
async def test_rm_removes_link_not_target():
    ws = _ws()
    await ws.execute("echo hi > /data/a.txt")
    await ws.execute("ln -s /data/a.txt /data/link.txt")
    r = await ws.execute("rm /data/link.txt")
    assert r.exit_code == 0
    r = await ws.execute("readlink /data/link.txt")
    assert r.exit_code == 1
    r = await ws.execute("cat /data/a.txt")
    assert r.stdout.decode() == "hi\n"


@pytest.mark.asyncio
async def test_rm_dangling_link():
    ws = _ws()
    await ws.execute("ln -s /data/missing /data/dangle")
    r = await ws.execute("rm /data/dangle")
    assert r.exit_code == 0


@pytest.mark.asyncio
async def test_rm_mixed_link_and_file():
    ws = _ws()
    await ws.execute("echo hi > /data/a.txt && echo x > /data/b.txt")
    await ws.execute("ln -s /data/a.txt /data/link.txt")
    r = await ws.execute("rm /data/link.txt /data/b.txt")
    assert r.exit_code == 0
    r = await ws.execute("ls /data")
    assert r.stdout.decode() == "a.txt\n"


@pytest.mark.asyncio
async def test_rm_target_leaves_link_dangling():
    ws = _ws()
    await ws.execute("echo hi > /data/a.txt")
    await ws.execute("ln -s /data/a.txt /data/link.txt")
    await ws.execute("rm /data/a.txt")
    r = await ws.execute("readlink /data/link.txt")
    assert r.stdout.decode() == "/data/a.txt\n"
    r = await ws.execute("cat /data/link.txt")
    assert r.exit_code == 1


@pytest.mark.asyncio
async def test_rm_r_purges_links_under_dir():
    ws = _ws()
    await ws.execute("mkdir -p /data/sub && echo hi > /data/sub/f.txt")
    await ws.execute("ln -s /data/sub/f.txt /data/sub/inner")
    r = await ws.execute("rm -r /data/sub")
    assert r.exit_code == 0
    r = await ws.execute("readlink /data/sub/inner")
    assert r.exit_code == 1


@pytest.mark.asyncio
async def test_mv_renames_link_entry():
    ws = _ws()
    await ws.execute("echo hi > /data/a.txt")
    await ws.execute("ln -s /data/a.txt /data/link.txt")
    r = await ws.execute("mv /data/link.txt /data/renamed.txt")
    assert r.exit_code == 0
    r = await ws.execute("readlink /data/renamed.txt")
    assert r.stdout.decode() == "/data/a.txt\n"
    r = await ws.execute("readlink /data/link.txt")
    assert r.exit_code == 1


@pytest.mark.asyncio
async def test_mv_link_into_existing_dir():
    ws = _ws()
    await ws.execute("mkdir -p /data/dir && echo hi > /data/a.txt")
    await ws.execute("ln -s /data/a.txt /data/link.txt")
    r = await ws.execute("mv /data/link.txt /data/dir")
    assert r.exit_code == 0
    r = await ws.execute("readlink /data/dir/link.txt")
    assert r.stdout.decode() == "/data/a.txt\n"


@pytest.mark.asyncio
async def test_mv_file_onto_link_replaces_entry():
    ws = _ws()
    await ws.execute("echo a > /data/a.txt && echo b > /data/b.txt")
    await ws.execute("ln -s /data/a.txt /data/link.txt")
    r = await ws.execute("mv /data/b.txt /data/link.txt")
    assert r.exit_code == 0
    r = await ws.execute("readlink /data/link.txt")
    assert r.exit_code == 1
    r = await ws.execute("cat /data/link.txt")
    assert r.stdout.decode() == "b\n"
    r = await ws.execute("cat /data/a.txt")
    assert r.stdout.decode() == "a\n"


@pytest.mark.asyncio
async def test_cross_mount_link_follow():
    ws = Workspace(
        {
            "/data": (RAMResource(), MountMode.WRITE),
            "/other": (RAMResource(), MountMode.WRITE),
        },
        mode=MountMode.WRITE)
    await ws.execute("echo remote > /other/g.txt")
    await ws.execute("ln -s /other/g.txt /data/xlink")
    r = await ws.execute("cat /data/xlink")
    assert r.stdout.decode() == "remote\n"


@pytest.mark.asyncio
async def test_cp_follows_source_link():
    ws = _ws()
    await ws.execute("echo hi > /data/a.txt")
    await ws.execute("ln -s /data/a.txt /data/link.txt")
    r = await ws.execute("cp /data/link.txt /data/copy.txt")
    assert r.exit_code == 0
    r = await ws.execute("cat /data/copy.txt")
    assert r.stdout.decode() == "hi\n"


@pytest.mark.asyncio
async def test_grep_follows_link():
    ws = _ws()
    await ws.execute("printf 'alpha\\nbeta\\n' > /data/a.txt")
    await ws.execute("ln -s /data/a.txt /data/link.txt")
    r = await ws.execute("grep beta /data/link.txt")
    assert r.exit_code == 0
    assert "beta" in r.stdout.decode()
