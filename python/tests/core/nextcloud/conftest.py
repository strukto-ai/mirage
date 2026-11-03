import re
from collections.abc import Callable
from contextlib import AbstractContextManager
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from email.utils import format_datetime, parsedate_to_datetime
from unittest.mock import AsyncMock, patch
from urllib.parse import quote

import httpx
import pytest
from opendal.exceptions import NotFound
from opendal.types import EntryMode

from mirage.accessor.nextcloud import NextcloudAccessor
from mirage.vfs.nextcloud import NextcloudConfig

ROOT = "https://cloud.example.com/remote.php/dav/files/user"


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
            out = self.data[self.pos :]
            self.pos = len(self.data)
        else:
            out = self.data[self.pos : self.pos + size]
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
                f.startswith(k + "/") for f in self.files
            ):
                return _FakeMetadata(content_length=0, mode=EntryMode.Dir)
            raise NotFound("path not found", key)
        if k in self.files:
            return self.metas[k]
        if k + "/" in self.dirs or any(
            f.startswith(k + "/") for f in self.files
        ):
            return _FakeMetadata(content_length=0, mode=EntryMode.Dir)
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

    async def list(self, path: str, recursive: bool = False):
        pfx = path.lstrip("/")
        if recursive:
            seen: set[str] = set()
            recursive_entries: list[_FakeEntry] = []
            for f in self.files:
                if not f.startswith(pfx):
                    continue
                rest = f[len(pfx) :]
                parts = rest.split("/")
                for i in range(len(parts) - 1):
                    dkey = pfx + "/".join(parts[: i + 1]) + "/"
                    if dkey not in seen:
                        seen.add(dkey)
                        recursive_entries.append(
                            _FakeEntry(
                                path=dkey,
                                metadata=_FakeMetadata(mode=EntryMode.Dir),
                            )
                        )
                recursive_entries.append(
                    _FakeEntry(path=f, metadata=self.metas[f])
                )

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
        elif (
            pfx == ""
            or pfx in self.dirs
            or any(f.startswith(pfx) for f in self.files)
        ):
            # PROPFIND on a collection lists the collection itself, so an
            # empty directory yields one entry where a missing path yields
            # none. Probed against Nextcloud 30: op.list("emptydir/")
            # answers ["emptydir/"] and op.list("never/") answers [].
            entries.append(
                _FakeEntry(
                    path=pfx, metadata=_FakeMetadata(mode=EntryMode.Dir)
                )
            )
        for f in self.files:
            if not f.startswith(pfx):
                continue
            rest = f[len(pfx) :]
            if "/" in rest:
                subdir = rest.split("/", 1)[0]
                dkey = pfx + subdir + "/"
                if dkey not in seen_dirs:
                    seen_dirs.add(dkey)
                    entries.append(
                        _FakeEntry(
                            path=dkey,
                            metadata=_FakeMetadata(mode=EntryMode.Dir),
                        )
                    )
            else:
                entries.append(_FakeEntry(path=f, metadata=self.metas[f]))

        async def _iter():
            for e in entries:
                yield e

        return _iter()

    async def scan(self, path: str):
        pfx = path.lstrip("/")
        entries = [
            _FakeEntry(path=f, metadata=self.metas[f])
            for f in self.files
            if f.startswith(pfx)
        ]

        async def _iter():
            for e in entries:
                yield e

        return _iter()


