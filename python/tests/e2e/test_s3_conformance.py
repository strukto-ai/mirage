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
"""Does the in-memory S3 fake answer what a real S3 store answers?

Every script in ``SCRIPTS`` is a list of requests (``tests/e2e/s3_script.py``).
``EXPECTED`` holds what real S3 answers each step and the keys it ends with.
The fake runs every script on every default run. A real store runs the same
scripts when it is reachable, and both are held to ``EXPECTED``, so a fake and
a store that both match it match each other.

Targets:

* ``fake``: always.
* ``minio``: set ``MIRAGE_S3_CONFORMANCE_MINIO_ENDPOINT`` (CI starts one in
  the Python job). ``MIRAGE_S3_CONFORMANCE_MINIO_KEY`` and ``_SECRET`` default
  to the CI container's ``minio`` / ``minio123``.
* ``aws``: set ``MIRAGE_S3_CONFORMANCE_AWS=1`` for a manual or nightly run.
  Credentials and region come from the ambient AWS environment; nothing is
  stored in the repo. The run creates and deletes a bucket of its own.

Where the fake is wrong the step is a strict ``xfail`` (``FAKE_DIFFERS``)
carrying the real answer in ``EXPECTED``; fixing the fake turns it into an
unexpected pass, which fails until the entry is removed.

Where MinIO differs from real S3 (``MINIO_DIFFERS``) the MinIO answer is
recorded and asserted, so the difference is named rather than hidden:

===========================  ============================  ==============
Request                      Real S3 (EXPECTED)            MinIO
===========================  ============================  ==============
DeleteObject IfMatch         404 gone, 412 mismatch        ignored, 204
DeleteObjects per-key ETag   per-key PreconditionFailed    ignored
CopyObject IfMatch           412 / 404 on the destination  ignored
CopyObject IfNoneMatch       412 on an existing key        ignored
===========================  ============================  ==============

``EXPECTED`` for those rows is the answer the product's error mapping
assumes (the fake's own); it is confirmed only by the ``aws`` target.

Dropbox is not covered: it is not an S3 request script.
"""

import os
import uuid
from collections.abc import Callable
from typing import Any

import aioboto3
import pytest
from botocore.config import Config

from tests.e2e.s3_mock import MultiBucketS3Client
from tests.e2e.s3_script import Outcome, Step, Trace, run_script

MINIO_ENDPOINT = "MIRAGE_S3_CONFORMANCE_MINIO_ENDPOINT"
AWS_FLAG = "MIRAGE_S3_CONFORMANCE_AWS"

A = b"one"
BAD = '"deadbeef"'
OTHER_BAD = '"cafef00d"'


def ok(*detail: str) -> Outcome:
    return Outcome(None, "2xx", detail)


def err(code: str) -> Outcome:
    return Outcome(code, "4xx")


