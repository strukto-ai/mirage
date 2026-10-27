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
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from typing import TypeVar

from mirage import Mount, MountMode, Workspace, WritePolicy
from mirage.shell.join import shell_join
from mirage.utils.ids import SeededIdSource
from mirage.vfs.s3 import S3VFS, S3Config
from tests.e2e.s3_mock import MultiBucketS3Client
from tests.sim.loop import SimClock, SimLoop, run
from tests.sim.model import stamped
from tests.sim.rand import u64
from tests.sim.seam import Hold, Latency, Match, Network, immediate, route_s3
from tests.sim.trace import STEP, Intent, LineDone, StepRef, Trace

T = TypeVar("T")

BUCKET = "b"
PREFIX = "/s3/"


@dataclass(frozen=True, slots=True)
class LineResult:
    """What a line printed and how it exited."""

    exit_code: int
    stdout: bytes
    stderr: bytes


class Actor:
    """One agent: a sequence of top-level lines on one session.

    The modeled methods attach an intent to the line, which is what the
    model judges; ``sh`` runs a raw line that only the generic checks see.

    Args:
        sim (Sim): the run.
        workspace (Workspace): where its lines run.
        name (str): its name in the trace.
        session_id (str | None): its session, None for the default one.
    """

    def __init__(
        self,
        sim: "Sim",
        workspace: Workspace,
        name: str,
        session_id: str | None,
    ) -> None:
        self.name = name
        self._sim = sim
        self._workspace = workspace
        self._session_id = session_id
        self._steps = 0
        self._seen: dict[str, bytes | None] = {}

    async def _line(
        self, text: str, intent: Intent, key: str | None
    ) -> LineResult:
        step = StepRef(self.name, self._steps)
        self._steps += 1
        token = STEP.set(step)
        try:
            result = await self._workspace.shell(
                text, session_id=self._session_id
            )
            stdout = await result.materialize_stdout()
            stderr = await result.materialize_stderr()
        finally:
            STEP.reset(token)
        self._sim.trace.append(
            LineDone(
                self._sim.loop.time(),
                step,
                text,
                intent,
                key,
                result.exit_code,
                stdout,
            )
        )
        return LineResult(result.exit_code, stdout, stderr)

    async def sh(self, text: str) -> LineResult:
        """Run a raw line.

        Args:
            text (str): the shell line.
        """
        return await self._line(text, Intent.RAW, None)

    def start(self, text: str) -> asyncio.Task[LineResult]:
        """Start a raw line without waiting for it.

        Args:
            text (str): the shell line.
        """
        return self._sim.loop.create_task(self.sh(text))

    async def read(self, key: str) -> LineResult:
        """``cat`` a key; its content becomes this actor's basis.

        Args:
            key (str): the object key under the mount.
        """
        result = await self._line(
            shell_join(["cat", PREFIX + key]), Intent.READS, key
        )
        self._seen[key] = result.stdout if result.exit_code == 0 else None
        return result

    async def exists(self, key: str) -> LineResult:
        """``test -e`` a key; a miss makes ABSENT this actor's basis.

        Args:
            key (str): the object key under the mount.
        """
        result = await self._line(
            shell_join(["test", "-e", PREFIX + key]), Intent.TESTS, key
        )
        if result.exit_code == 1:
            self._seen[key] = None
        return result

    async def write(self, key: str) -> LineResult:
        """Write a key on this actor's basis, stamped with this line.

        The body is the content the actor last saw plus one stamp line,
        so the stored bytes name the line that wrote them.

        Args:
            key (str): the object key under the mount.
        """
        seen = self._seen.get(key, b"")
        body = stamped(
            seen, StepRef(self.name, self._steps), key in self._seen
        )
        content = body.decode(errors="surrogateescape")
        line = shell_join(["printf", "%s", content])
        text = f"{line} > {shell_join([PREFIX + key])}"
        result = await self._line(text, Intent.WRITES, key)
        if result.exit_code == 0:
            self._seen[key] = body
        return result

    async def remove(self, key: str) -> LineResult:
        """``rm -f`` a key.

        Args:
            key (str): the object key under the mount.
        """
        result = await self._line(
            shell_join(["rm", "-f", PREFIX + key]), Intent.REMOVES, key
        )
        if result.exit_code == 0:
            self._seen[key] = None
        return result


