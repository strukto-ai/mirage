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

import mirage.core.hf_buckets.hub as hub_mod
from mirage.accessor.hf_buckets import HfBucketsAccessor, HfBucketsConfig
from mirage.core.hf_buckets.hub import (fetch_row, paths_info_url, read_token,
                                        resolve_url)
from mirage.core.hf_buckets.read import read_bytes
from mirage.core.hf_hub.client import HfHubError
from mirage.types import PathSpec
from tests.fixtures.hf_buckets_opendal import make_accessor
from tests.fixtures.hf_hub_api import (INVALID_PATHS, NO_ETAG, FakeHub,
                                       lfs_oid, serve, xet_hash)


def test_the_bucket_routes_carry_no_revision():
    acc = make_accessor({})
    base = acc.config.endpoint
    # `/paths-info/main` is 404 on a bucket (measured 2026-09-25).
    assert paths_info_url(acc) == f"{base}/api/buckets/o/b/paths-info"
    assert resolve_url(acc, "a.txt") == f"{base}/buckets/o/b/resolve/a.txt"


def test_resolve_encodes_each_segment():
    acc = make_accessor({})
    base = acc.config.endpoint
    # An unencoded "#" truncates the URL at the fragment.
    assert resolve_url(acc, "dir/Inkling_o (1)#.png") == (
        f"{base}/buckets/o/b/resolve/dir/Inkling_o%20%281%29%23.png")


@pytest.mark.parametrize("key_prefix", ["pfx/", "/pfx/", "pfx"])
def test_resolve_applies_the_key_prefix_once(key_prefix):
    acc = make_accessor({}, key_prefix=key_prefix)
    assert resolve_url(acc, "/a.txt").endswith("/resolve/pfx/a.txt")


def test_a_trailing_slash_endpoint_is_not_doubled():
    acc = HfBucketsAccessor(
        HfBucketsConfig(bucket="o/b", endpoint="http://127.0.0.1:9/"))
    assert paths_info_url(
        acc) == "http://127.0.0.1:9/api/buckets/o/b/paths-info"
    assert resolve_url(
        acc, "a.txt") == ("http://127.0.0.1:9/buckets/o/b/resolve/a.txt")


def _rows(answer):

    async def post(*_args, **kwargs):
        post.bodies.append(_args[2] if len(_args) > 2 else kwargs)
        return answer

    post.bodies = []
    return post


FILE = {"type": "file", "path": "pfx/a.txt", "size": 1, "xetHash": "h"}
DIR = {"type": "directory", "path": "pfx/a.txt"}


@pytest.mark.asyncio
@pytest.mark.parametrize("answer,expected", [
    ([], None),
    ([FILE], FILE),
    ([DIR], None),
    ([DIR, FILE], FILE),
])
async def test_fetch_row_answers_the_asked_files_row(monkeypatch, answer,
                                                     expected):
    post = _rows(answer)
    monkeypatch.setitem(vars(hub_mod), "hub_post", post)
    acc = make_accessor({}, key_prefix="pfx/")
    assert await fetch_row(acc, "a.txt") == expected
    # The prefix rides the asked path, not the route.
    assert post.bodies == [{"paths": ["pfx/a.txt"]}]


@pytest.mark.asyncio
@pytest.mark.parametrize("answer", [[{
    **FILE, "path": "pfx/other.txt"
}], {
    "x": 1
}])
async def test_fetch_row_refuses_an_answer_about_something_else(
        monkeypatch, answer):
    # An empty list is the only answer that means "absent"; anything else
    # read as absence would let reconcile delete a file that exists.
    monkeypatch.setitem(vars(hub_mod), "hub_post", _rows(answer))
    acc = make_accessor({}, key_prefix="pfx/")
    with pytest.raises(HfHubError):
        await fetch_row(acc, "a.txt")


@pytest.mark.asyncio
async def test_fetch_row_never_asks_about_the_mount_root(monkeypatch):
    post = _rows([FILE])
    monkeypatch.setitem(vars(hub_mod), "hub_post", post)
    acc = make_accessor({}, key_prefix="pfx/")
    assert await fetch_row(acc, "") is None
    assert post.bodies == []


@pytest.mark.parametrize("raw,token", [
    ('"X"', "X"),
    ("X", "X"),
    ('W/"X"', None),
    ('""', None),
    ("", None),
])
def test_read_token_is_a_strong_etag_or_none(raw, token):
    assert read_token(raw) == token


@pytest.mark.asyncio
async def test_the_fake_bucket_wire_matches_the_live_hub():
    # Each assertion is a shape measured against huggingface.co on
    # 2026-09-25; a fake that drifted from any of them would let the suite
    # pass against a Hub that does not exist.
    data = b"abc"
    hub = FakeHub(xet=False,
                  repos={
                      ("buckets", "o/b"): {
                          "a.txt": data,
                          "d/x.txt": b"x",
                          "w.txt": b"w",
                          "n.txt": b"n",
                      }
                  })
    hub.etags["w.txt"] = 'W/"weak"'
    hub.etags["n.txt"] = NO_ETAG
    with serve(hub):
        api = f"{hub.url}/api/buckets/o/b/paths-info"
        res = f"{hub.url}/buckets/o/b/resolve"
        async with aiohttp.ClientSession() as http:
            async with http.post(api, data=b'{"paths":["a.txt"]}') as r:
                assert r.status == 400
                assert (await r.json())["error"] == INVALID_PATHS
            async with http.post(
                    api, json={"paths": ["a.txt", "/a.txt", "d", "d/"]}) as r:
                rows = await r.json()
            assert rows == [{
                "type": "file",
                "path": "a.txt",
                "size": 3,
                "xetHash": xet_hash(data),
                "uploadedAt": rows[0]["uploadedAt"],
            }]
            assert rows[0]["xetHash"] != lfs_oid(data)
            async with http.get(f"{res}/a.txt",
                                headers={"Authorization": "Bearer tok"}) as r:
                assert r.headers["ETag"] == f'"{xet_hash(data)}"'
                assert await r.read() == data
            async with http.get(f"{res}/a.txt", headers={"Range":
                                                         "bytes=1-1"}) as r:
                assert (r.status, r.headers["ETag"]) == (206,
                                                         f'"{xet_hash(data)}"')
            async with http.get(f"{res}/a.txt", headers={"Range":
                                                         "bytes=3-9"}) as r:
                assert (r.status, "ETag" in r.headers) == (416, False)
            async with http.get(f"{res}/nope.txt") as r:
                assert (r.status,
                        r.headers["X-Error-Code"]) == (404, "EntryNotFound")
            async with http.get(f"{res}/w.txt") as r:
                assert r.headers["ETag"] == 'W/"weak"'
            async with http.get(f"{res}/n.txt") as r:
                assert "ETag" not in r.headers
    assert hub.auth["bucket_resolve"][0] == "Bearer tok"
    assert ("bucket_cdn", 416) in hub.statuses


@pytest.mark.asyncio
@pytest.mark.parametrize("token,sent", [("tok", "Bearer tok"), (None, "")])
async def test_the_token_reaches_both_bucket_routes(token, sent):
    # opendal used to carry the credential; now both HTTP calls must.
    with serve(FakeHub()) as hub:
        acc = make_accessor({"a.txt": b"x"}, hub=hub, token=token)
        try:
            assert await fetch_row(acc, "a.txt") is not None
            await read_bytes(acc, PathSpec.from_str_path("/a.txt"))
        finally:
            await acc.close()
    assert hub.auth["bucket_paths_info"] == [sent]
    assert hub.auth["bucket_resolve"] == [sent]
