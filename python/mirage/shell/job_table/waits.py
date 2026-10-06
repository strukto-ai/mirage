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

from mirage.shell.console import Channel, JobConsole, JobOutput, OwnedStream
from mirage.shell.job_table.types import Job


class JobWaits:
    """The background jobs started inside a capture (``$( )``, a pipe
    stage), which the capture waits for before it ends: bash reads the
    pipe until every writer has closed it, and a job holds it open for as
    long as one of its streams leads into it.

    Args:
        output (JobOutput): where the capture's jobs write, at its edge.
        channels (frozenset[Channel]): what the capture reads there:
            stdout, and stderr too for a stage piped with ``|&``.
    """

    def __init__(
        self,
        output: JobOutput,
        channels: frozenset[Channel] = frozenset({Channel.STDOUT}),
    ) -> None:
        self.jobs: list[Job] = []
        self.output = output
        self.channels = channels

    def reaches(
        self, start: JobConsole, streams: set[Channel | OwnedStream]
    ) -> bool:
        """Whether a job writing ``streams`` where ``start`` leads writes
        into the capture.

        A redirect on the way (``JobRoute``) may send them elsewhere; a
        stream that no level on the way owns is counted, as it may be the
        capture's.

        Args:
            start (JobConsole): where the job's shell writes.
            streams (set[Channel | OwnedStream]): what the job writes.
        """
        at = start
        left = set(streams)
        while at is not self.output:
            if not isinstance(at, JobOutput):
                return True
            left = at.passes(left)
            at = at.target
        return any(
            not isinstance(stream, Channel) or stream in self.channels
            for stream in left
        )

    def add(self, job: Job) -> None:
        """Count a job the capture has to outlast.

        Args:
            job (Job): the job.
        """
        self.jobs.append(job)

    async def join(self, rest: JobConsole) -> None:
        """Return once every job writing into the capture has ended; what
        the capture's other jobs write from then on goes to ``rest``,
        where the capture's caller writes.

        Args:
            rest (JobConsole): where the capture's caller writes.
        """
        # A job added while this waits is still reached: the loop reads
        # the list as it grows.
        for job in self.jobs:
            await job.console.wait_finished()
        self.output.target = rest