class SimWorkspace:
    """A real ``Workspace`` on the run's clock, store and seeded ids.

    Args:
        sim (Sim): the run.
        workspace (Workspace): the product workspace.
    """

    def __init__(self, sim: "Sim", workspace: Workspace) -> None:
        self._sim = sim
        self.workspace = workspace

    async def actor(self, name: str, session_id: str | None = None) -> Actor:
        """An actor on ``session_id``, creating that session if new.

        Args:
            name (str): the actor's name in the trace.
            session_id (str | None): its session, None for the default.
        """
        if session_id is not None:
            await self.workspace.session(session_id)
        return Actor(self._sim, self.workspace, name, session_id)


class Sim:
    """A scenario's handle on one run.

    Args:
        seed (int): the run's seed.
        files (Mapping[str, bytes]): the bucket's starting objects.
        latency (Latency): each request leg's delay.
    """

    def __init__(
        self, seed: int, files: Mapping[str, bytes], latency: Latency
    ) -> None:
        loop = asyncio.get_running_loop()
        assert isinstance(loop, SimLoop)
        self.seed = seed
        self.loop = loop
        self.trace = Trace()
        self.store = MultiBucketS3Client({BUCKET: dict(files)})
        self.network = Network(self.trace, latency, self.store)
        self._workspaces: list[Workspace] = []

    def workspace(
        self, write: WritePolicy = WritePolicy.CONDITIONAL
    ) -> SimWorkspace:
        """A new workspace with the bucket mounted at ``/s3``.

        Args:
            write (WritePolicy): the mount's write policy.
        """
        clock = SimClock(self.loop)
        ids_seed = u64(self.seed, "ids", len(self._workspaces)) >> 11
        mount = Mount(
            S3VFS(S3Config(bucket=BUCKET, region="us-east-1")),
            mode=MountMode.WRITE,
            write=write,
        )
        workspace = Workspace(
            {PREFIX.rstrip("/"): mount},
            mode=MountMode.WRITE,
            clock=clock,
            ids=SeededIdSource(ids_seed, clock),
        )
        self._workspaces.append(workspace)
        return SimWorkspace(self, workspace)

    def hold(self, match: Match, until: Match | None = None) -> Hold:
        """Hold the request ``match`` names before it reaches the store.

        Args:
            match (Match): which request.
            until (Match | None): the request that releases it, None to
                release it only by hand.
        """
        return self.network.hold(match, until)

    async def settle(self) -> None:
        """Run what is runnable at this instant; time does not move."""
        await self.loop.settle()

    async def close(self) -> None:
        """Close every workspace the run built."""
        for workspace in self._workspaces:
            await workspace.close()


def simulate(
    scenario: Callable[[Sim], Awaitable[T]],
    *,
    seed: int = 0,
    files: Mapping[str, bytes] | None = None,
    latency: Latency = immediate,
) -> tuple[T, Trace]:
    """Run ``scenario`` once on a fresh loop, store and network.

    Args:
        scenario (Callable[[Sim], Awaitable[T]]): the program.
        seed (int): the run's seed.
        files (Mapping[str, bytes] | None): the bucket's starting objects.
        latency (Latency): each request leg's delay.
    """

    async def main() -> tuple[T, Trace]:
        sim = Sim(seed, files or {}, latency)
        with route_s3(sim.network, sim.store):
            try:
                return await scenario(sim), sim.trace
            finally:
                await sim.close()

    outcome, _ = run(main())
    return outcome
