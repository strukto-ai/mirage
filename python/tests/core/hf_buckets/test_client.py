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

import pytest
from aioresponses import aioresponses

from mirage.accessor.hf_buckets import HfBucketsConfig
from mirage.core.hf_buckets._client import (HfBucketsClient, _bucket_url, _key,
                                            _paths_info_url, _prefix,
                                            _resolve_url, _strip_prefix,
                                            _tree_url)


def test_key_no_prefix():
    cfg = HfBucketsConfig(bucket="o/b")
    assert _key("/foo/bar.txt", cfg) == "foo/bar.txt"


def test_key_with_prefix():
    cfg = HfBucketsConfig(bucket="o/b", key_prefix="data/")
    assert _key("/foo.txt", cfg) == "data/foo.txt"


def test_prefix_with_trailing_slash():
    cfg = HfBucketsConfig(bucket="o/b", key_prefix="data/")
    assert _prefix("/sub/", cfg) == "data/sub/"


def test_strip_prefix_roundtrip():
    cfg = HfBucketsConfig(bucket="o/b", key_prefix="data/")
    assert _strip_prefix("data/foo.txt", cfg) == "foo.txt"


def test_bucket_url():
    cfg = HfBucketsConfig(bucket="o/b")
    assert _bucket_url(cfg) == "https://huggingface.co/api/buckets/o/b"


def test_tree_url_root():
    assert _tree_url("https://huggingface.co", "bkt-123",
                     "") == "https://huggingface.co/api/buckets/bkt-123/tree"


def test_tree_url_subpath():
    assert _tree_url(
        "https://huggingface.co", "bkt-123",
        "data/sub") == ("https://huggingface.co/api/buckets/bkt-123/"
                        "tree/data/sub")


def test_paths_info_url():
    assert _paths_info_url(
        "https://huggingface.co",
        "bkt-123") == "https://huggingface.co/api/buckets/bkt-123/paths-info"


def test_resolve_url():
    assert _resolve_url(
        "https://huggingface.co", "bkt-123",
        "data/x.txt") == ("https://huggingface.co/buckets/bkt-123/"
                          "resolve/data/x.txt")


def test_resolve_url_encodes_path():
    assert _resolve_url(
        "https://huggingface.co", "bkt-1", "data/hello world.txt"
    ) == (
        "https://huggingface.co/buckets/bkt-1/resolve/data/hello%20world.txt")


def test_tree_url_encodes_path():
    assert _tree_url("https://huggingface.co", "bkt-1", "data sub") == (
        "https://huggingface.co/api/buckets/bkt-1/tree/data%20sub")


@pytest.mark.asyncio
async def test_client_resolves_bucket_id():
    cfg = HfBucketsConfig(bucket="o/b", token="hf_test")
    client = HfBucketsClient(cfg)
    with aioresponses() as m:
        m.get("https://huggingface.co/api/buckets/o/b",
              payload={"id": "bkt-deadbeef"})
        assert await client.bucket_id() == "bkt-deadbeef"


@pytest.mark.asyncio
async def test_client_caches_bucket_id():
    cfg = HfBucketsConfig(bucket="o/b", token="hf_test")
    client = HfBucketsClient(cfg)
    with aioresponses() as m:
        m.get("https://huggingface.co/api/buckets/o/b",
              payload={"id": "bkt-1"})
        first = await client.bucket_id()
    assert await client.bucket_id() == first


@pytest.mark.asyncio
async def test_client_bucket_id_concurrent_calls_dedupe():
    cfg = HfBucketsConfig(bucket="o/b", token="hf_test")
    client = HfBucketsClient(cfg)
    with aioresponses() as m:
        m.get("https://huggingface.co/api/buckets/o/b",
              payload={"id": "bkt-1"})
        results = await asyncio.gather(*[client.bucket_id() for _ in range(8)])
    assert all(r == "bkt-1" for r in results)
    matched = sum(1 for call_list in m.requests.values() for _ in call_list)
    assert matched == 1
