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

from unittest.mock import MagicMock, patch

import pytest
from aioresponses import aioresponses

from mirage.accessor.hf_buckets import HfBucketsAccessor, HfBucketsConfig
from mirage.core.hf_buckets.create import create
from mirage.core.hf_buckets.unlink import unlink
from mirage.core.hf_buckets.write import write_bytes
from mirage.types import PathSpec


def _bucket_id_mock(m: aioresponses, repeat: int = 1) -> None:
    for _ in range(repeat):
        m.get("https://huggingface.co/api/buckets/o/b",
              payload={"id": "bkt-1"})


def _stat_file_mock(m: aioresponses, key: str, size: int = 0) -> None:
    m.head(
        f"https://huggingface.co/buckets/bkt-1/resolve/{key}",
        status=200,
        headers={"Content-Length": str(size)},
    )


def _stat_dir_mock(m: aioresponses, key: str) -> None:
    m.head(
        f"https://huggingface.co/buckets/bkt-1/resolve/{key}",
        status=404,
    )
    m.get(
        f"https://huggingface.co/api/buckets/bkt-1/tree/{key}/",
        payload=[{
            "path": f"{key}/child"
        }],
    )


@pytest.mark.asyncio
async def test_write_bytes_uploads():
    cfg = HfBucketsConfig(bucket="o/b", token="t")
    acc = HfBucketsAccessor(cfg)
    fake_api = MagicMock()
    with patch("mirage.core.hf_buckets.write.HfApi",
               return_value=fake_api) as api_ctor:
        with aioresponses() as m:
            _bucket_id_mock(m)
            await write_bytes(acc, PathSpec.from_str_path("/hello.txt"),
                              b"hi there")
    api_ctor.assert_called_once()
    fake_api.batch_bucket_files.assert_called_once_with("bkt-1",
                                                        add=[(b"hi there",
                                                              "hello.txt")])


@pytest.mark.asyncio
async def test_unlink_deletes_file():
    cfg = HfBucketsConfig(bucket="o/b", token="t")
    acc = HfBucketsAccessor(cfg)
    fake_api = MagicMock()
    with patch("mirage.core.hf_buckets.unlink.HfApi", return_value=fake_api):
        with aioresponses() as m:
            _bucket_id_mock(m, repeat=2)
            _stat_file_mock(m, "delete-me.txt", size=10)
            await unlink(acc, PathSpec.from_str_path("/delete-me.txt"))
    fake_api.batch_bucket_files.assert_called_once_with(
        "bkt-1", delete=["delete-me.txt"])


@pytest.mark.asyncio
async def test_unlink_refuses_directory():
    cfg = HfBucketsConfig(bucket="o/b", token="t")
    acc = HfBucketsAccessor(cfg)
    fake_api = MagicMock()
    with patch("mirage.core.hf_buckets.unlink.HfApi", return_value=fake_api):
        with aioresponses() as m:
            _bucket_id_mock(m)
            _stat_dir_mock(m, "some-dir")
            with pytest.raises(IsADirectoryError):
                await unlink(acc, PathSpec.from_str_path("/some-dir"))
    fake_api.batch_bucket_files.assert_not_called()


@pytest.mark.asyncio
async def test_create_writes_empty_file():
    cfg = HfBucketsConfig(bucket="o/b", token="t")
    acc = HfBucketsAccessor(cfg)
    fake_api = MagicMock()
    with patch("mirage.core.hf_buckets.write.HfApi", return_value=fake_api):
        with aioresponses() as m:
            _bucket_id_mock(m)
            await create(acc, PathSpec.from_str_path("/touched.txt"))
    fake_api.batch_bucket_files.assert_called_once_with("bkt-1",
                                                        add=[(b"",
                                                              "touched.txt")])
