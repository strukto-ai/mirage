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

from collections.abc import Awaitable
from typing import Any, Callable, TypeVar

try:
    from agno.tools import Toolkit
except ImportError as exc:
    raise ImportError(
        "`agno` not installed. Install with: pip install 'mirage-ai[agno]'"
    ) from exc

from mirage.bridge.sync import run_async_from_sync
from mirage.workspace.tools.tool_operations import (
    DEFAULT_READ_LIMIT,
    MirageToolOperations,
)
from mirage.workspace.workspace import Session, Workspace

T = TypeVar("T")


class MirageToolkit(Toolkit):
    """Agno toolkit backed by a Mirage Workspace.

    Serves Mirage's tool table (shell, read, write, edit, ls, grep, glob)
    as sync and async tool pairs, each answering as the MCP tool of the
    same name does. Agno builds a tool's schema from its signature, so
    each method takes the tool's input fields as parameters.

    Args:
        workspace (Workspace): The workspace to operate on.
        stale_write_protection (bool): False lets an agent overwrite a
            file that changed since it read it.
        session_id (str | None): The session the tools act as, with its
            profile; None is the workspace's default session.
    """

    def __init__(
        self,
        workspace: Workspace,
        stale_write_protection: bool = True,
        session_id: str | None = None,
        **kwargs: Any,
    ) -> None:
        session = Session(workspace, session_id)
        self._ops = (
            session.tools
            if stale_write_protection
            else MirageToolOperations(session, stale_write_protection=False)
        )
        tools: list[Callable[..., Any]] = [
            self.shell,
            self.read,
            self.write,
            self.edit,
            self.ls,
            self.grep,
            self.glob,
        ]
        async_tools: list[tuple[Callable[..., Any], str]] = [
            (self.ashell, "shell"),
            (self.aread, "read"),
            (self.awrite, "write"),
            (self.aedit, "edit"),
            (self.als, "ls"),
            (self.agrep, "grep"),
            (self.aglob, "glob"),
        ]
        names = self._ops.names()
        super().__init__(
            name="mirage",
            tools=[t for t in tools if t.__name__ in names],
            async_tools=[(t, n) for t, n in async_tools if n in names],
            **kwargs,
        )

    def _run(self, coro: Awaitable[T]) -> T:
        return run_async_from_sync(coro)

    async def _call(self, name: str, arguments: dict[str, Any]) -> str:
        return (await self._ops.call(name, arguments)).text

    def shell(self, command: str) -> str:
        """Run a command line in the workspace's shell (cat, grep, find,
        pipes and redirects included) and return its output.

        Args:
            command (str): The command line to run.
        """
        return self._run(self.ashell(command))

    async def ashell(self, command: str) -> str:
        return await self._call("shell", {"command": command})

    def read(
        self, path: str, offset: int = 0, limit: int = DEFAULT_READ_LIMIT
    ) -> str:
        """Read a text file and return its lines numbered.

        Args:
            path (str): Absolute path of the file to read.
            offset (int): Line to start at, 0-based.
            limit (int): Most lines to return.
        """
        return self._run(self.aread(path, offset, limit))

    async def aread(
        self, path: str, offset: int = 0, limit: int = DEFAULT_READ_LIMIT
    ) -> str:
        return await self._call(
            "read", {"path": path, "offset": offset, "limit": limit}
        )

    def write(self, path: str, content: str) -> str:
        """Write a file, creating missing parent directories. An existing
        file must be read in full first, and the write fails if it changed
        since.

        Args:
            path (str): Absolute path of the file to write.
            content (str): The text to write.
        """
        return self._run(self.awrite(path, content))

    async def awrite(self, path: str, content: str) -> str:
        return await self._call("write", {"path": path, "content": content})

    def edit(
        self,
        path: str,
        old_string: str,
        new_string: str,
        replace_all: bool = False,
    ) -> str:
        """Replace a string in an existing file, refusing one that changed
        since it was last read.

        Args:
            path (str): Absolute path of the file to edit.
            old_string (str): The exact text to replace.
            new_string (str): The text to put in its place.
            replace_all (bool): Replace every occurrence instead of
                exactly one.
        """
        return self._run(self.aedit(path, old_string, new_string, replace_all))

    async def aedit(
        self,
        path: str,
        old_string: str,
        new_string: str,
        replace_all: bool = False,
    ) -> str:
        return await self._call(
            "edit",
            {
                "path": path,
                "old_string": old_string,
                "new_string": new_string,
                "replace_all": replace_all,
            },
        )

    def ls(self, path: str) -> str:
        """List the files and directories at a path.

        Args:
            path (str): Absolute path of the directory to list.
        """
        return self._run(self.als(path))

    async def als(self, path: str) -> str:
        return await self._call("ls", {"path": path})

    def grep(
        self,
        pattern: str,
        path: str,
        ignore_case: bool = False,
        fixed_strings: bool = False,
        include: str | None = None,
        context: int | None = None,
        files_with_matches: bool = False,
        count: bool = False,
        max_count: int | None = None,
    ) -> str:
        """Search files recursively for a regular expression, as
        GNU grep -rn does.

        Args:
            pattern (str): Regular expression to search for.
            path (str): Absolute path of the file or directory to search.
            ignore_case (bool): Match case-insensitively (-i).
            fixed_strings (bool): Read pattern as a literal string (-F).
            include (str | None): Search only files whose name matches
                this glob (--include).
            context (int | None): Lines of context around each match (-C).
            files_with_matches (bool): Print only matching file names (-l).
            count (bool): Print only a count of matching lines (-c).
            max_count (int | None): Stop each file after this many
                matching lines (-m).
        """
        return self._run(
            self.agrep(
                pattern,
                path,
                ignore_case,
                fixed_strings,
                include,
                context,
                files_with_matches,
                count,
                max_count,
            )
        )

    async def agrep(
        self,
        pattern: str,
        path: str,
        ignore_case: bool = False,
        fixed_strings: bool = False,
        include: str | None = None,
        context: int | None = None,
        files_with_matches: bool = False,
        count: bool = False,
        max_count: int | None = None,
    ) -> str:
        arguments: dict[str, Any] = {
            "pattern": pattern,
            "path": path,
            "ignore_case": ignore_case,
            "fixed_strings": fixed_strings,
            "files_with_matches": files_with_matches,
            "count": count,
        }
        if include is not None:
            arguments["include"] = include
        if context is not None:
            arguments["context"] = context
        if max_count is not None:
            arguments["max_count"] = max_count
        return await self._call("grep", arguments)

    def glob(self, pattern: str, path: str = "/") -> str:
        """Find files whose path matches a pattern such as **/*.py.

        Args:
            pattern (str): Pathname pattern; ** matches any number of
                directories.
            path (str): Directory a relative pattern is matched under.
        """
        return self._run(self.aglob(pattern, path))

    async def aglob(self, pattern: str, path: str = "/") -> str:
        return await self._call("glob", {"pattern": pattern, "path": path})
