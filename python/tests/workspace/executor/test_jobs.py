# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import asyncio

import pytest

from mirage.resource.ram import RAMResource
from mirage.shell.console import Channel
from mirage.types import MountMode
from mirage.workspace import Workspace


def _workspace() -> Workspace:
    return Workspace({"/m": (RAMResource(), MountMode.WRITE)},
                     mode=MountMode.WRITE)


async def _run_bg(cmd: str, job_id: int = 1) -> tuple[bytes, bytes]:
    """Run a backgrounded command and return its finished console.

    Args:
        cmd (str): shell line to execute, ending in ``&``.
        job_id (int): job to wait for.
    """
    ws = _workspace()
    await ws.execute(cmd)
    await ws.job_table.wait(job_id)
    job = ws.job_table.get(job_id)
    assert job is not None
    return (await job.console.snapshot(Channel.STDOUT), await
            job.console.snapshot(Channel.STDERR))


# ── streaming: output lands while the job is still running ──────────


def test_loop_body_streams_each_iteration_instead_of_batching():
    """A reader sees earlier iterations before the loop finishes.

    Without the sink the whole construct is materialized and pumped at
    completion, so a mid-run snapshot is empty.
    """

    async def _do():
        ws = _workspace()
        await ws.execute("for i in 1 2 3; do echo $i; sleep 0.25; done &")
        job = ws.job_table.get(1)
        assert job is not None
        await asyncio.sleep(0.35)
        mid = await job.console.snapshot(Channel.STDOUT)
        await ws.job_table.wait(1)
        return mid, await job.console.snapshot(Channel.STDOUT)

    mid, end = asyncio.run(_do())
    assert end == b"1\n2\n3\n"
    assert mid, "loop produced nothing until it finished"
    assert end.startswith(mid) and mid != end


@pytest.mark.parametrize(
    "cmd,expected",
    [
        ("echo one && echo two &", b"one\ntwo\n"),
        ("(echo s1; echo s2) &", b"s1\ns2\n"),
        ("if true; then echo yes; fi &", b"yes\n"),
        ("i=0; while [ $i -lt 2 ]; do echo w$i; i=$((i+1)); done &",
         b"w0\nw1\n"),
        ("for i in a b; do echo $i; done &", b"a\nb\n"),
    ],
)
def test_compound_constructs_reach_the_console(cmd, expected):
    """Every sequencing construct feeds the job console.

    Args:
        cmd (str): backgrounded shell line.
        expected (bytes): the console's stdout once the job ends.
    """
    out, _ = asyncio.run(_run_bg(cmd))
    assert out == expected


# ── capture sites: a sink must never leak into a captured value ─────


def test_command_substitution_does_not_leak_into_the_console():
    out, _ = asyncio.run(_run_bg("echo $(echo inner) &"))
    assert out == b"inner\n"


def test_pipe_stages_do_not_leak_into_the_console():
    """Only the last stage's output is the job's output."""
    out, _ = asyncio.run(_run_bg("printf 'a\\nb\\n' | grep b &"))
    assert out == b"b\n"


def test_redirected_output_goes_to_the_file_not_the_console():

    async def _do():
        ws = _workspace()
        await ws.execute("echo hi > /m/f.txt &")
        await ws.job_table.wait(1)
        job = ws.job_table.get(1)
        assert job is not None
        written = await (await ws.execute("cat /m/f.txt")).stdout_str()
        return await job.console.snapshot(Channel.STDOUT), written

    out, written = asyncio.run(_do())
    assert out == b""
    assert written == "hi\n"


# ── bare `wait` adopts job output ───────────────────────────────────


def test_bare_wait_adopts_output_from_every_job_in_id_order():
    """`wait` with no operand surfaces what the jobs printed.

    A real shell has nothing to adopt because its jobs share the
    terminal. Mirage jobs print to their console, so bare `wait` has to
    surface it or the output is stranded.
    """

    async def _do():
        ws = _workspace()
        await ws.execute("echo a &")
        await ws.execute("echo b &")
        result = await ws.execute("wait")
        return await result.stdout_str()

    assert asyncio.run(_do()) == "a\nb\n"


def test_bare_wait_with_no_jobs_returns_nothing():

    async def _do():
        ws = _workspace()
        result = await ws.execute("wait")
        return await result.stdout_str(), result.exit_code

    out, code = asyncio.run(_do())
    assert out == ""
    assert code == 0


def test_stderr_is_routed_to_its_own_channel():
    out, err = asyncio.run(_run_bg("echo err >&2 &"))
    assert out == b""
    assert err == b"err\n"
