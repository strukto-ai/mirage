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

from mirage.core.nextcloud.checksum import checksum
from mirage.types import PathSpec
from tests.core.nextcloud.conftest import ROOT, answering, multistatus

SHA1 = "a" * 40
MD5 = "b" * 32
FILE = PathSpec(
    virtual="/nc/a b.txt",
    directory="/nc",
    vfs_path="a b.txt",
    raw_path="/nc/a b.txt",
)


def _sums(text: str, kind: str = "<d:resourcetype/>") -> bytes:
    return multistatus(
        "200 OK",
        f'{kind}<oc:checksums xmlns:oc="http://owncloud.org/ns">'
        f"<oc:checksum>{text}</oc:checksum></oc:checksums>",
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("algorithm", "digest"), [("sha1", SHA1), ("md5", MD5)]
)
async def test_the_digest_is_the_one_nextcloud_keeps(
    make_acc, algorithm, digest
):
    body = _sums(f"SHA1:{SHA1} MD5:{MD5} ADLER32:01234567")
    with answering("checksum", 207, body) as request:
        assert await checksum(make_acc(), FILE, algorithm) == digest
    assert request.await_args.args[1:3] == ("PROPFIND", f"{ROOT}/a%20b.txt")
    assert request.await_args.kwargs["headers"]["Depth"] == "0"


@pytest.mark.asyncio
async def test_a_digest_is_read_case_insensitively(make_acc):
    body = _sums(f"sha1:{SHA1.upper()}")
    with answering("checksum", 207, body):
        assert await checksum(make_acc(), FILE, "sha1") == SHA1


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "body",
    [
        _sums(f"MD5:{MD5}"),
        _sums(""),
        _sums(f"SHA1:{SHA1[1:]}"),
        _sums(f"SHA1:{SHA1[1:]}g"),
        _sums(
            f"SHA1:{SHA1}", "<d:resourcetype><d:collection/></d:resourcetype>"
        ),
        multistatus(
            "404 Not Found",
            '<oc:checksums xmlns:oc="http://owncloud.org/ns"/>',
        ),
    ],
)
async def test_no_digest_of_the_algorithm_leaves_the_read(make_acc, body):
    with answering("checksum", 207, body):
        assert await checksum(make_acc(), FILE, "sha1") is None


@pytest.mark.asyncio
async def test_anything_but_a_multistatus_leaves_the_read(make_acc):
    with answering("checksum", 404):
        assert await checksum(make_acc(), FILE, "sha1") is None


@pytest.mark.asyncio
async def test_an_algorithm_nextcloud_keeps_none_of_asks_nothing(make_acc):
    with answering("checksum", 207, _sums(f"SHA1:{SHA1}")) as request:
        assert await checksum(make_acc(), FILE, "sha512") is None
    request.assert_not_awaited()
