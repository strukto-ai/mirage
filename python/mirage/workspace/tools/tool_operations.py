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

import logging
import posixpath
import shlex
from collections.abc import Mapping
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from mirage.io.types import IOResult
from mirage.ops.ops import Ops
from mirage.utils.path import gnu_dirname
from mirage.workspace.tools.file_version import (
    FileVersionTracker,
    StaleMirageFileError,
)
from mirage.workspace.tools.io_text import decode, io_to_str, replace_text

if TYPE_CHECKING:
    from mirage.workspace.workspace.handle import Session

logger = logging.getLogger(__name__)

DEFAULT_READ_LIMIT = 2000


@dataclass(frozen=True, slots=True)
class ToolResult:
    """One tool's answer, before any framework's result shape.

    The two servers spell the failure flag differently -- MCP puts
    `isError` on the wire, the Claude Agent SDK takes `is_error` -- so
    the shared layer carries the fact and each server renders it.

    Args:
        text (str): The text handed back to the agent.
        is_error (bool): True when the call failed.
    """

    text: str
    is_error: bool = False


def _io_result(io: IOResult) -> ToolResult:
    return ToolResult(io_to_str(io), io.exit_code != 0)


def number_lines(text: str, offset: int, limit: int) -> str:
    """Render a slice of a file the way the read tool reports it.

    Splits on newlines only. `str.splitlines` would also break on
    \\v, \\f, \\x1c-\\x1e, \\x85 and the Unicode separators, which
    would number a file containing any of them differently from the
    TypeScript tool.

    Args:
        text (str): The decoded file content.
        offset (int): First line to show, zero-based.
        limit (int): Maximum number of lines to show.

    Returns:
        str: The numbered lines, joined.
    """
    if not text:
        lines: list[str] = []
    else:
        parts = text.split("\n")
        lines = [part + "\n" for part in parts[:-1]]
        if parts[-1]:
            lines.append(parts[-1])
    sliced = lines[offset : offset + limit]
    return "".join(
        f"{i + offset + 1:>6}\t{line}" for i, line in enumerate(sliced)
    )


async def ensure_parents(vfs: Ops, path: str) -> None:
    """Create the directories a new file needs, parents first.

    Args:
        vfs (Ops): The op facade to create them through.
        path (str): Virtual path of the file about to be written.
    """
    parent = gnu_dirname(path)
    if parent in ("/", "", "."):
        return
    if await vfs.exists(parent):
        return
    await ensure_parents(vfs, parent)
    try:
        await vfs.mkdir(parent)
    except OSError:
        if not await vfs.exists(parent):
            raise


async def missing(vfs: Ops, path: str) -> bool:
    """Whether a path a read just failed on is absent, which picks the
    failure's wording.

    A probe the workspace refuses means the path is there: a hidden one
    answers absent, never refused. The read's own error then stands
    rather than the probe's.

    Args:
        vfs (Ops): The op facade the read went through.
        path (str): Virtual path of the failed read.
    """
    try:
        return not await vfs.exists(path)
    except OSError as exc:
        logger.debug("exists probe refused for %s: %s", path, exc)
        return False


