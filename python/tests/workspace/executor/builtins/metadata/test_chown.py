import pytest

from mirage.resource.ram import RAMResource
from mirage.types import MountMode
from mirage.workspace import Workspace


def _make_ws(mode: MountMode = MountMode.WRITE) -> Workspace:
    resource = RAMResource()
    resource._store.files["/f.txt"] = b"hello"
    return Workspace({"/data/": (resource, mode)}, mode=MountMode.WRITE)


async def _run(ws: Workspace, cmd: str) -> tuple[int, str, str]:
    r = await ws.execute(cmd)
    return r.exit_code, await r.stdout_str(), await r.stderr_str()


@pytest.mark.asyncio
async def test_chown_renders_owner_and_group():
    ws = _make_ws()
    code, _, _ = await _run(ws, "chown 500:dev /data/f.txt")
    assert code == 0
    _, out, _ = await _run(ws, "ls -l /data")
    assert " 500 dev " in out


@pytest.mark.asyncio
async def test_chown_recursive_changes_a_traversed_link_itself():
    ws = _make_ws()
    await _run(ws, "mkdir -p /data/tree")
    await _run(ws, "echo aaa > /data/tree/a.txt")
    await _run(ws, "ln -s /data/tree/a.txt /data/tree/link.txt")
    code, _, err = await _run(ws, "chown -R alice /data/tree")
    assert code == 0, err
    _, out, _ = await _run(
        ws, "stat -c '%U %n' /data/tree /data/tree/a.txt /data/tree/link.txt")
    assert out.splitlines() == [
        "alice /data/tree",
        "alice /data/tree/a.txt",
        "alice /data/tree/link.txt",
    ]


@pytest.mark.asyncio
async def test_chown_recursive_does_not_follow_a_link_operand():
    ws = _make_ws()
    await _run(ws, "mkdir -p /data/tree/sub")
    await _run(ws, "echo bbb > /data/tree/sub/b.txt")
    await _run(ws, "ln -s /data/tree/sub /data/dirlink")
    code, _, err = await _run(ws, "chown -R bob /data/dirlink")
    assert code == 0, err
    # POSIX gives -R an implicit -P: the link changes, its target does not.
    _, out, _ = await _run(
        ws, "stat -c '%U %n' /data/dirlink /data/tree/sub/b.txt")
    assert out.splitlines() == [
        "bob /data/dirlink",
        "- /data/tree/sub/b.txt",
    ]


@pytest.mark.asyncio
async def test_chown_h_ownership_reaches_ls_and_stat():
    ws = _make_ws()
    await _run(ws, "ln -s /data/f.txt /data/link")
    code, _, err = await _run(ws, "chown -h alice /data/link")
    assert code == 0, err
    _, out, _ = await _run(ws, "stat -c '%U' /data/link")
    assert out == "alice\n"
    _, out, _ = await _run(ws, "ls -l /data/link")
    assert " alice " in out
