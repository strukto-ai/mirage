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
import json
import logging
import os
import time
from collections.abc import Iterable
from itertools import count
from typing import Any
from urllib.parse import quote, unquote

import aiofiles
import aiofiles.os

from mirage.workspace.session.store import (SessionFields, SessionStore,
                                            generation_of)

logger = logging.getLogger(__name__)

# A .lock older than this is presumed abandoned by a crashed writer and
# reclaimed (loudly). Live CAS critical sections are milliseconds.
LOCK_STALE_SECONDS = 10.0
LOCK_RETRY_SLEEP = 0.005
LOCK_RETRY_LIMIT = 2000

_TMP_COUNTER = count()


def _acquire_lock(lock_path: str) -> int | None:
    """Create the lockfile with O_CREAT|O_EXCL; fd on success, None when
    another writer holds it (filesystem-atomic mutex, the git protocol).
    Local filesystems only: O_EXCL is unreliable on ancient NFS, the
    same caveat git ships with."""
    try:
        fd = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError:
        return None
    os.write(fd, str(os.getpid()).encode())
    return fd


def _reclaim_stale_lock(lock_path: str) -> bool:
    """True when the lock is gone or was stale and removed; False when a
    live writer still holds it."""
    try:
        age = time.time() - os.stat(lock_path).st_mtime
    except FileNotFoundError:
        return True
    if age <= LOCK_STALE_SECONDS:
        return False
    logger.warning("reclaiming stale lock %s (age %.1fs)", lock_path, age)
    try:
        os.unlink(lock_path)
    except FileNotFoundError:
        # The holder released it between the stat and the unlink; the
        # lock is gone either way, which is all this function promises.
        pass
    return True


def _release_lock(fd: int, lock_path: str) -> None:
    os.close(fd)
    try:
        os.unlink(lock_path)
    except FileNotFoundError:
        # Only reachable when another writer reclaimed this lock as
        # stale; the record write already landed, nothing to undo.
        logger.warning("lock %s vanished before release (reclaimed?)",
                       lock_path)


