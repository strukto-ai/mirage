import asyncio
import json
import tomllib
from datetime import datetime
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, Mock

import botocore.session
import pytest
from botocore.exceptions import ClientError
from packaging.requirements import Requirement
from packaging.version import Version

from mirage.cache.types import ABSENT_WRITE, ANY_WRITE, MatchWrite
from mirage.context.session_context import (
    bind_caller,
    current_caller,
    reset_caller,
)
from mirage.core.object_store.errors import ConditionLostError
from mirage.core.s3.constants import MAX_PARTS, PART_DOUBLING
from mirage.core.s3.driver import DRIVER
from mirage.core.s3.types import S3Conn
from mirage.utils.abort import MirageAbortError
from mirage.vfs.s3.config import S3Config
from tests.core.s3.conftest import LOST_CODES, client_error


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "input,expected",
    [
        ("2026-09-05T10:55:39.000Z", "2026-09-05T10:55:39Z"),
        ("2026-09-05T10:55:39.123Z", "2026-09-05T10:55:39.123000Z"),
    ],
)
async def test_head_and_list_timestamp_format(input, expected):
    modified = datetime.fromisoformat(input)
    client = Mock()
    client.head_object = AsyncMock(
        return_value={"ContentLength": 2, "LastModified": modified}
    )
    pages = MagicMock()
    pages.__aiter__.return_value = [
        {
            "Contents": [
                {"Key": "a.txt", "Size": 2, "LastModified": modified}
            ],
        }
    ]
    client.get_paginator.return_value.paginate.return_value = pages
    conn = S3Conn(client, S3Config(bucket="b"))
    assert (await DRIVER.head(conn, "a.txt")).modified == expected
    children = [child async for child in DRIVER.list_children(conn, "")]
    assert children[0].modified == expected


_MATCHED = LOST_CODES["matched"]


@pytest.mark.asyncio
@pytest.mark.parametrize("case", _MATCHED, ids=[c["name"] for c in _MATCHED])
async def test_a_matched_write_loses_only_on_its_key(case):
    client = Mock()
    client.put_object = AsyncMock(
        side_effect=client_error(case["code"], case["status"], "PutObject")
    )
    conn = S3Conn(client, S3Config(bucket="b"))
    with pytest.raises(ConditionLostError if case["lost"] else ClientError):
        await DRIVER.put_if(conn, "k", b"x", MatchWrite("v1"))


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "code, status",
    [("AccessDenied", 403), ("404", 404)],
    ids=["probe-fails", "source-gone"],
)
async def test_a_copy_keeps_its_own_error_whatever_the_source_probe_finds(
    code, status
):
    # The probe only decides which side a 404 names; it never stands in for it.
    missing = client_error("NoSuchKey", 404, "CopyObject")
    client = Mock()
    client.copy_object = AsyncMock(side_effect=missing)
    client.head_object = AsyncMock(
        side_effect=client_error(code, status, "HeadObject")
    )
    conn = S3Conn(client, S3Config(bucket="b"))
    with pytest.raises(ClientError) as raised:
        await DRIVER.copy_if(conn, "src", "dst", MatchWrite("v1"))
    assert raised.value is missing


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "revision, code, missing",
    [
        (None, "NoSuchKey", True),
        ("rev", "NoSuchVersion", False),
        ("rev", "404", False),
        ("rev", "NoSuchBucket", None),
    ],
    ids=[
        "unpinned",
        "pinned NoSuchVersion",
        "pinned bodiless",
        "pinned missing bucket",
    ],
)
async def test_a_missing_pinned_revision_is_no_missing_file(
    revision, code, missing
):
    # A pin gone from the store fails the read; only an unpinned 404 is absence.
    gone = client_error(code, 404, "GetObject")
    client = Mock()
    client.get_object = AsyncMock(side_effect=gone)
    conn = S3Conn(client, S3Config(bucket="b"))
    if missing:
        assert await DRIVER.get_versioned(conn, "k", revision) is None
        return
    if missing is None:
        with pytest.raises(ClientError) as bucket:
            await DRIVER.get_versioned(conn, "k", revision)
        assert bucket.value is gone
        return
    with pytest.raises(FileNotFoundError) as raised:
        await DRIVER.get_versioned(conn, "k", revision)
    assert raised.value.__cause__ is gone


# CopyObject If-Match arrived in botocore 1.40.61; older models reject it.
_BOTOCORE_FLOOR = Version("1.40.61")


