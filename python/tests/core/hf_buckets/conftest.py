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
from datetime import datetime, timezone

import pytest
from opendal.exceptions import NotFound
from opendal.types import EntryMode

from mirage.accessor.hf_buckets import HfBucketsAccessor, HfBucketsConfig


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
    metadata: _FakeMetadata

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
    files: dict[str, bytes] = field(default_factory=dict)
    metas: dict[str, _FakeMetadata] = field(default_factory=dict)

    def __post_init__(self):
        for k, data in self.files.items():
            self.metas.setdefault(
                k,
                _FakeMetadata(
                    content_length=len(data),
                    mode=EntryMode.File,
                    etag=f"etag-{k}",
                    last_modified=datetime(2026, 1, 1, tzinfo=timezone.utc),
                ),
            )

    async def read(self, key: str) -> bytes:
        if key not in self.files:
            raise NotFound("path not found", key)
        return self.files[key]

    async def open(self, key: str, mode: str = "rb"):
        if key not in self.files:
            raise NotFound("path not found", key)
        return _FakeFile(data=self.files[key])

    async def stat(self, key: str) -> _FakeMetadata:
        k = key.rstrip("/")
        if key.endswith("/"):
            if any(f.startswith(k + "/") for f in self.files):
                return _FakeMetadata(content_length=0, mode=EntryMode.Dir)
            raise NotFound("path not found", key)
        if k in self.files:
            return self.metas[k]
        raise NotFound("path not found", key)

    async def write(self, key: str, data: bytes) -> None:
        self.files[key] = bytes(data)
        self.metas[key] = _FakeMetadata(
            content_length=len(data),
            mode=EntryMode.File,
            etag=f"etag-{key}",
        )

    async def delete(self, key: str) -> None:
        self.files.pop(key, None)
        self.metas.pop(key, None)

    async def list(self, path: str):
        pfx = path.lstrip("/")
        seen_dirs: set[str] = set()
        entries: list[_FakeEntry] = []
        for f in self.files:
            if not f.startswith(pfx):
                continue
            rest = f[len(pfx):]
            if "/" in rest:
                subdir = rest.split("/", 1)[0]
                dkey = pfx + subdir + "/"
                if dkey not in seen_dirs:
                    seen_dirs.add(dkey)
                    entries.append(
                        _FakeEntry(
                            path=dkey,
                            metadata=_FakeMetadata(mode=EntryMode.Dir),
                        ))
            else:
                entries.append(_FakeEntry(path=f, metadata=self.metas[f]))

        async def _iter():
            for e in entries:
                yield e

        return _iter()

    async def scan(self, path: str):
        pfx = path.lstrip("/")
        entries = [
            _FakeEntry(path=f, metadata=self.metas[f]) for f in self.files
            if f.startswith(pfx)
        ]

        async def _iter():
            for e in entries:
                yield e

        return _iter()


def make_accessor(files: dict[str, bytes] | None = None,
                  *,
                  key_prefix: str | None = None) -> HfBucketsAccessor:
    cfg = HfBucketsConfig(bucket="o/b", token="t", key_prefix=key_prefix)
    acc = HfBucketsAccessor(cfg)
    fake = FakeAsyncOperator(files=dict(files or {}))
    acc._fake = fake
    acc.operator = lambda: fake
    return acc


@pytest.fixture
def make_acc():
    return make_accessor
