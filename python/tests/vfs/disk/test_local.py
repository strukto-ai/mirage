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

import json
from functools import partial
from pathlib import Path

import pytest

from mirage import MountMode, Workspace
from mirage.commands.builtin.disk.io import IO
from mirage.types import PathSpec
from mirage.vfs.disk.disk import DiskVFS


@pytest.fixture
def local_backend(tmp_path):
    return DiskVFS(str(tmp_path))


@pytest.fixture
def ws(tmp_path):
    vfs = DiskVFS(str(tmp_path))
    return Workspace({"/data": vfs}, mode=MountMode.WRITE)


@pytest.mark.asyncio
async def test_create_and_cat(ws):
    await ws.shell('echo "hello" | tee /data/hello.txt')
    result = await ws.shell("cat /data/hello.txt")
    assert b"hello" in result.stdout


@pytest.mark.asyncio
async def test_mkdir_and_ls(ws):
    await ws.shell("mkdir /data/mydir")
    result = await ws.shell("ls /data/")
    assert b"mydir" in result.stdout


@pytest.mark.asyncio
async def test_rm(ws):
    await ws.shell('echo "x" | tee /data/del.txt')
    await ws.shell("rm /data/del.txt")
    result = await ws.shell("stat /data/del.txt")
    assert result.exit_code != 0


@pytest.mark.asyncio
async def test_stat_file(ws):
    await ws.shell('echo "hello" | tee /data/f.txt')
    result = await ws.shell("stat /data/f.txt")
    assert result.exit_code == 0
    assert b"File: /data/f.txt" in result.stdout


@pytest.mark.asyncio
async def test_stat_directory(ws):
    await ws.shell("mkdir /data/mydir")
    result = await ws.shell("stat /data/mydir")
    assert result.exit_code == 0
    assert b"directory" in result.stdout


@pytest.mark.asyncio
async def test_stat_missing_raises(ws):
    result = await ws.shell("stat /data/missing.txt")
    assert result.exit_code != 0


@pytest.mark.asyncio
async def test_path_traversal_raises(local_backend):
    from mirage.core.disk.stat import stat as core_stat
    from mirage.types import PathSpec

    with pytest.raises(ValueError):
        await core_stat(
            local_backend.accessor,
            PathSpec(
                vfs_path="../etc/passwd",
                virtual="/../etc/passwd",
                directory="/../etc/passwd",
            ),
        )


@pytest.mark.asyncio
async def test_get_state_preserves_file_mode(tmp_path):
    src = DiskVFS(str(tmp_path / "src"))
    ws = Workspace({"/data": src}, mode=MountMode.WRITE)
    await ws.shell("echo hi > /data/f.txt && chmod 640 /data/f.txt")
    state = src.get_state()
    assert state["modes"]["f.txt"] == 0o640

    dst = DiskVFS(str(tmp_path / "dst"))
    dst.load_state(state)
    assert (tmp_path / "dst" / "f.txt").stat().st_mode & 0o777 == 0o640


def test_get_state_leaves_host_symlinks_out(tmp_path):
    root = tmp_path / "root"
    root.mkdir()
    (root / "f.txt").write_text("hi")
    (tmp_path / "secret.txt").write_text("host bytes")
    (root / "link").symlink_to(tmp_path / "secret.txt")
    assert set(DiskVFS(str(root)).get_state()["files"]) == {"f.txt"}


@pytest.fixture
def host_tree(tmp_path):
    fixture = json.loads(
        (
            Path(__file__).resolve().parents[4]
            / "integ/fixtures/disk/host-links.json"
        ).read_text()
    )
    for relative, text in fixture["files"].items():
        p = tmp_path / relative
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text)
    for relative in fixture["directories"]:
        (tmp_path / relative).mkdir(parents=True, exist_ok=True)
    for relative, target in fixture["symlinks"].items():
        (tmp_path / relative).symlink_to(target)
    return DiskVFS(str(tmp_path / "root")), fixture


@pytest.mark.asyncio
async def test_host_link_contract(host_tree):
    vfs, fixture = host_tree
    root = PathSpec.from_str_path("/")
    assert sorted(vfs.get_state()["files"]) == fixture["visible_files"]
    assert await IO.find(vfs.accessor, root, type="f") == [
        "/" + p for p in fixture["visible_files"]
    ]
    assert await IO.du.size(vfs.accessor, root) == 13
    for path in fixture["hidden_paths"]:
        spec = PathSpec.from_str_path(path)
        assert not await IO.exists(vfs.accessor, spec)
        with pytest.raises(FileNotFoundError):
            await IO.read_bytes(vfs.accessor, spec)
        with pytest.raises(FileNotFoundError):
            await IO.write(vfs.accessor, spec, b"changed")
    assert (vfs.root.parent / "outside/secret.txt").read_text() == "outside\n"


