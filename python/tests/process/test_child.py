import asyncio

import pytest

from mirage.process.child import ChildProcess
from mirage.process.stdio import ProcessInput, ProcessOutput
from mirage.process.supervisor import ProcessSupervisor
from mirage.process.types import ProcessRunner
from mirage.shell.console import Channel
from mirage.types import PathSpec


def _child(supervisor: ProcessSupervisor, stdin: ProcessInput,
           output: ProcessOutput, run: ProcessRunner) -> ChildProcess:
    process = supervisor.start(session_id="a",
                               command="child",
                               cwd=PathSpec.from_str_path("/"),
                               run=run)
    return ChildProcess(process, stdin, output, process.terminate)


@pytest.mark.asyncio
async def test_communicate_feeds_stdin_and_drains_both_outputs():
    stdin, output = ProcessInput(), ProcessOutput()

    async def run() -> int:
        data = b"".join([chunk async for chunk in stdin.stream()])
        await output.emit(Channel.STDOUT, data.upper())
        await output.emit(Channel.STDERR, b"warn")
        return 3

    child = _child(ProcessSupervisor(), stdin, output, run)
    assert child.poll() is None
    result = await child.communicate(b"hello")
    assert (result.stdout, result.stderr, result.exit_code) == (b"HELLO",
                                                                b"warn", 3)
    assert child.poll() == 3


@pytest.mark.asyncio
async def test_terminate_cancels_a_child_that_never_answers():
    started = asyncio.Event()

    async def run() -> int:
        started.set()
        await asyncio.Event().wait()
        return 0

    child = _child(ProcessSupervisor(), ProcessInput(), ProcessOutput(), run)
    await started.wait()
    child.terminate()
    info = await child.wait()
    assert (info.exit_code, info.cancellation_requested) == (137, True)
    assert child.poll() == 137
