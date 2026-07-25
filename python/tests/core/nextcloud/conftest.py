from dataclasses import dataclass, field
from datetime import datetime, timezone

import pytest
from opendal.exceptions import NotFound
from opendal.types import EntryMode

from mirage.accessor.nextcloud import NextcloudAccessor
from mirage.resource.nextcloud import NextcloudConfig


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
    dirs: set[str] = field(default_factory=set)
    _writes: int = 0

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
            if k + "/" in self.dirs or any(
                    f.startswith(k + "/") for f in self.files):
                return _FakeMetadata(content_length=0, mode=EntryMode.Dir)
            raise NotFound("path not found", key)
        if k in self.files:
            return self.metas[k]
        raise NotFound("path not found", key)

    async def write(self, key: str, data: bytes) -> None:
        self.files[key] = bytes(data)
        self._writes += 1
        self.metas[key] = _FakeMetadata(
            content_length=len(data),
            mode=EntryMode.File,
            etag=f"etag-{key}-w{self._writes}",
        )

    async def delete(self, key: str) -> None:
        if key.endswith("/"):
            self.dirs.discard(key)
            return
        self.files.pop(key, None)
        self.metas.pop(key, None)

    async def create_dir(self, key: str) -> None:
        self.dirs.add(key.rstrip("/") + "/")

    async def copy(self, src: str, dst: str) -> None:
        if src not in self.files:
            raise NotFound("path not found", src)
        await self.write(dst, self.files[src])

    async def rename(self, src: str, dst: str) -> None:
        if src not in self.files:
            raise NotFound("path not found", src)
        await self.write(dst, self.files[src])
        await self.delete(src)

    async def remove_all(self, prefix: str) -> None:
        pfx = prefix.rstrip("/")
        for f in [
                f for f in self.files if f == pfx or f.startswith(pfx + "/")
        ]:
            self.files.pop(f, None)
            self.metas.pop(f, None)

    async def list(self, path: str, recursive: bool = False):
        pfx = path.lstrip("/")
        if recursive:
            seen: set[str] = set()
            recursive_entries: list[_FakeEntry] = []
            for f in self.files:
                if not f.startswith(pfx):
                    continue
                rest = f[len(pfx):]
                parts = rest.split("/")
                for i in range(len(parts) - 1):
                    dkey = pfx + "/".join(parts[:i + 1]) + "/"
                    if dkey not in seen:
                        seen.add(dkey)
                        recursive_entries.append(
                            _FakeEntry(
                                path=dkey,
                                metadata=_FakeMetadata(mode=EntryMode.Dir),
                            ))
                recursive_entries.append(
                    _FakeEntry(path=f, metadata=self.metas[f]))

            async def _iter_recursive():
                for e in recursive_entries:
                    yield e

            return _iter_recursive()
        seen_dirs: set[str] = set()
        entries: list[_FakeEntry] = []
        key = pfx.rstrip("/")
        if key in self.files:
            # WebDAV PROPFIND on a file returns the file itself.
            entries.append(_FakeEntry(path=key, metadata=self.metas[key]))
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


def make_accessor(files: dict[str, bytes] | None = None) -> NextcloudAccessor:
    cfg = NextcloudConfig(
        url="https://cloud.example.com/remote.php/dav/files/user/",
        username="user",
        password="pass",
    )
    acc = NextcloudAccessor(cfg)
    fake = FakeAsyncOperator(files=dict(files or {}))
    acc._fake = fake
    acc.operator = lambda: fake
    return acc


@pytest.fixture
def make_acc():
    return make_accessor