@pytest.mark.asyncio
async def test_copy_requires_an_exact_destination(host_tree):
    vfs, _ = host_tree
    with pytest.raises(IsADirectoryError):
        await IO.copy(
            vfs.accessor,
            PathSpec.from_str_path("/plain.txt"),
            PathSpec.from_str_path("/destination"),
        )
    assert (vfs.root.parent / "outside/secret.txt").read_text() == "outside\n"


@pytest.mark.parametrize(
    "relative",
    [
        "escape",
        "escape-dir/secret.txt",
        "destination/plain.txt",
        "../outside/secret.txt",
    ],
)
def test_restore_refuses_host_links_and_escape_keys(host_tree, relative):
    vfs, _ = host_tree
    outside = vfs.root.parent / "outside/secret.txt"
    before = outside.stat().st_mode
    with pytest.raises((FileNotFoundError, ValueError)):
        vfs.load_state(
            {"files": {relative: b"changed"}, "modes": {relative: 0o600}}
        )
    assert outside.stat().st_mode == before
    assert outside.read_text() == "outside\n"


def test_restore_refuses_absolute_keys(host_tree):
    vfs, _ = host_tree
    outside = vfs.root.parent / "outside/secret.txt"
    with pytest.raises(ValueError):
        vfs.load_state({"files": {str(outside): b"changed"}})
    assert outside.read_text() == "outside\n"


def test_snapshot_does_not_stat_an_unreadable_link_target(host_tree):
    vfs, fixture = host_tree
    outside = vfs.root.parent / "outside"
    outside.chmod(0)
    try:
        assert sorted(vfs.get_state()["files"]) == fixture["visible_files"]
    finally:
        outside.chmod(0o700)


@pytest.mark.asyncio
async def test_unreadable_tree_is_not_absent_or_empty(host_tree):
    vfs, _ = host_tree
    directory = vfs.root / "lib"
    directory.chmod(0)
    try:
        operations = (
            (IO.exists, "lib/a.txt"),
            (IO.find, "lib"),
            (IO.du.size, "lib"),
            (IO.readdir, "lib"),
        )
        for operation, key in operations:
            operand = PathSpec.from_str_path("/data/" + key, key)
            with pytest.raises(PermissionError) as caught:
                await partial(operation, vfs.accessor)(operand)
            assert caught.value.filename == operand.virtual
    finally:
        directory.chmod(0o700)


def test_restore_creates_missing_parents_and_applies_modes(host_tree):
    vfs, _ = host_tree
    vfs.load_state(
        {
            "files": {"new/deep/file": b"restored"},
            "modes": {"new/deep/file": 0o640},
        }
    )
    target = vfs.root / "new/deep/file"
    assert target.read_bytes() == b"restored"
    assert target.stat().st_mode & 0o777 == 0o640


@pytest.mark.asyncio
async def test_root_alias_keeps_the_same_visible_tree(host_tree):
    vfs, fixture = host_tree
    alias = vfs.root.parent / "alias"
    alias.symlink_to(vfs.root)
    mounted = DiskVFS(str(alias))
    assert (
        await IO.du.size(mounted.accessor, PathSpec.from_str_path("/")) == 13
    )
    assert sorted(mounted.get_state()["files"]) == fixture["visible_files"]


def test_get_state_names_files_by_path_not_bytes(tmp_path):
    root = tmp_path / "root"
    root.mkdir()
    (root / "f.txt").write_text("hi")
    files = DiskVFS(str(root)).get_state()["files"]
    assert files == {"f.txt": root / "f.txt"}


def test_load_state_copies_paths_and_leaves_the_same_file(tmp_path):
    src = tmp_path / "src"
    src.mkdir()
    (src / "a.txt").write_text("from a path")
    dst = DiskVFS(str(tmp_path / "dst"))
    dst.load_state({"files": {"a.txt": src / "a.txt", "b.txt": b"bytes"}})
    assert (tmp_path / "dst" / "a.txt").read_text() == "from a path"
    assert (tmp_path / "dst" / "b.txt").read_bytes() == b"bytes"
    same = DiskVFS(str(src))
    same.load_state(same.get_state())
    assert (src / "a.txt").read_text() == "from a path"


@pytest.mark.asyncio
async def test_snapshot_round_trip_streams_disk_files(tmp_path, monkeypatch):
    src = DiskVFS(str(tmp_path / "src"))
    ws = Workspace({"/data": src}, mode=MountMode.WRITE)
    await ws.shell("echo kept > /data/f.txt")
    target = tmp_path / "ws.tar"

    def no_whole_reads(self):
        raise AssertionError(f"read whole: {self}")

    monkeypatch.setattr(Path, "read_bytes", no_whole_reads)
    await ws.snapshot(str(target))
    loaded = await Workspace.load(str(target))
    monkeypatch.undo()
    io = await loaded.shell("cat /data/f.txt")
    assert await io.stdout_str() == "kept\n"
    await ws.close()
    await loaded.close()