def test_the_s3_model_carries_every_condition_the_driver_sends():
    model = botocore.session.get_session().get_service_model("s3")
    members = {
        shape: set(model.shape_for(shape).members)
        for shape in (
            "PutObjectRequest",
            "CompleteMultipartUploadRequest",
            "CopyObjectRequest",
            "DeleteObjectRequest",
            "ObjectIdentifier",
        )
    }
    assert {"IfMatch", "IfNoneMatch"} <= members["PutObjectRequest"]
    assert {"IfMatch", "IfNoneMatch"} <= members[
        "CompleteMultipartUploadRequest"
    ]
    assert {"IfMatch", "CopySourceIfMatch"} <= members["CopyObjectRequest"]
    assert {"IfMatch"} <= members["DeleteObjectRequest"]
    assert {"ETag"} <= members["ObjectIdentifier"]


@pytest.mark.parametrize("extra", ["s3", "r2", "gcs", "oci", "aws-sm"])
def test_every_s3_extra_admits_no_botocore_below_the_floor(extra):
    pyproject = Path(__file__).parents[3] / "pyproject.toml"
    extras = tomllib.loads(pyproject.read_text())["project"][
        "optional-dependencies"
    ]
    floors = [
        Requirement(r).specifier
        for r in extras[extra]
        if Requirement(r).name == "botocore"
    ]
    assert floors and not any(
        spec.contains(Version("1.40.60")) for spec in floors
    ), extras[extra]
    assert all(spec.contains(_BOTOCORE_FLOOR) for spec in floors)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "size", [0, 13, 8 * 1024 * 1024, 8 * 1024 * 1024 + 37]
)
@pytest.mark.parametrize(
    "condition, header, value",
    [
        (MatchWrite("old"), "IfMatch", '"old"'),
        (ABSENT_WRITE, "IfNoneMatch", "*"),
    ],
)
async def test_streamed_upload_uses_bounded_parts_and_conditions(
    size, condition, header, value
):
    client = Mock()
    client.put_object = AsyncMock(return_value={"ETag": '"small"'})
    client.create_multipart_upload = AsyncMock(
        return_value={"UploadId": "upload"}
    )
    client.upload_part = AsyncMock(return_value={"ETag": '"part"'})
    client.complete_multipart_upload = AsyncMock(
        return_value={"ETag": '"large"'}
    )
    client.abort_multipart_upload = AsyncMock()
    conn = S3Conn(client, S3Config(bucket="b"))
    closed = []

    async def source():
        try:
            for offset in range(0, size, 65536):
                yield b"x" * min(65536, size - offset)
        finally:
            closed.append(True)

    result = await DRIVER.put_stream(conn, "k", source(), condition)
    assert result.size == size
    assert closed == [True]
    if size < 8 * 1024 * 1024:
        client.create_multipart_upload.assert_not_called()
        assert client.put_object.call_args.kwargs[header] == value
        assert len(client.put_object.call_args.kwargs["Body"]) == size
    else:
        assert [
            len(c.kwargs["Body"]) for c in client.upload_part.call_args_list
        ] == ([8 * 1024 * 1024] + ([37] if size % (8 * 1024 * 1024) else []))
        assert (
            client.complete_multipart_upload.call_args.kwargs[header] == value
        )
    client.abort_multipart_upload.assert_not_called()


