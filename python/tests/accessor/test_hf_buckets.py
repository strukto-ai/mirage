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

import pytest

from mirage.accessor.hf_buckets import HfBucketsAccessor
from mirage.accessor.hf_hub import stall_timeout
from mirage.vfs.hf_buckets.config import HfBucketsConfig


def test_accessor_holds_config():
    cfg = HfBucketsConfig(bucket="myorg/mybkt")
    acc = HfBucketsAccessor(cfg)
    assert acc.config is cfg


def test_bucket_uri():
    cfg = HfBucketsConfig(bucket="myorg/mybkt")
    acc = HfBucketsAccessor(cfg)
    assert acc.bucket_uri == "hf://buckets/myorg/mybkt"


@pytest.mark.asyncio
async def test_the_accessor_owns_a_pool_that_close_drains():
    acc = HfBucketsAccessor(HfBucketsConfig(bucket="org/b"))
    session = acc.account.pool.get()
    assert not session.closed
    await acc.close()
    assert session.closed
    # A VFS closes its accessor once; a CLI verb may close one it built
    # again, which must be harmless.
    await acc.close()


def test_bucket_path_applies_the_key_prefix_once():
    acc = HfBucketsAccessor(
        HfBucketsConfig(bucket="org/b", key_prefix="/lead/trail/")
    )
    assert acc.bucket_path("a.txt") == "lead/trail/a.txt"
    assert acc.bucket_path("/sub/a.txt") == "lead/trail/sub/a.txt"
    assert (
        HfBucketsAccessor(HfBucketsConfig(bucket="org/b")).bucket_path(
            "/a.txt"
        )
        == "a.txt"
    )
    # opendal normalizes its root's empty segments away and the Hub matches
    # paths exactly, so the direct calls have to agree with the listing.
    assert (
        HfBucketsAccessor(
            HfBucketsConfig(bucket="org/b", key_prefix="a//b")
        ).bucket_path("/x.txt")
        == "a/b/x.txt"
    )
    assert (
        HfBucketsAccessor(
            HfBucketsConfig(bucket="org/b", key_prefix="/")
        ).bucket_path("/x.txt")
        == "x.txt"
    )


def test_the_pool_waits_the_configured_timeout_without_progress():
    assert HfBucketsAccessor(
        HfBucketsConfig(bucket="o/b")
    ).account.pool._timeout == stall_timeout(30)
    assert HfBucketsAccessor(
        HfBucketsConfig(bucket="o/b", timeout=5)
    ).account.pool._timeout == stall_timeout(5)