def make_accessor(files: dict[str, bytes] | None = None) -> NextcloudAccessor:
    cfg = NextcloudConfig(
        url=f"{ROOT}/",
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


def multistatus(status: str, prop: str | None = None) -> bytes:
    """A 207 body with one response: ``status`` for its property group
    ``prop`` when given, else for the member itself.

    Args:
        status (str): the status line's code and reason, e.g. ``200 OK``.
        prop (str | None): the property group's properties.
    """
    line = f"<d:status>HTTP/1.1 {status}</d:status>"
    if prop is not None:
        line = f"<d:propstat><d:prop>{prop}</d:prop>{line}</d:propstat>"
    return (
        '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response>'
        f"<d:href>/remote.php/dav/files/user/</d:href>{line}"
        "</d:response></d:multistatus>"
    ).encode()


def answering(
    module: str, status: int, body: bytes = b""
) -> AbstractContextManager[AsyncMock]:
    """Patch a module's ``dav_request`` to answer ``status`` and ``body``.

    Args:
        module (str): the module under ``mirage.core.nextcloud``.
        status (int): the HTTP status.
        body (bytes): the response body.
    """
    return patch(
        f"mirage.core.nextcloud.{module}.dav_request",
        new_callable=AsyncMock,
        return_value=httpx.Response(
            status, content=body, request=httpx.Request("GET", ROOT)
        ),
    )


HREF = "/remote.php/dav/files/user"


class FakeFolder:
    """One Nextcloud folder as a fenced removal sees it: its children,
    a modified time in whole seconds that every arrival moves to the
    server's clock, and ``If-Unmodified-Since`` honoured on DELETE."""

    def __init__(
        self,
        name: str,
        children: tuple[str, ...] = (),
        age: float = 60,
        exists: bool = True,
        settable: bool = True,
    ) -> None:
        self.name = name
        self.children = list(children)
        self.clock = datetime(2026, 11, 2, 12, 0, 0, tzinfo=timezone.utc)
        self.modified = (self.clock - timedelta(seconds=age)).replace(
            microsecond=0
        )
        self.exists = exists
        self.settable = settable
        self.locked = False
        self.busy = False
        self.calls: list[tuple[str, str, dict[str, str]]] = []
        self.before: dict[str, Callable[[], None]] = {}

    def arrive(self, child: str) -> None:
        self.children.append(child)
        self.modified = self.clock.replace(microsecond=0)

    def answer(self, status: int, body: bytes = b"") -> httpx.Response:
        return httpx.Response(
            status,
            content=body,
            headers={"Date": format_datetime(self.clock, True)},
            request=httpx.Request("GET", ROOT),
        )

    def listing(self, depth: str) -> bytes:
        own = f"{HREF}/{quote(self.name)}/"
        stamp = format_datetime(self.modified, True)
        rows = [
            f"<d:response><d:href>{own}</d:href><d:propstat><d:prop>"
            f"<d:getlastmodified>{stamp}</d:getlastmodified></d:prop>"
            "<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>"
        ]
        if depth == "1":
            rows += [
                f"<d:response><d:href>{own}{quote(c)}</d:href></d:response>"
                for c in self.children
            ]
        return (
            '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">'
            + "".join(rows)
            + "</d:multistatus>"
        ).encode()

    async def __call__(
        self,
        accessor: NextcloudAccessor,
        method: str,
        url: str,
        headers: dict[str, str] | None = None,
        content: bytes | None = None,
    ) -> httpx.Response:
        headers = dict(headers or {})
        self.calls.append((method, url, headers))
        self.clock += timedelta(milliseconds=300)
        if method in self.before:
            self.before.pop(method)()
        if not self.exists:
            return self.answer(404)
        if method == "PROPFIND":
            if self.busy:
                self.modified = self.clock.replace(microsecond=0)
            return self.answer(207, self.listing(headers["Depth"]))
        if method == "PROPPATCH":
            if not self.settable:
                return self.answer(
                    207, multistatus("403 Forbidden", "<d:lastmodified/>")
                )
            seconds = re.search(rb"<d:lastmodified>(\d+)<", content or b"")
            assert seconds is not None
            self.modified = datetime.fromtimestamp(
                int(seconds.group(1)), timezone.utc
            )
            return self.answer(207, multistatus("200 OK", "<d:lastmodified/>"))
        if self.locked:
            return self.answer(423)
        since = parsedate_to_datetime(headers["If-Unmodified-Since"])
        if self.modified > since:
            return self.answer(412)
        self.exists = False
        return self.answer(204)

    def methods(self) -> list[str]:
        return [method for method, _, _ in self.calls]


def removing(folder: FakeFolder) -> AbstractContextManager[FakeFolder]:
    """Route the fence's requests to ``folder``.

    Args:
        folder (FakeFolder): the folder answering them.
    """
    return patch("mirage.core.nextcloud.fence.dav_request", new=folder)


@pytest.fixture
def waits():
    with patch(
        "mirage.core.nextcloud.fence.sleep", new_callable=AsyncMock
    ) as wait:
        yield wait