SCRIPTS: dict[str, tuple[dict[str, bytes], tuple[Step, ...]]] = {
    "delete_if_match_missing": (
        {},
        (
            Step("delete", "gone", if_match="@gone"),
            Step("delete", "gone"),
        ),
    ),
    "delete_if_match_mismatch": (
        {"a": A},
        (
            Step("delete", "a", if_match=BAD),
            Step("delete", "a", if_match="@a"),
        ),
    ),
    "put_if_match": (
        {"a": A},
        (
            Step("put", "gone", b"x", if_match="@gone"),
            Step("put", "a", b"two", if_match=BAD),
            Step("put", "a", b"two", if_match="@a"),
            Step("head", "a"),
        ),
    ),
    "put_if_none_match": (
        {"a": A},
        (
            Step("put", "a", b"two", if_none_match="*"),
            Step("put", "new", b"x", if_none_match="*"),
            Step("put", "new", b"y", if_none_match="*"),
            Step("get", "new"),
        ),
    ),
    "copy_missing_source": (
        {"a": A},
        (
            Step("copy", "dst", src="gone"),
            Step("copy", "dst", src="gone", if_match="@dst"),
            Step("copy", "dst", src="gone", if_none_match="*"),
        ),
    ),
    "copy_source_if_match": (
        {"a": A},
        (
            Step("copy", "dst", src="a", copy_source_if_match=BAD),
            Step("copy", "dst", src="a", copy_source_if_match="@a"),
            Step("get", "dst"),
        ),
    ),
    "copy_both_conditions_fail": (
        {"a": A, "b": b"bee"},
        (
            Step(
                "copy",
                "b",
                src="a",
                copy_source_if_match=BAD,
                if_match=OTHER_BAD,
            ),
            Step(
                "copy",
                "gone",
                src="a",
                copy_source_if_match=BAD,
                if_match=OTHER_BAD,
            ),
            Step(
                "copy",
                "b",
                src="gone",
                copy_source_if_match=BAD,
                if_match=OTHER_BAD,
            ),
            Step("copy", "a", src="b", if_none_match="*"),
        ),
    ),
    "copy_destination_conditions": (
        {"a": A, "b": b"bee"},
        (
            Step("copy", "b", src="a", if_match=BAD),
            Step("copy", "gone", src="a", if_match=BAD),
            Step("copy", "b", src="a", if_match="@b"),
            Step("copy", "b", src="a", if_none_match="*"),
            Step("copy", "new", src="a", if_none_match="*"),
            Step("copy", "a", src="a"),
        ),
    ),
    "delete_objects_conditions": (
        {"a": A, "b": b"bee", "c": b"sea"},
        (
            Step(
                "delete_objects",
                keys=(("a", BAD), ("b", "@b"), ("gone", BAD), ("c", None)),
            ),
            Step("list"),
            Step("delete_objects", keys=(("a", "@a"), ("gone", None))),
        ),
    ),
    "etag_after_put_and_copy": (
        {},
        (
            Step("put", "a", b"hello"),
            Step("copy", "b", src="a"),
            Step("head", "b"),
            Step("put", "b", b"", if_match="@b"),
        ),
    ),
    "missing_key_reads": (
        {},
        (
            Step("get", "gone"),
            Step("head", "gone"),
            Step("delete", "gone"),
            Step("delete_objects", keys=(("gone", None),)),
        ),
    ),
    "list_prefix_delimiter": (
        {
            "dir/": b"",
            "dir/a": A,
            "dir/sub/": b"",
            "dir/sub/b": A,
            "dirx": A,
            "top": A,
        },
        (
            Step("list"),
            Step("list", delimiter="/"),
            Step("list", prefix="dir/"),
            Step("list", prefix="dir/", delimiter="/"),
            Step("list", prefix="dir", delimiter="/"),
            Step("list", prefix="dir/sub/", delimiter="/"),
            Step("list", prefix="nope/", delimiter="/"),
        ),
    ),
}

