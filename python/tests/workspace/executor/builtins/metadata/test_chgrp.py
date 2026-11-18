import pytest

from mirage.types import MountMode, PathSpec
from mirage.workspace import Workspace
from tests.fixtures.vfs_io import OverlayRAM as _OverlayRAMVFS
from tests.fixtures.vfs_io import metadata_workspace as _make_ws
from tests.fixtures.vfs_io import run_text as _run


@pytest.mark.asyncio
async def test_chgrp_renders_group_keeps_default_owner():
    ws = _make_ws()
    code, _, err = await _run(ws, "chgrp nogroup /data/f.txt")
    assert code == 0, err
    _, out, _ = await _run(ws, "ls -l /data")
    assert " root nogroup " in out


@pytest.mark.asyncio
async def test_chgrp_changes_only_group_keeping_chown_owner():
    ws = _make_ws()
    await _run(ws, "chown nobody:nogroup /data/f.txt")
    code, _, err = await _run(ws, "chgrp 20 /data/f.txt")
    assert code == 0, err
    _, out, _ = await _run(ws, "ls -l /data")
    assert " nobody 20 " in out


@pytest.mark.asyncio
async def test_chgrp_error_shapes():
    ws = _make_ws()
    code, _, err = await _run(ws, "chgrp staff /data/f.txt")
    assert (code, err) == (1, "chgrp: invalid group: 'staff'\n")
    assert (await _run(ws, "chgrp nogroup"))[0] == 1
    assert (await _run(ws, "chgrp '' /data/f.txt"))[0] == 1
    code, _, err = await _run(ws, "chgrp nogroup /data/nope.txt")
    assert code == 1
    assert "nope.txt" in err


@pytest.mark.asyncio
async def test_chgrp_h_targets_link_not_target():
    ws = _make_ws()
    await _run(ws, "ln -s /data/f.txt /data/link")
    code, _, err = await _run(ws, "chgrp -h nogroup /data/link")
    assert code == 0, err
    # stat follows the link; -h wrote the link node, so the target is clean.
    st, _ = await ws.dispatch("stat", PathSpec.from_str_path("/data/f.txt"))
    assert st.gid is None


@pytest.mark.asyncio
async def test_chgrp_refuses_read_only_mount():
    ws = _make_ws(MountMode.READ)
    code, _, err = await _run(ws, "chgrp nogroup /data/f.txt")
    assert code == 1
    assert err == (
        "chgrp: changing group of '/data/f.txt': Read-only file system\n"
    )


@pytest.mark.asyncio
async def test_chgrp_overlay_fallback_writes_only_gid():
    vfs = _OverlayRAMVFS()
    vfs._store.files["/f.txt"] = b"hello"
    ws = Workspace({"/data/": (vfs, MountMode.WRITE)}, mode=MountMode.WRITE)
    code, _, _ = await _run(ws, "chgrp nogroup /data/f.txt")
    assert code == 0
    assert vfs._store.attrs == {}
    st, _ = await ws.dispatch("stat", PathSpec.from_str_path("/data/f.txt"))
    assert st.gid == 65534
    assert st.uid is None


@pytest.mark.asyncio
async def test_chgrp_recursive_reaches_links_and_files():
    ws = _make_ws()
    await _run(ws, "mkdir -p /data/tree")
    await _run(ws, "echo aaa > /data/tree/a.txt")
    await _run(ws, "ln -s /data/tree/a.txt /data/tree/link.txt")
    code, _, err = await _run(ws, "chgrp -R nogroup /data/tree")
    assert code == 0, err
    _, out, _ = await _run(
        ws, "stat -c '%G %n' /data/tree/a.txt /data/tree/link.txt"
    )
    assert out.splitlines() == [
        "nogroup /data/tree/a.txt",
        "nogroup /data/tree/link.txt",
    ]
