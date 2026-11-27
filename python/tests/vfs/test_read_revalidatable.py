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
import datetime
import functools
import hashlib
from collections.abc import AsyncIterator, Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from inspect import isawaitable, signature
from types import ModuleType
from typing import Any, TypeVar
from weakref import WeakKeyDictionary

import boto3
import moto.s3.models
import pytest
from bson import ObjectId
from moto.server import ThreadedMotoServer

import mirage.core.box.read as box_read
import mirage.core.dropbox.read as dropbox_read
import mirage.core.gdocs.read as gdocs_read
import mirage.core.gdrive.read as gdrive_read
import mirage.core.github.read as github_read
import mirage.core.gridfs.client as gridfs_client
import mirage.core.gridfs.driver as gridfs_driver
import mirage.core.gridfs.events as gridfs_events
import mirage.core.gridfs.read as gridfs_read
import mirage.core.gridfs.stream as gridfs_stream
import mirage.core.gsheets.read as gsheets_read
import mirage.core.gslides.read as gslides_read
import mirage.core.hf_buckets.read as hf_buckets_read
import mirage.core.hf_buckets.stream as hf_buckets_stream
import mirage.core.hf_hub.read as hf_read
import mirage.core.hf_hub.stream as hf_stream
import mirage.core.msgraph.drive as drive_ops
import mirage.core.s3.read as s3_read
import mirage.core.s3.stream as s3_stream
from mirage.cache.index import IndexCacheStore, RAMIndexCacheStore
from mirage.cache.index.ram import ListingCheckStore
from mirage.core.box.readdir import readdir as box_readdir
from mirage.core.dropbox.readdir import readdir as dropbox_readdir
from mirage.core.gdrive.readdir import readdir as gdrive_readdir
from mirage.core.github.readdir import readdir as github_readdir
from mirage.core.hf_hub.client import etag_value
from mirage.core.hf_hub.readdir import readdir as hf_readdir
from mirage.core.render.json import compact_json_bytes
from mirage.observe.context import OpTimer, recording_active
from mirage.observe.record import OpRecord
from mirage.types import FileStat, MountMode, PathSpec, ReadPolicy, ReadSpec
from mirage.utils.filetype import get_extension
from mirage.utils.loader import load_attr
from mirage.vfs.base import BaseVFS
from mirage.vfs.gdocs.doc_entry import make_filename as doc_filename
from mirage.vfs.gdocs.gdocs import GDocsVFS
from mirage.vfs.gsheets.sheet_entry import make_filename as sheet_filename
from mirage.vfs.gslides.slide_entry import make_filename as slide_filename
from mirage.vfs.ram import RAMVFS
from mirage.vfs.registry import REGISTRY, build_vfs, known_vfs_names
from mirage.workspace import Workspace
from mirage.workspace.mount import Mount
from tests.core.box.conftest import TOKEN, BoxAccount
from tests.core.dropbox.conftest import DropboxAccount
from tests.core.github.conftest import TOKEN as GITHUB_TOKEN
from tests.core.github.conftest import GitHubRepo, blob_sha
from tests.e2e.s3_mock import MultiBucketSession, patch_s3_session
from tests.fixtures.google_account import FILES, GoogleAccount
from tests.fixtures.google_account import TOKEN as GOOGLE_TOKEN
from tests.fixtures.handed import ListFn, entry_at
from tests.fixtures.hf_buckets_opendal import FakeAsyncOperator
from tests.fixtures.hf_hub_api import FakeHub, blob_oid, serve, xet_hash
from tests.fixtures.kit_fake import KitRun, LoopThread
from tests.fixtures.msgraph_api import (
    DRIVE_ID,
    DRIVE_NAME,
    ME,
    SITE_NAME,
    FakeGraph,
)
from tests.fixtures.msgraph_api import serve as serve_graph
from tests.fixtures.vfs_io import vfs_over

S3_FAMILY = (
    "s3",
    "aliyun",
    "backblaze",
    "ceph",
    "digitalocean",
    "gcs",
    "minio",
    "oci",
    "qingstor",
    "r2",
    "scaleway",
    "seaweedfs",
    "supabase",
    "tencent",
    "wasabi",
)

HF_FAMILY = {
    "hf_models": "models",
    "hf_datasets": "datasets",
    "hf_spaces": "spaces",
}

HARNESSES = {
    **{name: "s3" for name in S3_FAMILY},
    "gridfs": "gridfs",
    **{name: "hf_models" for name in HF_FAMILY},
    "onedrive": "onedrive",
    "sharepoint": "sharepoint",
    "hf_buckets": "hf_buckets",
    "github": "github",
    "gdrive": "gdrive",
    "gdocs": "gdocs",
    "gsheets": "gsheets",
    "gslides": "gslides",
    "dropbox": "dropbox",
    "box": "box",
}

# The drive each Graph backend addresses in the fake: OneDrive the signed-in
# user's own, SharePoint one library of one site, mounted scoped so the keys
# stay drive-relative (unscoped, `a.txt` would name a site).
GRAPH = {
    "onedrive": ME,
    "sharepoint": DRIVE_ID,
}

ALL_SHAPES = ("root", "nested", "prefixed")
ALL_ROWS = ("bytes", "stream", "partial")

# The mounts that render a Drive file through its editor API: the mime type
# they list, the module whose `record` a read stamps through, and the file
# name a listing gives the file.
GAPPS = {
    "gdocs": (
        "application/vnd.google-apps.document",
        gdocs_read,
        doc_filename,
    ),
    "gsheets": (
        "application/vnd.google-apps.spreadsheet",
        gsheets_read,
        sheet_filename,
    ),
    "gslides": (
        "application/vnd.google-apps.presentation",
        gslides_read,
        slide_filename,
    ),
}

# The request each Google app renders its file with.
RENDERS = {
    "gdocs": ("GET", "/v1/documents/:id"),
    "gsheets": ("GET", "/v4/spreadsheets/:id"),
    "gslides": ("GET", "/v1/presentations/:id"),
}

# What each family can run, fixed at collection. github and gdrive have no
# key_prefix. The GAPPS mounts have one flat listing, so only one shape,
# and their stream is their render handed over whole, one chunk, so a
# partial row would read the whole file.
FAMILY_SHAPES = {
    "github": ("root", "nested"),
    "gdrive": ("root", "nested"),
    **{name: ("root",) for name in GAPPS},
}
FAMILY_ROWS = {
    **{name: ("bytes", "stream") for name in GAPPS},
}

# One document per family, identical in the TypeScript twin. oci is the one
# alias with a required field beyond these; every other one-of (r2's
# account_id, supabase's project_ref) is satisfied by the endpoint.
S3_CONFIG = {
    "bucket": "b",
    "region": "us-east-1",
    "endpoint_url": "http://127.0.0.1:9000",
}
S3_EXTRA = {"oci": {"namespace": "ns"}}
GRIDFS_CONFIG = {"uri": "mongodb://127.0.0.1:27017", "database": "d"}
DROPBOX_CONFIG = {
    "client_id": "i",
    "client_secret": "s",
    "refresh_token": TOKEN,
}
A = TypeVar("A", BoxAccount, DropboxAccount)
# More requests than any test here makes: an answer armed this many times
# stands for the test, the way a stored state would.
EVERY = 1000
RESTRICTED = {
    "error_summary": "path/restricted_content/..",
    "error": {".tag": "path", "path": {".tag": "restricted_content"}},
}
BOX_DOWNLOAD = ("GET", "/2.0/files/:file_id/content")
DROPBOX_DOWNLOAD = ("POST", "/2/files/download")

PREFIX = "pfx/"

# A non-empty suffix makes the mock's ETag differ from md5(content), so a
# token the backend returned is distinguishable from a fabricated md5.
SUFFIX = "-2"

KEYS = {
    "root": "a.txt",
    "listed": "a.txt",
    "nested": "m/a.txt",
    "prefixed": "a.txt",
}

SEED = b"name,age\nalice,30\n"
CHANGED = b"name,age\nalice,31\n"
DECOY = b"decoy at the unprefixed key\n"
# Several download chunks, so a read stopped after the first chunk has bytes
# left it never pulls.
BIG = (b"x" * 1023 + b"\n") * 300

# The bytes row is a whole read, which only the file API makes now that
# `cp` streams its source.
COMMANDS = {
    "stream": "cat {v}",
    "partial": "cat {v} | head -c 1",
}


def _with_index(
    fn: Callable[..., Any], index: IndexCacheStore | None
) -> Callable[..., Any]:
    """``fn`` handed ``index`` where it takes one, as a mount hands it."""
    if index is None or "index" not in signature(fn).parameters:
        return fn
    return functools.partial(fn, index=index)


async def _chunks(answer: Any) -> AsyncIterator[bytes]:
    """What a ``read`` answered, as a stream: bytes as one chunk."""
    found = await answer if isawaitable(answer) else answer
    if isinstance(found, bytes):
        yield found
        return
    async for chunk in found:
        yield chunk


async def _direct_stream(
    vfs: BaseVFS, path: PathSpec, index: IndexCacheStore | None
) -> AsyncIterator[bytes]:
    """A whole read straight from the VFS: its stored bytes, or the
    rendering of a VFS whose stored form is the rendering."""
    renderer = (
        None
        if vfs.supports("read")
        else vfs.renderers.get(get_extension(path.virtual) or "")
    )
    fn = vfs.read if renderer is None else getattr(vfs, renderer)
    async for chunk in _chunks(_with_index(fn, index)(path)):
        yield chunk