EXPECTED: dict[str, tuple[tuple[str, ...], tuple[Outcome, ...]]] = {
    "delete_if_match_missing": ((), (err("NoSuchKey"), ok())),
    "delete_if_match_mismatch": ((), (err("PreconditionFailed"), ok())),
    "put_if_match": (
        ("a",),
        (err("NoSuchKey"), err("PreconditionFailed"), ok("md5"), ok("size:3")),
    ),
    "put_if_none_match": (
        ("a", "new"),
        (
            err("PreconditionFailed"),
            ok("md5"),
            err("PreconditionFailed"),
            ok("body:b'x'"),
        ),
    ),
    "copy_missing_source": (
        ("a",),
        (err("NoSuchKey"), err("NoSuchKey"), err("NoSuchKey")),
    ),
    "copy_source_if_match": (
        ("a", "dst"),
        (err("PreconditionFailed"), ok("md5"), ok("body:b'one'")),
    ),
    "copy_both_conditions_fail": (
        ("a", "b"),
        (
            err("PreconditionFailed"),
            err("PreconditionFailed"),
            err("NoSuchKey"),
            err("PreconditionFailed"),
        ),
    ),
    "copy_destination_conditions": (
        ("a", "b", "new"),
        (
            err("PreconditionFailed"),
            err("NoSuchKey"),
            ok("md5"),
            err("PreconditionFailed"),
            ok("md5"),
            err("InvalidRequest"),
        ),
    ),
    "delete_objects_conditions": (
        (),
        (
            ok(
                "deleted:b",
                "deleted:c",
                "deleted:gone",
                "error:a:PreconditionFailed",
            ),
            ok("key:a"),
            ok("deleted:a", "deleted:gone"),
        ),
    ),
    "etag_after_put_and_copy": (
        ("a", "b"),
        (ok("md5"), ok("md5"), ok("size:5"), ok("md5")),
    ),
    "missing_key_reads": (
        (),
        (err("NoSuchKey"), err("404"), ok(), ok("deleted:gone")),
    ),
    "list_prefix_delimiter": (
        ("dir/", "dir/a", "dir/sub/", "dir/sub/b", "dirx", "top"),
        (
            ok(
                "key:dir/",
                "key:dir/a",
                "key:dir/sub/",
                "key:dir/sub/b",
                "key:dirx",
                "key:top",
            ),
            ok("key:dirx", "key:top", "prefix:dir/"),
            ok("key:dir/", "key:dir/a", "key:dir/sub/", "key:dir/sub/b"),
            ok("key:dir/", "key:dir/a", "prefix:dir/sub/"),
            ok("key:dirx", "prefix:dir/"),
            ok("key:dir/sub/", "key:dir/sub/b"),
            ok(),
        ),
    ),
}

FAKE_DIFFERS: dict[tuple[str, int], str] = {
    (
        "delete_if_match_missing",
        0,
    ): "the fake deletes a missing key under IfMatch with 204; "
    "the product's mapping assumes S3 answers 404 NoSuchKey",
    (
        "missing_key_reads",
        1,
    ): "HeadObject carries no body, so a real client reports the bare "
    "status '404' as the code, not NoSuchKey",
    (
        "copy_destination_conditions",
        5,
    ): "deliberate: the fake accepts a copy onto itself so the same-key "
    "guard stays observable; S3 refuses it with InvalidRequest",
}

MINIO_DIFFERS: dict[tuple[str, int], Outcome] = {
    ("delete_if_match_missing", 0): ok(),
    ("delete_if_match_mismatch", 0): ok(),
    ("copy_both_conditions_fail", 3): ok("md5"),
    ("copy_destination_conditions", 0): ok("md5"),
    ("copy_destination_conditions", 1): ok("md5"),
    ("copy_destination_conditions", 3): ok("md5"),
    (
        "delete_objects_conditions",
        0,
    ): ok("deleted:a", "deleted:b", "deleted:c", "deleted:gone"),
    ("delete_objects_conditions", 1): ok(),
}

MINIO_KEYS: dict[str, tuple[str, ...]] = {
    "copy_both_conditions_fail": ("a", "b"),
    "copy_destination_conditions": ("a", "b", "gone", "new"),
    "delete_objects_conditions": (),
}


def _agree(got: Outcome, expected: Outcome) -> bool:
    """Whether two answers match, a status the client left out aside.

    Args:
        got (Outcome): Answer of the store under test.
        expected (Outcome): Recorded real answer.
    """
    status = got.status in ("unknown", expected.status)
    return (
        got.code == expected.code and status and got.detail == expected.detail
    )


def _real_target(name: str) -> Callable[[], Any]:
    def client() -> Any:
        if name == "minio":
            return aioboto3.Session().client(
                "s3",
                endpoint_url=os.environ[MINIO_ENDPOINT],
                aws_access_key_id=os.environ.get(
                    "MIRAGE_S3_CONFORMANCE_MINIO_KEY", "minio"
                ),
                aws_secret_access_key=os.environ.get(
                    "MIRAGE_S3_CONFORMANCE_MINIO_SECRET", "minio123"
                ),
                region_name="us-east-1",
                config=Config(s3={"addressing_style": "path"}),
            )
        return aioboto3.Session().client("s3")

    return client


