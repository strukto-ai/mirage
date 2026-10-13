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
import os

import pytest

from mirage.runtime.sandbox.cli import Children, close_children, run_cli


async def _ended(pid: int) -> bool:
    """Whether ``pid`` has exited: gone, or a zombie its new parent has
    not reaped yet. Polled, since a kill lands asynchronously.

    Args:
        pid (int): the process to look for.
    """
    for _ in range(500):
        ps = await asyncio.create_subprocess_exec(
            "ps", "-o", "stat=", "-p", str(pid), stdout=asyncio.subprocess.PIPE
        )
        out, _ = await ps.communicate()
        state = out.decode().strip()
        if not state or state.startswith("Z"):
            return True
        await asyncio.sleep(0.01)
    return False


@pytest.mark.asyncio
async def test_run_cli_returns_both_streams_and_the_status():
    out, err, code = await run_cli(
        "sh", "no sh", ["-c", "cat; echo e >&2; exit 3"], b"in"
    )
    assert (out, err, code) == (b"in", b"e\n", 3)


@pytest.mark.asyncio
async def test_a_missing_cli_raises_its_hint():
    with pytest.raises(RuntimeError, match="install it"):
        await run_cli("mirage-no-such-cli", "install it", [], None)


@pytest.mark.asyncio
async def test_cancelling_a_call_kills_the_child(tmp_path):
    pid_file = tmp_path / "pid"
    task = asyncio.create_task(
        run_cli(
            "sh", "no sh", ["-c", f"echo $$ > {pid_file}; exec sleep 30"], None
        )
    )
    for _ in range(200):
        if pid_file.exists() and pid_file.read_text().strip():
            break
        await asyncio.sleep(0.01)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    pid = int(pid_file.read_text())
    with pytest.raises(ProcessLookupError):
        os.kill(pid, 0)


@pytest.mark.asyncio
async def test_cancelling_a_call_kills_what_the_child_started(tmp_path):
    # A grandchild holds the output pipes open, so killing the child
    # alone left the wait running until the grandchild exited.
    pid_file = tmp_path / "pid"
    task = asyncio.create_task(
        run_cli(
            "sh",
            None,
            ["-c", f"sleep 30 & echo $! > {pid_file}; wait"],
            None,
        )
    )
    for _ in range(200):
        if pid_file.exists() and pid_file.read_text().strip():
            break
        await asyncio.sleep(0.01)
    task.cancel()
    async with asyncio.timeout(5):
        with pytest.raises(asyncio.CancelledError):
            await task
    assert await _ended(int(pid_file.read_text()))


@pytest.mark.asyncio
async def test_close_children_kills_every_running_tree(tmp_path):
    children: Children = {}
    pid_file = tmp_path / "pid"
    task = asyncio.create_task(
        run_cli(
            "sh",
            None,
            ["-c", f"sleep 30 & echo $! > {pid_file}; wait"],
            None,
            children=children,
        )
    )
    async with asyncio.timeout(5):
        while not (pid_file.exists() and pid_file.read_text().strip()):
            await asyncio.sleep(0.01)
        await close_children(children)
        _, _, code = await task
    assert code != 0 and not children
    assert await _ended(int(pid_file.read_text()))
