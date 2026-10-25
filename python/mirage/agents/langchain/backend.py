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

import base64
import logging
import shlex
from collections.abc import Awaitable, Callable
from functools import partial
from pathlib import PurePosixPath
from typing import ParamSpec, TypeVar

from deepagents.backends.protocol import (
    DeleteResult,
    EditResult,
    ExecuteResponse,
    FileData,
    FileDownloadResponse,
    FileInfo,
    FileUploadResponse,
    GlobResult,
    GrepResult,
    LsResult,
    ReadResult,
    SandboxBackendProtocol,
    WriteResult,
)
from deepagents.backends.utils import (
    InvalidGlobPatternError,
    compile_grep_include_glob,
    slice_read_response,
)

from mirage.agents.langchain.convert import (
    io_to_execute_response,
    io_to_file_infos,
    io_to_grep_matches,
)
from mirage.bridge.sync import on_owner_loop
from mirage.io.types import IOResult
from mirage.workspace.files import Files
from mirage.workspace.tools.io_text import replace_text, with_refusal
from mirage.workspace.tools.tool_operations import ensure_parents
from mirage.workspace.workspace import Session, Workspace

logger = logging.getLogger(__name__)

T = TypeVar("T")
P = ParamSpec("P")

BINARY_EXTENSIONS = frozenset(
    {
        ".3gpp",
        ".aac",
        ".aiff",
        ".avi",
        ".flac",
        ".flv",
        ".gif",
        ".heic",
        ".heif",
        ".jpeg",
        ".jpg",
        ".mov",
        ".mp3",
        ".mp4",
        ".mpeg",
        ".mpg",
        ".ogg",
        ".pdf",
        ".png",
        ".ppt",
        ".pptx",
        ".wav",
        ".webm",
        ".webp",
        ".wmv",
    }
)
COMMAND_SUCCESS_EXIT_CODES = frozenset({0})
GREP_SUCCESS_EXIT_CODES = frozenset({0, 1})


def _is_binary(file_path: str, data: bytes) -> bool:
    suffix = PurePosixPath(file_path).suffix.lower()
    if suffix in BINARY_EXTENSIONS or b"\x00" in data:
        return True
    try:
        data.decode("utf-8")
    except UnicodeDecodeError:
        return True
    return False


def _to_read_result(
    file_path: str, data: bytes, offset: int, limit: int
) -> ReadResult:
    if _is_binary(file_path, data):
        content = base64.standard_b64encode(data).decode("ascii")
        return ReadResult(
            file_data=FileData(content=content, encoding="base64")
        )

    return slice_read_response(
        FileData(content=data.decode("utf-8"), encoding="utf-8"),
        offset,
        limit,
    )


def _relative_to(root: str, path: str) -> str:
    prefix = root.rstrip("/") + "/"
    if path.startswith(prefix):
        return path[len(prefix) :]
    return PurePosixPath(path).name


async def _command_error(
    io: IOResult,
    success_exit_codes: frozenset[int] = COMMAND_SUCCESS_EXIT_CODES,
) -> str | None:
    if io.exit_code in success_exit_codes:
        return None
    stderr = with_refusal((await io.stderr_str()).strip(), io.refusal).strip()
    if stderr:
        return stderr
    return f"Command failed with exit code {io.exit_code}"


