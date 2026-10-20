import os

import pytest

from mirage.types import FileStat, FileType, MountMode, PathSpec
from mirage.vfs.disk import DiskVFS
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace
from mirage.workspace.executor.builtins.metadata import (
    parse_group,
    parse_owner,
    parse_touch_stamp,
)
from mirage.workspace.executor.builtins.metadata.metadata import walk_owned
from tests.fixtures.vfs_io import OverlayRAM as _OverlayRAMVFS
from tests.fixtures.vfs_io import metadata_workspace as _make_ws
from tests.fixtures.vfs_io import overlay_workspace as _make_overlay_ws
from tests.fixtures.vfs_io import run_text as _run


async def _stat_mode(ws: Workspace, path: str) -> int | None:
    st, _ = await ws.dispatch("stat", PathSpec.from_str_path(path))
    return st.mode


def _make_disk_ws(root) -> Workspace:
    (root / "f.txt").write_bytes(b"hello")
    return Workspace(
        {"/data/": (DiskVFS(root=str(root)), MountMode.WRITE)},
        mode=MountMode.WRITE,
    )


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
    assert (
        parse_touch_stamp("202601021530", None) == "2026-01-02T15:30:00+00:00"
    )
    assert (
        parse_touch_stamp("202601021530.45", None)
        == "2026-01-02T15:30:45+00:00"
    )


def test_parse_touch_stamp_two_digit_year():
    assert parse_touch_stamp("2601021530", None).startswith("2026-")
    assert parse_touch_stamp("9901021530", None).startswith("1999-")


def test_parse_touch_stamp_date_string():
    assert parse_touch_stamp(None, "2026-01-02") == "2026-01-02T00:00:00+00:00"
    assert parse_touch_stamp(None, None) is None


def test_parse_touch_stamp_keeps_a_fraction():
    assert (
        parse_touch_stamp(None, "2024-01-01 00:00:00.5")
        == "2024-01-01T00:00:00.500000+00:00"
    )


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
    for cmd, action in (
        ("chmod 644", "changing permissions of"),
        ("chown alice", "changing ownership of"),
        ("touch", "cannot touch"),
        ("touch -c", "setting times of"),
    ):
        code, _, err = await _run(ws, f"{cmd} /data/f.txt")
        assert code == 1
        assert (
            err == f"{cmd.split()[0]}: {action} '/data/f.txt': "
            "Read-only file system\n"
        )


async def _sealed_ws() -> Workspace:
    # The rule lives on a profile so the tree is seeded under the
    # unrestricted default session; every probe runs as "g". A deny
    # rule lets a stat through and refuses the attribute write and the
    # listing.
    ws = Workspace(
        {"/data/": (RAMVFS(), MountMode.WRITE)},
        mode=MountMode.WRITE,
        profiles={
            "guarded": {
                "commands": {
                    "deny": [
                        {
                            "reason": "sealed",
                            "paths": [
                                "/data/t/secret.txt",
                                "/data/t/sealed",
                                "/data/t/sealed/*",
                            ],
                        }
                    ]
                }
            }
        },
    )
    ws.create_session("g", profile="guarded")
    await ws.shell(
        "mkdir -p /data/t/box /data/t/sealed && echo s > /data/t/secret.txt"
        " && echo o > /data/t/ok.txt && echo p > /data/t/box/pub.txt"
        " && echo i > /data/t/sealed/in.txt"
        " && ln -s /data/t/secret.txt /data/lnk"
        " && ln -s /data/t/ok.txt /data/t/sealed/il"
    )
    return ws


async def _guarded(ws: Workspace, line: str) -> tuple[int, str, str]:
    r = await ws.shell(line, session_id="g")
    return r.exit_code, await r.stdout_str(), await r.stderr_str()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "cmd, refused, fmt, changed",
    [
        ("chmod 600", "chmod: /data/lnk: Permission denied\n", "%a", "600"),
        ("chown 7", "chown: /data/lnk: Permission denied\n", "%u", "7"),
        ("chgrp 7", "chgrp: /data/lnk: Permission denied\n", "%g", "7"),
        (
            "touch -d 2001-01-01T00:00:00",
            "touch: cannot touch '/data/lnk': Permission denied\n",
            "%Y",
            "978307200",
        ),
    ],
)
async def test_a_denied_write_through_a_link_names_the_operand(
    cmd, refused, fmt, changed
):
    # The rule refuses the link's target; the line names the link as
    # typed, and the command goes on to the next operand.
    ws = await _sealed_ws()
    code, out, err = await _guarded(
        ws, f"{cmd} /data/lnk /data/t/ok.txt; echo rc=$?"
    )
    assert (code, out, err) == (0, "rc=1\n", refused)
    _, out, _ = await _guarded(ws, f"stat -c {fmt} /data/t/ok.txt")
    assert out == f"{changed}\n"


