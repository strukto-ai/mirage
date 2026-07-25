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

import os

import pytest

from mirage.resource.disk import DiskResource
from mirage.resource.ram import RAMResource
from mirage.types import MountMode, PathSpec
from mirage.workspace import Workspace
from mirage.workspace.executor.builtins.metadata import (parse_group,
                                                         parse_owner,
                                                         parse_touch_stamp)


def test_parse_owner_forms():
    assert parse_owner("1000:staff") == (1000, "staff")
    assert parse_owner("alice") == ("alice", None)
    assert parse_owner(":dev") == (None, "dev")
    assert parse_owner("500:501") == (500, 501)


def test_parse_group_forms():
    assert parse_group("staff") == "staff"
    assert parse_group("20") == 20
    assert parse_group("") is None


def test_parse_touch_stamp_posix():
    assert parse_touch_stamp("202601021530",
                             None) == "2026-01-02T15:30:00+00:00"
    assert parse_touch_stamp("202601021530.45",
                             None) == "2026-01-02T15:30:45+00:00"


def test_parse_touch_stamp_two_digit_year():
    assert parse_touch_stamp("2601021530", None).startswith("2026-")
    assert parse_touch_stamp("9901021530", None).startswith("1999-")


def test_parse_touch_stamp_date_string():
    assert parse_touch_stamp(None, "2026-01-02") == "2026-01-02T00:00:00+00:00"
    assert parse_touch_stamp(None, None) is None


def test_parse_touch_stamp_invalid():
    with pytest.raises(ValueError):
        parse_touch_stamp("13011200", "")
    with pytest.raises(ValueError):
        parse_touch_stamp("2026010215301", None)
    with pytest.raises(ValueError):
        parse_touch_stamp("202601021530.5", None)


class _OverlayRAMResource(RAMResource):
    """RAM resource with the native setattr op stripped, standing in for
    an API backend that has no attribute slot."""

    def __init__(self) -> None:
        super().__init__()
        self._ops_list = [ro for ro in self._ops_list if ro.name != "setattr"]


class _StatOnlyRAMResource(RAMResource):
    """RAM resource stripped of write-shaped ops, standing in for an API
    backend that can stat but never create files."""

    def __init__(self) -> None:
        super().__init__()
        self._ops_list = [
            ro for ro in self._ops_list if ro.name not in {"setattr", "write"}
        ]


def _make_overlay_ws(
        files: dict[str, bytes]) -> tuple[Workspace, _OverlayRAMResource]:
    resource = _OverlayRAMResource()
    resource._store.files.update(files)
    ws = Workspace({"/data/": (resource, MountMode.WRITE)},
                   mode=MountMode.WRITE)
    return ws, resource


async def _stat_mode(ws: Workspace, path: str) -> int | None:
    st, _ = await ws.dispatch("stat", PathSpec.from_str_path(path))
    return st.mode


def _make_ws(mode: MountMode = MountMode.WRITE) -> Workspace:
    resource = RAMResource()
    resource._store.files["/f.txt"] = b"hello"
    return Workspace({"/data/": (resource, mode)}, mode=MountMode.WRITE)


async def _run(ws: Workspace, cmd: str) -> tuple[int, str, str]:
    r = await ws.execute(cmd)
    return r.exit_code, await r.stdout_str(), await r.stderr_str()


@pytest.mark.asyncio
async def test_chmod_renders_in_ls_long():
    ws = _make_ws()
    code, _, _ = await _run(ws, "chmod 601 /data/f.txt")
    assert code == 0
    _, out, _ = await _run(ws, "ls -l /data")
    assert "-rw------x" in out


@pytest.mark.asyncio
async def test_chmod_symbolic_uses_current_mode():
    ws = _make_ws()
    await _run(ws, "chmod 644 /data/f.txt")
    await _run(ws, "chmod u+x /data/f.txt")
    _, out, _ = await _run(ws, "ls -l /data")
    assert "-rwxr--r--" in out


@pytest.mark.asyncio
async def test_chmod_bad_mode_fails_without_touching_files():
    ws = _make_ws()
    code, _, err = await _run(ws, "chmod zz /data/f.txt")
    assert code == 1
    assert "invalid mode" in err


@pytest.mark.asyncio
async def test_chmod_missing_file_reports_enoent():
    ws = _make_ws()
    code, _, err = await _run(ws, "chmod 644 /data/nope.txt")
    assert code == 1
    assert "nope.txt" in err


