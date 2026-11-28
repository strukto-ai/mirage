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

import uuid
from collections.abc import AsyncIterator
from typing import Any
from urllib.parse import unquote

import opendal
import pytest_asyncio

from mirage.accessor.hf_buckets import HfBucketsAccessor
from mirage.vfs.hf_buckets.config import HfBucketsConfig
from tests.fixtures.kit_fake import KitRun

BUCKET = "o/b"
# The run the fake's Xet storage lives in. Content addressed by hash is
# global on the Hub, and a client that uploaded content once commits it
# again without re-uploading, so the storage is shared and never dropped;
# each bucket is an account of its own in it.
SHARED_RUN = "default"
TREE = "/api/buckets/:ns/:name/tree/*path"
PATHS_INFO = "/api/buckets/:ns/:name/paths-info"
RESOLVE = "/buckets/:ns/:name/resolve/*path"
CDN = "/cdn/:ns/:name/:hash"
XET_READ_TOKEN = "/api/buckets/:ns/:name/xet-read-token"
UNTIL_CLEARED = 1_000_000
# An unset token, distinct from None, which sends none.
OWN = object()


class HfBucket:
    """One Hugging Face bucket on the integ ``hf`` fake, and the writes a
    test arranges it by.

    The account is the access token, so each bucket sends a token of its
    own. Another client's writes go through opendal, the client the Hub's
    Xet uploads are made with.

    Args:
        origin (str): the fake's origin.
        account (str | None): the account, a fresh one if None;
            ``default`` is the one a caller that sends no token reaches.
    """

    def __init__(self, origin: str, account: str | None = None) -> None:
        self.origin = origin
        self.token = account or f"unit-{uuid.uuid4().hex}"
        self.run = KitRun(
            origin, {"Authorization": f"Bearer {self.token}"}, SHARED_RUN
        )

    def config(
        self, key_prefix: str | None = None, token: Any = OWN
    ) -> HfBucketsConfig:
        """A mount config for the bucket.

        Args:
            key_prefix (str | None): the mount's key prefix.
            token (Any): the access token; the bucket's own if unset, none
                if None.
        """
        return HfBucketsConfig(
            bucket=BUCKET,
            token=self.token if token is OWN else token,
            key_prefix=key_prefix,
            endpoint=self.origin,
        )

    def fields(self, **extra: Any) -> dict[str, Any]:
        """A mount config's fields for the bucket, as ``build_vfs`` takes
        them.

        Args:
            **extra (Any): fields to set or replace.
        """
        given = {
            "bucket": BUCKET,
            "endpoint": self.origin,
            "token": self.token,
        }
        return {**given, **extra}

    def accessor(
        self, key_prefix: str | None = None, token: Any = OWN
    ) -> HfBucketsAccessor:
        """A Mirage accessor on the bucket.

        Args:
            key_prefix (str | None): the mount's key prefix.
            token (Any): the access token, as :meth:`config` takes it.
        """
        return HfBucketsAccessor(self.config(key_prefix, token))

    def operator(self) -> opendal.AsyncOperator:
        """An opendal operator on the whole bucket, another client."""
        return opendal.AsyncOperator(
            "hf",
            repo_type="bucket",
            repo_id=BUCKET,
            token=self.token,
            endpoint=self.origin,
        )

    async def reset(self) -> None:
        """Empty the bucket's account; the Xet storage stays."""
        await self.run.call("POST", "/reset", json={"tenants": [self.token]})

    async def put(self, **files: bytes) -> None:
        """Write files, bucket-absolute keys, as another client would.

        Args:
            **files (bytes): key to content.
        """
        op = self.operator()
        for key, data in files.items():
            await op.write(key, data)

    async def write(self, key: str, data: bytes) -> None:
        """Write one file, as :meth:`put` does, for a key no keyword
        spells.

        Args:
            key (str): its bucket-absolute key.
            data (bytes): what it holds.
        """
        await self.operator().write(key, data)

    async def remove(self, key: str) -> None:
        """Delete a file as another client would.

        Args:
            key (str): its bucket-absolute key.
        """
        await self.operator().delete(key)

    async def files(self) -> dict[str, bytes]:
        """Every file the bucket holds, bucket-absolute key to content."""
        op = self.operator()
        out: dict[str, bytes] = {}
        async for entry in await op.list("", recursive=True):
            if not entry.path.endswith("/"):
                out[entry.path] = bytes(await op.read(entry.path))
        return out

    async def row(self, key: str) -> dict[str, Any]:
        """The paths-info row the Hub answers for a file.

        Args:
            key (str): its bucket-absolute key.
        """
        rows = await self.run.call(
            "POST",
            f"/api/buckets/{BUCKET}/paths-info",
            json={"paths": [key]},
        )
        assert len(rows) == 1, rows
        row: dict[str, Any] = rows[0]
        return row

    async def refuse(
        self,
        name: str,
        status: int,
        code: str = "",
        times: int = UNTIL_CLEARED,
    ) -> None:
        """Answer the next ``times`` requests ``log`` names ``name`` with the
        Hub's error for ``status``.

        Args:
            name (str): ``paths_info``, ``resolve`` or ``tree``.
            status (int): the status to answer.
            code (str): the ``X-Error-Code`` the Hub names it by, "" for
                none.
            times (int): how many requests it answers.
        """
        method, route = {
            "paths_info": ("POST", PATHS_INFO),
            "resolve": ("GET", RESOLVE),
            "tree": ("GET", TREE),
        }[name]
        message = f"fake {name} refused"
        headers = {"X-Error-Message": message}
        if code:
            headers["X-Error-Code"] = code
        await self.run.answer_next(
            method, route, status, {"error": message}, times, headers=headers
        )

    async def serve_etag(self, data: bytes, etag: str | None) -> None:
        """Answer the next download of the bytes with ``etag`` as their
        ETag, or with none.

        Args:
            data (bytes): the bytes the download answers.
            etag (str | None): the ETag header as sent; None sends none.
        """
        headers = {"Content-Type": "application/octet-stream"}
        if etag is not None:
            headers["ETag"] = etag
        await self.run.answer_next("GET", CDN, 200, data, headers=headers)

    async def log(self) -> list[tuple[str, str, str]]:
        """Each request since recording started, as ``(name, path,
        query)``: ``tree``, ``paths_info``, ``stat`` (a HEAD on resolve),
        ``resolve``, ``cdn`` and ``opendal_read`` (Xet's read token and
        reconstructions, how opendal reads); ``path`` is the key a resolve
        names. Any other request is named by its method and route."""
        listed = await self.run.call("GET", "/_kit/requests")
        out: list[tuple[str, str, str]] = []
        for r in listed["requests"]:
            route, method = r["route"], r["method"]
            path = unquote(r["path"])
            if route == RESOLVE:
                key = path.split("/resolve/", 1)[1]
                name = "stat" if method == "HEAD" else "resolve"
                out.append((name, key, r["query"]))
            elif route == TREE:
                out.append(("tree", path.split("/tree/", 1)[1], r["query"]))
            elif route == PATHS_INFO:
                out.append(("paths_info", str(r["body"]), r["query"]))
            elif route == CDN:
                out.append(("cdn", "", r["query"]))
            elif route == XET_READ_TOKEN or "reconstructions" in route:
                out.append(("opendal_read", path, r["query"]))
            else:
                out.append((f"{method} {route}", path, r["query"]))
        return out

    async def count(self, name: str) -> int:
        """How many requests ``log`` names ``name`` since recording started.

        Args:
            name (str): the name.
        """
        return sum(1 for logged, *_ in await self.log() if logged == name)

    async def close(self) -> None:
        """Empty the account and close the run's session, keeping the run."""
        await self.reset()
        await self.run.close(drop=False)


@pytest_asyncio.fixture
async def bucket(hf_origin: str) -> AsyncIterator[HfBucket]:
    """A bucket of its own on the hf fake, empty, its requests recorded
    from here.

    Args:
        hf_origin (str): the fake's origin.
    """
    made = HfBucket(hf_origin)
    await made.reset()
    await made.run.record_requests()
    yield made
    await made.close()
