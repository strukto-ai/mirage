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

import boto3
from moto import mock_aws

from mirage.cache.index import LookupStatus
from mirage.types import MountMode
from mirage.vfs.ram import RAMVFS
from mirage.vfs.s3.s3 import S3VFS, S3Config
from mirage.workspace import Workspace


def _run(coro):
    return asyncio.run(coro)


def _stdout(io):
    if io.stdout is None:
        return b""
    if isinstance(io.stdout, bytes):
        return io.stdout
    if isinstance(io.stdout, memoryview):
        return bytes(io.stdout)
    return b""


# ── VFS has index ─────────────────────────


def test_ram_vfs_has_index():
    p = RAMVFS()
    assert p.index is not None
    assert p.index_ttl == 0


def test_s3_vfs_has_index():
    with mock_aws():
        boto3.client("s3",
                     region_name="us-east-1").create_bucket(Bucket="test-idx")
        p = S3VFS(S3Config(bucket="test-idx", region="us-east-1"))
        assert p.index is not None
        assert p.index_ttl == 600


# ── RAM index integration ─────────────────────


def _ram_ws():
    p = RAMVFS()
    p._store.dirs.add("/sub")
    p._store.files["/sub/a.txt"] = b"aaa\n"
    p._store.files["/sub/b.txt"] = b"bbb\n"
    p._store.files["/sub/c.csv"] = b"col\n"
    ws = Workspace(mounts={"/data/": (p, MountMode.WRITE)}, )
    ws.get_session(ws.default_session_id).cwd = "/data"
    return ws, p


def test_ram_glob_populates_index():
    """RAM ttl=0 → index populated but expires immediately."""
    ws, prov = _ram_ws()
    io = _run(ws.shell("cat /data/sub/*.txt"))
    assert io.exit_code == 0
    # ttl=0: entries were set but expired by the time we check
    # Index now stores virtual paths (with mount prefix)
    listing = _run(prov.index.list_dir("/data/sub"))
    assert listing.status == LookupStatus.EXPIRED


def test_ram_cat_of_a_literal_path_stores_no_listing():
    """A literal path asks for no directory listing, so nothing is indexed.

    Renamed from ``test_ram_glob_second_call_uses_index``, which asserted
    nothing and could not have: the RAM VFS's ``index_ttl`` is 0, so
    an index hit is unreachable for it by construction, and ``cat`` on a
    literal path never populates a listing in the first place (the glob
    sibling above is what populates, and it reads back EXPIRED). This
    pins what the pair of runs actually establishes.
    """
    ws, prov = _ram_ws()
    first = _run(ws.shell("cat /data/sub/a.txt"))
    second = _run(ws.shell("cat /data/sub/a.txt"))
    assert (first.exit_code, second.exit_code) == (0, 0)
    listing = _run(prov.index.list_dir("/data/sub"))
    assert listing.status == LookupStatus.NOT_FOUND


def test_ram_glob_pattern_works():
    ws, prov = _ram_ws()
    io = _run(ws.shell("cat /data/sub/*.txt"))
    assert io.exit_code == 0


# ── S3 index integration ──────────────────────


def test_s3_vfs_index_ttl():
    """S3 VFS gets index with TTL=600."""
    with mock_aws():
        boto3.client("s3",
                     region_name="us-east-1").create_bucket(Bucket="test-ttl")
        prov = S3VFS(S3Config(bucket="test-ttl", region="us-east-1"))
        assert prov.index is not None
        assert prov.index_ttl == 600


def test_s3_index_can_store_entries():
    """S3 index can store and retrieve entries."""
    from mirage.cache.index import IndexEntry
    with mock_aws():
        boto3.client(
            "s3", region_name="us-east-1").create_bucket(Bucket="test-store")
        prov = S3VFS(S3Config(bucket="test-store", region="us-east-1"))
        _run(
            prov.index.set_dir("/data", [
                ("a.txt", IndexEntry(
                    id="a", name="a.txt", resource_type="file")),
                ("b.txt", IndexEntry(
                    id="b", name="b.txt", resource_type="file")),
            ]))
        listing = _run(prov.index.list_dir("/data"))
        assert listing.entries is not None
        assert len(listing.entries) == 2


def test_s3_index_separate_from_ram():
    """S3 and RAM have independent indexes."""
    ram = RAMVFS()
    with mock_aws():
        boto3.client("s3",
                     region_name="us-east-1").create_bucket(Bucket="test-sep")
        s3 = S3VFS(S3Config(bucket="test-sep", region="us-east-1"))
        assert ram.index is not s3.index


# ── index per VFS ─────────────────────────


def test_index_per_vfs():
    p1 = RAMVFS()
    p2 = RAMVFS()
    assert p1.index is not p2.index


# ── TTL behavior ───────────────────────────────


def test_ram_index_ttl_zero():
    p = RAMVFS()
    assert p.index_ttl == 0


def test_index_expired_refetches():
    p = RAMVFS()
    p._store.dirs.add("/sub")
    p._store.files["/sub/a.txt"] = b"aaa\n"
    ws = Workspace(mounts={"/data/": (p, MountMode.WRITE)}, )
    ws.get_session(ws.default_session_id).cwd = "/data"
    _run(ws.shell("cat /data/sub/*.txt"))
    listing = _run(p.index.list_dir("/data/sub"))
    # RAM ttl=0 → expired immediately after set
    expired = listing.status == LookupStatus.EXPIRED
    assert expired or listing.entries is not None
