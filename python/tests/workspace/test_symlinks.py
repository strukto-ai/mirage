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

from mirage import MountMode, Workspace
from mirage.resource.ram import RAMResource


def _make_ws():
    resource = RAMResource()
    store = resource._store
    store.dirs.add("/")
    store.dirs.add("/sub")
    store.files["/target.txt"] = b"hello\n"
    store.modified["/target.txt"] = "2024-01-01"
    store.files["/sub/deep.txt"] = b"deep\n"
    store.modified["/sub/deep.txt"] = "2024-01-01"
    return Workspace({"/ram/": resource}, mode=MountMode.WRITE)


@pytest.mark.asyncio
async def test_ln_s_then_readlink():
    ws = _make_ws()
    r = await ws.execute(
        "ln -s /ram/target.txt /ram/link && readlink /ram/link")
    assert (await r.stdout_str()).strip() == "/ram/target.txt"
    assert r.exit_code == 0


@pytest.mark.asyncio
async def test_readlink_non_link_exit1_no_output():
    ws = _make_ws()
    r = await ws.execute("readlink /ram/target.txt")
    assert r.exit_code == 1
    assert (await r.stdout_str()) == ""


@pytest.mark.asyncio
async def test_readlink_returns_verbatim_relative_target():
    ws = _make_ws()
    r = await ws.execute(
        "ln -s deep.txt /ram/sub/dlink && readlink /ram/sub/dlink")
    assert (await r.stdout_str()).strip() == "deep.txt"


@pytest.mark.asyncio
async def test_cd_relative_symlink_resolves_against_link_dir():
    ws = _make_ws()
    r = await ws.execute("ln -s sub /ram/rlink && cd /ram/rlink && pwd")
    assert (await r.stdout_str()).strip() == "/ram/sub"


@pytest.mark.asyncio
async def test_ln_s_existing_link_without_f_errors():
    ws = _make_ws()
    r = await ws.execute(
        "ln -s /ram/target.txt /ram/link && ln -s /ram/sub /ram/link")
    assert r.exit_code == 1
    assert "File exists" in await r.stderr_str()


@pytest.mark.asyncio
async def test_ln_sf_overwrites():
    ws = _make_ws()
    r = await ws.execute(
        "ln -s /ram/target.txt /ram/link && ln -sf /ram/sub /ram/link "
        "&& readlink /ram/link")
    assert (await r.stdout_str()).strip() == "/ram/sub"
    assert r.exit_code == 0


@pytest.mark.asyncio
async def test_ln_s_missing_operand_errors():
    ws = _make_ws()
    r = await ws.execute("ln -s /ram/target.txt")
    assert r.exit_code != 0


@pytest.mark.asyncio
async def test_ln_s_in_subshell_persists():
    ws = _make_ws()
    r = await ws.execute(
        "(ln -s /ram/target.txt /ram/link) && readlink /ram/link")
    assert (await r.stdout_str()).strip() == "/ram/target.txt"


def _make_tree():
    resource = RAMResource()
    store = resource._store
    for d in ("/", "/a", "/x", "/x/y"):
        store.dirs.add(d)
    store.files["/x/y/f.txt"] = b"deep\n"
    store.modified["/x/y/f.txt"] = "2024-01-01"
    return Workspace({"/ram/": resource}, mode=MountMode.WRITE)


@pytest.mark.asyncio
async def test_cd_through_symlink_resolves():
    ws = _make_tree()
    r = await ws.execute("ln -s /ram/x/y /ram/a/b && cd /ram/a/b && pwd")
    assert (await r.stdout_str()).strip() == "/ram/x/y"


@pytest.mark.asyncio
async def test_cd_logical_dotdot_after_symlink():
    ws = _make_tree()
    r = await ws.execute(
        "ln -s /ram/x/y /ram/a/b && cd /ram && cd a/b/.. && pwd")
    assert (await r.stdout_str()).strip() == "/ram/a"


@pytest.mark.asyncio
async def test_cd_physical_dotdot_after_symlink():
    ws = _make_tree()
    r = await ws.execute(
        "ln -s /ram/x/y /ram/a/b && cd /ram && cd -P a/b/.. && pwd")
    assert (await r.stdout_str()).strip() == "/ram/x"


@pytest.mark.asyncio
async def test_cd_symlink_cycle_eloop():
    ws = _make_tree()
    r = await ws.execute(
        "ln -s /ram/loop2 /ram/loop && ln -s /ram/loop /ram/loop2 "
        "&& cd /ram/loop")
    assert r.exit_code == 1
    assert "Too many levels of symbolic links" in await r.stderr_str()


@pytest.mark.asyncio
async def test_symlink_survives_snapshot_round_trip(tmp_path):
    ws = _make_ws()
    await ws.execute("ln -s /ram/target.txt /ram/link")
    snap = tmp_path / "sym.tar"
    await ws.snapshot(snap)
    dst = await Workspace.load(snap)
    r = await dst.execute("readlink /ram/link")
    assert (await r.stdout_str()).strip() == "/ram/target.txt"
    assert r.exit_code == 0
