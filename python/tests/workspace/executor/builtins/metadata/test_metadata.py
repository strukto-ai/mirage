import os

import pytest

from mirage.resource.disk import DiskResource
from mirage.resource.ram import RAMResource
from mirage.types import MountMode, PathSpec
from mirage.workspace import Workspace
from mirage.workspace.executor.builtins.metadata import (parse_group,
                                                         parse_owner,
                                                         parse_touch_stamp)


class _OverlayRAMResource(RAMResource):
    """RAM resource with the native setattr op stripped, standing in for
    an API backend that has no attribute slot."""

    def __init__(self) -> None:
        super().__init__()
        self._ops_list = [ro for ro in self._ops_list if ro.name != "setattr"]


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


def _make_disk_ws(root) -> Workspace:
    (root / "f.txt").write_bytes(b"hello")
    return Workspace(
        {"/data/": (DiskResource(root=str(root)), MountMode.WRITE)},
        mode=MountMode.WRITE)


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


@pytest.mark.asyncio
async def test_metadata_commands_respect_read_only_mount():
    ws = _make_ws(MountMode.READ)
    for cmd in ("chmod 644 /data/f.txt", "chown alice /data/f.txt",
                "touch /data/f.txt"):
        code, _, err = await _run(ws, cmd)
        assert code == 1
        assert "read-only mount" in err


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
    assert "Mar  4  2026" in out


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