@pytest.mark.asyncio
@pytest.mark.parametrize("cmd", ["chmod -R 600", "chown -R 7", "chgrp -R 7"])
async def test_a_denied_listing_is_reported_and_not_descended(cmd):
    # fts's unreadable directory: its own change is still tried (and
    # refused here), its line follows, its subtree (the link in it
    # included) is left alone, and the walk goes on with its siblings.
    ws = await _sealed_ws()
    name = cmd.split()[0]
    code, out, err = await _guarded(ws, f"cd /data && {cmd} t; echo rc=$?")
    assert (code, out) == (0, "rc=1\n")
    assert err == (
        f"{name}: t/sealed: Permission denied\n"
        f"{name}: cannot read directory 't/sealed': Permission denied\n"
        f"{name}: t/secret.txt: Permission denied\n"
    )
    fmt = {"chmod": "%a", "chown": "%u", "chgrp": "%g"}[name]
    _, out, _ = await _guarded(ws, f"stat -c {fmt} /data/t/box/pub.txt")
    assert out == f"{cmd.split()[-1]}\n"


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
@pytest.mark.parametrize("line", ["mv /data/a.txt /data/b.txt", None])
async def test_a_rename_keeps_the_times_the_node_table_holds(line):
    # rename(2) leaves a file's times alone, so a time only the node
    # table holds moves with the name, whether a command or the
    # dispatcher's own caller (FUSE, ws.vfs) renames it.
    ws, _ = _make_overlay_ws({"/a.txt": b"x"})
    await _run(ws, "touch -d 2026-03-04T12:00:00 /data/a.txt")
    before, _ = await ws.dispatch(
        "stat", PathSpec.from_str_path("/data/a.txt")
    )
    if line is None:
        await ws.vfs.rename("/data/a.txt", "/data/b.txt")
    else:
        code, _, err = await _run(ws, line)
        assert code == 0, err
    after, _ = await ws.dispatch("stat", PathSpec.from_str_path("/data/b.txt"))
    assert after.modified == before.modified


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
    vfs = _OverlayRAMVFS()
    vfs._store.files["/f.txt"] = b"hello"
    ws = Workspace({"/data/": (vfs, MountMode.WRITE)}, mode=MountMode.WRITE)
    code, _, _ = await _run(
        ws,
        "chmod 601 /data/f.txt && chown 500:dev /data/f.txt"
        " && touch -t 202603041200 /data/f.txt",
    )
    assert code == 0
    assert vfs._store.attrs == {}
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
        ws,
        "chmod 664 /data/f.txt && chown 500:dev /data/f.txt"
        " && touch -t 202603041200 /data/f.txt",
    )
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


class _LinkUnderRoot:
    """A link table holding one link below the root."""

    def is_link(self, path: str) -> bool:
        return False

    def link_stats_below(self, directory: str) -> list[tuple[str, FileStat]]:
        return [("/a/lnk", FileStat(name="lnk", type=FileType.SYMLINK))]


async def _refused_readdir(op: str, path: PathSpec, *args, **kwargs):
    """A dispatch whose mount refuses every listing."""
    assert op == "readdir"
    raise PermissionError(13, "Permission denied", path.virtual)


@pytest.mark.asyncio
async def test_a_refused_root_listing_keeps_every_link_below_it():
    # A mount that stats `/` but refuses to list it: the walk never goes
    # below the root, so no link there is changed either.
    root = PathSpec.from_str_path("/")
    walked, owned = await walk_owned(
        _LinkUnderRoot(),
        _refused_readdir,
        root,
        FileStat(name="/", type=FileType.DIRECTORY),
    )
    assert owned == []
    assert isinstance(walked[0][2], PermissionError)
