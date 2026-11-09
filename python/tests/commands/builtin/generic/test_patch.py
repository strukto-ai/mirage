import pytest

from mirage.types import MountMode
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace


async def _shell(line: str) -> tuple[int, bytes, bytes]:
    ws = Workspace({"/data": RAMVFS()}, mode=MountMode.WRITE)
    try:
        r = await ws.shell("cd /data && " + line)
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
            "printf 'a\\nb\\nc\\n' > f; printf -- '--- f\\n+++ f\\n@@ -1,3 +"
            "1,3 @@\\n a\\n-b\\n+X\\n c\\n' > p; patch -o sub/out < p; echo "
            "rc=$?",
            (
                0,
                b"rc=2\n",
                (
                    b"patch: **** Can't create file sub/out : No s"
                    b"uch file or directory\n"
                ),
            ),
            id="output_that_cannot_open",
        ),
        pytest.param(
            "printf 'a\\nb\\nc\\n' > f; printf -- '--- f\\n+++ f\\n@@ -1,3 +"
            "1,3 @@\\n a\\n-b\\n+X\\n c\\n' > p; patch -b f p; echo rc=$?; c"
            "at f.orig f",
            (0, b"patching file f\nrc=0\na\nb\nc\na\nX\nc\n", b""),
            id="backup",
        ),
        pytest.param(
            "printf 'a\\n' > f; printf -- '--- f\\n+++ f\\n@@ -1 +1 @@\\n-z"
            "\\n+A\\n' > q; patch -f -r sub/r f q; echo rc=$?",
            (
                0,
                (
                    b"patching file f\nHunk #1 FAILED at 1.\n1 out o"
                    b"f 1 hunk FAILED -- saving rejects to file su"
                    b"b/r\nrc=2\n"
                ),
                (
                    b"patch: **** Can't create file sub/r : No suc"
                    b"h file or directory\n"
                ),
            ),
            id="reject_that_cannot_open",
        ),
    ],
)
@pytest.mark.asyncio
async def test_patch_options_behave_as_pinned(
    line: str, expected: tuple[int, bytes, bytes]
) -> None:
    assert await _shell(line) == expected
