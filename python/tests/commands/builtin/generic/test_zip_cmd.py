import io
import zipfile

import pytest

from mirage.types import MountMode
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace


async def _zip(
    line: str, mounts: tuple[str, ...] = ()
) -> tuple[int, bytes, list[str]]:
    vfs = RAMVFS()
    vfs.load_state(
        {"files": {"/w/d/a.txt": b"alpha"}, "dirs": ["/", "/w", "/w/d"]}
    )
    ws = Workspace(
        {"/data/": vfs, **{m: RAMVFS() for m in mounts}}, mode=MountMode.WRITE
    )
    try:
        result = await ws.shell(f"cd /data/w && {line}")
        await result.materialize_stdout()
        archive = vfs.get_state()["files"]["/w/out.zip"]
        with zipfile.ZipFile(io.BytesIO(archive)) as zf:
            names = zf.namelist()
        return result.exit_code, result.stderr or b"", names
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_stops_at_a_nested_mount_and_says_so():
    code, stderr, names = await _zip(
        "mkdir -p d/nested && zip -r out.zip d", mounts=("/data/w/d/nested/",)
    )
    assert code == 0
    assert stderr == (
        b"\tzip warning: d/nested: file is on a different filesystem; "
        b"not dumped\n"
    )
    # The mountpoint stays an entry; only its contents are left out.
    assert names == ["d/", "d/a.txt", "d/nested/"]


@pytest.mark.asyncio
async def test_leaves_the_archive_out_of_itself():
    code, _, names = await _zip("zip -q out.zip d/a.txt && zip -qr out.zip .")
    assert code == 0
    assert names == ["d/a.txt", "d/"]