class LangchainWorkspace(SandboxBackendProtocol):
    """Deep Agents backend backed by a Mirage Workspace.

    File operations (read, write, edit, ls, upload, download) go through the
    Files facade directly. Shell operations (execute, grep, glob, delete) go through
    Workspace.shell() for pipe and flag support. Both run as the session,
    so its profile judges every call.

    Sync tools may run on worker threads, but refuse calls on the owner
    event-loop thread: await the corresponding async method there. Close
    the workspace when finished to drain the sync loop and pooled clients.

    Args:
        workspace (Workspace): The workspace to operate on.
        sandbox_id (str): The id the backend reports.
        session_id (str | None): The session the backend acts as; None
            is the workspace's default session.
    """

    def __init__(
        self,
        workspace: Workspace,
        sandbox_id: str = "mirage",
        session_id: str | None = None,
    ) -> None:
        self._ws = workspace
        self._sync_bridge = workspace._sync_bridge
        self._sync_bridge.attach()
        self._id = sandbox_id
        self._session_id = session_id

    def _run(
        self, fn: Callable[P, Awaitable[T]], *args: P.args, **kwargs: P.kwargs
    ) -> T:
        return self._ws._run_sync(partial(fn, *args, **kwargs), fn.__name__)

    @property
    def _vfs(self) -> Files:
        """The file API run as this backend's session."""
        if self._session_id is None:
            return self._ws.vfs
        return Session(self._ws, self._session_id).vfs

    @property
    def id(self) -> str:
        return self._id

    async def _exec(self, command: str) -> IOResult:
        return await self._ws.shell(command, session_id=self._session_id)

    # ── execute ──────────────────────────────────────────────

    def execute(
        self, command: str, *, timeout: int | None = None
    ) -> ExecuteResponse:
        return self._run(self.aexecute, command, timeout=timeout)

    @on_owner_loop
    async def aexecute(
        self, command: str, *, timeout: int | None = None
    ) -> ExecuteResponse:
        io = await self._exec(command)
        return io_to_execute_response(io)

    # ── ls ──────────────────────────────────────────────────

    def ls(self, path: str) -> LsResult:
        return self._run(self.als, path)

    @on_owner_loop
    async def als(self, path: str) -> LsResult:
        io = await self._exec(f"ls {shlex.quote(path)}")
        stdout = (await io.stdout_str()).strip()
        error = await _command_error(io)
        if error:
            return LsResult(error=error)
        if not stdout:
            return LsResult(entries=[])
        base = path.rstrip("/")
        result: list[FileInfo] = []
        for name in stdout.split("\n"):
            name = name.strip()
            if not name:
                continue
            is_dir = name.endswith("/")
            clean = name.rstrip("/")
            result.append(FileInfo(path=f"{base}/{clean}", is_dir=is_dir))
        return LsResult(entries=result)

    # ── read ─────────────────────────────────────────────────

    def read(
        self, file_path: str, offset: int = 0, limit: int = 2000
    ) -> ReadResult:
        return self._run(self.aread, file_path, offset, limit)

    @on_owner_loop
    async def aread(
        self, file_path: str, offset: int = 0, limit: int = 2000
    ) -> ReadResult:
        ops = self._vfs
        try:
            data = await ops.read(file_path)
        except (FileNotFoundError, NotADirectoryError, ValueError) as exc:
            return ReadResult(error=f"Error: {exc}")
        return _to_read_result(file_path, data, offset, limit)

    # ── write ────────────────────────────────────────────────

    def write(self, file_path: str, content: str) -> WriteResult:
        return self._run(self.awrite, file_path, content)

    @on_owner_loop
    async def awrite(self, file_path: str, content: str) -> WriteResult:
        ops = self._vfs
        try:
            await ops.stat(file_path)
            return WriteResult(
                error=f"Error: file '{file_path}' already exists"
            )
        except (FileNotFoundError, NotADirectoryError, ValueError) as exc:
            # missing file is the good path: the write may proceed
            logger.debug("nothing to overwrite at %s: %s", file_path, exc)
        await ensure_parents(ops, file_path)
        await ops.write(file_path, content.encode("utf-8"))
        return WriteResult(path=file_path)

    # ── edit ─────────────────────────────────────────────────

    def edit(
        self,
        file_path: str,
        old_string: str,
        new_string: str,
        replace_all: bool = False,
    ) -> EditResult:
        return self._run(
            self.aedit, file_path, old_string, new_string, replace_all
        )

    @on_owner_loop
    async def aedit(
        self,
        file_path: str,
        old_string: str,
        new_string: str,
        replace_all: bool = False,
    ) -> EditResult:
        ops = self._vfs
        try:
            data = await ops.read(file_path)
        except (FileNotFoundError, NotADirectoryError, ValueError):
            return EditResult(error=f"Error: file '{file_path}' not found")
        content = data.decode("utf-8", errors="replace")
        new_content, count = replace_text(
            content, old_string, new_string, replace_all
        )
        if count == 0:
            return EditResult(
                error=f"Error: string not found in file: '{old_string}'"
            )
        if count > 1 and not replace_all:
            return EditResult(
                error=f"Error: string '{old_string}' appears {count} times. "
                f"Use replace_all=True"
            )
        await ops.write(file_path, new_content.encode("utf-8"))
        return EditResult(
            path=file_path, occurrences=count if replace_all else 1
        )

    # ── grep ─────────────────────────────────────────────────

    def grep(
        self,
        pattern: str,
        path: str | None = None,
        glob: str | None = None,
        *,
        max_count: int | None = None,
    ) -> GrepResult:
        return self._run(self.agrep, pattern, path, glob, max_count=max_count)

    @on_owner_loop
    async def agrep(
        self,
        pattern: str,
        path: str | None = None,
        glob: str | None = None,
        *,
        max_count: int | None = None,
    ) -> GrepResult:
        """Search file contents, optionally capping the matches returned.

        ``max_count`` is a total cap across every file, which is not what
        ``grep -m`` means (that one caps each file separately), so it is
        applied to the collected matches rather than pushed onto the
        command line. A run that hits the cap with matches left over is
        reported truncated; one that lands on it exactly is complete.

        ``glob`` follows Deep Agents' include-glob rules: without a ``/``
        it matches the basename at any depth, with one the path relative
        to ``path``. A basename glob narrows the command line too.

        Args:
            pattern (str): literal text to search for.
            path (str | None): directory to search, root when absent.
            glob (str | None): filename filter for which files to search.
            max_count (int | None): total cap on matches returned.
        """
        root = path or "/"
        included = None
        if glob:
            try:
                included = compile_grep_include_glob(glob)
            except InvalidGlobPatternError as exc:
                return GrepResult(error=str(exc))
        parts = ["grep", "-rnH"]
        if glob and "/" not in glob:
            parts.extend(["--include", shlex.quote(glob)])
        parts.append(shlex.quote(pattern))
        parts.append(shlex.quote(root))
        io = await self._exec(" ".join(parts))
        await io.materialize_stdout()
        error = await _command_error(io, GREP_SUCCESS_EXIT_CODES)
        if error:
            return GrepResult(error=error)
        matches = io_to_grep_matches(io)
        if included is not None:
            matches = [
                m for m in matches if included(_relative_to(root, m["path"]))
            ]
        if max_count is None or len(matches) <= max_count:
            return GrepResult(matches=matches)
        return GrepResult(matches=matches[:max_count], truncated=True)

    # ── glob ─────────────────────────────────────────────────

    def glob(self, pattern: str, path: str | None = None) -> GlobResult:
        return self._run(self.aglob, pattern, path)

    @on_owner_loop
    async def aglob(self, pattern: str, path: str | None = None) -> GlobResult:
        """Find the files under ``path`` that a pattern matches.

        Matching is Deep Agents' own: without a ``/`` the pattern matches
        the basename at any depth, with one the path relative to ``path``,
        and only regular files are returned.

        Args:
            pattern (str): the glob pattern.
            path (str | None): directory to search, root when absent.
        """
        try:
            matches = compile_grep_include_glob(pattern)
        except InvalidGlobPatternError as exc:
            return GlobResult(error=str(exc))
        root = path or "/"
        io = await self._exec(f"find {shlex.quote(root)} -type f")
        await io.materialize_stdout()
        error = await _command_error(io)
        if error:
            return GlobResult(error=error)
        return GlobResult(
            matches=[
                info
                for info in io_to_file_infos(io)
                if matches(_relative_to(root, info["path"]))
            ]
        )

    # ── delete ───────────────────────────────────────────────

    def delete(self, file_path: str) -> DeleteResult:
        return self._run(self.adelete, file_path)

    @on_owner_loop
    async def adelete(self, file_path: str) -> DeleteResult:
        """Remove a file, or a directory with everything under it.

        Args:
            file_path (str): the path to remove.
        """
        io = await self._exec(f"rm -r -- {shlex.quote(file_path)}")
        error = await _command_error(io)
        if error:
            return DeleteResult(error=error)
        return DeleteResult(path=file_path)

    # ── upload / download ────────────────────────────────────

    def upload_files(
        self, files: list[tuple[str, bytes]]
    ) -> list[FileUploadResponse]:
        return self._run(self.aupload_files, files)

    @on_owner_loop
    async def aupload_files(
        self, files: list[tuple[str, bytes]]
    ) -> list[FileUploadResponse]:
        ops = self._vfs
        results: list[FileUploadResponse] = []
        for path, data in files:
            await ensure_parents(ops, path)
            await ops.write(path, data)
            results.append(FileUploadResponse(path=path))
        return results

    def download_files(self, paths: list[str]) -> list[FileDownloadResponse]:
        return self._run(self.adownload_files, paths)

    @on_owner_loop
    async def adownload_files(
        self, paths: list[str]
    ) -> list[FileDownloadResponse]:
        ops = self._vfs
        results: list[FileDownloadResponse] = []
        for path in paths:
            try:
                data = await ops.read(path)
                results.append(FileDownloadResponse(path=path, content=data))
            except (FileNotFoundError, NotADirectoryError, ValueError):
                results.append(
                    FileDownloadResponse(
                        path=path, content=None, error="file_not_found"
                    )
                )
        return results
