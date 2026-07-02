import asyncio

from mirage.accessor.s3 import S3Accessor
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.core.s3.find import find
from mirage.core.s3.read import read_bytes
from mirage.core.s3.readdir import readdir
from mirage.resource.s3 import S3Config
from mirage.types import PathSpec
from tests.integration.s3_mock import patch_s3_multi


def _make_config(key_prefix: str | None = None) -> S3Config:
    return S3Config(
        bucket="test-bucket",
        region="us-east-1",
        aws_access_key_id="fake",
        aws_secret_access_key="fake",
        key_prefix=key_prefix,
    )


def test_readdir_no_prefix_backward_compat():
    store = {"test-bucket": {"dir/a.txt": b"a", "dir/b.txt": b"b"}}
    with patch_s3_multi(store):
        config = _make_config(key_prefix=None)
        accessor = S3Accessor(config)
        path = PathSpec(resource_path="dir", virtual="/dir", directory="/dir")
        index = RAMIndexCacheStore()
        entries = asyncio.run(readdir(accessor, path, index=index))
    assert any(e.endswith("/a.txt") for e in entries)
    assert any(e.endswith("/b.txt") for e in entries)


def test_readdir_strips_key_prefix_from_entries():
    store = {"test-bucket": {"prod/dir/a.txt": b"a", "prod/dir/b.txt": b"b"}}
    with patch_s3_multi(store):
        config = _make_config(key_prefix="prod")
        accessor = S3Accessor(config)
        path = PathSpec(resource_path="dir", virtual="/dir", directory="/dir")
        index = RAMIndexCacheStore()
        entries = asyncio.run(readdir(accessor, path, index=index))
    for e in entries:
        assert "prod" not in e, f"key_prefix leaked into entry: {e}"


def test_read_bytes_with_key_prefix():
    store = {"test-bucket": {"prod/hello.txt": b"hello"}}
    with patch_s3_multi(store):
        config = _make_config(key_prefix="prod")
        accessor = S3Accessor(config)
        path = PathSpec(resource_path="hello.txt",
                        virtual="/hello.txt",
                        directory="/hello.txt")
        data = asyncio.run(read_bytes(accessor, path))
    assert data == b"hello"


def test_find_strips_key_prefix_from_results():
    store = {"test-bucket": {"prod/dir/a.txt": b"a", "prod/dir/b.txt": b"b"}}
    with patch_s3_multi(store):
        config = _make_config(key_prefix="prod")
        accessor = S3Accessor(config)
        path = PathSpec(resource_path="dir", virtual="/dir", directory="/dir")
        results = asyncio.run(find(accessor, path))
    for r in results:
        assert "prod" not in r, f"key_prefix leaked into find result: {r}"