@dataclass(frozen=True)
class Fake:
    vfs: BaseVFS
    key: str
    fetches: Callable[[], int]
    rewrite: Callable[[bytes], None]
    reach: list[str]
    read_mod: ModuleType
    # None when the backend answers a whole read with its bytes, which then
    # record through read_mod's record; the slot it lands in is "bytes".
    stream_mod: ModuleType | None
    # Passed to direct IO calls when the backend resolves through its index.
    index: IndexCacheStore | None = None
    # False where stat answers from its own request (the Google apps): it
    # then takes no index, so the unrecorded row compares two independent
    # reads of the object rather than one index entry with itself.
    stat_indexed: bool = True
    # The listing that names the row each function is handed, where the
    # backend reads one (gdrive, box, dropbox, github, the Hub): the direct
    # calls are handed it, as the mount hands it.
    readdir: ListFn | None = None
    # What a read of the key answers now, where that is not the bytes last
    # written: a Google app's file reads as its API's rendering of it.
    rendered: Callable[[], bytes] | None = None
    # How many Drive listings the mount has asked, for a Google app, whose
    # listing is a Drive search.
    searched: Callable[[], int] | None = None

    def slot(self) -> str:
        return "stream" if self.stream_mod is not None else "bytes"

    def expected(self, data: bytes) -> bytes:
        """What a read of the key answers once ``data`` is its content.

        Args:
            data (bytes): the bytes last written to the key.
        """
        return data if self.rendered is None else self.rendered()

    async def handed(
        self, fn: Callable[..., Any], path: PathSpec
    ) -> dict[str, FileStat | None]:
        if self.readdir is None or "entry" not in signature(fn).parameters:
            return {}
        return {"entry": await entry_at(self.readdir, self.vfs.accessor, path)}

    async def read_stream(self, path: PathSpec) -> AsyncIterator[bytes]:
        if self.readdir is not None:
            read = self.vfs.read
            stream = _chunks(read(path, **await self.handed(read, path)))
        else:
            stream = _direct_stream(self.vfs, path, self.index)
        async for chunk in stream:
            yield chunk

    async def stat(self, path: PathSpec) -> FileStat:
        if self.readdir is not None:
            stat = self.vfs.stat
            return await stat(path, **await self.handed(stat, path))
        index = self.index if self.stat_indexed else None
        return await _with_index(self.vfs.stat, index)(path)


# The store each driver's mount runs under, filled when a fresh workspace
# places it.
_OWN_INDEX: WeakKeyDictionary[BaseVFS, IndexCacheStore] = WeakKeyDictionary()


class _Download:
    def __init__(self, data: bytes) -> None:
        self._data = data
        self._pos = 0

    async def read(self, size: int = -1) -> bytes:
        if size < 0:
            size = len(self._data) - self._pos
        chunk = self._data[self._pos : self._pos + size]
        self._pos += len(chunk)
        return chunk

    async def close(self) -> None:
        return None


class _Upload:
    def __init__(self, files, key):
        self._id, self.files, self.key = ObjectId(), files, key
        self.data = bytearray()

    async def write(self, data):
        self.data.extend(data)

    async def close(self):
        self.files[self.key] = _gridfs_doc(
            self.key, bytes(self.data), str(self._id), 2030
        )

    async def abort(self):
        self.data.clear()


class _Bucket:
    def __init__(self, files: dict[str, dict]) -> None:
        self._files = files
        self.opened: list[ObjectId] = []

    def open_upload_stream(self, filename: str) -> _Upload:
        return _Upload(self._files, filename)

    async def upload_from_stream(self, filename: str, data: bytes) -> ObjectId:
        # A new revision is a new doc with a new _id, dated after every
        # seeded one, so it is what latest_file answers next.
        oid = ObjectId()
        self._files[filename] = _gridfs_doc(filename, data, str(oid), 2030)
        return oid

    async def open_download_stream(self, file_id: ObjectId) -> _Download:
        self.opened.append(file_id)
        for doc in self._files.values():
            if doc["_id"] == file_id:
                return _Download(doc["data"])
        raise AssertionError(f"no file {file_id}")


def _gridfs_doc(key: str, data: bytes, oid: str, year: int) -> dict:
    return {
        "_id": ObjectId(oid),
        "filename": key,
        "length": len(data),
        "uploadDate": datetime.datetime(
            year, 1, 2, tzinfo=datetime.timezone.utc
        ),
        "data": data,
    }


def _stray(reach: list[str], name: str) -> Callable[..., None]:
    def refuse(*_args, **_kwargs) -> None:
        reach.append(name)
        raise AssertionError(f"stray reach: {name}")

    return refuse


@contextmanager
def _s3_fake(name: str, shape: str, data: bytes) -> Iterator[Fake]:
    key = KEYS[shape]
    prefix = PREFIX if shape == "prefixed" else None
    objects = {(prefix or "") + key: data}
    config: dict[str, str] = {**S3_CONFIG, **S3_EXTRA.get(name, {})}
    if prefix is not None:
        objects[key] = DECOY
        config["key_prefix"] = prefix
    session = MultiBucketSession({"b": objects}, etag_suffix=SUFFIX)

    def rewrite(new: bytes) -> None:
        objects[(prefix or "") + key] = new

    with patch_s3_session(session):
        vfs = build_vfs(name, config)
        assert vfs.accessor.config.key_prefix == prefix
        yield Fake(
            vfs=vfs,
            key=key,
            fetches=lambda: session._client.calls["get_object"],
            rewrite=rewrite,
            reach=[],
            read_mod=s3_read,
            stream_mod=s3_stream,
        )


@contextmanager
def _gridfs_fake(
    shape: str, data: bytes, monkeypatch: pytest.MonkeyPatch
) -> Iterator[Fake]:
    key = KEYS[shape]
    prefix = PREFIX if shape == "prefixed" else None
    stored = (prefix or "") + key
    # _id is neither the md5 nor the uploadDate, so a stat or a read that
    # moved to either kind of token no longer matches the other side.
    files = {
        stored: _gridfs_doc(stored, data, "0123456789ab0123456789ab", 2020)
    }
    config: dict[str, str] = dict(GRIDFS_CONFIG)
    if prefix is not None:
        files[key] = _gridfs_doc(key, DECOY, "ffffffffffffffffffffffff", 2021)
        config["key_prefix"] = prefix
    bucket = _Bucket(files)
    reach: list[str] = []

    async def latest_file(_accessor, name: str) -> dict | None:
        return files.get(name)

    def rewrite(new: bytes) -> None:
        files[stored] = _gridfs_doc(
            stored, new, "aaaaaaaaaaaaaaaaaaaaaaaa", 2022
        )

    for module in (gridfs_read, gridfs_stream, gridfs_driver):
        monkeypatch.setitem(vars(module), "latest_file", latest_file)
        monkeypatch.setitem(vars(module), "bucket", lambda *_args: bucket)
    # A listing or a collection query means the path under test reached for
    # something no read or stat should need; refuse it loudly.
    for module in (gridfs_client, gridfs_driver, gridfs_events):
        for name in ("iter_latest", "files_coll"):
            if name in vars(module):
                monkeypatch.setitem(vars(module), name, _stray(reach, name))
    vfs = build_vfs("gridfs", config)
    assert vfs.accessor.config.key_prefix == prefix
    yield Fake(
        vfs=vfs,
        key=key,
        fetches=lambda: len(bucket.opened),
        rewrite=rewrite,
        reach=reach,
        read_mod=gridfs_read,
        stream_mod=gridfs_stream,
    )


