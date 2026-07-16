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
import shlex

from deepagents.backends.protocol import (EditResult, ExecuteResponse,
                                          FileDownloadResponse, FileInfo,
                                          FileUploadResponse, GrepMatch,
                                          SandboxBackendProtocol, WriteResult)

from mirage.agents.langchain._convert import (io_to_execute_response,
                                              io_to_file_infos,
                                              io_to_grep_matches)
from mirage.io.types import IOResult
from mirage.workspace.workspace import Workspace


class LangchainWorkspace(SandboxBackendProtocol):
    """Deep Agents backend backed by a Mirage Workspace.

    File operations (read, write, edit, ls, upload, download) go through the
    Ops layer directly. Shell operations (execute, grep, glob) go through
    Workspace.execute() for pipe and flag support.
    """

    def __init__(
        self,
        workspace: Workspace,
        sandbox_id: str = "mirage",
        session_id: str | None = None,
    ) -> None:
        self._ws = workspace
        self._id = sandbox_id
        self._session_id = session_id

    def _run(self, coro):
        return asyncio.run(coro)

    @property
    def id(self) -> str:
        return self._id

    async def _exec(self, command: str) -> IOResult:
        result = await self._ws.execute(command, session_id=self._session_id)
        assert isinstance(result, IOResult)
        return result

    # ── execute ──────────────────────────────────────────────

    def execute(self,
                command: str,
                *,
                timeout: int | None = None) -> ExecuteResponse:
        return self._run(self.aexecute(command, timeout=timeout))

    async def aexecute(self,
                       command: str,
                       *,
                       timeout: int | None = None) -> ExecuteResponse:
        io = await self._exec(command)
        return io_to_execute_response(io)

    # ── ls_info ─────────────────────────────────────────────

    def ls_info(self, path: str) -> list[FileInfo]:
        return self._run(self.als_info(path))

    async def als_info(self, path: str) -> list[FileInfo]:
        io = await self._exec(f"ls {shlex.quote(path)}")
        stdout = (await io.stdout_str()).strip()
        if not stdout:
            return []
        base = path.rstrip("/")
        result: list[FileInfo] = []
        for name in stdout.split("\n"):
            name = name.strip()
            if not name:
                continue
            is_dir = name.endswith("/")
            clean = name.rstrip("/")
            result.append(FileInfo(path=f"{base}/{clean}", is_dir=is_dir))
        return result

    # ── read ─────────────────────────────────────────────────

    def read(self, file_path: str, offset: int = 0, limit: int = 2000) -> str:
        return self._run(self.aread(file_path, offset, limit))

    async def aread(self,
                    file_path: str,
                    offset: int = 0,
                    limit: int = 2000) -> str:
        ops = self._ws.ops
        try:
            data = await ops.read(file_path)
        except (FileNotFoundError, ValueError) as exc:
            return f"Error: {exc}"
        text = data.decode("utf-8", errors="replace")
        lines = text.splitlines(keepends=True)
        sliced = lines[offset:offset + limit]
        numbered = []
        for i, line in enumerate(sliced, start=offset + 1):
            numbered.append(f"{i:>6}\t{line}")
        return "".join(numbered)

    # ── write ────────────────────────────────────────────────

    def write(self, file_path: str, content: str) -> WriteResult:
        return self._run(self.awrite(file_path, content))

    async def awrite(self, file_path: str, content: str) -> WriteResult:
        ops = self._ws.ops
        try:
            await ops.stat(file_path)
            return WriteResult(
                error=f"Error: file '{file_path}' already exists")
        except (FileNotFoundError, ValueError):
            # missing file is the good path: the write may proceed
            pass
        parent = "/".join(file_path.rstrip("/").split("/")[:-1]) or "/"
        try:
            await ops.mkdir(parent)
        except (FileExistsError, ValueError):
            # mkdir -p semantics: an existing parent is success
            pass
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
            self.aedit(file_path, old_string, new_string, replace_all))

    async def aedit(
        self,
        file_path: str,
        old_string: str,
        new_string: str,
        replace_all: bool = False,
    ) -> EditResult:
        ops = self._ws.ops
        try:
            data = await ops.read(file_path)
        except (FileNotFoundError, ValueError):
            return EditResult(error=f"Error: file '{file_path}' not found")
        content = data.decode("utf-8", errors="replace")
        count = content.count(old_string)
        if count == 0:
            return EditResult(
                error=f"Error: string not found in file: '{old_string}'")
        if count > 1 and not replace_all:
            return EditResult(
                error=f"Error: string '{old_string}' appears {count} times. "
                f"Use replace_all=True")
        if replace_all:
            new_content = content.replace(old_string, new_string)
        else:
            new_content = content.replace(old_string, new_string, 1)
        await ops.write(file_path, new_content.encode("utf-8"))
        return EditResult(path=file_path,
                          occurrences=count if replace_all else 1)

    # ── grep_raw ─────────────────────────────────────────────

    def grep_raw(
        self,
        pattern: str,
        path: str | None = None,
        glob: str | None = None,
    ) -> list[GrepMatch] | str:
        return self._run(self.agrep_raw(pattern, path, glob))

    async def agrep_raw(
        self,
        pattern: str,
        path: str | None = None,
        glob: str | None = None,
    ) -> list[GrepMatch] | str:
        parts = ["grep", "-rn"]
        if glob:
            parts.extend(["--include", shlex.quote(glob)])
        parts.append(shlex.quote(pattern))
        parts.append(shlex.quote(path or "/"))
        io = await self._exec(" ".join(parts))
        return io_to_grep_matches(io)

    # ── glob_info ────────────────────────────────────────────

    def glob_info(self, pattern: str, path: str = "/") -> list[FileInfo]:
        return self._run(self.aglob_info(pattern, path))

    async def aglob_info(self,
                         pattern: str,
                         path: str = "/") -> list[FileInfo]:
        name = pattern.split("/")[-1] if "/" in pattern else pattern
        io = await self._exec(
            f"find {shlex.quote(path)} -name {shlex.quote(name)}")
        return io_to_file_infos(io)

    # ── upload / download ────────────────────────────────────

    def upload_files(
            self, files: list[tuple[str, bytes]]) -> list[FileUploadResponse]:
        return self._run(self.aupload_files(files))

    async def aupload_files(
            self, files: list[tuple[str, bytes]]) -> list[FileUploadResponse]:
        ops = self._ws.ops
        results: list[FileUploadResponse] = []
        for path, data in files:
            parent = "/".join(path.rstrip("/").split("/")[:-1]) or "/"
            try:
                await ops.mkdir(parent)
            except (FileExistsError, ValueError):
                # mkdir -p semantics: an existing parent is success
                pass
            await ops.write(path, data)
            results.append(FileUploadResponse(path=path))
        return results

    def download_files(self, paths: list[str]) -> list[FileDownloadResponse]:
        return self._run(self.adownload_files(paths))

    async def adownload_files(self,
                              paths: list[str]) -> list[FileDownloadResponse]:
        ops = self._ws.ops
        results: list[FileDownloadResponse] = []
        for path in paths:
            try:
                data = await ops.read(path)
                results.append(FileDownloadResponse(path=path, content=data))
            except (FileNotFoundError, ValueError):
                results.append(
                    FileDownloadResponse(path=path,
                                         content=None,
                                         error="file_not_found"))
        return results
