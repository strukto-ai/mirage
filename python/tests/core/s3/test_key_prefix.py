import asyncio

from mirage.accessor.s3 import S3Accessor
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.core.s3.constants import SCOPE_ERROR
from mirage.core.s3.copy import copy
from mirage.core.s3.exists import exists
from mirage.core.s3.read import read_bytes
from mirage.core.s3.readdir import readdir
from mirage.core.s3.rename import rename
from mirage.core.s3.stat import stat
from mirage.core.s3.unlink import unlink
from mirage.core.s3.write import write_bytes
from mirage.resource.s3 import S3Config
from mirage.resource.s3.s3 import S3Resource
from mirage.types import PathSpec
from mirage.utils.glob_walk import make_resolve_glob
from tests.integration.s3_mock import patch_s3_multi

resolve_glob = make_resolve_glob(readdir, SCOPE_ERROR)

PREFIX = "users/abc/"
BUCKET = "test-bucket"


def _config(key_prefix: str | None = None) -> S3Config:
    return S3Config(
        bucket=BUCKET,
        region="us-east-1",
        aws_access_key_id="fake",
        aws_secret_access_key="fake",
        key_prefix=key_prefix,
    )


def _accessor(key_prefix: str | None = None) -> S3Accessor:
    return S3Accessor(_config(key_prefix))


def _path(p: str) -> PathSpec:
    return PathSpec(virtual=p, directory=p, resource_path=p.strip("/"))


def test_normalize_empty_returns_none():
    assert S3Config(bucket="b", key_prefix="").key_prefix is None


def test_normalize_strips_leading_slash():
    assert S3Config(bucket="b",
                    key_prefix="/users/abc/").key_prefix == "users/abc/"


def test_normalize_adds_trailing_slash():
    assert S3Config(bucket="b",
                    key_prefix="users/abc").key_prefix == "users/abc/"


def test_write_with_prefix():
    store = {BUCKET: {}}
    with patch_s3_multi(store):
        accessor = _accessor(PREFIX)
        asyncio.run(write_bytes(accessor, _path("/a.txt"), b"hello"))
    assert store[BUCKET].get("users/abc/a.txt") == b"hello"


def test_read_baseline_no_prefix():
    store = {BUCKET: {"a.txt": b"baseline"}}
    with patch_s3_multi(store):
        accessor = _accessor(None)
        data = asyncio.run(read_bytes(accessor, _path("/a.txt")))
    assert data == b"baseline"


def test_readdir_returns_user_facing_paths():
    store = {BUCKET: {"users/abc/a.txt": b"a", "users/abc/b.txt": b"b"}}
    with patch_s3_multi(store):
        accessor = _accessor(PREFIX)
        index = RAMIndexCacheStore()
        entries = asyncio.run(readdir(accessor, _path("/"), index=index))
    for entry in entries:
        assert "users" not in entry, f"key_prefix leaked into entry: {entry}"
        assert "abc" not in entry, f"key_prefix leaked into entry: {entry}"


def test_resolve_glob_with_prefix():
    store = {BUCKET: {"users/abc/a.txt": b"a", "users/abc/b.txt": b"b"}}
    with patch_s3_multi(store):
        accessor = _accessor(PREFIX)
        index = RAMIndexCacheStore()
        glob_path = PathSpec(
            resource_path="*.txt",
            virtual="/*.txt",
            directory="/",
            pattern="*.txt",
            resolved=False,
        )
        results = asyncio.run(resolve_glob(accessor, [glob_path], index))
    for r in results:
        assert "users" not in r.virtual, (
            f"key_prefix leaked into glob result: {r.virtual}")
        assert "abc" not in r.virtual, (
            f"key_prefix leaked into glob result: {r.virtual}")


def test_stat_with_prefix():
    store = {BUCKET: {"users/abc/a.txt": b"data"}}
    with patch_s3_multi(store):
        accessor = _accessor(PREFIX)
        result = asyncio.run(stat(accessor, _path("/a.txt")))
    assert result.name == "a.txt"
    assert "users" not in (result.name or "")
    assert "abc" not in (result.name or "")


def test_exists_with_prefix():
    store = {BUCKET: {"users/abc/a.txt": b"yes"}}
    with patch_s3_multi(store):
        accessor = _accessor(PREFIX)
        found = asyncio.run(exists(accessor, _path("/a.txt")))
        not_found = asyncio.run(exists(accessor, _path("/missing.txt")))
    assert found is True
    assert not_found is False


def test_copy_within_prefixed_scope():
    store = {BUCKET: {"users/abc/a.txt": b"content"}}
    with patch_s3_multi(store):
        accessor = _accessor(PREFIX)
        asyncio.run(copy(accessor, _path("/a.txt"), _path("/b.txt")))
    assert "users/abc/b.txt" in store[BUCKET]
    assert store[BUCKET]["users/abc/b.txt"] == b"content"
    assert "users/abc/a.txt" in store[BUCKET]


def test_rename_within_prefixed_scope():
    store = {BUCKET: {"users/abc/a.txt": b"moved"}}
    with patch_s3_multi(store):
        accessor = _accessor(PREFIX)
        asyncio.run(rename(accessor, _path("/a.txt"), _path("/b.txt")))
    assert "users/abc/b.txt" in store[BUCKET]
    assert store[BUCKET]["users/abc/b.txt"] == b"moved"
    assert "users/abc/a.txt" not in store[BUCKET]


def test_unlink_with_prefix():
    store = {BUCKET: {"users/abc/a.txt": b"gone"}}
    with patch_s3_multi(store):
        accessor = _accessor(PREFIX)
        asyncio.run(unlink(accessor, _path("/a.txt")))
    assert "users/abc/a.txt" not in store[BUCKET]


def test_get_state_includes_key_prefix():
    config = _config(PREFIX)
    resource = S3Resource(config)
    state = resource.get_state()
    assert state["config"]["key_prefix"] == PREFIX
    assert state["config"]["key_prefix"] != "<REDACTED>"
