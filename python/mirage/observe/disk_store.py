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

import os
import stat

import aiofiles
import aiofiles.os

from mirage.observe.store import ObserverStoreBase


class DiskObserverStore(ObserverStoreBase):
    """ObserverStore backed by a directory of JSONL files.

    Args:
        root (str): Directory holding the recorder's files; created on
            first append.
    """

    def __init__(self, root: str) -> None:
        self._root = root

    def _abs(self, path: str) -> str:
        return os.path.join(self._root, path.lstrip("/"))

    async def append(self, path: str, data: bytes) -> None:
        """Append bytes to the file at path, creating parents.

        Args:
            path (str): File key.
            data (bytes): Bytes to append.
        """
        abs_path = self._abs(path)
        await aiofiles.os.makedirs(os.path.dirname(abs_path), exist_ok=True)
        async with aiofiles.open(abs_path, "ab") as f:
            await f.write(data)

    async def write(self, path: str, data: bytes) -> None:
        """Overwrite the file at path, creating parents.

        Args:
            path (str): File key.
            data (bytes): Full new content.
        """
        abs_path = self._abs(path)
        await aiofiles.os.makedirs(os.path.dirname(abs_path), exist_ok=True)
        async with aiofiles.open(abs_path, "wb") as f:
            await f.write(data)

    async def read_matching(self, suffix: str) -> dict[str, bytes]:
        """Read only the files whose key ends with suffix.

        Args:
            suffix (str): File-key suffix; empty matches everything.

        Returns:
            dict[str, bytes]: Mapping of matching key to content.
        """
        out: dict[str, bytes] = {}
        files, _dirs = await self._walk()
        for abs_path in files:
            rel = "/" + os.path.relpath(abs_path, self._root)
            if not rel.endswith(suffix):
                continue
            async with aiofiles.open(abs_path, "rb") as f:
                out[rel] = await f.read()
        return out

    async def clear(self) -> None:
        """Delete every stored file (snapshot-restore rewind)."""
        files, dirs = await self._walk()
        for abs_path in files:
            await aiofiles.os.remove(abs_path)
        for d in reversed(dirs):
            await aiofiles.os.rmdir(d)

    async def _root_is_dir(self) -> bool:
        """Whether the recorder's directory exists.

        ``os.path.isdir`` would answer False for an unreadable root as
        well as a missing one, and an unreadable root must not read as
        an empty recording; only "nothing written yet" does.

        Returns:
            bool: True when root exists and is a directory.
        """
        try:
            st = await aiofiles.os.stat(self._root)
        except FileNotFoundError:
            return False
        return stat.S_ISDIR(st.st_mode)

    async def _walk(self) -> tuple[list[str], list[str]]:
        """List all file paths and directories under root.

        Returns:
            tuple[list[str], list[str]]: File paths, and directories
            ordered parent before child (including root).
        """
        files: list[str] = []
        dirs: list[str] = []
        if not await self._root_is_dir():
            return files, dirs
        stack = [self._root]
        while stack:
            d = stack.pop()
            dirs.append(d)
            for entry in await aiofiles.os.scandir(d):
                if entry.is_dir():
                    stack.append(entry.path)
                else:
                    files.append(entry.path)
        return files, dirs