@pytest.mark.asyncio
async def test_chown_renders_owner_and_group():
    ws = _make_ws()
    code, _, _ = await _run(ws, "chown 500:dev /data/f.txt")
    assert code == 0
    _, out, _ = await _run(ws, "ls -l /data")
    assert " 500 dev " in out


@pytest.mark.asyncio
async def test_chgrp_renders_group_keeps_default_owner():
    ws = _make_ws()
    code, _, err = await _run(ws, "chgrp staff /data/f.txt")
    assert code == 0, err
    _, out, _ = await _run(ws, "ls -l /data")
    assert " user staff " in out


@pytest.mark.asyncio
async def test_chgrp_changes_only_group_keeping_chown_owner():
    ws = _make_ws()
    await _run(ws, "chown alice:devs /data/f.txt")
    code, _, err = await _run(ws, "chgrp 20 /data/f.txt")
    assert code == 0, err
    _, out, _ = await _run(ws, "ls -l /data")
    assert " alice 20 " in out


@pytest.mark.asyncio
async def test_chgrp_error_shapes():
    ws = _make_ws()
    assert (await _run(ws, "chgrp staff"))[0] == 2
    assert (await _run(ws, "chgrp '' /data/f.txt"))[0] == 1
    assert (await _run(ws, "chgrp -R staff /data"))[0] == 2
    code, _, err = await _run(ws, "chgrp staff /data/nope.txt")
    assert code == 1
    assert "nope.txt" in err


@pytest.mark.asyncio
async def test_chgrp_h_targets_link_not_target():
    ws = _make_ws()
    await _run(ws, "ln -s /data/f.txt /data/link")
    code, _, err = await _run(ws, "chgrp -h ops /data/link")
    assert code == 0, err
    # stat follows the link; -h wrote the link node, so the target is clean.
    st, _ = await ws.dispatch("stat", PathSpec.from_str_path("/data/f.txt"))
    assert st.gid is None


@pytest.mark.asyncio
async def test_chgrp_refuses_read_only_mount():
    ws = _make_ws(MountMode.READ)
    code, _, err = await _run(ws, "chgrp staff /data/f.txt")
    assert code == 1
    assert "read-only mount" in err


@pytest.mark.asyncio
async def test_chgrp_overlay_fallback_writes_only_gid():
    resource = _OverlayRAMResource()
    resource._store.files["/f.txt"] = b"hello"
    ws = Workspace({"/data/": (resource, MountMode.WRITE)},
                   mode=MountMode.WRITE)
    code, _, _ = await _run(ws, "chgrp dev /data/f.txt")
    assert code == 0
    assert resource._store.attrs == {}
    st, _ = await ws.dispatch("stat", PathSpec.from_str_path("/data/f.txt"))
    assert st.gid == "dev"
    assert st.uid is None


@pytest.mark.asyncio
async def test_touch_sets_mtime():
    ws = _make_ws()
    code, _, _ = await _run(ws, "touch -t 202603041200 /data/f.txt")
    assert code == 0
    _, out, _ = await _run(ws, "ls -l /data")
    assert "Mar  4 12:00" in out


@pytest.mark.asyncio
async def test_touch_creates_missing_file():
    ws = _make_ws()
    code, _, _ = await _run(ws, "touch /data/new.txt")
    assert code == 0
    _, out, _ = await _run(ws, "ls /data")
    assert "new.txt" in out


@pytest.mark.asyncio
async def test_touch_no_create_flag():
    ws = _make_ws()
    code, _, _ = await _run(ws, "touch -c /data/ghost.txt")
    assert code == 0
    _, out, _ = await _run(ws, "ls /data")
    assert "ghost.txt" not in out


@pytest.mark.asyncio
async def test_chmod_follows_symlink():
    ws = _make_ws()
    await _run(ws, "ln -s /data/f.txt /data/link")
    await _run(ws, "chmod 640 /data/link")
    _, out, _ = await _run(ws, "ls -l /data")
    assert "-rw-r----- 1 user user 5" in out


@pytest.mark.asyncio
async def test_metadata_commands_respect_read_only_mount():
    ws = _make_ws(MountMode.READ)
    for cmd in ("chmod 644 /data/f.txt", "chown alice /data/f.txt",
                "touch /data/f.txt"):
        code, _, err = await _run(ws, cmd)
        assert code == 1
        assert "read-only mount" in err


