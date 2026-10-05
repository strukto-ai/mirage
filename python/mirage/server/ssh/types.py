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

import socket
from collections.abc import Awaitable, Callable, Coroutine
from typing import Any, Protocol

from mirage.server.registry import WorkspaceRegistry
from mirage.server.ssh.config import SSHConfig


class SSHListener(Protocol):
    """A running SSH door, as the daemon holds it."""

    def get_port(self) -> int: ...

    def close(self) -> None: ...

    async def wait_closed(self) -> None: ...


StartSSH = Callable[[WorkspaceRegistry, SSHConfig], Awaitable[SSHListener]]


class SSHTunnel(Protocol):
    """One SSH connection the HTTPS route carries, once its login is in."""

    def close(self) -> None: ...

    async def wait_closed(self) -> None: ...


ServeTunnel = Callable[
    [WorkspaceRegistry, SSHConfig, socket.socket, str, str | None],
    Coroutine[Any, Any, SSHTunnel],
]
