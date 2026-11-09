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


async def _shell(line: str) -> tuple[int, bytes, bytes]:
    ws = Workspace({"/data": RAMVFS()}, mode=MountMode.WRITE)
    try:
        r = await ws.shell(
            "cd /data && printf '1\\n' > a; mkdir d; "
            "printf '1\\n' > d/a; printf '2\\n' > d/b; " + line
        )
        return (
            r.exit_code,
            await r.materialize_stdout(),
            await r.materialize_stderr(),
        )
    finally:
        await ws.close()


@pytest.mark.parametrize(
    ("line", "expected"),
    [
        pytest.param(
            "zip -q out.zip d/a d/b; zip -q -d out.zip d/a; echo rc=$?;"
            " unzip -Z1 out.zip",
            (0, b"rc=0\nd/b\n", b""),
            id="delete",
        ),
        pytest.param(
            "zip -qj out.zip d/a; unzip -Z1 out.zip",
            (0, b"a\n", b""),
            id="junk_paths",
        ),
        pytest.param(
            "zip -q out.zip d/a d/b -x d/b; unzip -Z1 out.zip; rm out.z"
            "ip; zip -q out.zip d/a d/b -i 'd/b'; unzip -Z1 out.zip",
            (0, b"d/a\nd/b\n", b""),
            id="exclude_and_include",
        ),
        pytest.param(
            "printf 'd/a\\n' | zip -q -@ out.zip; unzip -Z1 out.zip",
            (0, b"d/a\n", b""),
            id="names_from_stdin",
        ),
        pytest.param(
            "zip -qm out.zip d/a; echo rc=$?; ls d",
            (0, b"rc=0\nb\n", b""),
            id="move",
        ),
        pytest.param(
            "zip -qrD out.zip d; unzip -Z1 out.zip | sort",
            (0, b"d/a\nd/b\n", b""),
            id="no_directory_entries",
        ),
    ],
)
@pytest.mark.asyncio
async def test_zip_options_behave_as_pinned(
    line: str, expected: tuple[int, bytes, bytes]
) -> None:
    assert await _shell(line) == expected


async def _mounted(line: str) -> tuple[int, bytes, bytes]:
    ws = Workspace(
        {"/data": RAMVFS(), "/m": RAMVFS()},
        mode=MountMode.WRITE,
    )
    try:
        r = await ws.shell(line)
        return (
            r.exit_code,
            await r.materialize_stdout(),
            await r.materialize_stderr(),
        )
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_mount_root_named_on_stdin_is_refused_like_an_operand():
    line = "cd /data; echo /m | zip -q -@ o.zip; echo rc=$?"
    assert await _mounted(line) == (
        0,
        b"rc=1\n",
        b"zip: cannot read '/m': Device or resource busy\n",
    )


@pytest.mark.asyncio
async def test_a_member_named_like_a_mount_root_can_be_deleted():
    line = (
        "cd /data; echo x > m; zip -q a.zip m; cd /; "
        "zip -q -d /data/a.zip m; echo rc=$?"
    )
    assert (await _mounted(line))[1] == b"rc=0\n"


@pytest.mark.asyncio
async def test_names_on_stdin_reach_a_zip_across_mounts():
    line = (
        "echo a > /m/f; echo b > /m/g; "
        "echo /m/f | zip -q -@ /data/o.zip /m/g; unzip -Z1 /data/o.zip | sort"
    )
    assert (await _mounted(line))[1] == b"m/f\nm/g\n"