@pytest.mark.asyncio
async def test_streamed_parts_carry_their_bytes_as_they_went():
    client = Mock()
    client.create_multipart_upload = AsyncMock(
        return_value={"UploadId": "upload"}
    )
    bodies = []

    async def upload_part(**kwargs):
        bodies.append(bytes(kwargs["Body"]))
        return {"ETag": '"part"'}

    client.upload_part = upload_part
    client.complete_multipart_upload = AsyncMock(return_value={})
    part = 8 * 1024 * 1024
    data = (bytes(range(251)) * (2 * part // 251 + 1))[: 2 * part + 37]

    async def source():
        for offset in range(0, len(data), 65521):
            yield data[offset : offset + 65521]

    await DRIVER.put_stream(
        S3Conn(client, S3Config(bucket="b")), "k", source(), ANY_WRITE
    )
    assert [len(body) for body in bodies] == [part, part, 37]
    assert b"".join(bodies) == data


@pytest.mark.asyncio
async def test_streamed_parts_double_past_the_part_cap(monkeypatch):
    monkeypatch.setattr("mirage.core.s3.driver.PART_SIZE", 16)
    client = Mock()
    client.create_multipart_upload = AsyncMock(
        return_value={"UploadId": "upload"}
    )
    client.upload_part = AsyncMock(return_value={"ETag": '"part"'})
    client.complete_multipart_upload = AsyncMock(return_value={})
    size = MAX_PARTS * 16 + 1

    async def source():
        for offset in range(0, size, 16):
            yield b"x" * min(16, size - offset)

    result = await DRIVER.put_stream(
        S3Conn(client, S3Config(bucket="b")), "k", source(), ANY_WRITE
    )
    sizes = [len(c.kwargs["Body"]) for c in client.upload_part.call_args_list]
    assert result.size == sum(sizes) == size
    assert (
        sizes[: 2 * PART_DOUBLING]
        == [16] * PART_DOUBLING + [32] * PART_DOUBLING
    )
    assert len(sizes) < MAX_PARTS


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["source", "part", "condition", "cancel"])
async def test_failed_multipart_upload_is_aborted(failure):
    client = Mock()
    client.create_multipart_upload = AsyncMock(
        return_value={"UploadId": "upload"}
    )
    client.upload_part = AsyncMock(return_value={"ETag": '"part"'})
    client.complete_multipart_upload = AsyncMock(return_value={})
    client.abort_multipart_upload = AsyncMock()
    conn = S3Conn(client, S3Config(bucket="b"))
    closed = []
    if failure == "part":
        client.upload_part.side_effect = OSError("upload failed")
    if failure == "condition":
        client.complete_multipart_upload.side_effect = client_error(
            "PreconditionFailed", 412, "CompleteMultipartUpload"
        )

    async def source():
        try:
            yield b"x" * (8 * 1024 * 1024)
            if failure == "source":
                raise OSError("read failed")
            if failure == "cancel":
                raise asyncio.CancelledError()
        finally:
            closed.append(True)

    expected = (
        asyncio.CancelledError
        if failure == "cancel"
        else ConditionLostError
        if failure == "condition"
        else OSError
    )
    with pytest.raises(expected):
        await DRIVER.put_stream(conn, "k", source(), MatchWrite("old"))
    client.abort_multipart_upload.assert_awaited_once_with(
        Bucket="b", Key="k", UploadId="upload"
    )
    assert closed == [True]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "condition, header, value",
    [
        (MatchWrite("old"), "IfMatch", '"old"'),
        (ABSENT_WRITE, "IfNoneMatch", "*"),
    ],
)
async def test_custom_endpoint_keeps_conditional_single_put(
    condition, header, value
):
    client = Mock()
    client.put_object = AsyncMock(return_value={"ETag": '"new"'})
    conn = S3Conn(
        client, S3Config(bucket="b", endpoint_url="https://store.invalid")
    )
    data = b"x" * (8 * 1024 * 1024)
    result = await DRIVER.put_stream(conn, "k", data, condition)
    assert result.size == len(data)
    client.create_multipart_upload.assert_not_called()
    assert client.put_object.call_args.kwargs[header] == value


