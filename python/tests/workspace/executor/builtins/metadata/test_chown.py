import pytest

from tests.fixtures.vfs_io import metadata_workspace as _make_ws
from tests.fixtures.vfs_io import run_text as _run


@pytest.mark.asyncio
async def test_chown_renders_owner_and_group():
    ws = _make_ws()
    code, _, _ = await _run(ws, "chown 500:nogroup /data/f.txt")
    assert code == 0
    _, out, _ = await _run(ws, "ls -l /data")
    assert " 500 nogroup " in out
    code, _, err = await _run(ws, "chown alice /data/f.txt")
    assert (code, err) == (1, "chown: invalid user: 'alice'\n")


@pytest.mark.asyncio
async def test_chown_recursive_changes_a_traversed_link_itself():
    ws = _make_ws()
    await _run(ws, "mkdir -p /data/tree")
    await _run(ws, "echo aaa > /data/tree/a.txt")
    await _run(ws, "ln -s /data/tree/a.txt /data/tree/link.txt")
    code, _, err = await _run(ws, "chown -R nobody /data/tree")
    assert code == 0, err
    _, out, _ = await _run(
        ws, "stat -c '%U %n' /data/tree /data/tree/a.txt /data/tree/link.txt"
    )
    assert out.splitlines() == [
        "nobody /data/tree",
        "nobody /data/tree/a.txt",
        "nobody /data/tree/link.txt",
    ]


@pytest.mark.asyncio
async def test_chown_recursive_does_not_follow_a_link_operand():
    ws = _make_ws()
    await _run(ws, "mkdir -p /data/tree/sub")
    await _run(ws, "echo bbb > /data/tree/sub/b.txt")
    await _run(ws, "ln -s /data/tree/sub /data/dirlink")
    code, _, err = await _run(ws, "chown -R nobody /data/dirlink")
    assert code == 0, err
    # POSIX gives -R an implicit -P: the link changes, its target does not.
    _, out, _ = await _run(
        ws, "stat -c '%U %n' /data/dirlink /data/tree/sub/b.txt"
    )
    assert out.splitlines() == [
        "nobody /data/dirlink",
        "root /data/tree/sub/b.txt",
    ]


@pytest.mark.asyncio
async def test_chown_h_ownership_reaches_ls_and_stat():
    ws = _make_ws()
    await _run(ws, "ln -s /data/f.txt /data/link")
    code, _, err = await _run(ws, "chown -h nobody /data/link")
    assert code == 0, err
    _, out, _ = await _run(ws, "stat -c '%U' /data/link")
    assert out == "nobody\n"
    _, out, _ = await _run(ws, "ls -l /data/link")
    assert " nobody " in out