class MirageToolOperations:
    """The agent tools for one session, independent of any agent
    framework.

    ``session.tools`` is the session's own table. Every guarded table of
    a session shares the session's read history, so a read through one
    guards a write through another. Build one directly only to turn the
    guard off.

    Args:
        session (Session): The session the tools act as, with its cwd,
            environment and mount grants.
        stale_write_protection (bool): False lets an agent overwrite a
            file that changed since it read it.
    """

    def __init__(
        self, session: "Session", stale_write_protection: bool = True
    ) -> None:
        self._session = session
        self._own = (
            None
            if stale_write_protection
            else FileVersionTracker(session.vfs, False)
        )

    async def _versions(self) -> FileVersionTracker:
        """The read history this call uses: the session's, which every
        guarded table of the session shares, or this table's own when
        the guard is off. A call keeps the one it started with, so a
        restore during the call cannot mix two histories."""
        if self._own is not None:
            return self._own
        return await self._session._reads()

    async def shell(self, command: str) -> ToolResult:
        """Run a command line in the session's shell.

        Args:
            command (str): The command line to run.

        Returns:
            ToolResult: The command's rendered output.
        """
        return _io_result(await self._session.shell(command))

    async def read(
        self, path: str, offset: int = 0, limit: int = DEFAULT_READ_LIMIT
    ) -> ToolResult:
        """Read a file as line-numbered text.

        Args:
            path (str): Virtual path.
            offset (int): First line to show, zero-based.
            limit (int): Maximum number of lines to show.

        Returns:
            ToolResult: The numbered lines, or the failure.
        """
        versions = await self._versions()
        try:
            data = await versions.read(path)
        except (OSError, ValueError) as exc:
            if await missing(versions.vfs, path):
                return ToolResult(f"Error: file '{path}' not found", True)
            return ToolResult(f"Error: {exc}", True)
        text = decode(data)
        lines = text.count("\n") + (1 if text and text[-1] != "\n" else 0)
        if offset <= 0 and offset + limit >= lines:
            versions.mark_seen(path)
        return ToolResult(number_lines(text, offset, limit))

    async def write(self, path: str, content: str) -> ToolResult:
        """Write a file; an existing one must have been read in full first.

        A new file is created with its missing parents. An existing one
        is overwritten only when the agent was shown all of it and it did
        not change since, so a write never clobbers text the agent has not
        seen.

        Args:
            path (str): Virtual path.
            content (str): Text to write.

        Returns:
            ToolResult: The confirmation, or the failure.
        """
        versions = await self._versions()
        try:
            if await versions.vfs.exists(path) and not versions.has_read(path):
                return ToolResult(
                    f"Error: file '{path}' exists; read all of it before "
                    "overwriting it",
                    True,
                )
            await ensure_parents(versions.vfs, path)
            await versions.write(path, content)
        except (StaleMirageFileError, OSError, ValueError) as exc:
            return ToolResult(f"Error: {exc}", True)
        return ToolResult(f"Written: {path}")

    async def edit(
        self,
        path: str,
        old_string: str,
        new_string: str,
        replace_all: bool = False,
    ) -> ToolResult:
        """Replace a string in an existing file.

        Args:
            path (str): Virtual path.
            old_string (str): The text to find.
            new_string (str): The text to put in its place.
            replace_all (bool): True replaces every occurrence.

        Returns:
            ToolResult: The confirmation, or the failure.
        """
        versions = await self._versions()
        try:
            content = decode(await versions.read_for_edit(path))
        except StaleMirageFileError as exc:
            return ToolResult(f"Error: {exc}", True)
        except (OSError, ValueError) as exc:
            if await missing(versions.vfs, path):
                return ToolResult(f"Error: file '{path}' not found", True)
            return ToolResult(f"Error: {exc}", True)
        new_content, count = replace_text(
            content, old_string, new_string, replace_all
        )
        if count == 0:
            return ToolResult(
                f"Error: string not found in file: '{old_string}'", True
            )
        if count > 1 and not replace_all:
            return ToolResult(
                f"Error: string appears {count} times. Pass replace_all=true",
                True,
            )
        try:
            await versions.write_edit(path, new_content)
        except (StaleMirageFileError, OSError, ValueError) as exc:
            return ToolResult(f"Error: {exc}", True)
        occurrences = count if replace_all else 1
        return ToolResult(f"Edited: {path} ({occurrences} occurrence(s))")

    async def ls(self, path: str) -> ToolResult:
        """List a directory.

        Args:
            path (str): Virtual path.

        Returns:
            ToolResult: The listing, or the failure.
        """
        return _io_result(await self._session.shell(f"ls {shlex.quote(path)}"))

    async def grep(
        self,
        pattern: str,
        path: str,
        *,
        ignore_case: bool = False,
        fixed_strings: bool = False,
        include: str | None = None,
        context: int | None = None,
        files_with_matches: bool = False,
        count: bool = False,
        max_count: int | None = None,
    ) -> ToolResult:
        """Search recursively for a pattern, as ``grep -rn`` does.

        Each option is the GNU grep flag of the same name, and the line
        runs in the session's shell, so the search is the shell's own:
        the same policy, push-down and history as typing it. grep exits
        1 when nothing matched, an empty answer rather than a failure,
        so only an exit above 1 (a bad regex, an unreadable path) is a
        tool error.

        Args:
            pattern (str): The regex to search for.
            path (str): Virtual path to search under.
            ignore_case (bool): ``-i``.
            fixed_strings (bool): ``-F``.
            include (str | None): ``--include``, a file-name glob.
            context (int | None): ``-C``, lines around each match.
            files_with_matches (bool): ``-l``.
            count (bool): ``-c``.
            max_count (int | None): ``-m``, matches per file.

        Returns:
            ToolResult: The matches.
        """
        words = ["grep", "-rn"]
        if ignore_case:
            words.append("-i")
        if fixed_strings:
            words.append("-F")
        if files_with_matches:
            words.append("-l")
        if count:
            words.append("-c")
        if max_count is not None:
            words += ["-m", str(max_count)]
        if context is not None:
            words += ["-C", str(context)]
        if include is not None:
            words.append(shlex.quote(f"--include={include}"))
        words += ["-e", shlex.quote(pattern), shlex.quote(path)]
        io = await self._session.shell(" ".join(words))
        return ToolResult(io_to_str(io), io.exit_code > 1)

    async def glob(self, pattern: str, path: str = "/") -> ToolResult:
        """Find files, not directories, whose path matches a pattern.

        The pattern is expanded by ``Session.glob``, the shell's own
        resolver: ``**`` matches any number of directories, and a
        relative pattern is matched under ``path``. A symlink to a file
        counts; a dangling one does not, nor does a match the workspace
        refuses to stat, since nothing says what it is.

        Args:
            pattern (str): A pathname pattern such as ``**/*.py``.
            path (str): Directory a relative pattern is matched under.

        Returns:
            ToolResult: One path per line, sorted.
        """
        matches = await self._session.glob(posixpath.join(path, pattern))
        files: list[str] = []
        for match in matches:
            try:
                if await self._session.vfs.is_file(match):
                    files.append(match)
            except OSError as exc:
                logger.debug("glob match refused for %s: %s", match, exc)
        return ToolResult("".join(f"{match}\n" for match in files))

    async def call(
        self, name: str, arguments: Mapping[str, Any]
    ) -> ToolResult:
        """Run one tool by name with its JSON input.

        The one entry every door shares: MCP, the HTTP routes, the CLI
        and the agent adapters hand a tool's name and its input, as the
        tool's ``*_INPUT`` schema reads it, to this method, so each
        tool answers the same way through each of them.

        Args:
            name (str): ``shell``, ``read``, ``write``, ``edit``, ``ls``,
                ``grep`` or ``glob``.
            arguments (Mapping[str, Any]): the tool's input, already
                checked against its schema.

        Returns:
            ToolResult: The tool's answer.

        Raises:
            KeyError: No tool has the name.
        """
        if name == "shell":
            return await self.shell(arguments["command"])
        if name == "read":
            return await self.read(
                arguments["path"],
                int(arguments.get("offset", 0)),
                int(arguments.get("limit", DEFAULT_READ_LIMIT)),
            )
        if name == "write":
            return await self.write(arguments["path"], arguments["content"])
        if name == "edit":
            return await self.edit(
                arguments["path"],
                arguments["old_string"],
                arguments["new_string"],
                bool(arguments.get("replace_all", False)),
            )
        if name == "ls":
            return await self.ls(arguments["path"])
        if name == "grep":
            return await self.grep(
                arguments["pattern"],
                arguments["path"],
                ignore_case=bool(arguments.get("ignore_case", False)),
                fixed_strings=bool(arguments.get("fixed_strings", False)),
                include=arguments.get("include"),
                context=arguments.get("context"),
                files_with_matches=bool(
                    arguments.get("files_with_matches", False)
                ),
                count=bool(arguments.get("count", False)),
                max_count=arguments.get("max_count"),
            )
        if name == "glob":
            return await self.glob(
                arguments["pattern"], arguments.get("path", "/")
            )
        raise KeyError(name)