def _watch_walks(vfs: BaseVFS, monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """What a tree walk on a throwaway store reached, for a backend whose
    one listing is the whole tree.

    A listing kept is the one sign of a walk. In the mount's own index a
    cold read keeps one legitimately; in any other store it is the
    reconcile probe walking the tree.

    Args:
        vfs (BaseVFS): the backend whose mount owns the index.
        monkeypatch (pytest.MonkeyPatch): undoes the watch.
    """
    reach: list[str] = []
    set_dir = RAMIndexCacheStore.set_dir

    async def watched(store, vfs_path, entries, *args, **kwargs):
        if store is not _OWN_INDEX.get(vfs):
            reach.append("tree walk on a throwaway index")
        return await set_dir(store, vfs_path, entries, *args, **kwargs)

    monkeypatch.setattr(RAMIndexCacheStore, "set_dir", watched)
    return reach


@contextmanager
def _hf_fake(
    name: str, shape: str, data: bytes, monkeypatch: pytest.MonkeyPatch
) -> Iterator[Fake]:
    key = KEYS[shape]
    prefix = PREFIX if shape == "prefixed" else None
    stored = (prefix or "") + key
    files = {stored: data}
    config: dict[str, str] = {"repo_id": "acme/widget"}
    if prefix is not None:
        files[key] = DECOY
        config["key_prefix"] = prefix
    # Files are served Xet-shaped, so the download's ETag is the xet hash,
    # not the oid stat stamps: a read that trusted only the oid would stamp
    # nothing. The repo is filed under the family's own API segment, so a
    # request built for another repo type gets no answer.
    hub = FakeHub(repos={(HF_FAMILY[name], "acme/widget"): files})
    with serve(hub):
        vfs = build_vfs(name, {**config, "endpoint": hub.url})
        assert vfs.accessor.key_prefix == (prefix or "")
        reach = _watch_walks(vfs, monkeypatch)

        def rewrite(new: bytes) -> None:
            files[stored] = new

        yield Fake(
            vfs=vfs,
            key=key,
            fetches=lambda: hub.count("resolve"),
            rewrite=rewrite,
            reach=reach,
            read_mod=hf_read,
            stream_mod=hf_stream,
            readdir=hf_readdir,
        )


@contextmanager
def _graph_fake(name: str, shape: str, data: bytes) -> Iterator[Fake]:
    key = KEYS[shape]
    prefix = PREFIX if shape == "prefixed" else None
    stored = (prefix or "") + key
    drive = GRAPH[name]
    files = {stored: data}
    config: dict[str, str] = {"access_token": "t"}
    if name == "sharepoint":
        config.update(site=SITE_NAME, drive=DRIVE_NAME)
    if prefix is not None:
        files[key] = DECOY
        config["key_prefix"] = prefix
    # A children listing is a walk no read or stat should make; the listed
    # shape's own `ls` is the one allowed.
    graph = FakeGraph(
        drives={drive: files}, children_allowed=1 if shape == "listed" else 0
    )
    with serve_graph(graph):
        vfs = build_vfs(name, {**config, "graph_base_url": graph.url})
        assert (vfs.accessor.config.key_prefix or "").strip("/") == (
            prefix or ""
        ).strip("/")

        def rewrite(new: bytes) -> None:
            graph.write(drive, stored, new)

        yield Fake(
            vfs=vfs,
            key=key,
            fetches=graph.fetches,
            rewrite=rewrite,
            reach=graph.reach,
            read_mod=drive_ops,
            stream_mod=drive_ops,
        )


def _google_config(drive: GoogleAccount) -> dict[str, str]:
    return {"access_token": GOOGLE_TOKEN, "api_base": drive.run.url}


async def _downloads(drive: GoogleAccount) -> int:
    return [name for name, _ in await drive.log()].count("media")


@contextmanager
def _gdrive_fake(shape: str, data: bytes, origin: str) -> Iterator[Fake]:
    # The account runs on a loop of its own, as Dropbox's does.
    key = KEYS[shape]
    thread = LoopThread()
    try:
        drive = thread.run(_account(GoogleAccount, origin))
        try:
            thread.run(drive.put(key, data))
            thread.run(drive.run.record_requests())
            # No stray reach to refuse: stat has no download to fall into,
            # and a no-index stat reaching get_file is its legitimate API
            # entry point.
            yield Fake(
                vfs=build_vfs("gdrive", _google_config(drive)),
                key=key,
                fetches=lambda: thread.run(_downloads(drive)),
                rewrite=lambda new: thread.run(drive.put(key, new)),
                reach=[],
                read_mod=gdrive_read,
                stream_mod=gdrive_read,
                readdir=gdrive_readdir,
            )
        finally:
            thread.run(drive.run.close())
    finally:
        thread.close()


async def _app_write(
    drive: GoogleAccount, name: str, file_id: str, text: str
) -> None:
    """Write ``text`` into a Google app's file as its editor's API does,
    which moves the file's modifiedTime.

    Args:
        drive (GoogleAccount): the account.
        name (str): the app's mount name.
        file_id (str): the file.
        text (str): what is written.
    """
    if name == "gdocs":
        edit = {"insertText": {"location": {"index": 1}, "text": text}}
        await drive.run.call(
            "POST",
            f"/v1/documents/{file_id}:batchUpdate",
            json={"requests": [edit]},
        )
    elif name == "gsheets":
        await drive.run.call(
            "PUT",
            f"/v4/spreadsheets/{file_id}/values/A1",
            params={"valueInputOption": "RAW"},
            json={"values": [[text]]},
        )
    else:
        await drive.run.call(
            "POST",
            f"/v1/presentations/{file_id}:batchUpdate",
            json={
                "requests": [
                    {"insertText": {"objectId": "shape", "text": text}}
                ]
            },
        )


async def _app_file(drive: GoogleAccount, name: str, text: str) -> str:
    """A Google app's file named ``a`` holding ``text``, and its id; a
    presentation's text is in a shape on a slide of its own.

    Args:
        drive (GoogleAccount): the account.
        name (str): the app's mount name.
        text (str): what it holds.
    """
    file_id = await drive.create("a", GAPPS[name][0])
    if name == "gslides":
        on_slide = {"pageObjectId": "slide"}
        await drive.run.call(
            "POST",
            f"/v1/presentations/{file_id}:batchUpdate",
            json={
                "requests": [
                    {"createSlide": {"objectId": "slide"}},
                    {
                        "createShape": {
                            "objectId": "shape",
                            "elementProperties": on_slide,
                        }
                    },
                ]
            },
        )
    await _app_write(drive, name, file_id, text)
    return file_id


async def _searches(drive: GoogleAccount) -> int:
    return len(await drive.asked("GET", FILES))


async def _renders(drive: GoogleAccount, name: str) -> int:
    return len(await drive.asked(*RENDERS[name]))


async def _rendered(drive: GoogleAccount, name: str) -> bytes:
    """The app's answer to the last render request the mount made, asked
    again, compacted as a read hands it on.

    Args:
        drive (GoogleAccount): the account.
        name (str): the app's mount name.
    """
    asked = (await drive.asked(*RENDERS[name]))[-1]
    made = await drive.run.call("GET", f"{asked['path']}?{asked['query']}")
    return compact_json_bytes(made)


@contextmanager
def _gapps_fake(name: str, data: bytes, origin: str) -> Iterator[Fake]:
    _, read_mod, filename = GAPPS[name]
    thread = LoopThread()
    try:
        drive = thread.run(_account(GoogleAccount, origin))
        try:
            file_id = thread.run(_app_file(drive, name, data.decode()))
            item = thread.run(drive.item(file_id))
            # The account owns the file, so it lists under owned/. A rewrite
            # moves modifiedTime within the same day, which keeps the name.
            key = "owned/" + filename("a", file_id, item["modifiedTime"])
            thread.run(drive.run.record_requests())
            yield Fake(
                vfs=build_vfs(name, _google_config(drive)),
                key=key,
                fetches=lambda: thread.run(_renders(drive, name)),
                rewrite=lambda new: thread.run(
                    _app_write(drive, name, file_id, new.decode())
                ),
                reach=[],
                read_mod=read_mod,
                stream_mod=None,
                index=RAMIndexCacheStore(),
                stat_indexed=False,
                rendered=lambda: thread.run(_rendered(drive, name)),
                searched=lambda: thread.run(_searches(drive)),
            )
        finally:
            thread.run(drive.run.close())
    finally:
        thread.close()


@contextmanager
def _hf_buckets_fake(shape: str, data: bytes) -> Iterator[Fake]:
    key = KEYS[shape]
    prefix = PREFIX if shape == "prefixed" else None
    stored = (prefix or "") + key
    files = {stored: data}
    config: dict[str, str] = {"bucket": "acme/bkt"}
    if prefix is not None:
        files[key] = DECOY
        config["key_prefix"] = prefix
    # One dict behind both entry points: the Hub serves it over HTTP and the
    # opendal fake lists and writes it. The opendal fake refuses every read,
    # so a stat or read that fell back to opendal fails here.
    hub = FakeHub(repos={("buckets", "acme/bkt"): files})
    with serve(hub):
        vfs = build_vfs("hf_buckets", {**config, "endpoint": hub.url})
        assert vfs.accessor.config.key_prefix == prefix
        reach: list[str] = []
        op = FakeAsyncOperator(
            files=files, root=vfs.accessor._root() or "", reach=reach
        )
        vfs.accessor.operator = lambda: op

        def rewrite(new: bytes) -> None:
            files[stored] = new

        yield Fake(
            vfs=vfs,
            key=key,
            fetches=lambda: hub.count("bucket_resolve"),
            rewrite=rewrite,
            reach=reach,
            read_mod=hf_buckets_read,
            stream_mod=hf_buckets_stream,
        )


@contextmanager
def _github_fake(
    shape: str, data: bytes, monkeypatch: pytest.MonkeyPatch, origin: str
) -> Iterator[Fake]:
    # The nested key's parent is two or more lowercase letters, the spelling
    # Octokit rewrites when the point request goes unencoded; the python
    # twin keeps the same key so both hosts test one shape. The repository
    # runs on a loop of its own, as Dropbox's does.
    key = {"root": "a.txt", "nested": "docs/a.txt"}[shape]
    thread = LoopThread()
    try:
        repo = thread.run(_account(GitHubRepo, origin))
        try:
            thread.run(repo.create({key: data, "other.txt": DECOY}))
            vfs = build_vfs(
                "github",
                {
                    "token": GITHUB_TOKEN,
                    "owner": repo.owner,
                    "repo": repo.name,
                    "ref": "main",
                    "base_url": repo.run.url,
                },
            )
            yield Fake(
                vfs=vfs,
                key=key,
                fetches=lambda: thread.run(repo.count("blob")),
                rewrite=lambda new: thread.run(repo.commit({key: new})),
                reach=_watch_walks(vfs, monkeypatch),
                read_mod=github_read,
                stream_mod=github_read,
                readdir=github_readdir,
            )
        finally:
            thread.run(repo.run.close())
    finally:
        thread.close()


async def _account(kind: type[A], origin: str) -> A:
    """An account made on the running loop, which its session belongs to."""
    return kind(origin)


async def _requests_to(run: KitRun, route: tuple[str, str]) -> int:
    return len(await run.params(*route))


async def _dropbox_rewrite(
    dropbox: DropboxAccount, path: str, data: bytes
) -> None:
    # Two same-size edits in one second share server_modified on the real
    # service, so only content_hash may tell them apart. The fake's clock
    # moves on every write, so the stamp is set back; the reload stops the
    # request list, which starts again.
    stamp = (await dropbox.metadata(path))["server_modified"]
    await dropbox.put(path, data)
    await dropbox.run.execute(
        "UPDATE DropboxItem SET modified = ? WHERE path = ?", stamp, path
    )
    await dropbox.run.record_requests()


async def _box_rewrite(box: BoxAccount, path: str, data: bytes) -> None:
    # As _dropbox_rewrite: modified_at stays, so only sha1 tells the two
    # versions apart.
    file_id = await box.id_of(path)
    stamp = (await box.file_info(file_id))["modified_at"]
    await box.write(path, data)
    await box.run.execute(
        "UPDATE BoxItem SET modified = ? WHERE id = ?", stamp, file_id
    )
    await box.run.record_requests()


@contextmanager
def _dropbox_fake(shape: str, data: bytes, origin: str) -> Iterator[Fake]:
    # Dropbox has no key_prefix; the prefixed shape mounts a root_path
    # instead, with a decoy at the same key outside it. The harness counts
    # and rewrites from inside its own loop and does not await, so the
    # account runs on a loop of its own.
    key = KEYS[shape]
    root = "/" + PREFIX.strip("/") if shape == "prefixed" else "/"
    stored = root.rstrip("/") + "/" + key
    thread = LoopThread()
    try:
        dropbox = thread.run(_account(DropboxAccount, origin))
        try:
            thread.run(dropbox.put(stored, data))
            if shape == "prefixed":
                thread.run(dropbox.put("/" + key, DECOY))
            thread.run(dropbox.run.record_requests())
            vfs = build_vfs(
                "dropbox",
                {
                    **DROPBOX_CONFIG,
                    "root_path": root,
                    "endpoint": dropbox.run.url,
                },
            )
            yield Fake(
                vfs=vfs,
                key=key,
                fetches=lambda: thread.run(
                    _requests_to(dropbox.run, DROPBOX_DOWNLOAD)
                ),
                rewrite=lambda new: thread.run(
                    _dropbox_rewrite(dropbox, stored, new)
                ),
                reach=[],
                read_mod=dropbox_read,
                stream_mod=dropbox_read,
                readdir=dropbox_readdir,
            )
        finally:
            thread.run(dropbox.run.close())
    finally:
        thread.close()


@contextmanager
def _box_fake(shape: str, data: bytes, origin: str) -> Iterator[Fake]:
    # Box has no key_prefix; the prefixed shape mounts a root_folder_id
    # instead, with a decoy at the same key outside it. The account runs on
    # a loop of its own, as Dropbox's does.
    key = KEYS[shape]
    stored = PREFIX + key if shape == "prefixed" else key
    thread = LoopThread()
    try:
        box = thread.run(_account(BoxAccount, origin))
        try:
            thread.run(box.write(stored, data))
            if shape == "prefixed":
                thread.run(box.write(key, DECOY))
            thread.run(box.run.record_requests())
            config = {"access_token": TOKEN, "endpoint": box.run.url}
            if shape == "prefixed":
                config["root_folder_id"] = thread.run(box.id_of(PREFIX))
            yield Fake(
                vfs=build_vfs("box", config),
                key=key,
                fetches=lambda: thread.run(
                    _requests_to(box.run, BOX_DOWNLOAD)
                ),
                rewrite=lambda new: thread.run(_box_rewrite(box, stored, new)),
                reach=[],
                read_mod=box_read,
                stream_mod=box_read,
                readdir=box_readdir,
            )
        finally:
            thread.run(box.run.close())
    finally:
        thread.close()


@contextmanager
def _fake(
    name: str,
    shape: str,
    data: bytes,
    monkeypatch: pytest.MonkeyPatch,
    request: pytest.FixtureRequest | None = None,
) -> Iterator[Fake]:
    if HARNESSES[name] in ("dropbox", "box"):
        assert request is not None, name
        origin = request.getfixturevalue(f"{HARNESSES[name]}_origin")
        build = _dropbox_fake if HARNESSES[name] == "dropbox" else _box_fake
        with build(shape, data, origin) as fake:
            yield fake
        return
    if HARNESSES[name] == "hf_buckets":
        with _hf_buckets_fake(shape, data) as fake:
            yield fake
        return
    if HARNESSES[name] == "github":
        assert request is not None, name
        origin = request.getfixturevalue("github_origin")
        with _github_fake(shape, data, monkeypatch, origin) as fake:
            yield fake
        return
    if HARNESSES[name] in GRAPH:
        with _graph_fake(name, shape, data) as fake:
            yield fake
        return
    if HARNESSES[name] == "gdrive":
        assert request is not None, name
        origin = request.getfixturevalue("gws_origin")
        with _gdrive_fake(shape, data, origin) as fake:
            yield fake
        return
    if HARNESSES[name] in GAPPS:
        assert request is not None, name
        origin = request.getfixturevalue("gws_origin")
        with _gapps_fake(name, data, origin) as fake:
            yield fake
        return
    if HARNESSES[name] == "hf_models":
        with _hf_fake(name, shape, data, monkeypatch) as fake:
            yield fake
        return
    if HARNESSES[name] == "gridfs":
        with _gridfs_fake(shape, data, monkeypatch) as fake:
            yield fake
        return
    with _s3_fake(name, shape, data) as fake:
        yield fake


def _cases(rows: tuple[str, ...]) -> list:
    cases = []
    for name, family in HARNESSES.items():
        # The aliases share every read and stat path with s3, so the key
        # shapes run once per family.
        shapes = (
            FAMILY_SHAPES.get(family, ALL_SHAPES)
            if name == family
            else ("root",)
        )
        for shape in shapes:
            for row in rows:
                if row not in FAMILY_ROWS.get(family, ALL_ROWS):
                    continue
                cases.append(
                    pytest.param(name, shape, row, id=f"{name}-{shape}-{row}")
                )
    return cases


A_CASES = _cases(("bytes", "stream")) + [
    pytest.param(name, "listed", "stream", id=f"{name}-listed-stream")
    for name in ("s3", *GRAPH)
]
B_CASES = _cases(("bytes", "stream"))


def _fresh_workspace(vfs: BaseVFS) -> Workspace:
    ws = Workspace(
        {
            "/m": Mount(
                vfs=vfs,
                mode=MountMode.WRITE,
                read=ReadSpec(policy=ReadPolicy.FRESH),
            ),
            "/r": (RAMVFS(), MountMode.WRITE),
        }
    )
    _OWN_INDEX[vfs] = ws.mount("/m").index_store
    return ws


async def _line(ws: Workspace, line: str) -> bytes:
    result = await ws.shell(line)
    out = await result.materialize_stdout()
    err = await result.stderr_str()
    assert (result.exit_code, err) == (0, ""), line
    return out


async def _read_row(ws: Workspace, row: str, virtual: str) -> bytes:
    if row == "bytes":
        return await ws.vfs.read(virtual)
    return await _line(ws, COMMANDS[row].format(v=virtual))


async def _reconcile_stat(ws: Workspace, virtual: str) -> FileStat:
    # Reconcile stats through its own check store (workspace/reconcile.py),
    # so a listing's index row, which carries no token, cannot answer for it.
    return await ws.mount(virtual).call(
        "stat", virtual, index=ListingCheckStore()
    )


def _spy_slots(
    fake: Fake, monkeypatch: pytest.MonkeyPatch
) -> list[tuple[str, str]]:
    slots: list[tuple[str, str]] = []
    record = fake.read_mod.record

    def spy_record(op, path, *args, **kwargs):
        slots.append(("bytes", path))
        return record(op, path, *args, **kwargs)

    monkeypatch.setitem(vars(fake.read_mod), "record", spy_record)
    if fake.stream_mod is None:
        return slots
    record_stream = fake.stream_mod.record_stream

    def spy_record_stream(op, path, *args, **kwargs):
        slots.append(("stream", path))
        return record_stream(op, path, *args, **kwargs)

    monkeypatch.setitem(
        vars(fake.stream_mod), "record_stream", spy_record_stream
    )
    return slots


def _declared() -> set[str]:
    declared = set()
    for name in known_vfs_names():
        entry = REGISTRY.get(name)
        if entry is None:
            continue
        if load_attr(entry.vfs_path).read_revalidatable:
            declared.add(name)
    return declared


def test_each_family_runs_exactly_its_rows():
    # The per-family table is filtered at collection, so a filter bug drops
    # a row silently or hands a whole-read stream a partial row that reads
    # the whole file. Pin the ids outright rather than the count.
    aliases = [n for n in S3_FAMILY if n != "s3"] + [
        "hf_datasets",
        "hf_spaces",
    ]
    # Literals, not ALL_SHAPES / ALL_ROWS: the expectation must not move
    # with the tables it checks.
    shapes = ("root", "nested", "prefixed")
    rows = ("bytes", "stream")
    expected_a = (
        {
            f"{family}-{shape}-{row}"
            for family in (
                "s3",
                "gridfs",
                "hf_models",
                "onedrive",
                "sharepoint",
                "hf_buckets",
                "dropbox",
                "box",
            )
            for shape in shapes
            for row in rows
        }
        | {f"{n}-root-{row}" for n in aliases for row in rows}
        | {f"{n}-listed-stream" for n in ("s3", "onedrive", "sharepoint")}
        | {
            f"{family}-{shape}-{row}"
            for family in ("github", "gdrive")
            for shape in ("root", "nested")
            for row in rows
        }
        | {
            f"{family}-root-{row}"
            for family in ("gdocs", "gsheets", "gslides")
            for row in ("bytes", "stream")
        }
    )
    expected_b = {i for i in expected_a if not i.endswith("-listed-stream")}
    assert {c.id for c in A_CASES} == expected_a
    assert {c.id for c in B_CASES} == expected_b
    assert {c.id for c in WRITE_CASES} == {
        f"{family}-write-{target}"
        for family in (
            "s3",
            "gridfs",
            "hf_buckets",
            "onedrive",
            "sharepoint",
            "gdrive",
            "box",
            "dropbox",
        )
        for target in ("new", "seeded")
    }
    assert not any(
        c.id.startswith(("gdocs-", "gsheets-", "gslides-"))
        for c in _cases(("partial",))
    )


def test_every_declaring_backend_has_a_harness():
    """Every read_revalidatable backend runs the read-token contract.

    The flag lets a mount declare ``read: fresh``, which is a claim that
    stat and an ordinary read stamp the same kind of content token. For a
    long time nothing checked the read half: a backend could set the flag,
    stamp nothing on reads, and the suite stayed green while every fresh
    read refetched (#1165). The roster is walked from the registry here
    rather than imported, so a new declarer fails this test until it has
    a harness, and a harness outliving its flag fails it too.
    """
    declared = _declared()
    assert declared
    assert set(HARNESSES) == declared


@pytest.mark.parametrize(("name", "shape", "row"), A_CASES)
def test_a_read_leaves_an_entry_reconcile_calls_fresh(
    name, shape, row, monkeypatch, request
):
    data = SEED
    with _fake(name, shape, data, monkeypatch, request) as fake:
        slots = _spy_slots(fake, monkeypatch)
        virtual = "/m/" + fake.key

        async def run():
            ws = _fresh_workspace(fake.vfs)
            try:
                if shape == "listed":
                    await _line(ws, "ls /m")
                cached_before = await ws.cache.exists(virtual)
                before = fake.fetches()
                first = await _read_row(ws, row, virtual)
                fetched = fake.fetches() - before
                taken = list(slots)
                stat = await _reconcile_stat(ws, virtual)
                fresh = (
                    stat.fingerprint is not None
                    and await ws.cache.is_fresh(virtual, stat.fingerprint)
                )
                middle = fake.fetches()
                second = await _read_row(ws, row, virtual)
                return (
                    cached_before,
                    first,
                    fetched,
                    taken,
                    stat,
                    fresh,
                    fake.fetches() - middle,
                    second,
                )
            finally:
                await ws.close()

        (
            cached_before,
            first,
            fetched,
            taken,
            stat,
            fresh,
            refetched,
            second,
        ) = asyncio.run(run())
        want = fake.expected(data)

    assert cached_before is False
    assert taken == [(fake.slot(), virtual)]
    assert fetched == 1
    assert first == want
    assert stat.fingerprint is not None
    # A whole read of a rendered Google file goes through the dispatcher,
    # where a filetype read op always renders and keeps nothing, so its
    # second read fetches again. Every other read left an entry reconcile calls FRESH,
    # and the warm read made no content fetch.
    renders = row == "bytes" and name in GAPPS
    assert fresh is not renders
    assert refetched == (1 if renders else 0)
    assert second == want
    assert fake.reach == []


@pytest.mark.parametrize(("name", "shape", "row"), _cases(("partial",)))
def test_early_pipe_exit_keeps_nothing(name, shape, row, monkeypatch, request):
    with _fake(name, shape, BIG, monkeypatch, request) as fake:
        slots = _spy_slots(fake, monkeypatch)
        virtual = "/m/" + fake.key

        async def run():
            ws = _fresh_workspace(fake.vfs)
            try:
                before = fake.fetches()
                assert (
                    await _line(ws, COMMANDS[row].format(v=virtual))
                    == (BIG[:1])
                )
                assert slots == [(fake.slot(), virtual)]
                assert fake.fetches() - before == 1
                assert await ws.cache.get(virtual) is None
                assert await _line(ws, f"cat {virtual}") == BIG
                assert fake.fetches() - before == 2
            finally:
                await ws.close()

        asyncio.run(run())


@pytest.mark.parametrize(("name", "shape", "row"), B_CASES)
def test_an_unrecorded_read_stamps_the_stat_token(
    name, shape, row, monkeypatch, request
):
    records: list[OpRecord] = []

    def capture(
        op: str,
        path: str,
        source: str,
        nbytes: int,
        _timer: OpTimer,
        fingerprint: str | None = None,
        revision: str | None = None,
    ) -> None:
        records.append(
            OpRecord(
                op=op,
                path=path,
                source=source,
                bytes=nbytes,
                timestamp=0,
                duration_ms=0,
                fingerprint=fingerprint,
                revision=revision,
            )
        )

    def capture_stream(
        op: str,
        path: str,
        source: str,
        fingerprint: str | None = None,
        revision: str | None = None,
    ) -> OpRecord:
        rec = OpRecord(
            op=op,
            path=path,
            source=source,
            bytes=0,
            timestamp=0,
            duration_ms=0,
            fingerprint=fingerprint,
            revision=revision,
        )
        rec.complete = False
        records.append(rec)
        return rec

    with _fake(name, shape, SEED, monkeypatch, request) as fake:
        monkeypatch.setitem(vars(fake.read_mod), "record", capture)
        if fake.stream_mod is not None:
            monkeypatch.setitem(
                vars(fake.stream_mod), "record_stream", capture_stream
            )
        virtual = "/m/" + fake.key
        spec = PathSpec(
            virtual=virtual,
            directory=virtual.rsplit("/", 1)[0] + "/",
            vfs_path=fake.key,
        )
        accessor = fake.vfs.accessor

        async def run():
            unrecorded = not recording_active()
            try:
                data = b"".join([c async for c in fake.read_stream(spec)])
                stat = await fake.stat(spec)
            finally:
                await accessor.close()
            return unrecorded, data, stat

        unrecorded, data, stat = asyncio.run(run())
        want = fake.expected(SEED)

    assert unrecorded
    assert data == want
    assert [r.path for r in records] == [virtual]
    # The real record_stream returns None with no recorder bound, so no
    # stream read can stamp a token outside a capture at all. This row can
    # only show the stamp does not depend on the recorder check itself.
    assert records[0].complete
    assert records[0].fingerprint is not None
    assert stat.fingerprint is not None
    assert records[0].fingerprint == stat.fingerprint


FAMILIES = sorted(set(HARNESSES.values()))

# A Graph listing leaves each file's cTag in the mount index, so the listed
# rows put a token-bearing row in front of the probe: only a probe that
# stats through a throwaway index sees the rewrite.
CHANGED_CASES = [
    pytest.param(f, "root", id=f"{f}-changed-stream") for f in FAMILIES
] + [
    pytest.param(name, "listed", id=f"{name}-listed-changed-stream")
    for name in GRAPH
]


@pytest.mark.parametrize(("name", "shape"), CHANGED_CASES)
def test_a_changed_object_is_refetched(name, shape, monkeypatch, request):
    # The rows above prove stat and read agree; this proves what they agree
    # on is the content. A backend stamping a constant, or the key, on both
    # sides passes every other row and serves stale bytes here.
    with _fake(name, shape, SEED, monkeypatch, request) as fake:
        virtual = "/m/" + fake.key

        async def run():
            ws = _fresh_workspace(fake.vfs)
            try:
                if shape == "listed":
                    await _line(ws, "ls /m")
                await _line(ws, f"cat {virtual}")
                fake.rewrite(CHANGED)
                stat = await _reconcile_stat(ws, virtual)
                fresh = (
                    stat.fingerprint is not None
                    and await ws.cache.is_fresh(virtual, stat.fingerprint)
                )
                before = fake.fetches()
                second = await _line(ws, f"cat {virtual}")
                refetched = fake.fetches() - before
                # The refetch has to stamp the new token, or every later
                # read refetches as well and the backend never serves warm.
                restat = await _reconcile_stat(ws, virtual)
                refreshed = (
                    restat.fingerprint is not None
                    and await ws.cache.is_fresh(virtual, restat.fingerprint)
                )
                before = fake.fetches()
                third = await _line(ws, f"cat {virtual}")
                return (
                    stat,
                    fresh,
                    refetched,
                    second,
                    refreshed,
                    fake.fetches() - before,
                    third,
                )
            finally:
                await ws.close()

        (stat, fresh, refetched, second, refreshed, third_fetched, third) = (
            asyncio.run(run())
        )
        want = fake.expected(CHANGED)

    assert stat.fingerprint is not None
    assert not fresh
    assert refetched == 1
    assert second == want
    assert refreshed
    assert third_fetched == 0
    assert third == want
    assert fake.reach == []


def _wires_write(name: str) -> bool:
    vfs = load_attr(REGISTRY[name].vfs_path)
    return vfs.write is not BaseVFS.write


def _writable_names() -> set[str]:
    # Derived from the registry and each backend's own write function,
    # not listed: a declarer that gains a write joins the write rows.
    return {name for name in _declared() if _wires_write(name)}


def _write_families() -> set[str]:
    return {HARNESSES[n] for n in _writable_names() if n in HARNESSES}


# hf_buckets, onedrive and sharepoint record no write token, as on main, so
# the next fresh read downloads once.
WRITE_EXCEPTIONS = {"hf_buckets": 1, "onedrive": 1, "sharepoint": 1}
WRITE_TARGETS = {"new": "w.txt", "seeded": KEYS["root"]}
WRITE_FAMILIES = sorted(_write_families())
WRITE_CASES = [
    pytest.param(family, target, id=f"{family}-write-{target}")
    for family in WRITE_FAMILIES
    for target in WRITE_TARGETS
]


def test_every_writable_family_has_a_write_harness_or_an_exception():
    # The write rows run each family's own harness through _fake, so a
    # writable family is covered exactly when it has a harness; the
    # exception table may name only writable families.
    names = _writable_names()
    assert names
    assert names <= set(HARNESSES)
    assert set(WRITE_EXCEPTIONS) <= _write_families()


@pytest.mark.parametrize(("family", "target"), WRITE_CASES)
def test_a_written_file_is_served_without_a_download(
    family, target, monkeypatch, request
):
    # The new target takes the create path (box/gdrive new upload, Graph
    # create), the seeded one the update path (version, update by id).
    with _fake(family, "root", SEED, monkeypatch, request) as fake:
        virtual = "/m/" + WRITE_TARGETS[target]

        async def run():
            ws = _fresh_workspace(fake.vfs)
            try:
                await _line(ws, f"echo new | tee {virtual}")
                written = list(fake.reach)
                before = fake.fetches()
                out = await _line(ws, f"cat {virtual}")
                return out, fake.fetches() - before, written
            finally:
                await ws.close()

        out, downloads, written = asyncio.run(run())

    assert out == b"new\n"
    assert downloads == WRITE_EXCEPTIONS.get(family, 0)
    # A new gridfs key's stat miss asks files_coll whether the key names a
    # folder, a dispatcher the read rows refuse; the read itself reaches
    # nothing.
    stat_miss = family == "gridfs" and target == "new"
    assert written == (["files_coll"] if stat_miss else [])
    assert fake.reach == written


def _dropbox_routes(requests: list[str]) -> list[str]:
    """Each request's endpoint name, the token refresh left out."""
    names = [request.rsplit("/", 1)[-1] for request in requests]
    return [name for name in names if name != "token"]


def _dropbox_vfs(dropbox: DropboxAccount) -> BaseVFS:
    return build_vfs(
        "dropbox", {**DROPBOX_CONFIG, "endpoint": dropbox.run.url}
    )


def test_a_dropbox_fresh_probe_asks_for_the_file_not_its_folder(
    dropbox_origin,
):
    # The probe stats through a throwaway store, so dropbox answers it
    # with one get_metadata rather than listing the whole folder into it.
    files = {"/d/a.txt": SEED, **{f"/d/f{i}.txt": DECOY for i in range(5)}}

    async def run():
        dropbox = DropboxAccount(dropbox_origin)
        try:
            for path, data in files.items():
                await dropbox.put(path, data)
            ws = _fresh_workspace(_dropbox_vfs(dropbox))
            try:
                await _line(ws, "cat /m/d/a.txt")
                await dropbox.run.record_requests()
                out = await _line(ws, "cat /m/d/a.txt")
                return out, _dropbox_routes(await dropbox.run.requests())
            finally:
                await ws.close()
        finally:
            await dropbox.run.close()

    out, routes = asyncio.run(run())
    assert out == SEED
    assert "list_folder" not in routes
    assert "download" not in routes
    assert "get_metadata" in routes


@pytest.mark.parametrize("gone", [False, True], ids=["restricted", "deleted"])
def test_a_dropbox_probe_drops_an_overlay_only_on_a_miss(gone, dropbox_origin):
    # A 409 other than not_found cannot verify the copy: the read fails but
    # the file is not called gone, so chmod's 600 stays. A real miss drops
    # it, so it never carries over to a file re-created at the path.

    async def run():
        dropbox = DropboxAccount(dropbox_origin)
        try:
            await dropbox.put("/d/a.txt", SEED)
            ws = _fresh_workspace(_dropbox_vfs(dropbox))
            try:
                await _line(ws, "cat /m/d/a.txt")
                await _line(ws, "chmod 600 /m/d/a.txt")
                if gone:
                    await dropbox.remove("/d/a.txt")
                else:
                    # Dropbox refuses content it may not serve this way, on
                    # its metadata and on its download, for as long as the
                    # restriction stands.
                    for route in (
                        "/2/files/get_metadata",
                        "/2/files/download",
                    ):
                        await dropbox.run.answer_next(
                            "POST", route, 409, RESTRICTED, times=EVERY
                        )
                result = await ws.shell("cat /m/d/a.txt")
                err = await result.stderr_str()
                await dropbox.run.clear_answers()
                await dropbox.put("/d/a.txt", SEED)
                mode = await _line(ws, "stat -c %a /m/d/a.txt")
                return result.exit_code, err, mode
            finally:
                await ws.close()
        finally:
            await dropbox.run.close()

    code, err, mode = asyncio.run(run())
    assert code == 1
    assert ("No such file" in err) is gone
    assert mode == (b"644\n" if gone else b"600\n")


@pytest.fixture()
def moto_endpoint() -> Iterator[str]:
    server = ThreadedMotoServer(ip_address="127.0.0.1", port=0, verbose=False)
    server.start()
    host, port = server.get_host_and_port()
    yield f"http://{host}:{port}"
    server.stop()


def test_moto_agrees_that_stat_and_read_stamp_one_token(
    moto_endpoint, monkeypatch
):
    # The fakes derive Head and Get ETags from one helper, so they cannot
    # disagree; moto 5.2.1 (uv.lock) is the real implementation checked here,
    # multipart included. Its part-size floor is patched so two tiny parts
    # make a real multipart object.
    monkeypatch.setattr(moto.s3.models, "S3_UPLOAD_PART_MIN_SIZE", 5)
    client = boto3.client(
        "s3",
        endpoint_url=moto_endpoint,
        aws_access_key_id="testing",
        aws_secret_access_key="testing",
        region_name="us-east-1",
    )
    client.create_bucket(Bucket="bkt")
    client.put_object(Bucket="bkt", Key="simple.txt", Body=SEED)
    upload = client.create_multipart_upload(Bucket="bkt", Key="multi.txt")
    parts = []
    for number, body in enumerate((b"first part\n", b"second part\n"), 1):
        part = client.upload_part(
            Bucket="bkt",
            Key="multi.txt",
            PartNumber=number,
            UploadId=upload["UploadId"],
            Body=body,
        )
        parts.append({"ETag": part["ETag"], "PartNumber": number})
    client.complete_multipart_upload(
        Bucket="bkt",
        Key="multi.txt",
        UploadId=upload["UploadId"],
        MultipartUpload={"Parts": parts},
    )
    vfs = build_vfs(
        "s3",
        {
            "bucket": "bkt",
            "region": "us-east-1",
            "endpoint_url": moto_endpoint,
            "aws_access_key_id": "testing",
            "aws_secret_access_key": "testing",
            "path_style": True,
        },
    )

    async def run():
        ws = _fresh_workspace(vfs)
        try:
            seen = {}
            for key in ("simple.txt", "multi.txt"):
                virtual = f"/m/{key}"
                cached_before = await ws.cache.exists(virtual)
                await _line(ws, f"cat {virtual}")
                stat = await _reconcile_stat(ws, virtual)
                fresh = (
                    stat.fingerprint is not None
                    and await ws.cache.is_fresh(virtual, stat.fingerprint)
                )
                seen[key] = (cached_before, stat.fingerprint, fresh)
            return seen
        finally:
            await ws.close()

    seen = asyncio.run(run())

    for cached_before, fingerprint, fresh in seen.values():
        assert cached_before is False
        assert fingerprint is not None
        assert fresh
    assert seen["multi.txt"][1].endswith("-2")


def test_the_contract_goes_red_on_a_backend_with_two_token_kinds(monkeypatch):
    # s3 forced to stat a timestamp while its read stamps the ETag: both
    # tokens exist and differ. The contract must fail it, or it could not
    # tell a backend that keeps the promise from one that only makes it.
    objects = {"a.txt": SEED}
    session = MultiBucketSession({"b": objects}, etag_suffix=SUFFIX)
    head_object = session._client.head_object

    async def timestamped(**kwargs):
        resp = await head_object(**kwargs)
        return {**resp, "ETag": '"2026-04-16T00:00:00Z"'}

    monkeypatch.setattr(session._client, "head_object", timestamped)
    virtual = "/m/a.txt"

    async def run():
        ws = _fresh_workspace(vfs)
        try:
            await _line(ws, f"cat {virtual}")
            before = session._client.calls["get_object"]
            read_token = hashlib.md5(SEED).hexdigest() + SUFFIX
            holds_read_token = await ws.cache.is_fresh(virtual, read_token)
            stat = await _reconcile_stat(ws, virtual)
            assert stat.fingerprint is not None
            fresh = await ws.cache.is_fresh(virtual, stat.fingerprint)
            await _line(ws, f"cat {virtual}")
            return (
                holds_read_token,
                stat.fingerprint != read_token,
                fresh,
                session._client.calls["get_object"] - before,
            )
        finally:
            await ws.close()

    with patch_s3_session(session):
        vfs = build_vfs("s3", S3_CONFIG)
        holds_read_token, kinds_differ, fresh, refetched = asyncio.run(run())

    # The entry does hold the read's token, so a helper that compared the
    # entry with itself would call it fresh.
    assert holds_read_token
    # The stat token exists and is another kind; a missing one would also
    # read as not fresh without showing a mismatch go red.
    assert kinds_differ
    assert not fresh
    assert refetched > 0


def test_the_contract_goes_red_on_hf_stamping_another_kind(monkeypatch):
    # hf forced to stamp the download's own ETag (the xet hash) while stat
    # reports the git oid: both tokens exist and differ, the mismatch the
    # verified stamp exists to prevent.
    def raw_etag(_entry, etag: str) -> str:
        return etag_value(etag)

    with _fake("hf_models", "root", SEED, monkeypatch) as fake:
        monkeypatch.setitem(vars(hf_read), "row_token", raw_etag)
        monkeypatch.setitem(vars(hf_stream), "row_token", raw_etag)
        virtual = "/m/" + fake.key

        async def run():
            ws = _fresh_workspace(fake.vfs)
            try:
                await _line(ws, f"cat {virtual}")
                holds_read_token = await ws.cache.is_fresh(
                    virtual, xet_hash(SEED)
                )
                stat = await _reconcile_stat(ws, virtual)
                fresh = await ws.cache.is_fresh(virtual, stat.fingerprint)
                return holds_read_token, stat.fingerprint, fresh
            finally:
                await ws.close()

        holds_read_token, fingerprint, fresh = asyncio.run(run())

    assert holds_read_token
    assert fingerprint == blob_oid(SEED)
    assert fingerprint != xet_hash(SEED)
    assert not fresh


def test_the_contract_goes_red_on_msgraph_stamping_another_kind(monkeypatch):
    # onedrive forced to stamp the item's eTag on the read while stat
    # reports its cTag: both tokens exist and differ as strings on every
    # write, so the contract must call the entry stale.
    capture = drive_ops.capture_item_metadata

    async def etag_instead(accessor, loc, *args, **kwargs):
        _ctag, revision, url = await capture(accessor, loc, *args, **kwargs)
        item = await drive_ops.graph_get(accessor, loc.item())
        return item["eTag"], revision, url

    with _fake("onedrive", "root", SEED, monkeypatch) as fake:
        monkeypatch.setitem(
            vars(drive_ops), "capture_item_metadata", etag_instead
        )
        monkeypatch.setattr(fake.vfs, "read_revalidatable", True)
        virtual = "/m/" + fake.key

        async def run():
            ws = _fresh_workspace(fake.vfs)
            try:
                await _line(ws, f"cat {virtual}")
                holds_read_token = await ws.cache.is_fresh(virtual, "e1")
                stat = await _reconcile_stat(ws, virtual)
                fresh = await ws.cache.is_fresh(virtual, stat.fingerprint)
                return holds_read_token, stat.fingerprint, fresh
            finally:
                await ws.close()

        holds_read_token, fingerprint, fresh = asyncio.run(run())

    assert holds_read_token
    assert fingerprint == "c1"
    assert not fresh


def test_the_contract_goes_red_on_hf_buckets_stamping_another_kind(
    monkeypatch,
):
    # hf_buckets forced to stamp a hash of the header rather than the token
    # stat reports: both exist and differ, so the entry must never be
    # called fresh, and the warm read refetches exactly once.
    def other_kind(raw: str) -> str:
        return hashlib.sha1(raw.encode()).hexdigest()

    with _fake("hf_buckets", "root", SEED, monkeypatch) as fake:
        monkeypatch.setitem(vars(hf_buckets_read), "read_token", other_kind)
        monkeypatch.setitem(vars(hf_buckets_stream), "read_token", other_kind)
        virtual = "/m/" + fake.key
        served = f'"{xet_hash(SEED)}"'

        async def run():
            ws = _fresh_workspace(fake.vfs)
            try:
                await _line(ws, f"cat {virtual}")
                holds_read_token = await ws.cache.is_fresh(
                    virtual, other_kind(served)
                )
                stat = await _reconcile_stat(ws, virtual)
                fresh = await ws.cache.is_fresh(virtual, stat.fingerprint)
                before = fake.fetches()
                await _line(ws, f"cat {virtual}")
                return (
                    holds_read_token,
                    stat.fingerprint,
                    fresh,
                    fake.fetches() - before,
                )
            finally:
                await ws.close()

        holds_read_token, fingerprint, fresh, refetched = asyncio.run(run())

    assert holds_read_token
    assert fingerprint == xet_hash(SEED)
    assert not fresh
    assert refetched == 1


def test_a_rendered_read_is_the_read_it_records_through():
    # gdocs answers a whole read with its rendering, which is why its
    # expected slot is "bytes". A stream that forgot to record would
    # otherwise hide behind stream_mod=None.
    vfs = vfs_over(GDocsVFS, None)
    assert not vfs.supports("read")


def test_the_contract_goes_red_on_github_stamping_another_kind(
    monkeypatch, request
):
    # github forced to stamp an md5 of the bytes while stat reports the blob
    # sha: both tokens exist and differ. A whole read streams, so the
    # override replaces what `record_stream` stamps.
    record_stream = github_read.record_stream

    def md5_record(op, path, source, fingerprint=None, revision=None):
        del fingerprint
        return record_stream(
            op,
            path,
            source,
            fingerprint=hashlib.md5(SEED).hexdigest(),
            revision=revision,
        )

    with _fake("github", "root", SEED, monkeypatch, request) as fake:
        monkeypatch.setitem(vars(github_read), "record_stream", md5_record)
        virtual = "/m/" + fake.key

        async def run():
            ws = _fresh_workspace(fake.vfs)
            try:
                await ws.vfs.read(virtual)
                holds_read_token = await ws.cache.is_fresh(
                    virtual, hashlib.md5(SEED).hexdigest()
                )
                stat = await _reconcile_stat(ws, virtual)
                fresh = await ws.cache.is_fresh(virtual, stat.fingerprint)
                return holds_read_token, stat.fingerprint, fresh
            finally:
                await ws.close()

        holds_read_token, fingerprint, fresh = asyncio.run(run())

    assert holds_read_token
    assert fingerprint == blob_sha(SEED)
    assert not fresh


@pytest.mark.parametrize("name", ["gdocs", "gsheets", "gslides"])
def test_partial_search_cannot_evict_live_app_bytes_or_overlay(
    name, monkeypatch, request
):
    with _fake(name, "root", SEED, monkeypatch, request) as fake:
        virtual = "/m/" + fake.key
        assert fake.searched is not None
        searched = fake.searched

        async def run():
            ws = _fresh_workspace(fake.vfs)
            try:
                first = await _line(ws, f"cat {virtual}")
                await _line(ws, f"chmod 600 {virtual}")
                before = fake.fetches()
                listed = searched()
                assert await _line(ws, f"cat {virtual}") == first
                assert await _line(ws, f"stat -c %a {virtual}") == b"600\n"
                assert fake.fetches() == before
                # Neither the read nor the stat searched Drive.
                assert searched() == listed
                return first
            finally:
                await ws.close()

        first = asyncio.run(run())
        want = fake.expected(SEED)

    assert first == want


DEEP = "a/b/c.txt"
BOX_INFO = ("GET", "/2.0/files/:file_id")
FORBIDDEN = {
    "type": "error",
    "status": 403,
    "code": "forbidden",
    "message": "Access denied - insufficient permission",
}
TRASHED = {
    "type": "error",
    "status": 404,
    "code": "trashed",
    "message": "Item is trashed",
}


def _info(file_id: str) -> str:
    return f"GET /2.0/files/{file_id}"


def _content(file_id: str) -> str:
    return f"GET /2.0/files/{file_id}/content"


def _dl(file_id: str) -> str:
    return f"GET /dl/{file_id}"


def _items(folder_id: str) -> str:
    return f"GET /2.0/folders/{folder_id}/items"


async def _deep_box(box: BoxAccount, root: str = "") -> None:
    # Decoys at every level, so a folder listing reads differently from a
    # point lookup by id.
    await box.write(f"{root}{DEEP}", SEED)
    for level in ("", "a/", "a/b/"):
        for i in range(5):
            await box.write(f"{root}{level}d{i}.txt", DECOY)


async def _box_vfs(box: BoxAccount, root: str = "") -> BaseVFS:
    config = {"access_token": TOKEN, "endpoint": box.run.url}
    if root:
        config["root_folder_id"] = await box.id_of(root)
    return build_vfs("box", config)


async def _run(ws: Workspace, line: str) -> tuple[int, bytes, str]:
    result = await ws.shell(line)
    out = await result.materialize_stdout()
    return result.exit_code, out, await result.stderr_str()


async def _walk(box: BoxAccount) -> list[str]:
    return [
        _items("0"),
        _items(await box.id_of("a")),
        _items(await box.id_of("a/b")),
    ]


def _box_case(origin: str, scenario, root: str = ""):
    async def run():
        box = BoxAccount(origin)
        try:
            await _deep_box(box, root)
            vfs = await _box_vfs(box, root)
            await box.run.record_requests()
            ws = _fresh_workspace(vfs)
            try:
                return await scenario(ws, box)
            finally:
                await ws.close()
        finally:
            await box.run.close()

    return asyncio.run(run())


def test_a_cold_fresh_box_read_lists_each_level_once_then_downloads(
    box_origin,
):
    out, log, walk, fid = _box_case(
        box_origin,
        _a_cold_fresh_box_read_lists_each_level_once_then_downloads_case,
    )
    assert out == SEED
    assert log == walk + [_content(fid), _dl(fid)]


@pytest.mark.parametrize("root", ["", "r/"])
def test_a_warm_fresh_box_read_is_one_request_by_id(root, box_origin):
    out, log, fid = _box_case(
        box_origin,
        functools.partial(
            _a_warm_fresh_box_read_is_one_request_by_id_case, root=root
        ),
        root=root,
    )
    assert out == SEED
    assert log == [_info(fid)]


def test_a_fresh_box_read_after_a_tee_probes_once_without_a_download(
    box_origin,
):
    async def scenario(ws, box):
        await _line(ws, f"echo new | tee /m/{DEEP}")
        await box.run.record_requests()
        out = await _line(ws, f"cat /m/{DEEP}")
        return out, await box.run.requests(), await box.id_of(DEEP)

    out, log, fid = _box_case(box_origin, scenario)
    assert out == b"new\n"
    # The write keeps the row its reply named, so the probe after it is one
    # info by id rather than a parent walk.
    assert log == [_info(fid)]


async def _direct_box_read_case(ws, box):
    assert await ws.vfs.read(f"/m/{DEEP}") == SEED
    await box.run.record_requests()
    assert await ws.vfs.read(f"/m/{DEEP}") == SEED
    return await box.run.requests(), await box.id_of(DEEP)


def test_direct_warm_fresh_box_read_is_one_request_by_id(box_origin):
    log, fid = _box_case(box_origin, _direct_box_read_case)
    assert log == [_info(fid)]


def test_with_its_index_cleared_a_warm_box_read_walks_every_time(box_origin):
    # Every stale or unknown verdict on the mount clears its index, and a
    # fresh verdict reached by the walk refills only the throwaway store:
    # until a cold read or a listing refills it, each check walks.

    logs, walk = _box_case(
        box_origin,
        _with_its_index_cleared_a_warm_box_read_walks_every_time_case,
    )
    assert logs == [walk, walk]


def test_a_same_size_box_rewrite_in_the_same_second_is_refetched(box_origin):
    # The rewrite keeps modified_at, as the real service does within a
    # second: only sha1 tells the two versions apart, and it must come from
    # Box's live answer, not the cached row.

    out, log, walk, fid = _box_case(
        box_origin,
        _a_same_size_box_rewrite_in_the_same_second_is_refetched_case,
    )
    assert len(CHANGED) == len(SEED)
    assert out == CHANGED
    # The read is handed the probe's live row, so it downloads by id.
    assert log == [_info(fid), _content(fid), _dl(fid)]


def test_a_box_file_moved_outside_is_gone_and_drops_its_overlay(box_origin):
    code, err, log, meta, moved, fid, walk = _box_case(
        box_origin,
        _a_box_file_moved_outside_is_gone_and_drops_its_overlay_case,
    )
    assert code == 1
    assert "No such file or directory" in err
    assert meta is None
    assert moved == SEED
    # The probe: one info by the hinted id, which places the file elsewhere;
    # its walk lists the old parent chain and misses. GONE clears the mount
    # index, so cat's own stat walks once more.
    assert log == [_info(fid)] + walk + walk


@pytest.mark.parametrize("mode", ["trash", "purge"])
def test_a_box_file_deleted_and_recreated_is_read_anew(mode, box_origin):
    async def scenario(ws, box):
        await _line(ws, f"cat /m/{DEEP}")
        await _line(ws, f"chmod 600 /m/{DEEP}")
        old = await box.id_of(DEEP)
        await box.remove(DEEP)
        if mode == "trash":
            # A trashed file keeps its id, which Box answers as trashed
            # rather than not found.
            await box.run.answer_next(
                *BOX_INFO, 404, TRASHED, times=EVERY, path=f"/2.0/files/{old}"
            )
        new = await box.write(DEEP, CHANGED)
        await box.run.record_requests()
        out = await _line(ws, f"cat /m/{DEEP}")
        log = await box.run.requests()
        mode_bits = await _line(ws, f"stat -c %a /m/{DEEP}")
        return out, log, mode_bits, old, new, await _walk(box)

    out, log, mode_bits, old, new, walk = _box_case(box_origin, scenario)
    assert out == CHANGED
    # The probe's walk finds the new id, and the read is handed that live
    # row: no second walk.
    assert log == [_info(old)] + walk + [_content(new), _dl(new)]
    # STALE keeps the overlay; reading the purged id's 404 as gone would
    # have dropped it while the walk still printed the new bytes.
    assert mode_bits == b"600\n"


def test_a_box_file_recreated_with_the_same_bytes_is_served_warm(box_origin):
    logs, old, new, walk = _box_case(
        box_origin,
        _a_box_file_recreated_with_the_same_bytes_is_served_warm_case,
    )
    assert logs == [[_info(old)] + walk, [_info(new)]]


def test_a_box_file_under_a_renamed_parent_is_gone(box_origin):
    code, err, renamed, log, fid, to_a = _box_case(
        box_origin, _a_box_file_under_a_renamed_parent_is_gone_case
    )
    assert code == 1
    assert "No such file or directory" in err
    assert renamed == SEED
    # Each walk stops at a, which no longer holds b: the probe's, then cat's
    # own stat over the cleared index.
    assert log == [_info(fid)] + to_a + to_a


def test_a_box_file_under_a_trashed_mount_root_is_gone(box_origin):
    # Trashing the root makes metadata for its descendant return not_found,
    # as deleting it does, which stands for it here.

    code, out, err, log, root, fid = _box_case(
        box_origin,
        _a_box_file_under_a_trashed_mount_root_is_gone_case,
        root="r/",
    )
    assert code == 1
    assert out == b""
    assert "No such file or directory" in err
    # The root's listing 404s each time: the probe's walk, cat's own stat,
    # then the parent listing cat's missing-operand path asks for.
    assert log == [_info(fid)] + [_items(root)] * 3


def test_a_box_file_the_user_lost_info_access_to_is_checked_by_the_walk(
    box_origin,
):
    out, log, again, mode_bits, fid, walk = _box_case(
        box_origin,
        _a_box_file_the_user_lost_info_access_to_is_checked_by_the_walk_case,
    )
    assert out == SEED
    # Each check pays the refused GET and the walk again: an accepted cost.
    assert log == again == [_info(fid)] + walk
    assert mode_bits == b"600\n"


def test_a_box_file_with_no_sha1_is_refetched_on_every_fresh_read(box_origin):
    # Pinned on purpose: a file Box gives no sha1 cannot be verified, so
    # each fresh read is UNKNOWN -- a cold download and a cleared mount
    # index. That cost is the documented price of an unverifiable file.

    out, log, fid, walk = _box_case(
        box_origin,
        _a_box_file_with_no_sha1_is_refetched_on_every_fresh_read_case,
    )
    assert out == SEED
    assert log == [_info(fid), _content(fid), _dl(fid)]


def test_a_warm_box_ls_shows_what_a_cold_one_does_from_one_request(
    box_origin,
):
    # The probe's stat is reused by the command's own stat, so the fields
    # the probe asks for must carry everything ls prints.

    cold, warm, log, fid = _box_case(
        box_origin,
        _a_warm_box_ls_shows_what_a_cold_one_does_from_one_request_case,
    )
    assert warm == cold
    assert log == [_info(fid)]


async def _replaced_box_folder_case(ws, box, root="", operand="/m/a/b"):
    await _line(ws, f"ls {operand}")
    await box.move(f"{root}a/b", f"{root}a/old")
    await box.write(f"{root}a/b/new.txt", b"new listing")
    await box.write(f"{root}{DEEP}", CHANGED)
    await box.run.record_requests()
    listing = await _line(ws, f"ls {operand}")
    body = await _line(ws, f"cat /m/{DEEP}")
    log = await box.run.requests()
    walk = [
        _items(await box.id_of(root) if root else "0"),
        _items(await box.id_of(root + "a")),
        _items(await box.id_of(root + "a/b")),
    ]
    return listing, body, log, walk, await box.id_of(root + DEEP)


@pytest.mark.parametrize("root", ["", "sub/"])
@pytest.mark.parametrize("operand", ["/m/a/b", "/m/a/b/"])
def test_fresh_box_listing_resolves_replaced_parent_folder(
    root, operand, box_origin
):
    async def scenario(ws, box):
        return await _replaced_box_folder_case(ws, box, root, operand)

    listing, body, log, walk, fid = _box_case(box_origin, scenario, root)
    assert listing == b"c.txt\nnew.txt\n"
    assert body == CHANGED
    assert log == walk + walk + [_content(fid), _dl(fid)]


async def _a_cold_fresh_box_read_lists_each_level_once_then_downloads_case(
    ws, box
):
    out = await _line(ws, f"cat /m/{DEEP}")
    log = await box.run.requests()
    return out, log, await _walk(box), await box.id_of(DEEP)


async def _a_warm_fresh_box_read_is_one_request_by_id_case(ws, box, root):
    await _line(ws, f"cat /m/{DEEP}")
    await box.run.record_requests()
    out = await _line(ws, f"cat /m/{DEEP}")
    return out, await box.run.requests(), await box.id_of(root + DEEP)


async def _with_its_index_cleared_a_warm_box_read_walks_every_time_case(
    ws, box
):
    await _line(ws, f"cat /m/{DEEP}")
    logs = []
    for _ in range(2):
        await ws.mount("/m").index.clear()
        await box.run.record_requests()
        assert await _line(ws, f"cat /m/{DEEP}") == SEED
        logs.append(await box.run.requests())
    return logs, await _walk(box)


async def _a_same_size_box_rewrite_in_the_same_second_is_refetched_case(
    ws, box
):
    await _line(ws, f"cat /m/{DEEP}")
    fid = await box.id_of(DEEP)
    stamp = (await box.file_info(fid))["modified_at"]
    await box.write(DEEP, CHANGED)
    # The fake's clock moves on every write, so the stamp is set back.
    await box.run.execute(
        "UPDATE BoxItem SET modified = ? WHERE id = ?", stamp, fid
    )
    await box.run.record_requests()
    out = await _line(ws, f"cat /m/{DEEP}")
    return out, await box.run.requests(), await _walk(box), fid


async def _a_box_file_moved_outside_is_gone_and_drops_its_overlay_case(
    ws, box
):
    await _line(ws, f"cat /m/{DEEP}")
    await _line(ws, f"chmod 600 /m/{DEEP}")
    fid = await box.id_of(DEEP)
    await box.move(DEEP, "a/x/c.txt")
    await box.run.record_requests()
    code, _, err = await _run(ws, f"cat /m/{DEEP}")
    log = await box.run.requests()
    meta = ws.namespace.meta_for(f"/m/{DEEP}")
    moved = await _line(ws, "cat /m/a/x/c.txt")
    return code, err, log, meta, moved, fid, await _walk(box)


async def _a_box_file_recreated_with_the_same_bytes_is_served_warm_case(
    ws, box
):
    await _line(ws, f"cat /m/{DEEP}")
    old = await box.id_of(DEEP)
    await box.remove(DEEP)
    new = await box.write(DEEP, SEED)
    logs = []
    for _ in range(2):
        await box.run.record_requests()
        assert await _line(ws, f"cat /m/{DEEP}") == SEED
        logs.append(await box.run.requests())
    return logs, old, new, await _walk(box)


async def _a_box_file_under_a_renamed_parent_is_gone_case(ws, box):
    await _line(ws, f"cat /m/{DEEP}")
    fid, to_a = await box.id_of(DEEP), (await _walk(box))[:2]
    await box.move("a/b", "a/b2")
    await box.run.record_requests()
    code, _, err = await _run(ws, f"cat /m/{DEEP}")
    log = await box.run.requests()
    renamed = await _line(ws, "cat /m/a/b2/c.txt")
    return code, err, renamed, log, fid, to_a


async def _a_box_file_under_a_trashed_mount_root_is_gone_case(ws, box):
    await _line(ws, f"cat /m/{DEEP}")
    root, fid = await box.id_of("r"), await box.id_of("r/" + DEEP)
    await box.remove("r")
    await box.run.record_requests()
    code, out, err = await _run(ws, f"cat /m/{DEEP}")
    return code, out, err, await box.run.requests(), root, fid


async def _a_box_file_the_user_lost_info_access_to_is_checked_by_the_walk_case(
    ws, box
):
    await _line(ws, f"cat /m/{DEEP}")
    await _line(ws, f"chmod 600 /m/{DEEP}")
    fid = await box.id_of(DEEP)
    await box.run.answer_next(
        *BOX_INFO, 403, FORBIDDEN, times=EVERY, path=f"/2.0/files/{fid}"
    )
    await box.run.record_requests()
    out = await _line(ws, f"cat /m/{DEEP}")
    log = await box.run.requests()
    mode_bits = await _line(ws, f"stat -c %a /m/{DEEP}")
    await box.run.record_requests()
    assert await _line(ws, f"cat /m/{DEEP}") == SEED
    again = await box.run.requests()
    return out, log, again, mode_bits, fid, await _walk(box)


async def _a_box_file_with_no_sha1_is_refetched_on_every_fresh_read_case(
    ws, box
):
    fid = await box.id_of(DEEP)
    await box.unhash(fid)
    await _line(ws, f"cat /m/{DEEP}")
    await box.run.record_requests()
    out = await _line(ws, f"cat /m/{DEEP}")
    return out, await box.run.requests(), fid, await _walk(box)


async def _a_warm_box_ls_shows_what_a_cold_one_does_from_one_request_case(
    ws, box
):
    cold = await _line(ws, f"ls -l /m/{DEEP}")
    await _line(ws, f"cat /m/{DEEP}")
    await box.run.record_requests()
    warm = await _line(ws, f"ls -l /m/{DEEP}")
    return cold, warm, await box.run.requests(), await box.id_of(DEEP)
