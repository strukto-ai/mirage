import logging

import pytest

from mirage import RAMVFS, Workspace
from mirage.commands.config import command
from mirage.commands.errors import CommandTimeoutError
from mirage.commands.spec import SPECS
from mirage.errors.fs import eacces
from mirage.io.types import IOResult, materialize
from mirage.types import PathSpec
from mirage.workspace.mount.mount import MountEntry
from tests.fixtures.vfs_io import override


def failing_command(name, error, lazy=True):
    async def stream():
        yield b"/bad/visible\n"
        raise error

    @command(name, vfs="ram", spec=SPECS[name])
    async def fail(accessor, paths, texts, opts):
        if not lazy:
            raise error
        return stream(), IOResult()

    return fail


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "error", [eacces("/bad/closed"), RuntimeError("remote failure")]
)
@pytest.mark.parametrize(
    "tail,expected",
    [
        ("; echo after=$?", b"before\n/bad/visible\nafter=1\n"),
        (" | head -10; echo after=$?", b"before\n/bad/visible\nafter=0\n"),
        (
            " >/out/file; echo after=$?; cat /out/file",
            b"before\nafter=1\n/bad/visible\n",
        ),
    ],
)
async def test_lazy_errors_remain_on_the_producer(error, tail, expected):
    bad = RAMVFS()
    ws = Workspace({"/bad": bad, "/out": RAMVFS()}, mode="exec")
    ws.mount("/bad").register_commands([failing_command("cat", error)])
    try:
        await ws.shell("echo data >/bad/f")
        result = await ws.shell("echo before; cat /bad/f 2>/dev/null" + tail)
        assert result.stdout == expected
        assert not result.stderr
        assert result.exit_code == 0
        result = await ws.shell("cat /bad/f")
        assert result.stdout == b"/bad/visible\n"
        assert result.stderr.startswith(b"cat: ")
        assert result.exit_code == 1
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("name", ["find", "du", "ls -R"])
async def test_nested_mount_failure_keeps_the_line(name, caplog):
    caplog.set_level(logging.DEBUG, logger="mirage.workspace")
    error = RuntimeError("remote failure")

    async def failing_readdir(accessor, path, **kwargs):
        raise error

    ws = Workspace({"/bad": RAMVFS(), "/good": RAMVFS()}, mode="exec")
    # find and du hand each mount's part to that mount's own command;
    # ls -R lists the nested mount through the dispatcher.
    if name == "ls -R":
        override(ws.mount("/bad").vfs, "readdir", failing_readdir)
    else:
        ws.mount("/bad").register_commands(
            [failing_command(name, error, lazy=False)]
        )
    try:
        await ws.shell("echo data >/good/file")
        result = await ws.shell(
            f"echo before; {name} / >/dev/null 2>&1; echo after=$?"
        )
        assert result.stdout == b"before\nafter=1\n"
        assert not result.stderr
        assert any(
            record.exc_info and record.exc_info[1] is error
            for record in caplog.records
        )
        result = await ws.shell(f"{name} /")
        assert result.stderr == f"{name.split()[0]}: remote failure\n".encode()
        assert result.exit_code == 1
        # A mount's own find or du fails alone; the other mounts answer.
        assert (b"/good" in result.stdout) == (name != "ls -R")
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_lazy_timeout_still_reaches_the_timeout_handler():
    vfs = RAMVFS()
    mount = MountEntry("/bad/", vfs)
    mount.register_commands(
        [failing_command("cat", CommandTimeoutError("cat", 1))]
    )
    out, _ = await mount.run_command(
        "cat", [PathSpec.from_str_path("/bad/f")], [], {}
    )
    with pytest.raises(CommandTimeoutError):
        await materialize(out)