_MOVE_RECOVERY = json.loads(
    (
        Path(__file__).parents[4] / "integ/fixtures/write/move_recovery.json"
    ).read_text()
)["cases"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "case", _MOVE_RECOVERY, ids=[c["name"] for c in _MOVE_RECOVERY]
)
async def test_a_failed_move_compensates_only_its_copy(case):
    objects = {"src": "source"}
    if "initial" in case:
        objects["dst"] = case["initial"]
    calls = []
    client = Mock()

    async def head(**params):
        key = params["Key"]
        if key not in objects:
            raise client_error("NoSuchKey", 404, "HeadObject")
        return {
            "ContentLength": 6,
            "LastModified": datetime(2026, 1, 1),
            "ETag": '"' + objects[key] + '"',
        }

    async def copy(**params):
        assert params["CopySourceIfMatch"] == '"source"'
        if "initial" not in case:
            assert params.get("IfNoneMatch") == "*"
        objects["dst"] = "copy"
        response = {
            "CopyObjectResult": {},
            "ResponseMetadata": {"RetryAttempts": case.get("copy_retries", 0)},
        }
        if not case.get("no_etag"):
            response["CopyObjectResult"]["ETag"] = case.get("etag", '"copy"')
        if "version" in case:
            response["VersionId"] = case["version"]
        return response

    async def delete(**params):
        calls.append(params)
        if params["Key"] == "src":
            code = case.get("source_code", "PreconditionFailed")
            if code == "NoSuchKey":
                objects.pop("src")
            else:
                objects["src"] = "new-source"
            error = client_error(
                code,
                {
                    "NoSuchKey": 404,
                    "ConditionalRequestConflict": 409,
                    "AccessDenied": 403,
                }.get(code, 412),
                "DeleteObject",
            )
            error.response["ResponseMetadata"]["RetryAttempts"] = case.get(
                "retries", 0
            )
            raise error
        if "replacement" in case:
            objects["dst"] = case["replacement"]
        if "cleanup_code" in case:
            code = case["cleanup_code"]
            if code == "NoSuchKey":
                objects.pop("dst", None)
            raise client_error(
                code,
                404
                if code == "NoSuchKey"
                else 412
                if code == "PreconditionFailed"
                else 403,
                "DeleteObject",
            )
        if "version" in case:
            assert params.get("VersionId") == case["version"]
            assert "IfMatch" not in params
            if objects["dst"] == "copy":
                objects["dst"] = (
                    "copy" if case.get("copy_retries") else case["initial"]
                )
        else:
            assert params.get("IfMatch") == '"copy"'
            objects.pop("dst", None)
        return {}

    client.head_object = head
    client.copy_object = copy
    client.delete_object = delete
    with pytest.raises(Exception) as raised:
        await DRIVER.move_file_if(
            S3Conn(client, S3Config(bucket="b")),
            "src",
            "dst",
            ANY_WRITE,
            "source",
        )
    assert objects.get("dst") == case["destination"]
    assert len(calls) == case["deletes"]
    assert raised.value.recovered == case["recovered"]
    if case.get("cleanup_code") and not case["recovered"]:
        assert raised.value.recovery_error is not None


@pytest.mark.asyncio
async def test_cancel_after_confirmed_copy_recovers_before_source_delete():
    stop = asyncio.Event()
    client = Mock()
    objects = {"src": b"original"}
    deleted = []

    async def copy(**params):
        objects["dst"] = objects["src"]
        stop.set()
        return {"CopyObjectResult": {"ETag": '"copy"'}}

    async def delete(**params):
        deleted.append(params["Key"])
        objects.pop(params["Key"], None)
        return {}

    client.copy_object = copy
    client.delete_object = delete
    token = bind_caller(current_caller().changed({"stop": stop}))
    try:
        with pytest.raises(MirageAbortError):
            await DRIVER.move_file_if(
                S3Conn(client, S3Config(bucket="b")),
                "src",
                "dst",
                ABSENT_WRITE,
                "source",
            )
    finally:
        reset_caller(token)
    assert objects == {"src": b"original"}
    assert deleted == ["dst"]


@pytest.mark.asyncio
async def test_cancel_during_source_delete_joins_a_confirmed_refusal():
    reached = asyncio.Event()
    release = asyncio.Event()
    client = Mock()
    deleted = []
    client.copy_object = AsyncMock(
        return_value={"CopyObjectResult": {"ETag": '"copy"'}}
    )

    async def delete(**params):
        deleted.append(params["Key"])
        if params["Key"] == "src":
            reached.set()
            await release.wait()
            raise client_error("PreconditionFailed", 412, "DeleteObject")
        return {}

    client.delete_object = delete
    task = asyncio.create_task(
        DRIVER.move_file_if(
            S3Conn(client, S3Config(bucket="b")),
            "src",
            "dst",
            ABSENT_WRITE,
            "source",
        )
    )
    await reached.wait()
    task.cancel()
    release.set()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert deleted == ["src", "dst"]


@pytest.mark.asyncio
async def test_cancel_after_source_delete_commit_keeps_the_surviving_copy():
    committed = asyncio.Event()
    release = asyncio.Event()
    client = Mock()
    objects = {"src": b"original"}
    deleted = []

    async def copy(**params):
        objects["dst"] = objects["src"]
        return {"CopyObjectResult": {"ETag": '"copy"'}}

    async def delete(**params):
        deleted.append(params["Key"])
        objects.pop(params["Key"], None)
        committed.set()
        await release.wait()
        return {}

    client.copy_object = copy
    client.delete_object = delete
    task = asyncio.create_task(
        DRIVER.move_file_if(
            S3Conn(client, S3Config(bucket="b")),
            "src",
            "dst",
            ABSENT_WRITE,
            "source",
        )
    )
    await committed.wait()
    task.cancel()
    release.set()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert objects == {"dst": b"original"}
    assert deleted == ["src"]