@pytest.mark.asyncio
async def test_touch_cannot_create_on_stat_only_mount():
    resource = _StatOnlyRAMResource()
    resource._store.files["/f.txt"] = b"hello"
    ws = Workspace({"/data/": (resource, MountMode.WRITE)},
                   mode=MountMode.WRITE)
    code, _, err = await _run(ws, "touch /data/new.txt")
    assert code == 1
    assert "cannot touch '/data/new.txt': Read-only file system" in err
    _, out, _ = await _run(ws, "ls /data")
    assert "new.txt" not in out


@pytest.mark.asyncio
async def test_touch_stat_only_mount_existing_file_uses_overlay():
    resource = _StatOnlyRAMResource()
    resource._store.files["/f.txt"] = b"hello"
    ws = Workspace({"/data/": (resource, MountMode.WRITE)},
                   mode=MountMode.WRITE)
    code, _, _ = await _run(ws, "touch -t 202603041200 /data/f.txt")
    assert code == 0
    st, _ = await ws.dispatch("stat", PathSpec.from_str_path("/data/f.txt"))
    assert st.modified == "2026-03-04T12:00:00Z"


@pytest.mark.asyncio
async def test_chmod_symbolic_directory_base_is_755():
    ws, _ = _make_overlay_ws({})
    await _run(ws, "mkdir /data/sub")
    code, _, err = await _run(ws, "chmod g+w /data/sub")
    assert code == 0, err
    assert await _stat_mode(ws, "/data/sub") == 0o775


@pytest.mark.asyncio
async def test_touch_r_relative_reference_resolves_against_cwd():
    ws = _make_ws()
    await _run(ws, "touch -t 202603041200 /data/f.txt")
    code, _, err = await _run(ws, "cd /data && touch -r f.txt new.txt")
    assert code == 0, err
    _, out, _ = await _run(ws, "ls -l /data")
    assert out.count("Mar  4 12:00") == 2


@pytest.mark.asyncio
async def test_write_clears_overlay_times_but_keeps_mode():
    ws, _ = _make_overlay_ws({"/f.txt": b"hello"})
    await _run(ws, "chmod 601 /data/f.txt")
    await _run(ws, "touch -t 202603041200 /data/f.txt")
    code, _, _ = await _run(ws, "echo more >> /data/f.txt")
    assert code == 0
    st, _ = await ws.dispatch("stat", PathSpec.from_str_path("/data/f.txt"))
    assert st.modified != "2026-03-04T12:00:00Z"
    assert st.mode == 0o601


@pytest.mark.asyncio
async def test_mv_replacing_file_drops_destination_meta():
    ws, _ = _make_overlay_ws({"/src.txt": b"new", "/dst.txt": b"old"})
    await _run(ws, "chmod 601 /data/dst.txt")
    code, _, err = await _run(ws, "mv /data/src.txt /data/dst.txt")
    assert code == 0, err
    assert await _stat_mode(ws, "/data/dst.txt") is None


@pytest.mark.asyncio
async def test_mv_carries_source_meta_over_destination_meta():
    ws, _ = _make_overlay_ws({"/src.txt": b"new", "/dst.txt": b"old"})
    await _run(ws, "chmod 601 /data/dst.txt")
    await _run(ws, "chmod 640 /data/src.txt")
    code, _, err = await _run(ws, "mv /data/src.txt /data/dst.txt")
    assert code == 0, err
    assert await _stat_mode(ws, "/data/dst.txt") == 0o640


@pytest.mark.asyncio
async def test_mv_into_linked_dir_keys_meta_under_real_path():
    ws, _ = _make_overlay_ws({"/f.txt": b"hi"})
    await _run(ws, "mkdir /data/sub")
    await _run(ws, "chmod 601 /data/f.txt")
    await _run(ws, "ln -s /data/sub /data/lnk")
    code, _, err = await _run(ws, "mv /data/f.txt /data/lnk")
    assert code == 0, err
    assert await _stat_mode(ws, "/data/sub/f.txt") == 0o601


@pytest.mark.asyncio
async def test_glob_rm_drops_meta_of_expanded_files():
    ws, _ = _make_overlay_ws({"/f.txt": b"hello"})
    await _run(ws, "chmod 601 /data/f.txt")
    code, _, err = await _run(ws, "rm /data/*.txt")
    assert code == 0, err
    await _run(ws, "echo hi > /data/f.txt")
    assert await _stat_mode(ws, "/data/f.txt") is None


