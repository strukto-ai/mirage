import pytest

from mirage.resource.ram import RAMResource
from mirage.types import MountMode, PathSpec
from mirage.workspace import Workspace


class _OverlayRAMResource(RAMResource):
    """RAM resource with the native setattr op stripped, standing in for
    an API backend that has no attribute slot."""

    def __init__(self) -> None:
        super().__init__()
        self._ops_list = [ro for ro in self._ops_list if ro.name != "setattr"]


def _make_ws(mode: MountMode = MountMode.WRITE) -> Workspace:
    resource = RAMResource()
    resource._store.files["/f.txt"] = b"hello"
    return Workspace({"/data/": (resource, mode)}, mode=MountMode.WRITE)


async def _run(ws: Workspace, cmd: str) -> tuple[int, str, str]:
    r = await ws.execute(cmd)
    return r.exit_code, await r.stdout_str(), await r.stderr_str()


@pytest.mark.asyncio
async def test_chgrp_renders_group_keeps_default_owner():
    ws = _make_ws()
    code, _, err = await _run(ws, "chgrp staff /data/f.txt")
    assert code == 0, err
    _, out, _ = await _run(ws, "ls -l /data")
    assert " - staff " in out


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
async def test_chgrp_recursive_reaches_links_and_files():
    ws = _make_ws()
    await _run(ws, "mkdir -p /data/tree")
    await _run(ws, "echo aaa > /data/tree/a.txt")
    await _run(ws, "ln -s /data/tree/a.txt /data/tree/link.txt")
    code, _, err = await _run(ws, "chgrp -R dev /data/tree")
    assert code == 0, err
    _, out, _ = await _run(
        ws, "stat -c '%G %n' /data/tree/a.txt /data/tree/link.txt")
    assert out.splitlines() == [
        "dev /data/tree/a.txt",
        "dev /data/tree/link.txt",
    ]
