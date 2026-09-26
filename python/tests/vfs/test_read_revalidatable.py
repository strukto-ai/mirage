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
import hashlib
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from types import ModuleType

import boto3
import moto.s3.models
import pytest
from bson import ObjectId
from moto.server import ThreadedMotoServer

import mirage.cache.file.io as cache_io
import mirage.core.gridfs.client as gridfs_client
import mirage.core.gridfs.driver as gridfs_driver
import mirage.core.gridfs.read as gridfs_read
import mirage.core.gridfs.stream as gridfs_stream
import mirage.core.gridfs.watch as gridfs_watch
import mirage.core.hf_buckets.read as hf_buckets_read
import mirage.core.hf_buckets.stream as hf_buckets_stream
import mirage.core.hf_hub.read as hf_read
import mirage.core.hf_hub.stream as hf_stream
import mirage.core.msgraph.drive_ops as drive_ops
import mirage.core.s3.read as s3_read
import mirage.core.s3.stream as s3_stream
from mirage.cache.index import RAMIndexCacheStore
from mirage.commands.builtin.generic_bind.adapter import CommandIO
from mirage.commands.builtin.gridfs.io import IO as GRIDFS_IO
from mirage.commands.builtin.hf_buckets.io import IO as HF_BUCKETS_IO
from mirage.commands.builtin.hf_hub.io import IO as HF_IO
from mirage.commands.builtin.onedrive.io import IO as ONEDRIVE_IO
from mirage.commands.builtin.s3.io import IO as S3_IO
from mirage.commands.builtin.sharepoint.io import IO as SHAREPOINT_IO
from mirage.core.hf_hub.client import etag_value
from mirage.io.cachable_iterator import CachableAsyncIterator
from mirage.io.types import IOResult
from mirage.observe.context import OpTimer, RecordingScope, active_recorder
from mirage.observe.record import OpRecord
from mirage.types import FileStat, MountMode, PathSpec, ReadPolicy, ReadSpec
from mirage.vfs.base import BaseVFS
from mirage.vfs.gdrive import GoogleDriveConfig, GoogleDriveVFS
from mirage.vfs.loader import load_attr
from mirage.vfs.ram import RAMVFS
from mirage.vfs.registry import REGISTRY, build_vfs, known_vfs_names
from mirage.workspace import Workspace
from mirage.workspace.mount import Mount
from tests.e2e.gdrive_mock import FakeGDrive, patch_gdrive
from tests.e2e.s3_mock import MultiBucketSession, patch_s3_session
from tests.fixtures.hf_buckets_opendal import FakeAsyncOperator
from tests.fixtures.hf_hub_api import FakeHub, blob_oid, serve, xet_hash
from tests.fixtures.msgraph_api import (DRIVE_ID, DRIVE_NAME, ME, SITE_NAME,
                                        FakeGraph)
from tests.fixtures.msgraph_api import serve as serve_graph

S3_FAMILY = ("s3", "aliyun", "backblaze", "ceph", "digitalocean", "gcs",
             "minio", "oci", "qingstor", "r2", "scaleway", "seaweedfs",
             "supabase", "tencent", "wasabi")

HF_FAMILY = {
    "hf_models": "models",
    "hf_datasets": "datasets",
    "hf_spaces": "spaces"
}

HARNESSES = {
    **{
        name: "s3"
        for name in S3_FAMILY
    },
    "gridfs": "gridfs",
    **{
        name: "hf_models"
        for name in HF_FAMILY
    },
    "onedrive": "onedrive",
    "sharepoint": "sharepoint",
    "hf_buckets": "hf_buckets",
}

