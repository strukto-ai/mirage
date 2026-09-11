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
import hashlib

from mirage.workspace.workspace import Workspace


class StaleMirageFileError(Exception):

    def __init__(self, path: str) -> None:
        super().__init__(f"File changed since it was last read: {path}. "
                         f"Read the file again before modifying it.")
        self.path = path


def fingerprint(content: bytes) -> str:
    """Version stamp for one file's stored bytes.

    Args:
        content (bytes): The bytes to stamp.

    Returns:
        str: A base64url digest, matching the TypeScript tracker's stamp.
    """
    digest = hashlib.sha256(content).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")


class FileVersionTracker:
    """Refuses a write to a file that moved under the agent.

    Two stamps are kept per path because a read and an edit are
    different promises: `read` records what the agent was shown, and
    `read_for_edit` records what it is about to rewrite. A plain write
    is checked against the read stamp, an edit against the edit stamp.

    Stamps cover the rendered bytes, which is what the read tool hands
    the agent. The TypeScript tracker stamps the stored bytes instead;
    here that would let `edit` search bytes the agent never saw, since
    this side's read tool has always rendered.

    Args:
        workspace (Workspace): The workspace to read and write through.
        enabled (bool): False serves every call unchecked, which is
            what `mirage mcp --no-stale-write-protection` asks for.
    """

    def __init__(self, workspace: Workspace, enabled: bool = True) -> None:
        self._ws = workspace
        self._enabled = enabled
        self._read_versions: dict[str, str] = {}
        self._edit_versions: dict[str, str] = {}

    def _key(self, path: str) -> str:
        """The stamp key for a path: one key per file, not per spelling.

        `ops.read` and `ops.write` follow the namespace symlink table, so
        `/alias` and `/target` are the same file. Keying by the caller's
        spelling would give each its own stamp, and an edit that arrived
        through the other name would find no prior version and skip the
        staleness check entirely.

        Args:
            path (str): Virtual path as the agent spelled it.

        Returns:
            str: The path with symlink prefixes resolved.
        """
        return self._ws.namespace.follow(path)

    async def _current_version(self, path: str) -> str | None:
        if not await self._ws.fs.exists(path):
            return None
        return fingerprint(await self._ws.fs.read(path))

    async def _assert_version(self, path: str, expected: str) -> None:
        if await self._current_version(path) != expected:
            raise StaleMirageFileError(path)

    async def _record_write(self, path: str, key: str) -> None:
        # Stamp what a later read will return, not the bytes handed in.
        # A mount whose read op renders answers with something other than
        # what was stored, so stamping the input would make the very next
        # write or edit look stale with nobody having touched the file.
        if not self._enabled:
            return
        version = await self._current_version(path)
        if version is None:
            self._read_versions.pop(key, None)
        else:
            self._read_versions[key] = version
        self._edit_versions.pop(key, None)

    async def read(self, path: str) -> bytes:
        """Read a file and record what the agent was shown.

        Args:
            path (str): Virtual path.

        Returns:
            bytes: The stored bytes.
        """
        content = await self._ws.fs.read(path)
        if self._enabled:
            self._read_versions[self._key(path)] = fingerprint(content)
        return content

    async def read_for_edit(self, path: str) -> bytes:
        """Read a file the agent is about to rewrite.

        Args:
            path (str): Virtual path.

        Returns:
            bytes: The stored bytes.

        Raises:
            StaleMirageFileError: The file moved since it was last read.
        """
        content = await self._ws.fs.read(path)
        if not self._enabled:
            return content
        key = self._key(path)
        version = fingerprint(content)
        read_version = self._read_versions.get(key)
        if read_version is not None and read_version != version:
            raise StaleMirageFileError(path)
        self._edit_versions[key] = version
        return content

    async def write(self, path: str, content: str) -> None:
        """Write a file, refusing if it moved since it was read.

        Args:
            path (str): Virtual path.
            content (str): Text to write.

        Raises:
            StaleMirageFileError: The file moved since it was last read.
        """
        key = self._key(path)
        if self._enabled:
            read_version = self._read_versions.get(key)
            if read_version is not None:
                await self._assert_version(path, read_version)
        await self._ws.fs.write(path, content.encode("utf-8"))
        await self._record_write(path, key)

    async def write_edit(self, path: str, content: str) -> None:
        """Write an edit, refusing if it moved since it was read for edit.

        Args:
            path (str): Virtual path.
            content (str): Text to write.

        Raises:
            StaleMirageFileError: The file moved since it was read for edit.
        """
        key = self._key(path)
        if self._enabled:
            edit_version = self._edit_versions.get(key)
            if edit_version is not None:
                await self._assert_version(path, edit_version)
        await self._ws.fs.write(path, content.encode("utf-8"))
        await self._record_write(path, key)