class DiskRecordClient:
    """One JSON-record-per-file client with lockfile CAS.

    The disk twin of ``S3RecordClient``: a record is one file at
    ``{root}/{prefix}{name}.json``, written atomically (tmp then
    rename(2)) so readers never see a torn record. The conditional
    write serializes on a ``{record}.lock`` created with O_CREAT|O_EXCL,
    so compare and write hit the same stored version. Record names are
    percent-encoded into filenames, so any id is safe.
    """

    def __init__(self, root: str, prefix: str) -> None:
        self._root = root
        self._dir = os.path.join(root, prefix)

    def path(self, name: str) -> str:
        return os.path.join(self._dir, f"{quote(name, safe='')}.json")

    async def get(self, name: str) -> tuple[dict[str, Any] | None, str]:
        """Read one record; ``(fields, "")``, ``(None, "")`` when absent.

        The token slot mirrors the S3 client's ETag but stays empty:
        disk CAS anchors on the lockfile, not on a version token.
        """
        try:
            async with aiofiles.open(self.path(name), "rb") as f:
                body = await f.read()
        except FileNotFoundError:
            return None, ""
        return json.loads(body), ""

    async def put(self, name: str, fields: dict[str, Any]) -> None:
        await aiofiles.os.makedirs(self._dir, exist_ok=True)
        await self._write_record(self.path(name), fields)

    async def cas_put(self, name: str, fields: dict[str, Any],
                      expected_generation: int) -> bool:
        """Write one record iff its stored generation matches.

        Take the record's lockfile, re-read under the lock, check the
        generation, then tmp-write + rename. Losing the lock race or the
        generation check returns False; the caller adopts and retries.
        """
        await aiofiles.os.makedirs(self._dir, exist_ok=True)
        path = self.path(name)
        lock_path = path + ".lock"
        fd = await asyncio.to_thread(_acquire_lock, lock_path)
        if fd is None:
            if not await asyncio.to_thread(_reclaim_stale_lock, lock_path):
                return False
            fd = await asyncio.to_thread(_acquire_lock, lock_path)
            if fd is None:
                return False
        try:
            stored, _ = await self.get(name)
            if generation_of(stored) != expected_generation:
                return False
            await self._write_record(path, fields)
            return True
        finally:
            await asyncio.to_thread(_release_lock, fd, lock_path)

    async def lock(self, name: str) -> int:
        """Block until this record's lockfile is held; fd to release.

        For callers doing a read-modify-write that is not generation-CAS
        (e.g. the single-file namespace plane); spins past contention
        and reclaims stale locks, raising only if a live writer holds
        the lock for the whole retry budget (~10s)."""
        await aiofiles.os.makedirs(self._dir, exist_ok=True)
        lock_path = self.path(name) + ".lock"
        for _ in range(LOCK_RETRY_LIMIT):
            fd = await asyncio.to_thread(_acquire_lock, lock_path)
            if fd is not None:
                return fd
            if await asyncio.to_thread(_reclaim_stale_lock, lock_path):
                continue
            await asyncio.sleep(LOCK_RETRY_SLEEP)
        raise RuntimeError(f"could not acquire lock {lock_path}")

    async def unlock(self, name: str, fd: int) -> None:
        await asyncio.to_thread(_release_lock, fd, self.path(name) + ".lock")

    async def _write_record(self, path: str, fields: dict[str, Any]) -> None:
        tmp = f"{path}.{os.getpid()}.{next(_TMP_COUNTER)}.tmp"
        async with aiofiles.open(tmp, "wb") as f:
            await f.write(json.dumps(fields).encode())
        await aiofiles.os.replace(tmp, path)

    async def list_names(self) -> list[str]:
        if not await aiofiles.os.path.isdir(self._dir):
            return []
        names: list[str] = []
        for entry in await aiofiles.os.scandir(self._dir):
            if entry.is_file() and entry.name.endswith(".json"):
                names.append(unquote(entry.name.removesuffix(".json")))
        return names

    async def load_all(self) -> dict[str, dict[str, Any]]:
        names = await self.list_names()
        records = await asyncio.gather(*(self.get(name) for name in names))
        return {
            name: fields
            for name, (fields, _) in zip(names, records) if fields is not None
        }

    async def delete(self, names: Iterable[str]) -> None:
        for name in names:
            try:
                await aiofiles.os.remove(self.path(name))
            except FileNotFoundError:
                # Delete promises absence; already-absent is success
                # (mirrors S3 delete_objects on a missing key).
                pass

    async def clear(self) -> None:
        await self.delete(await self.list_names())

    async def close(self) -> None:
        return None


class DiskSessionStore(SessionStore):
    """SessionStore backed by per-session files under one directory.

    One file per session at ``{root}/sessions/{session_id}.json``,
    lockfile CAS per record, so multiple local processes share one
    session table with the same generation contract as the Redis Lua
    script, with zero infrastructure.
    """

    def __init__(self, root: str) -> None:
        self._records = DiskRecordClient(root, "sessions/")

    async def load(self) -> dict[str, SessionFields]:
        return await self._records.load_all()

    async def set(self, session_id: str, fields: SessionFields) -> None:
        await self._records.put(session_id, fields)

    async def cas_set(self, session_id: str, fields: SessionFields,
                      expected_generation: int) -> bool:
        return await self._records.cas_put(session_id, fields,
                                           expected_generation)

    async def delete(self, session_ids: Iterable[str]) -> None:
        await self._records.delete(session_ids)

    async def replace_all(self, entries: dict[str, SessionFields]) -> None:
        stale = set(await self._records.list_names()) - set(entries)
        await self._records.delete(stale)
        await asyncio.gather(*(self._records.put(sid, fields)
                               for sid, fields in entries.items()))

    async def clear(self) -> None:
        await self._records.clear()

    async def close(self) -> None:
        await self._records.close()
