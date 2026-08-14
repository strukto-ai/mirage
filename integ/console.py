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
import sys
from pathlib import Path

_INTEG_DIR = str(Path(__file__).parent)
sys.path[:] = [p for p in sys.path if p not in (_INTEG_DIR, "")]

import asyncio  # noqa: E402
import os  # noqa: E402
from functools import partial  # noqa: E402

from mirage import MountMode, Workspace  # noqa: E402
from mirage.resource.ram import RAMResource  # noqa: E402
from mirage.shell.console import Channel, JobConsole  # noqa: E402
from mirage.shell.console.redis import RedisConsoleStore  # noqa: E402

REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6379/0")
POLL_S = 0.1
TIMEOUT_S = 60.0

fail = 0
CREATED: list[RedisConsoleStore] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    global fail
    if ok:
        print(f"  OK   {name}")
    else:
        print(f"  FAIL {name} {detail}")
        fail = 1


def job_store(prefix: str, job_id: int) -> RedisConsoleStore:
    return RedisConsoleStore(url=REDIS_URL,
                             key_prefix=f"{prefix}job:{job_id}:")


def signal_store(prefix: str) -> RedisConsoleStore:
    """The reader-to-writer handshake rides a console stream too, so the
    battery needs no redis client of its own."""
    return RedisConsoleStore(url=REDIS_URL, key_prefix=f"{prefix}signal:")


def console_for(prefix: str, job_id: int) -> JobConsole:
    """The factory owns its stores' lifecycle: the workspace never
    closes a console it was handed, so the embedder tracks and closes
    them (in Node an open client would hold the process alive).

    Args:
        prefix (str): this run's key namespace.
        job_id (int): the job the console is being built for.
    """
    store = job_store(prefix, job_id)
    CREATED.append(store)
    return JobConsole(store=store)


async def close_created() -> None:
    for store in CREATED:
        await store.close()


def make_workspace(prefix: str) -> Workspace:
    return Workspace({"/data": RAMResource()},
                     mode=MountMode.EXEC,
                     console_factory=partial(console_for, prefix))


async def attach(store: RedisConsoleStore) -> list:
    """Poll until the job's stream holds its first chunk.

    Args:
        store (RedisConsoleStore): the reader's own store instance.
    """
    deadline = asyncio.get_event_loop().time() + TIMEOUT_S
    while True:
        chunks, _, _ = await store.read_from(0)
        if chunks:
            return chunks
        if asyncio.get_event_loop().time() > deadline:
            raise SystemExit("reader: job stream never appeared")
        await asyncio.sleep(POLL_S)


async def wait_signal(prefix: str) -> None:
    sig = signal_store(prefix)
    deadline = asyncio.get_event_loop().time() + TIMEOUT_S
    while True:
        chunks, _, _ = await sig.read_from(0)
        if chunks:
            break
        if asyncio.get_event_loop().time() > deadline:
            raise SystemExit("writer: reader never signalled")
        await asyncio.sleep(POLL_S)
    await sig.close()


async def send_signal(prefix: str) -> None:
    sig = signal_store(prefix)
    await sig.append(Channel.STDOUT, b"go")
    await sig.close()


async def solo(prefix: str) -> None:
    """Same-process round trip: shell jobs on a redis console, output
    adopted by ``wait`` and persisted in redis past the reap."""
    ws = make_workspace(prefix)
    result = await ws.execute("(echo out; echo err 1>&2) & wait")
    check("py solo: exit 0", result.exit_code == 0)
    check("py solo: stdout adopted", b"out\n" in result.stdout,
          repr(result.stdout))
    check("py solo: stderr adopted", b"err\n" in result.stderr,
          repr(result.stderr))
    reader = job_store(prefix, 1)
    console = JobConsole(store=reader)
    snap_out = await console.snapshot(Channel.STDOUT)
    snap_err = await console.snapshot(Channel.STDERR)
    check("py solo: chunks persisted in redis",
          snap_out == b"out\n" and snap_err == b"err\n",
          f"got {snap_out!r} / {snap_err!r}")
    await reader.close()
    await ws.close()
    await close_created()


async def write(prefix: str) -> None:
    """Run a job that parks until the foreign reader has attached, so
    the reader provably follows it mid-run."""
    ws = make_workspace(prefix)
    result = await ws.execute(
        "(echo started; until [ -s /data/go ]; do sleep 0.1; done; "
        "echo finished) &")
    check("py write: job submitted", result.exit_code == 0)
    await wait_signal(prefix)
    result = await ws.execute("echo go > /data/go")
    check("py write: released the job", result.exit_code == 0)
    result = await ws.execute("wait")
    check("py write: wait joined", result.exit_code == 0)
    await ws.close()
    await close_created()


async def read(prefix: str) -> None:
    """Attach to the foreign writer's job console and follow it live."""
    store = job_store(prefix, 1)
    chunks = await attach(store)
    stdout = b"".join(c.data for c in chunks if c.channel == Channel.STDOUT)
    control = [c for c in chunks if c.channel == Channel.CONTROL]
    check("py read: attached mid-run, no ending chunk yet", not control)
    check("py read: first line before the job was released",
          stdout == b"started\n", repr(stdout))
    await send_signal(prefix)
    got = []
    async for chunk in JobConsole(store=store).follow():
        got.append(chunk)
    stdout = b"".join(c.data for c in got if c.channel == Channel.STDOUT)
    outcome = [c.data for c in got if c.channel == Channel.CONTROL]
    check("py read: streamed both lines", stdout == b"started\nfinished\n",
          repr(stdout))
    check("py read: job ended with exit:0", outcome == [b"exit:0"],
          repr(outcome))
    await store.close()


async def kill_write(prefix: str) -> None:
    """Kill a running job once the foreign reader is watching it."""
    ws = make_workspace(prefix)
    result = await ws.execute("(echo started; sleep 500) &")
    check("py kill-write: job submitted", result.exit_code == 0)
    await wait_signal(prefix)
    result = await ws.execute("kill %1")
    check("py kill-write: kill %1", result.exit_code == 0)
    await ws.close()
    await close_created()


async def kill_read(prefix: str) -> None:
    """A follower of a killed job sees the marker and the outcome."""
    store = job_store(prefix, 1)
    chunks = await attach(store)
    control = [c for c in chunks if c.channel == Channel.CONTROL]
    check("py kill-read: attached mid-run, no ending chunk yet", not control)
    await send_signal(prefix)
    got = []
    async for chunk in JobConsole(store=store).follow():
        got.append(chunk)
    stderr = b"".join(c.data for c in got if c.channel == Channel.STDERR)
    outcome = [c.data for c in got if c.channel == Channel.CONTROL]
    check("py kill-read: Killed marker on stderr", stderr == b"Killed",
          repr(stderr))
    check("py kill-read: killed outcome", outcome == [b"killed"],
          repr(outcome))
    await store.close()


async def main() -> None:
    role = sys.argv[1]
    prefix = sys.argv[2]
    if role == "solo":
        await solo(prefix)
    elif role == "write":
        await write(prefix)
    elif role == "read":
        await read(prefix)
    elif role == "kill-write":
        await kill_write(prefix)
    elif role == "kill-read":
        await kill_read(prefix)
    else:
        raise SystemExit(f"unknown role: {role!r}")
    if fail:
        raise SystemExit(1)


if __name__ == "__main__":
    asyncio.run(main())