async def _create_bucket(client: Any) -> str:
    bucket = f"mirage-conf-{uuid.uuid4().hex[:16]}"
    region = client.meta.region_name
    if region == "us-east-1":
        await client.create_bucket(Bucket=bucket)
    else:
        await client.create_bucket(
            Bucket=bucket,
            CreateBucketConfiguration={"LocationConstraint": region},
        )
    return bucket


async def _drop_bucket(client: Any, bucket: str) -> None:
    listed = await client.list_objects_v2(Bucket=bucket)
    rows = [{"Key": o["Key"]} for o in listed.get("Contents") or []]
    if rows:
        await client.delete_objects(Bucket=bucket, Delete={"Objects": rows})
    await client.delete_bucket(Bucket=bucket)


async def _trace(target: str, name: str) -> Trace:
    seed, steps = SCRIPTS[name]
    if target == "fake":
        return await run_script(MultiBucketS3Client({}), "b", seed, steps)
    async with _real_target(target)() as client:
        bucket = await _create_bucket(client)
        try:
            return await run_script(client, bucket, seed, steps)
        finally:
            await _drop_bucket(client, bucket)


def _targets() -> list[Any]:
    return [
        "fake",
        pytest.param(
            "minio",
            marks=pytest.mark.skipif(
                MINIO_ENDPOINT not in os.environ,
                reason=f"{MINIO_ENDPOINT} not set",
            ),
        ),
        pytest.param(
            "aws",
            marks=pytest.mark.skipif(
                AWS_FLAG not in os.environ, reason=f"{AWS_FLAG} not set"
            ),
        ),
    ]


def _step_cases() -> list[Any]:
    cases = []
    for target in _targets():
        name = target if isinstance(target, str) else target.values[0]
        for script, (_, outcomes) in sorted(EXPECTED.items()):
            for i in range(len(outcomes)):
                marks = []
                if name == "fake" and (script, i) in FAKE_DIFFERS:
                    marks.append(
                        pytest.mark.xfail(
                            strict=True, reason=FAKE_DIFFERS[script, i]
                        )
                    )
                if not isinstance(target, str):
                    marks += target.marks
                cases.append(
                    pytest.param(
                        name, script, i, marks=marks, id=f"{name}-{script}-{i}"
                    )
                )
    return cases


def test_scripts_and_expectations_line_up():
    assert set(SCRIPTS) == set(EXPECTED)
    for name, (_, steps) in SCRIPTS.items():
        assert len(steps) == len(EXPECTED[name][1]), name
    assert set(FAKE_DIFFERS) <= {
        (n, i) for n, (_, o) in EXPECTED.items() for i in range(len(o))
    }


@pytest.mark.asyncio
@pytest.mark.parametrize(("target", "script", "step"), _step_cases())
async def test_step_answer(target, script, step):
    trace = await _trace(target, script)
    expected = EXPECTED[script][1][step]
    if target == "minio":
        expected = MINIO_DIFFERS.get((script, step), expected)
    assert _agree(trace.outcomes[step], expected), (
        f"{target} answered {trace.outcomes[step]}, real S3 answers {expected}"
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("target", "script"),
    [
        pytest.param(p.values[0], s, marks=p.marks, id=f"{p.values[0]}-{s}")
        if not isinstance(p, str)
        else pytest.param(p, s, id=f"{p}-{s}")
        for p in _targets()
        for s in sorted(EXPECTED)
    ],
)
async def test_final_state(target, script):
    trace = await _trace(target, script)
    keys = EXPECTED[script][0]
    if target == "minio":
        keys = MINIO_KEYS.get(script, keys)
    assert trace.state == tuple((k, "md5") for k in keys)


@pytest.mark.asyncio
@pytest.mark.xfail(
    strict=True,
    reason="the fake raises NoSuchKey without the HTTP status botocore "
    "always attaches to a ClientError",
)
async def test_fake_errors_carry_a_status():
    for name in SCRIPTS:
        trace = await _trace("fake", name)
        for outcome in trace.outcomes:
            assert outcome.code is None or outcome.status != "unknown"