@pytest.mark.asyncio
async def test_overlay_fallback_when_mount_has_no_setattr():
    resource = _OverlayRAMResource()
    resource._store.files["/f.txt"] = b"hello"
    ws = Workspace({"/data/": (resource, MountMode.WRITE)},
                   mode=MountMode.WRITE)
    code, _, _ = await _run(
        ws, "chmod 601 /data/f.txt && chown 500:dev /data/f.txt"
        " && touch -t 202603041200 /data/f.txt")
    assert code == 0
    assert resource._store.attrs == {}
    st, _ = await ws.dispatch("stat", PathSpec.from_str_path("/data/f.txt"))
    assert st.mode == 0o601
    assert st.uid == 500
    assert st.gid == "dev"
    assert st.modified == "2026-03-04T12:00:00Z"


@pytest.mark.asyncio
async def test_overlay_attrs_render_in_ls_long():
    # ls stats through the backend, which has no attribute slot here; the
    # injected namespace overlay must still render chmod/chown/touch.
    ws, _ = _make_overlay_ws({"/f.txt": b"hello"})
    await _run(
        ws, "chmod 664 /data/f.txt && chown 500:dev /data/f.txt"
        " && touch -t 202603041200 /data/f.txt")
    _, out, _ = await _run(ws, "ls -l /data")
    assert "-rw-rw-r--" in out
    assert " 500 dev " in out
    assert "Mar  4 12:00" in out


def _make_disk_ws(root) -> Workspace:
    (root / "f.txt").write_bytes(b"hello")
    return Workspace(
        {"/data/": (DiskResource(root=str(root)), MountMode.WRITE)},
        mode=MountMode.WRITE)


@pytest.mark.asyncio
async def test_disk_chmod_000_shows_zero_keeps_owner_access(tmp_path):
    ws = _make_disk_ws(tmp_path)
    code, _, _ = await _run(ws, "chmod 000 /data/f.txt")
    assert code == 0
    _, out, _ = await _run(ws, "ls -l /data")
    assert "----------" in out
    assert os.stat(tmp_path / "f.txt").st_mode & 0o777 == 0o600
    code, out, _ = await _run(ws, "cat /data/f.txt")
    assert code == 0 and out == "hello"


@pytest.mark.asyncio
async def test_disk_chmod_relax_drops_stale_residual(tmp_path):
    ws = _make_disk_ws(tmp_path)
    await _run(ws, "chmod 000 /data/f.txt")
    await _run(ws, "chmod 644 /data/f.txt")
    assert await _stat_mode(ws, "/data/f.txt") == 0o644
    assert ws._namespace.meta_for("/data/f.txt") is None


@pytest.mark.asyncio
async def test_disk_external_chmod_visible(tmp_path):
    ws = _make_disk_ws(tmp_path)
    os.chmod(tmp_path / "f.txt", 0o640)
    _, out, _ = await _run(ws, "ls -l /data")
    assert "-rw-r-----" in out
    assert await _stat_mode(ws, "/data/f.txt") == 0o640


@pytest.mark.asyncio
async def test_disk_chown_overlays_and_renders(tmp_path):
    ws = _make_disk_ws(tmp_path)
    code, _, _ = await _run(ws, "chown 500:dev /data/f.txt")
    assert code == 0
    _, out, _ = await _run(ws, "ls -l /data")
    assert " 500 dev " in out
    st, _ = await ws.dispatch("stat", PathSpec.from_str_path("/data/f.txt"))
    assert st.uid == 500
    assert st.gid == "dev"


@pytest.mark.asyncio
async def test_disk_mv_carries_clamped_mode(tmp_path):
    # chmod 000 clamps the inode to 600 and stores 0 in the overlay; mv must
    # carry the overlay to the new path while the OS rename moves the inode.
    ws = _make_disk_ws(tmp_path)
    await _run(ws, "chmod 000 /data/f.txt")
    code, _, err = await _run(ws, "mv /data/f.txt /data/g.txt")
    assert code == 0, err
    _, out, _ = await _run(ws, "ls -l /data")
    assert "----------" in out
    assert os.stat(os.path.join(tmp_path, "g.txt")).st_mode & 0o777 == 0o600
