import pytest

from mirage.commands.builtin.generic.crossmount.relay.tee import run_tee
from mirage.io.types import IOResult
from mirage.types import MountMode, PathSpec
from mirage.utils.errors import enoent
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace


@pytest.mark.asyncio
async def test_relay_tee_checks_every_output_before_writing_any():
    left, right = RAMVFS(), RAMVFS()
    ws = Workspace({"/a": left, "/b": right}, mode=MountMode.WRITE)
    try:
        result = await ws.shell(
            "printf x | tee --output-error=exit /a/one /b/nope/two /a/three"
        )
        assert result.exit_code == 1
        assert await result.materialize_stdout() == b""
        assert (
            result.stderr == b"tee: /b/nope/two: No such file or directory\n"
        )
        listing = await ws.shell(
            "ls /a; cat /a/one; printf y | tee /a/one /b/two"
        )
        assert await listing.materialize_stdout() == b"one\ny"
        both = await ws.shell("cat /a/one /b/two")
        assert await both.materialize_stdout() == b"yy"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_relay_tee_a_appends_through_the_append_op():
    ops: list[tuple[str, str]] = []

    async def dispatch(op, path, **kwargs):
        ops.append((op, path.virtual))
        if op == "stat":
            raise enoent(path)
        return None, IOResult()

    outputs = [
        PathSpec(virtual=v, directory=v, vfs_path=v, raw_path=v, resolved=True)
        for v in ("/a/f", "/b/g")
    ]
    out, io = await run_tee(outputs, {"append": True}, dispatch, b"x")
    assert (out, io.exit_code) == (b"x", 0)
    assert [o for o in ops if o[0] != "stat"] == [
        ("append", "/a/f"),
        ("append", "/b/g"),
    ]
