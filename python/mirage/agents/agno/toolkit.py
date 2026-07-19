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

import shlex
from posixpath import dirname
from typing import Any, Callable

try:
    from agno.tools import Toolkit
except ImportError as exc:
    raise ImportError(
        "`agno` not installed. Install with: pip install 'mirage-ai[agno]'"
    ) from exc

from mirage.agents.io_text import io_to_str
from mirage.bridge.sync import run_async_from_sync
from mirage.workspace.workspace import Workspace


class MirageToolkit(Toolkit):
    """Agno toolkit backed by a Mirage Workspace.

    Exposes shell-style filesystem access (execute, read, write, ls, grep)
    as sync and async tool pairs for Agno agents.

    Args:
        workspace (Workspace): The workspace to operate on.
    """

    def __init__(self, workspace: Workspace, **kwargs) -> None:
        self._ws = workspace
        tools: list[Callable[..., Any]] = [
            self.execute, self.read, self.write, self.ls, self.grep
        ]
        async_tools: list[tuple[Callable[..., Any], str]] = [
            (self.aexecute, "execute"),
            (self.aread, "read"),
            (self.awrite, "write"),
            (self.als, "ls"),
            (self.agrep, "grep"),
        ]
        super().__init__(name="mirage",
                         tools=tools,
                         async_tools=async_tools,
                         **kwargs)

    def _run(self, coro):
        return run_async_from_sync(coro)

    # -- execute ---------------------------------------------------------

    def execute(self, command: str) -> str:
        """Run a shell-style command on the mounted filesystem.

        Supports cat, grep, find, head, pipe, and any other Unix command.

        Args:
            command (str): The shell command to execute.
        """
        return self._run(self.aexecute(command))

    async def aexecute(self, command: str) -> str:
        io = await self._ws.execute(command)
        return io_to_str(io)

    # -- read --------------------------------------------------------------

    def read(self, path: str) -> str:
        """Read the full contents of a file at the given path.

        Args:
            path (str): Absolute path to the file on the mounted filesystem.
        """
        return self._run(self.aread(path))

    async def aread(self, path: str) -> str:
        io = await self._ws.execute(f"cat {shlex.quote(path)}")
        return io_to_str(io)

    # -- write -------------------------------------------------------------

    def write(self, path: str, content: str) -> str:
        """Write content to a file, creating it if it does not exist.

        Args:
            path (str): Absolute path to the file on the mounted filesystem.
            content (str): The content to write to the file.
        """
        return self._run(self.awrite(path, content))

    async def awrite(self, path: str, content: str) -> str:
        parent = dirname(path) or "/"
        mkdir = await self._ws.execute(f"mkdir -p {shlex.quote(parent)}")
        if mkdir.exit_code != 0:
            return io_to_str(mkdir)
        io = await self._ws.execute(f"tee {shlex.quote(path)}",
                                    stdin=content.encode("utf-8"))
        return io_to_str(io)

    # -- ls ------------------------------------------------------------------

    def ls(self, path: str = "/") -> str:
        """List the files and directories at the given path.

        Args:
            path (str): Absolute directory path to list. Defaults to root.
        """
        return self._run(self.als(path))

    async def als(self, path: str = "/") -> str:
        io = await self._ws.execute(f"ls {shlex.quote(path)}")
        return io_to_str(io)

    # -- grep ---------------------------------------------------------------

    def grep(self, pattern: str, path: str) -> str:
        """Search for a pattern in files at the given path.

        Supports regex patterns.

        Args:
            pattern (str): The string or regex pattern to search for.
            path (str): The file or directory path to search within.
        """
        return self._run(self.agrep(pattern, path))

    async def agrep(self, pattern: str, path: str) -> str:
        io = await self._ws.execute(
            f"grep -r {shlex.quote(pattern)} {shlex.quote(path)}")
        return io_to_str(io)
