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
async def test_chmod_follows_symlink():
    ws = _make_ws()
    await _run(ws, "ln -s /data/f.txt /data/link")
    await _run(ws, "chmod 640 /data/link")
    _, out, _ = await _run(ws, "ls -l /data")
    # The mode lands on the target, not the link. The link's own row is
    # listed too and is wider, so the size column pads f.txt's 5.
    assert "-rw-r----- 1 - -  5 Jan  1 00:00 f.txt" in out
    assert "lrwxrwxrwx" in out


@pytest.mark.asyncio
async def test_chmod_symbolic_directory_base_is_755():
    ws, _ = _make_overlay_ws({})
    await _run(ws, "mkdir /data/sub")
    code, _, err = await _run(ws, "chmod g+w /data/sub")
    assert code == 0, err
    assert await _stat_mode(ws, "/data/sub") == 0o775


@pytest.mark.asyncio
async def test_chmod_recursive_covers_the_whole_subtree():
    ws = _make_ws()
    await _run(ws, "mkdir -p /data/tree/sub")
    await _run(ws, "echo aaa > /data/tree/a.txt")
    await _run(ws, "echo bbb > /data/tree/sub/b.txt")
    code, _, err = await _run(ws, "chmod -R 700 /data/tree")
    assert code == 0, err
    _, out, _ = await _run(
        ws, "stat -c '%A %n' /data/tree /data/tree/a.txt "
        "/data/tree/sub /data/tree/sub/b.txt")
    assert out.splitlines() == [
        "drwx------ /data/tree",
        "-rwx------ /data/tree/a.txt",
        "drwx------ /data/tree/sub",
        "-rwx------ /data/tree/sub/b.txt",
    ]


@pytest.mark.asyncio
async def test_chmod_recursive_skips_a_traversed_link():
    ws = _make_ws()
    await _run(ws, "mkdir -p /data/tree")
    await _run(ws, "echo aaa > /data/outside.txt")
    await _run(ws, "chmod 600 /data/outside.txt")
    await _run(ws, "ln -s /data/outside.txt /data/tree/link.txt")
    code, _, err = await _run(ws, "chmod -R 777 /data/tree")
    assert code == 0, err
    # GNU changes neither the traversed link nor its referent.
    _, out, _ = await _run(
        ws, "stat -c '%A %n' /data/outside.txt /data/tree/link.txt")
    assert out.splitlines() == [
        "-rw------- /data/outside.txt",
        "lrwxrwxrwx /data/tree/link.txt",
    ]


@pytest.mark.asyncio
async def test_chmod_recursive_follows_a_command_line_dir_link():
    ws = _make_ws()
    await _run(ws, "mkdir -p /data/tree/sub")
    await _run(ws, "echo bbb > /data/tree/sub/b.txt")
    await _run(ws, "ln -s /data/tree/sub /data/dirlink")
    code, _, err = await _run(ws, "chmod -R 700 /data/dirlink")
    assert code == 0, err
    _, out, _ = await _run(ws, "stat -c '%A %n' /data/tree/sub/b.txt")
    assert out == "-rwx------ /data/tree/sub/b.txt\n"


@pytest.mark.asyncio
async def test_chmod_recursive_reports_a_missing_operand():
    ws = _make_ws()
    code, _, err = await _run(ws, "chmod -R 700 /data/nope")
    assert code == 1
    assert err == ("chmod: cannot access '/data/nope': "
                   "No such file or directory\n")
