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
from typing import Protocol, TypeAlias, TypedDict

from mirage.types import JsonValue


class ProcessInput(Protocol):
    """A process's stdin: written in order, then closed."""

    async def write(self, data: bytes) -> None: ...

    async def close(self) -> None: ...


class ExecProcess(Protocol):
    """A process an exec started: its three pipes, its status, and how
    to signal it. ``release`` stops reading its output, which a child it
    left may hold open."""

    @property
    def stdin(self) -> ProcessInput: ...

    @property
    def stdout(self) -> asyncio.StreamReader: ...

    @property
    def stderr(self) -> asyncio.StreamReader: ...

    @property
    def exit_code(self) -> asyncio.Future[int]: ...

    async def kill(self, signum: int = 15) -> None: ...

    def release(self) -> None: ...


class Container(Protocol):
    """A Cloudflare Container: what ``ContainerMachine`` drives."""

    async def exec(self, cmd: list[str], env: dict[str, str]) -> ExecProcess:
        """Start ``cmd`` with its three pipes; raise when the container
        is not running.

        Args:
            cmd (list[str]): the program and its arguments.
            env (dict[str, str]): set over the container's own.
        """
        ...

    async def monitor(self) -> None:
        """Return when the container exits, raising when it exits with
        an error."""
        ...


class RelayRequest(TypedDict, total=False):
    """What a client sends first on a relay socket: the token and, on an
    exec, its command."""

    token: str
    argv: list[str]
    env: dict[str, str]


# What a relay sends as text. On an exec: ``started`` once the container
# took it, or ``stopped`` when it refused; then ``closed`` as each output
# stream ends and ``exit`` with the status. On a monitor: ``exited`` once
# the container has, with its error or None. ``refused`` answers a bad
# token, and ``alive`` keeps a quiet socket open.
RelayEvent: TypeAlias = dict[str, JsonValue]

# What a client sends as text after its request: ``eof`` ends stdin, and
# ``kill`` signals the process.
RelayControl: TypeAlias = dict[str, JsonValue]
