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
from collections.abc import Iterable
from typing import Any

from mirage.accessor.s3 import S3Config
from mirage.core.s3._client import _client_kwargs, async_session
from mirage.workspace.session.store import (SessionFields, SessionStore,
                                            generation_of)


def _is_missing(exc: Exception) -> bool:
    if hasattr(exc, "response"):
        code = exc.response.get("Error", {}).get("Code")
        return code in ("404", "NoSuchKey")
    return False


def _is_condition_lost(exc: Exception) -> bool:
    """True when a conditional write lost: the object changed since the
    read (412) or a concurrent conditional write is in flight (409)."""
    if hasattr(exc, "response"):
        code = exc.response.get("Error", {}).get("Code")
        return code in ("412", "PreconditionFailed", "409",
                        "ConditionalRequestConflict")
    return False


class S3RecordClient:
    """One JSON-record-per-object client with ETag-anchored CAS.

    The generic building block both S3 stores share (mirroring how the
    Redis stores share one cas.lua): a record is one object at
    ``{prefix}{name}.json``, and a conditional write anchors on the
    exact ETag the compare-read returned, so the generation check and
    the write hit the same stored version. Immutable-blob planes never
    need this; it exists only for the few mutable control-plane cells.
    """

    def __init__(self, config: S3Config, prefix: str) -> None:
        self._config = config
        self._prefix = prefix
        self._client: Any = None
        self._client_cm: Any = None
        self._client_lock = asyncio.Lock()

    async def client(self) -> Any:
        async with self._client_lock:
            if self._client is None:
                session = async_session(self._config)
                self._client_cm = session.client(
                    **_client_kwargs(self._config))
                self._client = await self._client_cm.__aenter__()
        return self._client

    def key(self, name: str) -> str:
        return f"{self._prefix}{name}.json"

    async def get(self, name: str) -> tuple[dict[str, Any] | None, str]:
        """Read one record; ``(fields, etag)``, ``(None, "")`` when absent."""
        client = await self.client()
        try:
            resp = await client.get_object(Bucket=self._config.bucket,
                                           Key=self.key(name))
        except Exception as exc:
            if _is_missing(exc):
                return None, ""
            raise
        body = await resp["Body"].read()
        return json.loads(body), resp.get("ETag", "")

    async def put(self, name: str, fields: dict[str, Any]) -> None:
        client = await self.client()
        await client.put_object(Bucket=self._config.bucket,
                                Key=self.key(name),
                                Body=json.dumps(fields).encode())

    async def cas_put(self, name: str, fields: dict[str, Any],
                      expected_generation: int) -> bool:
        """Write one record iff its stored generation matches.

        Compare-read the record, check the generation client-side, then
        make the write conditional on the exact version read: If-None-Match
        for create (expected 0, nothing stored), If-Match on the read
        ETag otherwise. A 412/409 means another writer moved the record
        between our read and write; the caller adopts and retries.
        """
        stored, etag = await self.get(name)
        if generation_of(stored) != expected_generation:
            return False
        client = await self.client()
        condition = ({
            "IfNoneMatch": "*"
        } if stored is None else {
            "IfMatch": etag
        })
        try:
            await client.put_object(Bucket=self._config.bucket,
                                    Key=self.key(name),
                                    Body=json.dumps(fields).encode(),
                                    **condition)
        except Exception as exc:
            if _is_condition_lost(exc):
                return False
            raise
        return True

    async def list_names(self) -> list[str]:
        client = await self.client()
        names: list[str] = []
        paginator = client.get_paginator("list_objects_v2")
        async for page in paginator.paginate(Bucket=self._config.bucket,
                                             Prefix=self._prefix):
            for entry in page.get("Contents", []):
                key = entry["Key"][len(self._prefix):]
                if key.endswith(".json"):
                    names.append(key.removesuffix(".json"))
        return names

    async def load_all(self) -> dict[str, dict[str, Any]]:
        """Every stored record, keyed by name; batch-first (one list,
        then parallel reads)."""
        names = await self.list_names()
        records = await asyncio.gather(*(self.get(name) for name in names))
        return {
            name: fields
            for name, (fields, _) in zip(names, records) if fields is not None
        }

    async def delete(self, names: Iterable[str]) -> None:
        ids = [{"Key": self.key(name)} for name in names]
        if not ids:
            return
        client = await self.client()
        await client.delete_objects(Bucket=self._config.bucket,
                                    Delete={"Objects": ids})

    async def clear(self) -> None:
        await self.delete(await self.list_names())

    async def close(self) -> None:
        async with self._client_lock:
            if self._client_cm is not None:
                await self._client_cm.__aexit__(None, None, None)
                self._client_cm = None
                self._client = None


class S3SessionStore(SessionStore):
    """SessionStore backed by per-session S3 objects.

    One object per session at ``{key_prefix}sessions/{session_id}.json``
    (the store appends the ``sessions/`` segment, mirroring the Redis
    store's ``{key_prefix}sessions`` hash). Conditional writes
    (If-Match on the compare-read's ETag) give the same generation-CAS
    contract as the Redis Lua script, so the S3 control plane is safe
    for the same multi-process sharing. Works on any S3-compatible
    backend that honors conditional PUTs.
    """

    def __init__(self, config: S3Config) -> None:
        self._records = S3RecordClient(config,
                                       f"{config.key_prefix or ''}sessions/")

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
