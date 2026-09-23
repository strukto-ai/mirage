import asyncio

from mirage.accessor.s3 import S3Accessor
from mirage.core.s3.watch import S3Walk, build_delta_hook
from mirage.types import FileChangeKind, PathSpec
from mirage.vfs.s3 import S3Config
from tests.e2e.s3_mock import patch_s3_multi

BUCKET = "watch-bucket"


def _accessor(key_prefix: str | None = None) -> S3Accessor:
    return S3Accessor(
        S3Config(bucket=BUCKET,
                 region="us-east-1",
                 aws_access_key_id="fake",
                 aws_secret_access_key="fake",
                 key_prefix=key_prefix))


def _root(virtual: str, vfs_path: str) -> PathSpec:
    return PathSpec(virtual=virtual, directory=virtual, vfs_path=vfs_path)


async def _collect(walk, root):
    return [entry async for entry in walk(root)]


def test_walk_yields_files_with_etag_fingerprints():
    store = {BUCKET: {"data/a.txt": b"alpha", "data/b.txt": b"beta"}}
    with patch_s3_multi(store):
        entries = asyncio.run(
            _collect(S3Walk(_accessor()), _root("/s3/data", "data")))
    files = {e.virtual: e for e in entries if not e.is_dir}
    assert set(files) == {"/s3/data/a.txt", "/s3/data/b.txt"}
    assert files["/s3/data/a.txt"].size == 5
    # The ETag leads the composite, which is what keeps two files of
    # equal size apart: the mock's LastModified is a constant, so the
    # size alone would collide across them. The mock's ETag is the
    # content md5, so both values are deterministic.
    assert (files["/s3/data/a.txt"].fingerprint ==
            "2c1743a391305fbf367df8e4f069f9f9|5")
    assert (files["/s3/data/b.txt"].fingerprint ==
            "987bcab01b929eb2c07877b224215c92|4")
    assert (files["/s3/data/a.txt"].fingerprint
            != files["/s3/data/b.txt"].fingerprint)


def test_walk_synthesizes_intermediate_directories():
    store = {BUCKET: {"data/sub/deep/x.txt": b"x"}}
    with patch_s3_multi(store):
        entries = asyncio.run(
            _collect(S3Walk(_accessor()), _root("/s3/data", "data")))
    dirs = {e.virtual for e in entries if e.is_dir}
    assert dirs == {"/s3/data/sub", "/s3/data/sub/deep"}


def test_walk_reports_an_explicit_marker_as_its_own_directory():
    store = {BUCKET: {"data/empty/": b""}}
    with patch_s3_multi(store):
        entries = asyncio.run(
            _collect(S3Walk(_accessor()), _root("/s3/data", "data")))
    assert [e.virtual for e in entries if e.is_dir] == ["/s3/data/empty"]
    assert not [e for e in entries if not e.is_dir]


def test_walk_strips_the_key_prefix():
    store = {BUCKET: {"team/x/data/a.txt": b"alpha"}}
    with patch_s3_multi(store):
        entries = asyncio.run(
            _collect(S3Walk(_accessor("team/x/")), _root("/s3/data", "data")))
    assert [e.virtual for e in entries if not e.is_dir] == ["/s3/data/a.txt"]


def test_baseline_pull_reports_nothing_then_detects_a_write():
    store = {BUCKET: {"data/a.txt": b"alpha"}}
    hook = build_delta_hook(_accessor())
    root = _root("/s3/data", "data")
    with patch_s3_multi(store):
        first = asyncio.run(hook.pull(root, None))
        assert first.changes == ()
        store[BUCKET]["data/a.txt"] = b"gamma"
        store[BUCKET]["data/new.txt"] = b"new"
        second = asyncio.run(hook.pull(root, first.checkpoint))
    by_path = {c.path.virtual: c.kind for c in second.changes}
    assert by_path == {
        "/s3/data/a.txt": FileChangeKind.UPDATE,
        "/s3/data/new.txt": FileChangeKind.CREATE,
    }


def test_delete_is_detected():
    store = {BUCKET: {"data/a.txt": b"alpha", "data/b.txt": b"beta"}}
    hook = build_delta_hook(_accessor())
    root = _root("/s3/data", "data")
    with patch_s3_multi(store):
        first = asyncio.run(hook.pull(root, None))
        del store[BUCKET]["data/b.txt"]
        second = asyncio.run(hook.pull(root, first.checkpoint))
    assert [(c.kind, c.path.virtual) for c in second.changes
            ] == [(FileChangeKind.DELETE, "/s3/data/b.txt")]


def test_same_bytes_rewritten_is_not_a_change():
    store = {BUCKET: {"data/a.txt": b"alpha"}}
    hook = build_delta_hook(_accessor())
    root = _root("/s3/data", "data")
    with patch_s3_multi(store):
        first = asyncio.run(hook.pull(root, None))
        store[BUCKET]["data/a.txt"] = b"alpha"
        second = asyncio.run(hook.pull(root, first.checkpoint))
    assert second.changes == ()


def test_changed_path_carries_the_mount_framing():
    store = {BUCKET: {"data/a.txt": b"alpha"}}
    hook = build_delta_hook(_accessor())
    root = _root("/s3/data", "data")
    with patch_s3_multi(store):
        first = asyncio.run(hook.pull(root, None))
        store[BUCKET]["data/a.txt"] = b"gamma"
        second = asyncio.run(hook.pull(root, first.checkpoint))
    changed = second.changes[0].path
    assert changed.virtual == "/s3/data/a.txt"
    assert changed.vfs_path == "data/a.txt"