@pytest.mark.asyncio
async def test_move_does_not_require_new_destination_read_permissions():
    client = Mock()
    client.head_object = AsyncMock(
        side_effect=client_error("AccessDenied", 403, "HeadObject")
    )
    client.copy_object = AsyncMock(
        return_value={"CopyObjectResult": {"ETag": '"copy"'}}
    )
    client.delete_object = AsyncMock(return_value={})
    assert await DRIVER.move_file_if(
        S3Conn(client, S3Config(bucket="b")), "src", "dst", ANY_WRITE, "source"
    )
    assert "IfNoneMatch" not in client.copy_object.call_args.kwargs
    assert client.delete_object.call_args.kwargs["Key"] == "src"


@pytest.mark.asyncio
async def test_cancellation_during_compensation_still_joins_its_request():
    cleanup_started = asyncio.Event()
    release = asyncio.Event()
    client = Mock()
    objects = {"src": "new-source", "dst": "copy"}
    client.copy_object = AsyncMock(
        return_value={"CopyObjectResult": {"ETag": '"copy"'}}
    )

    async def delete(**params):
        if params["Key"] == "src":
            raise client_error("PreconditionFailed", 412, "DeleteObject")
        cleanup_started.set()
        await release.wait()
        objects.pop("dst")
        return {}

    client.delete_object = delete
    move = asyncio.create_task(
        DRIVER.move_file_if(
            S3Conn(client, S3Config(bucket="b")),
            "src",
            "dst",
            ABSENT_WRITE,
            "source",
        )
    )
    await cleanup_started.wait()
    move.cancel()
    release.set()
    with pytest.raises(asyncio.CancelledError):
        await move
    assert objects == {"src": "new-source"}


@pytest.mark.asyncio
async def test_cancelled_delete_with_unknown_outcome_is_bounded_and_keeps_copy(
    caplog,
):
    started = asyncio.Event()
    stopped = asyncio.Event()
    client = Mock()
    client.copy_object = AsyncMock(
        return_value={"CopyObjectResult": {"ETag": '"copy"'}}
    )
    deleted = []

    async def delete(**params):
        deleted.append(params["Key"])
        started.set()
        try:
            await asyncio.Event().wait()
        finally:
            stopped.set()

    client.delete_object = delete
    move = asyncio.create_task(
        DRIVER.move_file_if(
            S3Conn(client, S3Config(bucket="b")),
            "src",
            "dst",
            ABSENT_WRITE,
            "source",
        )
    )
    await started.wait()
    move.cancel()
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(move, 1)
    assert stopped.is_set()
    assert deleted == ["src"]
    assert "source deletion outcome unknown" in caplog.text


@pytest.mark.asyncio
async def test_repeated_cancel_keeps_ownership_of_a_refused_source_delete():
    started = asyncio.Event()
    release = asyncio.Event()
    client = Mock()
    deleted = []
    client.copy_object = AsyncMock(
        return_value={"CopyObjectResult": {"ETag": '"copy"'}}
    )

    async def delete(**params):
        deleted.append(params["Key"])
        if params["Key"] == "src":
            started.set()
            await release.wait()
            raise client_error("PreconditionFailed", 412, "DeleteObject")
        return {}

    client.delete_object = delete
    move = asyncio.create_task(
        DRIVER.move_file_if(
            S3Conn(client, S3Config(bucket="b")),
            "src",
            "dst",
            ABSENT_WRITE,
            "source",
        )
    )
    await started.wait()
    move.cancel()
    await asyncio.sleep(0)
    move.cancel()
    release.set()
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(move, 1)
    assert deleted == ["src", "dst"]


@pytest.mark.asyncio
async def test_competing_destination_creation_names_the_destination():
    client = Mock()
    client.head_object = AsyncMock(
        side_effect=[
            client_error("NoSuchKey", 404, "HeadObject"),
            {
                "ContentLength": 6,
                "LastModified": datetime(2026, 1, 1),
                "ETag": '"theirs"',
            },
        ]
    )
    client.copy_object = AsyncMock(
        side_effect=client_error("PreconditionFailed", 412, "CopyObject")
    )
    client.delete_object = AsyncMock()
    with pytest.raises(ConditionLostError) as raised:
        await DRIVER.move_file_if(
            S3Conn(client, S3Config(bucket="b")),
            "src",
            "dst",
            ANY_WRITE,
            "source",
        )
    assert raised.value.keys == ["dst"]
    assert not raised.value.gone
    client.delete_object.assert_not_called()
