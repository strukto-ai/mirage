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

from dataclasses import dataclass, field
from datetime import datetime

from opendal.exceptions import NotFound
from opendal.types import EntryMode

from mirage.accessor.hf_buckets import HfBucketsAccessor, HfBucketsConfig
from tests.fixtures.hf_hub_api import FakeHub

BUCKET = "o/b"
# Nothing listens here, so an accessor built without a FakeHub fails loudly
# instead of reaching huggingface.co.
DEAD_ENDPOINT = "http://127.0.0.1:9"


@dataclass
class _FakeMetadata:
    content_length: int = 0
    mode: EntryMode = EntryMode.File
    etag: str | None = None
    last_modified: datetime | None = None
    content_type: str | None = None


@dataclass
class _FakeEntry:
    path: str
    metadata: _FakeMetadata | None

    @property
    def name(self) -> str:
        return self.path.rstrip("/").rsplit("/", 1)[-1]


@dataclass
class _FakeFile:
    data: bytes
    pos: int = 0

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return None

    async def seek(self, offset: int) -> None:
        self.pos = offset

    async def read(self, size: int | None = None) -> bytes:
        if size is None:
            out = self.data[self.pos:]
            self.pos = len(self.data)
        else:
            out = self.data[self.pos:self.pos + size]
            self.pos += len(out)
        return out

    async def tell(self) -> int:
        return self.pos


@dataclass
class FakeAsyncOperator:
    """The opendal hf operator over a bucket, the way the binding behaves.

    ``files`` is keyed bucket-absolute and may be the very dict a FakeHub
    serves, so a write through opendal is what an HTTP read sees. ``root``
    is the operator root key_prefix becomes: keys going in gain it and
    paths coming out of a listing lose it, as the real binding does. Stat
    and listing metadata carry no etag and no mtime, because live opendal
    reports neither for a bucket (py 0.47.1 and node 0.49.4, probed
    2026-09-25); ``modified`` stages a listing mtime where a test needs one.

    Args:
        files (dict[str, bytes]): bucket-absolute key to content.
        root (str): the operator root, "" or "/pfx/".
        modified (dict[str, datetime]): per-key listing mtime overrides.
        reach (list[str] | None): when set, read and open append here and
            raise, so a test can prove nothing reads through opendal.
        stat_calls (int): how many times stat ran.
    """

    files: dict[str, bytes] = field(default_factory=dict)
    root: str = ""
    modified: dict[str, datetime] = field(default_factory=dict)
    reach: list[str] | None = None
    stat_calls: int = 0

    def _key(self, key: str) -> str:
        stem = self.root.strip("/")
        key = key.lstrip("/")
        return f"{stem}/{key}" if stem else key

    def _rel(self, key: str) -> str:
        stem = self.root.strip("/")
        return key[len(stem) + 1:] if stem else key

    def _meta(self, key: str) -> _FakeMetadata:
        return _FakeMetadata(content_length=len(self.files[key]),
                             mode=EntryMode.File,
                             last_modified=self.modified.get(key))

    def _refuse(self, name: str) -> None:
        if self.reach is not None:
            self.reach.append(name)
            raise AssertionError(f"stray opendal {name}")

    async def read(self, key: str) -> bytes:
        self._refuse("read")
        full = self._key(key)
        if full not in self.files:
            raise NotFound("path not found", key)
        return self.files[full]

    async def open(self, key: str, mode: str = "rb"):
        self._refuse("open")
        full = self._key(key)
        if full not in self.files:
            raise NotFound("path not found", key)
        return _FakeFile(data=self.files[full])

    async def stat(self, key: str) -> _FakeMetadata:
        self.stat_calls += 1
        full = self._key(key).rstrip("/")
        if key.endswith("/"):
            if any(f.startswith(full + "/") for f in self.files):
                return _FakeMetadata(content_length=0, mode=EntryMode.Dir)
            raise NotFound("path not found", key)
        if full in self.files:
            return self._meta(full)
        raise NotFound("path not found", key)

    async def write(self, key: str, data: bytes) -> None:
        self.files[self._key(key)] = bytes(data)

    async def delete(self, key: str) -> None:
        full = self._key(key)
        self.files.pop(full, None)
        self.modified.pop(full, None)

    def _under(self, path: str) -> tuple[list[str], str]:
        stem = self.root.strip("/")
        if path.strip("/"):
            pfx = self._key(path.lstrip("/"))
        else:
            pfx = stem + "/" if stem else ""
        return [f for f in self.files if f.startswith(pfx)], pfx

    async def list(self, path: str, *, recursive: bool = False):
        if recursive:
            return await self.scan(path)
        keys, pfx = self._under(path)
        seen_dirs: set[str] = set()
        entries: list[_FakeEntry] = []
        for f in keys:
            rest = f[len(pfx):]
            if "/" in rest:
                dkey = pfx + rest.split("/", 1)[0] + "/"
                if dkey not in seen_dirs:
                    seen_dirs.add(dkey)
                    entries.append(
                        _FakeEntry(
                            path=self._rel(dkey),
                            metadata=_FakeMetadata(mode=EntryMode.Dir),
                        ))
            else:
                entries.append(
                    _FakeEntry(path=self._rel(f), metadata=self._meta(f)))

        async def _iter():
            for e in entries:
                yield e

        return _iter()

    async def scan(self, path: str):
        keys, _ = self._under(path)
        entries = [
            _FakeEntry(path=self._rel(f), metadata=self._meta(f)) for f in keys
        ]

        async def _iter():
            for e in entries:
                yield e

        return _iter()


def make_accessor(files: dict[str, bytes] | None = None,
                  *,
                  key_prefix: str | None = None,
                  hub: FakeHub | None = None,
                  token: str | None = "t") -> HfBucketsAccessor:
    """A bucket accessor over one shared store.

    With ``hub``, the FakeHub serves the same dict the opendal fake reads
    and writes, under ``("buckets", BUCKET)``; without one, HTTP calls go
    to a dead port.

    Args:
        files (dict[str, bytes] | None): bucket-absolute key to content.
        key_prefix (str | None): the mount's key prefix.
        hub (FakeHub | None): the fake Hub to point the endpoint at.
        token (str | None): the access token.
    """
    store: dict[str, bytes] = dict(files or {})
    if hub is not None:
        hub.repos[("buckets", BUCKET)] = store
    cfg = HfBucketsConfig(
        bucket=BUCKET,
        token=token,
        key_prefix=key_prefix,
        endpoint=hub.url if hub is not None else DEAD_ENDPOINT)
    acc = HfBucketsAccessor(cfg)
    fake = FakeAsyncOperator(files=store, root=acc._root() or "")
    acc._fake = fake
    acc.operator = lambda: fake
    return acc
