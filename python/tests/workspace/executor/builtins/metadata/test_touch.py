import pytest

from mirage.resource.ram import RAMResource
from mirage.types import MountMode, PathSpec
from mirage.workspace import Workspace


class _StatOnlyRAMResource(RAMResource):
    """RAM resource stripped of write-shaped ops, standing in for an API
    backend that can stat but never create files."""

    def __init__(self) -> None:
        super().__init__()
        self._ops_list = [
            ro for ro in self._ops_list if ro.name not in {"setattr", "write"}
        ]


def _make_ws(mode: MountMode = MountMode.WRITE) -> Workspace:
    resource = RAMResource()
    resource._store.files["/f.txt"] = b"hello"
    return Workspace({"/data/": (resource, mode)}, mode=MountMode.WRITE)


async def _run(ws: Workspace, cmd: str) -> tuple[int, str, str]:
    r = await ws.execute(cmd)
    return r.exit_code, await r.stdout_str(), await r.stderr_str()


@pytest.mark.asyncio
async def test_touch_sets_mtime():
    ws = _make_ws()
    code, _, _ = await _run(ws, "touch -t 202603041200 /data/f.txt")
    assert code == 0
    _, out, _ = await _run(ws, "ls -l /data")
    assert "Mar  4  2026" in out


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
async def test_touch_r_relative_reference_resolves_against_cwd():
    ws = _make_ws()
    await _run(ws, "touch -t 202603041200 /data/f.txt")
    code, _, err = await _run(ws, "cd /data && touch -r f.txt new.txt")
    assert code == 0, err
    _, out, _ = await _run(ws, "ls -l /data")
    assert out.count("Mar  4  2026") == 2
