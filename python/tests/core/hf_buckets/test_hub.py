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

import aiohttp
import pytest

from mirage.accessor.hf_buckets import HfBucketsAccessor
from mirage.core.hf_buckets.hub import (
    fetch_row,
    paths_info_url,
    read_token,
    resolve_url,
)
from mirage.core.hf_buckets.read import read
from mirage.core.hf_hub.client import HfHubError
from mirage.types import PathSpec
from mirage.vfs.hf_buckets.config import HfBucketsConfig
from tests.fixtures.hf_bucket import PATHS_INFO, RESOLVE, HfBucket

# Nothing listens here: the URL tests build no request.
DEAD = "http://127.0.0.1:9"
INVALID_PATHS = "✖ Invalid input\n  → at paths"


def _built(key_prefix: str | None = None) -> HfBucketsAccessor:
    return HfBucketsAccessor(
        HfBucketsConfig(bucket="o/b", endpoint=DEAD, key_prefix=key_prefix)
    )


def test_the_bucket_routes_carry_no_revision():
    acc = _built()
    base = acc.config.endpoint
    # `/paths-info/main` is 404 on a bucket (measured 2026-09-25).
    assert paths_info_url(acc) == f"{base}/api/buckets/o/b/paths-info"
    assert resolve_url(acc, "a.txt") == f"{base}/buckets/o/b/resolve/a.txt"


def test_resolve_encodes_each_segment():
    acc = _built()
    base = acc.config.endpoint
    # An unencoded "#" truncates the URL at the fragment.
    assert resolve_url(acc, "dir/Inkling_o (1)#.png") == (
        f"{base}/buckets/o/b/resolve/dir/Inkling_o%20%281%29%23.png"
    )


@pytest.mark.parametrize("key_prefix", ["pfx/", "/pfx/", "pfx"])
def test_resolve_applies_the_key_prefix_once(key_prefix):
    acc = _built(key_prefix)
    assert resolve_url(acc, "/a.txt").endswith("/resolve/pfx/a.txt")


def test_a_trailing_slash_endpoint_is_not_doubled():
    acc = HfBucketsAccessor(
        HfBucketsConfig(bucket="o/b", endpoint="http://127.0.0.1:9/")
    )
    assert (
        paths_info_url(acc) == "http://127.0.0.1:9/api/buckets/o/b/paths-info"
    )
    assert resolve_url(acc, "a.txt") == (
        "http://127.0.0.1:9/buckets/o/b/resolve/a.txt"
    )


FILE = {"type": "file", "path": "pfx/a.txt", "size": 1, "xetHash": "h"}
DIR = {"type": "directory", "path": "pfx/a.txt"}


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "answer,expected",
    [
        ([], None),
        ([FILE], FILE),
        ([DIR], None),
        ([DIR, FILE], FILE),
    ],
)
async def test_fetch_row_answers_the_asked_files_row(
    make_acc, bucket, answer, expected
):
    acc = await make_acc({}, key_prefix="pfx/")
    await bucket.run.answer_next("POST", PATHS_INFO, 200, answer)
    assert await fetch_row(acc, "a.txt") == expected
    # The prefix rides the asked path, not the route.
    assert await bucket.run.bodies("POST", PATHS_INFO) == [
        {"paths": ["pfx/a.txt"]}
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "answer", [[{**FILE, "path": "pfx/other.txt"}], {"x": 1}]
)
async def test_fetch_row_refuses_an_answer_about_something_else(
    make_acc, bucket, answer
):
    # An empty list is the only answer that means "absent"; anything else
    # read as absence would let reconcile delete a file that exists.
    acc = await make_acc({}, key_prefix="pfx/")
    await bucket.run.answer_next("POST", PATHS_INFO, 200, answer)
    with pytest.raises(HfHubError):
        await fetch_row(acc, "a.txt")


@pytest.mark.asyncio
async def test_fetch_row_never_asks_about_the_mount_root(make_acc, bucket):
    acc = await make_acc({"pfx/a.txt": b"a"}, key_prefix="pfx/")
    assert await fetch_row(acc, "") is None
    assert await bucket.count("paths_info") == 0


@pytest.mark.parametrize(
    "raw,token",
    [
        ('"X"', "X"),
        ("X", "X"),
        ('W/"X"', None),
        ('""', None),
        ("", None),
    ],
)
def test_read_token_is_a_strong_etag_or_none(raw, token):
    assert read_token(raw) == token


@pytest.mark.asyncio
async def test_the_fake_bucket_wire_matches_the_live_hub(bucket):
    # Each assertion is a shape measured against huggingface.co on
    # 2026-09-25; a fake that drifted from any of them would let the suite
    # pass against a Hub that does not exist.
    data = b"abc"
    await bucket.put(**{"a.txt": data, "d/x.txt": b"x"})
    api = f"{bucket.origin}/api/buckets/o/b/paths-info"
    res = f"{bucket.origin}/buckets/o/b/resolve"
    auth = {"Authorization": f"Bearer {bucket.token}"}
    async with aiohttp.ClientSession(headers=auth) as http:
        async with http.post(api, data=b'{"paths":["a.txt"]}') as r:
            assert r.status == 400
            assert (await r.json())["error"] == INVALID_PATHS
        async with http.post(
            api, json={"paths": ["a.txt", "/a.txt", "d", "d/"]}
        ) as r:
            rows = await r.json()
        assert rows == [
            {
                "type": "file",
                "path": "a.txt",
                "size": 3,
                "xetHash": rows[0]["xetHash"],
                "uploadedAt": rows[0]["uploadedAt"],
            }
        ]
        async with http.get(f"{res}/a.txt") as r:
            assert r.headers["ETag"] == f'"{rows[0]["xetHash"]}"'
            assert await r.read() == data
        async with http.get(
            f"{res}/a.txt", headers={"Range": "bytes=1-1"}
        ) as r:
            assert (r.status, r.headers["ETag"]) == (
                206,
                f'"{rows[0]["xetHash"]}"',
            )
        async with http.get(
            f"{res}/a.txt", headers={"Range": "bytes=3-9"}
        ) as r:
            assert (r.status, "ETag" in r.headers) == (416, False)
        async with http.get(f"{res}/nope.txt") as r:
            assert (r.status, r.headers["X-Error-Code"]) == (
                404,
                "EntryNotFound",
            )


@pytest.mark.asyncio
@pytest.mark.parametrize("token,sent", [("tok", "Bearer tok"), (None, None)])
async def test_the_token_reaches_both_bucket_routes(hf_origin, token, sent):
    # opendal used to carry the credential; now both HTTP calls must. A
    # caller that sends no token reaches the anonymous default account.
    bucket = HfBucket(hf_origin, token or "default")
    await bucket.reset()
    await bucket.put(**{"a.txt": b"x"})
    await bucket.run.record_requests("authorization")
    acc = bucket.accessor(token=token)
    try:
        assert await fetch_row(acc, "a.txt") is not None
        await read(acc, PathSpec.from_str_path("/a.txt"))
    finally:
        await acc.close()
        heard = [
            await bucket.run.headers("POST", PATHS_INFO),
            await bucket.run.headers("GET", RESOLVE),
        ]
        await bucket.close()
    want = [{} if sent is None else {"authorization": sent}]
    assert heard == [want, want]