# The drive each Graph backend addresses in the fake: OneDrive the signed-in
# user's own, SharePoint one library of one site, mounted scoped so the keys
# stay drive-relative (unscoped, `a.txt` would name a site).
GRAPH = {
    "onedrive": (ME, ONEDRIVE_IO),
    "sharepoint": (DRIVE_ID, SHAREPOINT_IO)
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
# Several download chunks, so the background drain has bytes left to pull
# after the first chunk is consumed.
BIG = (b"x" * 1023 + b"\n") * 300

COMMANDS = {
    "bytes": "cp {v} /r/a.txt",
    "stream": "cat {v}",
    "drain": "cat {v}",
}
SLOTS = {"bytes": "bytes", "stream": "stream", "drain": "stream"}


@dataclass(frozen=True)
class Fake:
    vfs: BaseVFS
    key: str
    fetches: Callable[[], int]
    rewrite: Callable[[bytes], None]
    reach: list[str]
    io: CommandIO
    read_mod: ModuleType
    stream_mod: ModuleType


class _Download:

    def __init__(self, data: bytes) -> None:
        self._data = data
        self._pos = 0

    async def read(self, size: int = -1) -> bytes:
        if size < 0:
            size = len(self._data) - self._pos
        chunk = self._data[self._pos:self._pos + size]
        self._pos += len(chunk)
        return chunk

    async def close(self) -> None:
        return None


class _Bucket:

    def __init__(self, files: dict[str, dict]) -> None:
        self._files = files
        self.opened: list[ObjectId] = []

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
        "uploadDate": datetime.datetime(year,
                                        1,
                                        2,
                                        tzinfo=datetime.timezone.utc),
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
        yield Fake(vfs=vfs,
                   key=key,
                   fetches=lambda: session._client.calls["get_object"],
                   rewrite=rewrite,
                   reach=[],
                   io=S3_IO,
                   read_mod=s3_read,
                   stream_mod=s3_stream)


@contextmanager
def _gridfs_fake(shape: str, data: bytes,
                 monkeypatch: pytest.MonkeyPatch) -> Iterator[Fake]:
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
        files[stored] = _gridfs_doc(stored, new, "aaaaaaaaaaaaaaaaaaaaaaaa",
                                    2022)

    for module in (gridfs_read, gridfs_stream, gridfs_driver):
        monkeypatch.setitem(vars(module), "latest_file", latest_file)
        monkeypatch.setitem(vars(module), "bucket", lambda *_args: bucket)
    # A listing or a collection query means the path under test reached for
    # something no read or stat should need; refuse it loudly.
    for module in (gridfs_client, gridfs_driver, gridfs_watch):
        for name in ("iter_latest", "files_coll"):
            if name in vars(module):
                monkeypatch.setitem(vars(module), name, _stray(reach, name))
    vfs = build_vfs("gridfs", config)
    assert vfs.accessor.config.key_prefix == prefix
    yield Fake(vfs=vfs,
               key=key,
               fetches=lambda: len(bucket.opened),
               rewrite=rewrite,
               reach=reach,
               io=GRIDFS_IO,
               read_mod=gridfs_read,
               stream_mod=gridfs_stream)


@contextmanager
def _hf_fake(name: str, shape: str, data: bytes,
             monkeypatch: pytest.MonkeyPatch) -> Iterator[Fake]:
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
        reach: list[str] = []
        invalidate = RAMIndexCacheStore.invalidate_prefix

        # A whole-tree refill is the one thing that invalidates a store's
        # prefix. On the mount's own index a cold read does it legitimately;
        # on any other store it is the reconcile probe walking the tree.
        async def watched(store, prefix_: str) -> None:
            if store is not vfs.index:
                reach.append("tree walk on a throwaway index")
            await invalidate(store, prefix_)

        monkeypatch.setattr(RAMIndexCacheStore, "invalidate_prefix", watched)

        def rewrite(new: bytes) -> None:
            files[stored] = new

        yield Fake(vfs=vfs,
                   key=key,
                   fetches=lambda: hub.count("resolve"),
                   rewrite=rewrite,
                   reach=reach,
                   io=HF_IO,
                   read_mod=hf_read,
                   stream_mod=hf_stream)


@contextmanager
def _graph_fake(name: str, shape: str, data: bytes) -> Iterator[Fake]:
    key = KEYS[shape]
    prefix = PREFIX if shape == "prefixed" else None
    stored = (prefix or "") + key
    drive, io = GRAPH[name]
    files = {stored: data}
    config: dict[str, str] = {"access_token": "t"}
    if name == "sharepoint":
        config.update(site=SITE_NAME, drive=DRIVE_NAME)
    if prefix is not None:
        files[key] = DECOY
        config["key_prefix"] = prefix
    # A children listing is a walk no read or stat should make; the listed
    # shape's own `ls` is the one allowed.
    graph = FakeGraph(drives={drive: files},
                      children_allowed=1 if shape == "listed" else 0)
    with serve_graph(graph):
        vfs = build_vfs(name, {**config, "graph_base_url": graph.url})
        assert ((vfs.accessor.config.key_prefix
                 or "").strip("/") == (prefix or "").strip("/"))

        def rewrite(new: bytes) -> None:
            graph.write(drive, stored, new)

        yield Fake(vfs=vfs,
                   key=key,
                   fetches=graph.fetches,
                   rewrite=rewrite,
                   reach=graph.reach,
                   io=io,
                   read_mod=drive_ops,
                   stream_mod=drive_ops)


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
    # One dict behind both doors: the Hub serves it over HTTP and the
    # opendal fake lists and writes it. The opendal fake refuses every read,
    # so a stat or read that fell back to opendal fails here.
    hub = FakeHub(repos={("buckets", "acme/bkt"): files})
    with serve(hub):
        vfs = build_vfs("hf_buckets", {**config, "endpoint": hub.url})
        assert vfs.accessor.config.key_prefix == prefix
        reach: list[str] = []
        op = FakeAsyncOperator(files=files,
                               root=vfs.accessor._root() or "",
                               reach=reach)
        vfs.accessor.operator = lambda: op

        def rewrite(new: bytes) -> None:
            files[stored] = new

        yield Fake(vfs=vfs,
                   key=key,
                   fetches=lambda: hub.count("bucket_resolve"),
                   rewrite=rewrite,
                   reach=reach,
                   io=HF_BUCKETS_IO,
                   read_mod=hf_buckets_read,
                   stream_mod=hf_buckets_stream)


@contextmanager
def _fake(name: str, shape: str, data: bytes,
          monkeypatch: pytest.MonkeyPatch) -> Iterator[Fake]:
    if HARNESSES[name] == "hf_buckets":
        with _hf_buckets_fake(shape, data) as fake:
            yield fake
        return
    if HARNESSES[name] in GRAPH:
        with _graph_fake(name, shape, data) as fake:
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
        shapes = ("root", "nested",
                  "prefixed") if name == family else ("root", )
        for shape in shapes:
            for row in rows:
                cases.append(
                    pytest.param(name, shape, row, id=f"{name}-{shape}-{row}"))
    return cases


A_CASES = _cases(("bytes", "stream", "drain")) + [
    pytest.param(name, "listed", "stream", id=f"{name}-listed-stream")
    for name in ("s3", *GRAPH)
]
B_CASES = _cases(("bytes", "stream"))


def _fresh_workspace(vfs: BaseVFS) -> Workspace:
    return Workspace({
        "/m":
        Mount(vfs=vfs,
              mode=MountMode.WRITE,
              read=ReadSpec(policy=ReadPolicy.FRESH)),
        "/r": (RAMVFS(), MountMode.WRITE),
    })


async def _line(ws: Workspace, line: str) -> bytes:
    result = await ws.shell(line)
    out = await result.materialize_stdout()
    err = await result.stderr_str()
    assert (result.exit_code, err) == (0, ""), line
    return out


async def _partial_read(ws: Workspace, fake: Fake, virtual: str) -> bytes:
    # Exercise the cache handoff directly, independent of pipe cancellation.
    spec = PathSpec(virtual=virtual,
                    directory=virtual.rsplit("/", 1)[0] + "/",
                    vfs_path=fake.key)
    scope = RecordingScope()
    try:
        source = CachableAsyncIterator(
            fake.io.read_stream(fake.vfs.accessor, spec))
        first = await anext(source)
        assert not source.exhausted
        await ws.apply_io(IOResult(reads={virtual: source}, cache=[virtual]),
                          records=scope.records)
        return first[:1]
    finally:
        scope.close()


async def _reconcile_stat(ws: Workspace, virtual: str) -> FileStat:
    # Reconcile stats through a fresh index (workspace/reconcile.py), so a
    # listing's index row, which carries no token, cannot answer for it.
    return await ws.mount(virtual).execute_op("stat",
                                              virtual,
                                              index=RAMIndexCacheStore())


def _spy_slots(fake: Fake,
               monkeypatch: pytest.MonkeyPatch) -> list[tuple[str, str]]:
    slots: list[tuple[str, str]] = []
    record = fake.read_mod.record
    record_stream = fake.stream_mod.record_stream

    def spy_record(op, path, *args, **kwargs):
        slots.append(("bytes", path))
        return record(op, path, *args, **kwargs)

    def spy_record_stream(op, path, *args, **kwargs):
        slots.append(("stream", path))
        return record_stream(op, path, *args, **kwargs)

    monkeypatch.setitem(vars(fake.read_mod), "record", spy_record)
    monkeypatch.setitem(vars(fake.stream_mod), "record_stream",
                        spy_record_stream)
    return slots


def _spy_drain(monkeypatch: pytest.MonkeyPatch) -> list[asyncio.Event]:
    drains: list[asyncio.Event] = []
    original = cache_io._background_drain

    # Sync, so the call is counted when apply_io creates the task; the
    # coroutine still runs inside that task, which the drain checks.
    def spy(*args, **kwargs):
        done = asyncio.Event()
        drains.append(done)

        async def drain():
            try:
                await original(*args, **kwargs)
            finally:
                done.set()

        return drain()

    monkeypatch.setattr(cache_io, "_background_drain", spy)
    return drains


def _declared() -> set[str]:
    declared = set()
    for name in known_vfs_names():
        entry = REGISTRY.get(name)
        if entry is None:
            continue
        if getattr(load_attr(entry.vfs_path), "READ_REVALIDATABLE", False):
            declared.add(name)
    return declared


def test_every_declaring_backend_has_a_harness():
    """Every READ_REVALIDATABLE backend runs the read-token contract.

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
def test_a_read_leaves_an_entry_reconcile_calls_fresh(name, shape, row,
                                                      monkeypatch):
    data = BIG if row == "drain" else SEED
    with _fake(name, shape, data, monkeypatch) as fake:
        slots = _spy_slots(fake, monkeypatch)
        drains = _spy_drain(monkeypatch)
        virtual = "/m/" + fake.key
        line = COMMANDS[row].format(v=virtual)

        async def run():
            ws = _fresh_workspace(fake.vfs)
            try:
                if shape == "listed":
                    await _line(ws, "ls /m")
                cached_before = await ws.cache.exists(virtual)
                before = fake.fetches()
                first = await (_partial_read(ws, fake, virtual)
                               if row == "drain" else _line(ws, line))
                drained = len(drains)
                for done in drains:
                    await done.wait()
                fetched = fake.fetches() - before
                taken = list(slots)
                if row == "bytes":
                    first = await _line(ws, "cat /r/a.txt")
                stat = await _reconcile_stat(ws, virtual)
                fresh = (stat.fingerprint is not None and await
                         ws.cache.is_fresh(virtual, stat.fingerprint))
                middle = fake.fetches()
                # The drain row's second run reads the whole entry back, so
                # a drain that cached a truncated buffer cannot pass.
                second = await _line(ws, line)
                if row == "bytes":
                    second = await _line(ws, "cat /r/a.txt")
                return (cached_before, first, drained, fetched, taken, stat,
                        fresh, fake.fetches() - middle, second)
            finally:
                await ws.close()

        (cached_before, first, drained, fetched, taken, stat, fresh, refetched,
         second) = asyncio.run(run())

    assert cached_before is False
    assert taken == [(SLOTS[row], virtual)]
    assert drained == (1 if row == "drain" else 0)
    assert fetched == 1
    assert first == (data[:1] if row == "drain" else data)
    assert stat.fingerprint is not None
    assert fresh
    # Reconcile answered FRESH: the warm read made no content fetch.
    assert refetched == 0
    assert second == data
    assert fake.reach == []


@pytest.mark.parametrize(("name", "shape", "row"), _cases(("drain", )))
def test_early_pipe_exit_never_caches_a_prefix(name, shape, row, monkeypatch):
    with _fake(name, shape, BIG, monkeypatch) as fake:
        slots = _spy_slots(fake, monkeypatch)
        drains = _spy_drain(monkeypatch)
        virtual = "/m/" + fake.key

        async def run():
            ws = _fresh_workspace(fake.vfs)
            try:
                before = fake.fetches()
                assert await _line(ws, f"cat {virtual} | head -c 1") == BIG[:1]
                for done in drains:
                    await done.wait()
                assert slots == [(SLOTS[row], virtual)]
                assert fake.fetches() - before == 1
                cached = await ws.cache.get(virtual)
                assert cached is None or cached == BIG
                assert await _line(ws, f"cat {virtual}") == BIG
                assert fake.fetches() - before == (2 if cached is None else 1)
            finally:
                await ws.close()

        asyncio.run(run())


@pytest.mark.parametrize(("name", "shape", "row"), B_CASES)
def test_an_unrecorded_read_stamps_the_stat_token(name, shape, row,
                                                  monkeypatch):
    records: list[OpRecord] = []

    def capture(op: str,
                path: str,
                source: str,
                nbytes: int,
                _timer: OpTimer,
                fingerprint: str | None = None,
                revision: str | None = None) -> None:
        records.append(
            OpRecord(op=op,
                     path=path,
                     source=source,
                     bytes=nbytes,
                     timestamp=0,
                     duration_ms=0,
                     fingerprint=fingerprint,
                     revision=revision))

    def capture_stream(op: str,
                       path: str,
                       source: str,
                       fingerprint: str | None = None,
                       revision: str | None = None) -> OpRecord:
        rec = OpRecord(op=op,
                       path=path,
                       source=source,
                       bytes=0,
                       timestamp=0,
                       duration_ms=0,
                       fingerprint=fingerprint,
                       revision=revision)
        records.append(rec)
        return rec

    with _fake(name, shape, SEED, monkeypatch) as fake:
        monkeypatch.setitem(vars(fake.read_mod), "record", capture)
        monkeypatch.setitem(vars(fake.stream_mod), "record_stream",
                            capture_stream)
        virtual = "/m/" + fake.key
        spec = PathSpec(virtual=virtual,
                        directory=virtual.rsplit("/", 1)[0] + "/",
                        vfs_path=fake.key)
        accessor = fake.vfs.accessor

        async def run():
            unrecorded = active_recorder() is None
            try:
                if row == "bytes":
                    data = await fake.io.read_bytes(accessor, spec)
                else:
                    data = b"".join(
                        [c async for c in fake.io.read_stream(accessor, spec)])
                stat = await fake.io.stat(accessor, spec)
            finally:
                await accessor.close()
            return unrecorded, data, stat

        unrecorded, data, stat = asyncio.run(run())

    assert unrecorded
    assert data == SEED
    assert [r.path for r in records] == [virtual]
    # The real record_stream returns None with no recorder bound, so no
    # stream read can stamp a token outside a capture at all. This row can
    # only show the stamp does not depend on the recorder check itself.
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
def test_a_changed_object_is_refetched(name, shape, monkeypatch):
    # The rows above prove stat and read agree; this proves what they agree
    # on is the content. A backend stamping a constant, or the key, on both
    # sides passes every other row and serves stale bytes here.
    with _fake(name, shape, SEED, monkeypatch) as fake:
        virtual = "/m/" + fake.key

        async def run():
            ws = _fresh_workspace(fake.vfs)
            try:
                if shape == "listed":
                    await _line(ws, "ls /m")
                await _line(ws, f"cat {virtual}")
                fake.rewrite(CHANGED)
                stat = await _reconcile_stat(ws, virtual)
                fresh = (stat.fingerprint is not None and await
                         ws.cache.is_fresh(virtual, stat.fingerprint))
                before = fake.fetches()
                second = await _line(ws, f"cat {virtual}")
                refetched = fake.fetches() - before
                # The refetch has to stamp the new token, or every later
                # read refetches as well and the backend never serves warm.
                restat = await _reconcile_stat(ws, virtual)
                refreshed = (restat.fingerprint is not None
                             and await ws.cache.is_fresh(
                                 virtual, restat.fingerprint))
                before = fake.fetches()
                third = await _line(ws, f"cat {virtual}")
                return (stat, fresh, refetched, second, refreshed,
                        fake.fetches() - before, third)
            finally:
                await ws.close()

        (stat, fresh, refetched, second, refreshed, third_fetched,
         third) = asyncio.run(run())

    assert stat.fingerprint is not None
    assert not fresh
    assert refetched == 1
    assert second == CHANGED
    assert refreshed
    assert third_fetched == 0
    assert third == CHANGED
    assert fake.reach == []


@pytest.fixture()
def moto_endpoint() -> Iterator[str]:
    server = ThreadedMotoServer(ip_address="127.0.0.1", port=0, verbose=False)
    server.start()
    host, port = server.get_host_and_port()
    yield f"http://{host}:{port}"
    server.stop()


def test_moto_agrees_that_stat_and_read_stamp_one_token(
        moto_endpoint, monkeypatch):
    # The fakes derive Head and Get ETags from one helper, so they cannot
    # disagree; moto 5.2.1 (uv.lock) is the real implementation checked here,
    # multipart included. Its part-size floor is patched so two tiny parts
    # make a real multipart object.
    monkeypatch.setattr(moto.s3.models, "S3_UPLOAD_PART_MIN_SIZE", 5)
    client = boto3.client("s3",
                          endpoint_url=moto_endpoint,
                          aws_access_key_id="testing",
                          aws_secret_access_key="testing",
                          region_name="us-east-1")
    client.create_bucket(Bucket="bkt")
    client.put_object(Bucket="bkt", Key="simple.txt", Body=SEED)
    upload = client.create_multipart_upload(Bucket="bkt", Key="multi.txt")
    parts = []
    for number, body in enumerate((b"first part\n", b"second part\n"), 1):
        part = client.upload_part(Bucket="bkt",
                                  Key="multi.txt",
                                  PartNumber=number,
                                  UploadId=upload["UploadId"],
                                  Body=body)
        parts.append({"ETag": part["ETag"], "PartNumber": number})
    client.complete_multipart_upload(Bucket="bkt",
                                     Key="multi.txt",
                                     UploadId=upload["UploadId"],
                                     MultipartUpload={"Parts": parts})
    vfs = build_vfs(
        "s3", {
            "bucket": "bkt",
            "region": "us-east-1",
            "endpoint_url": moto_endpoint,
            "aws_access_key_id": "testing",
            "aws_secret_access_key": "testing",
            "path_style": True,
        })

    async def run():
        ws = _fresh_workspace(vfs)
        try:
            seen = {}
            for key in ("simple.txt", "multi.txt"):
                virtual = f"/m/{key}"
                cached_before = await ws.cache.exists(virtual)
                await _line(ws, f"cat {virtual}")
                stat = await _reconcile_stat(ws, virtual)
                fresh = (stat.fingerprint is not None and await
                         ws.cache.is_fresh(virtual, stat.fingerprint))
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
    # gdrive stats a modifiedTime and reads an md5. Forced to claim the flag,
    # it must fail the same checks the declaring backends pass, or the
    # contract could not tell a backend that keeps the promise from one that
    # only makes it.
    fake = FakeGDrive()
    fake.add_file("a.txt", SEED)
    fetched: list[str] = []
    get_bytes = fake.get_bytes

    def counting(file_id: str) -> bytes:
        fetched.append(file_id)
        return get_bytes(file_id)

    monkeypatch.setattr(fake, "get_bytes", counting)
    vfs = GoogleDriveVFS(
        GoogleDriveConfig(client_id="i", client_secret="s", refresh_token="r"))
    monkeypatch.setattr(vfs, "READ_REVALIDATABLE", True)
    virtual = "/m/a.txt"

    async def run():
        ws = _fresh_workspace(vfs)
        try:
            await _line(ws, f"cat {virtual}")
            before = len(fetched)
            read_token = hashlib.md5(SEED).hexdigest()
            holds_read_token = await ws.cache.is_fresh(virtual, read_token)
            stat = await _reconcile_stat(ws, virtual)
            assert stat.fingerprint is not None
            fresh = await ws.cache.is_fresh(virtual, stat.fingerprint)
            await _line(ws, f"cat {virtual}")
            return (holds_read_token, stat.fingerprint
                    != read_token, fresh, len(fetched) - before)
        finally:
            await ws.close()

    with patch_gdrive(fake):
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
                    virtual, xet_hash(SEED))
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

    async def etag_instead(config, loc, *args, **kwargs):
        _ctag, revision, url = await capture(config, loc, *args, **kwargs)
        item = await drive_ops.graph_get(config, loc.item())
        return item["eTag"], revision, url

    with _fake("onedrive", "root", SEED, monkeypatch) as fake:
        monkeypatch.setitem(vars(drive_ops), "capture_item_metadata",
                            etag_instead)
        monkeypatch.setattr(fake.vfs, "READ_REVALIDATABLE", True)
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
        monkeypatch):
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
                    virtual, other_kind(served))
                stat = await _reconcile_stat(ws, virtual)
                fresh = await ws.cache.is_fresh(virtual, stat.fingerprint)
                before = fake.fetches()
                await _line(ws, f"cat {virtual}")
                return (holds_read_token, stat.fingerprint, fresh,
                        fake.fetches() - before)
            finally:
                await ws.close()

        holds_read_token, fingerprint, fresh, refetched = asyncio.run(run())

    assert holds_read_token
    assert fingerprint == xet_hash(SEED)
    assert not fresh
    assert refetched == 1
