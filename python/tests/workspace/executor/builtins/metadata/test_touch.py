import pytest

from mirage.errors.types import CommandTimeoutError
from mirage.types import FileStat, MountMode, PathSpec
from mirage.vfs.base import BaseVFS
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace
from tests.fixtures.vfs_io import metadata_workspace as _make_ws
from tests.fixtures.vfs_io import run_text as _run


class _StatOnlyRAMVFS(RAMVFS):
    """RAM VFS with no write or setattr, standing in for an API
    backend that can stat but never create files."""

    setattr = BaseVFS.setattr
    write = BaseVFS.write


class _RejectingRAMVFS(RAMVFS):
    """RAM VFS whose upload fails with the store's own error, no
    ``OSError``: a Drive 503 or a botocore ``ClientError`` on commit."""

    def __init__(self, error: Exception, stats: bool = False):
        super().__init__()
        self.error = error
        self.stats = stats

    async def stat(self, path: PathSpec) -> FileStat:
        if self.stats:
            raise self.error
        return await super().stat(path)

    async def write(self, path: PathSpec, data: bytes) -> None:
        raise self.error


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
    vfs = _StatOnlyRAMVFS()
    vfs._store.files["/f.txt"] = b"hello"
    ws = Workspace({"/data/": (vfs, MountMode.WRITE)}, mode=MountMode.WRITE)
    code, _, err = await _run(ws, "touch /data/new.txt")
    assert code == 1
    assert "cannot touch '/data/new.txt': Read-only file system" in err
    _, out, _ = await _run(ws, "ls /data")
    assert "new.txt" not in out


@pytest.mark.asyncio
async def test_touch_stat_only_mount_existing_file_uses_overlay():
    vfs = _StatOnlyRAMVFS()
    vfs._store.files["/f.txt"] = b"hello"
    ws = Workspace({"/data/": (vfs, MountMode.WRITE)}, mode=MountMode.WRITE)
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


@pytest.mark.asyncio
async def test_touch_reports_a_failed_upload_and_the_line_goes_on():
    vfs = _RejectingRAMVFS(RuntimeError("upload refused: 503"))
    ws = Workspace({"/data/": (vfs, MountMode.WRITE)}, mode=MountMode.WRITE)
    code, out, err = await _run(ws, 'touch /data/new.txt; echo "s=$?"')
    assert (code, out) == (0, "s=1\n")
    assert err == "touch: cannot touch '/data/new.txt': upload refused: 503\n"
    code, out, err = await _run(
        ws, "touch /data/new.txt 2>/dev/null || echo ran"
    )
    assert (code, out, err) == (0, "ran\n", "")


@pytest.mark.asyncio
async def test_touch_lets_a_timeout_on_upload_end_the_line():
    vfs = _RejectingRAMVFS(CommandTimeoutError("write", 1))
    ws = Workspace({"/data/": (vfs, MountMode.WRITE)}, mode=MountMode.WRITE)
    code, out, _ = await _run(ws, "touch /data/new.txt; echo after")
    assert (code, out) == (124, "")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("line", "stderr"),
    [
        (
            "touch -r /data/ref.txt /data/new.txt",
            "touch: failed to get attributes of '/data/ref.txt': "
            "stat refused: 503\n",
        ),
        (
            "touch /data/d/",
            "touch: setting times of '/data/d/': stat refused: 503\n",
        ),
    ],
)
async def test_touch_reports_a_refused_stat_and_the_line_goes_on(
    line: str, stderr: str
):
    vfs = _RejectingRAMVFS(RuntimeError("stat refused: 503"), stats=True)
    ws = Workspace({"/data/": (vfs, MountMode.WRITE)}, mode=MountMode.WRITE)
    code, out, err = await _run(ws, f'{line}; echo "s=$?"')
    assert (code, out, err) == (0, "s=1\n", stderr)
