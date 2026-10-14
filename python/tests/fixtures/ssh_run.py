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

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

from mirage.accessor.ssh import SSHAccessor
from mirage.vfs.ssh.config import SSHConfig

Answer = tuple[int | None, bytes, bytes] | Exception


class RunAccessor(SSHAccessor):
    """An accessor whose server answers every command with ``answer``.

    Args:
        root (str): the mount's remote root.
        answer (Answer): the run's status, output and error output, or
            what it raises.
    """

    def __init__(self, root: str, answer: Answer) -> None:
        super().__init__(SSHConfig(host="example.test", root=root))
        self.answer = answer
        self.sent: list[str] = []

    async def run(self, command: str) -> tuple[int | None, bytes, bytes]:
        self.sent.append(command)
        if isinstance(self.answer, Exception):
            raise self.answer
        return self.answer


def sftp_only_connection() -> MagicMock:
    """A connection to a server that runs no commands, as one forced to
    internal-sftp: every command exits 1 and says so on stdout."""
    refused = SimpleNamespace(
        exit_status=1,
        stdout=b"This service allows sftp connections only.\n",
        stderr=b"",
    )
    return MagicMock(
        wait_closed=AsyncMock(),
        is_closed=MagicMock(return_value=False),
        run=AsyncMock(return_value=refused),
    )
