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

import hashlib

import pytest

from tests.e2e.s3_mock import MultiBucketS3Client

OLD, NEW, SRC = b"old\n", b"new\n", b"src\n"


def _etag(data: bytes) -> str:
    return '"' + hashlib.md5(data).hexdigest() + '"'


def _client() -> MultiBucketS3Client:
    return MultiBucketS3Client({"b": {"k": NEW, "src": SRC}})


async def _put(c: MultiBucketS3Client, **cond: str) -> None:
    await c.put_object(Bucket="b", Key="k", Body=b"attempt\n", **cond)


async def _copy(c: MultiBucketS3Client, **cond: str) -> None:
    await c.copy_object(
        Bucket="b", CopySource={"Bucket": "b", "Key": "src"}, Key="k", **cond
    )


async def _delete(c: MultiBucketS3Client, **cond: str) -> None:
    await c.delete_object(Bucket="b", Key="k", **cond)


# The fakes the conditional-write suite runs on must refuse a stale
# condition the way AWS does (measured 2026-10-06), or every loss-side
# test over them passes having checked nothing: moto ignores the copy
# condition, which is the failure this table exists to rule out.
@pytest.mark.asyncio
@pytest.mark.parametrize(
    "call, cond",
    [
        (_put, {"IfMatch": _etag(OLD)}),
        (_put, {"IfNoneMatch": "*"}),
        (_copy, {"IfMatch": _etag(OLD)}),
        (_copy, {"IfNoneMatch": "*"}),
        (_delete, {"IfMatch": _etag(OLD)}),
    ],
    ids=[
        "put-if-match",
        "put-if-none-match",
        "copy-if-match",
        "copy-if-none-match",
        "delete-if-match",
    ],
)
async def test_a_stale_condition_is_refused_and_keeps_the_object(call, cond):
    c = _client()
    with pytest.raises(Exception) as info:
        await call(c, **cond)
    assert info.value.response["Error"]["Code"] == "PreconditionFailed"
    assert info.value.response["ResponseMetadata"]["HTTPStatusCode"] == 412
    assert c.buckets["b"]["k"] == NEW


@pytest.mark.asyncio
@pytest.mark.parametrize("call", [_put, _copy], ids=["put", "copy"])
async def test_an_if_match_on_a_missing_key_answers_not_found(call):
    c = _client()
    del c.buckets["b"]["k"]
    with pytest.raises(Exception) as info:
        await call(c, IfMatch=_etag(OLD))
    assert info.value.response["Error"]["Code"] == "NoSuchKey"
    assert "k" not in c.buckets["b"]


@pytest.mark.asyncio
async def test_a_stale_copy_source_is_refused_and_writes_nothing():
    c = MultiBucketS3Client({"b": {"src": SRC}})
    with pytest.raises(Exception) as info:
        await c.copy_object(
            Bucket="b",
            CopySource={"Bucket": "b", "Key": "src"},
            Key="k",
            CopySourceIfMatch=_etag(OLD),
        )
    assert info.value.response["Error"]["Code"] == "PreconditionFailed"
    assert "k" not in c.buckets["b"]


@pytest.mark.asyncio
async def test_a_stale_batch_delete_key_is_reported_and_kept():
    c = MultiBucketS3Client({"b": {"k": NEW, "j": SRC}})
    resp = await c.delete_objects(
        Bucket="b",
        Delete={
            "Objects": [
                {"Key": "k", "ETag": _etag(OLD)},
                {"Key": "j", "ETag": _etag(SRC)},
            ]
        },
    )
    # A refused key comes back in the body of a 200, not as a raise,
    # which is what the driver has to read.
    assert [e["Key"] for e in resp["Errors"]] == ["k"]
    assert resp["Errors"][0]["Code"] == "PreconditionFailed"
    assert c.buckets["b"] == {"k": NEW}


@pytest.mark.asyncio
@pytest.mark.parametrize("spell", [_etag(NEW), _etag(NEW).strip('"')])
async def test_a_matching_condition_applies_in_either_spelling(spell):
    c = _client()
    await _put(c, IfMatch=spell)
    assert c.buckets["b"]["k"] == b"attempt\n"


@pytest.mark.asyncio
async def test_the_ledger_keeps_order_and_condition_params():
    c = _client()
    await c.head_object(Bucket="b", Key="k")
    await _put(c, IfMatch=_etag(NEW))
    assert c.ledger == [
        ("head_object", {}),
        ("put_object", {"IfMatch": _etag(NEW)}),
    ]


@pytest.mark.asyncio
async def test_a_hook_lands_between_two_requests():
    c = _client()

    def other_writer() -> None:
        c.buckets["b"]["k"] = b"theirs\n"

    c.before("put_object", other_writer)
    with pytest.raises(Exception):
        await _put(c, IfMatch=_etag(NEW))
    assert c.buckets["b"]["k"] == b"theirs\n"


@pytest.mark.asyncio
async def test_the_tripwire_refuses_an_unconditioned_mutation():
    c = _client()
    c.tripwire = True
    with pytest.raises(AssertionError, match="unconditioned put_object"):
        await _put(c)
    # A directory marker is the one unconditioned delete allowed.
    await c.delete_object(Bucket="b", Key="dir/")


@pytest.mark.asyncio
async def test_a_copy_answers_the_new_objects_etag():
    c = _client()
    resp = await c.copy_object(
        Bucket="b", CopySource={"Bucket": "b", "Key": "src"}, Key="k"
    )
    assert resp["CopyObjectResult"]["ETag"] == _etag(SRC)


@pytest.mark.asyncio
async def test_the_tripwire_judges_a_batch_delete_per_key():
    # A marker first must not exempt an untagged file key behind it.
    c = MultiBucketS3Client({"b": {"d/": b"", "d/a": b"a"}})
    c.tripwire = True
    with pytest.raises(AssertionError):
        await c.delete_objects(
            Bucket="b", Delete={"Objects": [{"Key": "d/"}, {"Key": "d/a"}]}
        )
