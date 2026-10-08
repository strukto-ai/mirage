import tomllib
from datetime import datetime
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, Mock

import botocore.session
import pytest
from botocore.exceptions import ClientError
from packaging.requirements import Requirement
from packaging.version import Version

from mirage.cache.types import WriteCondition
from mirage.core.object_store.errors import ConditionLostError
from mirage.core.s3.driver import DRIVER, S3Conn
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
        await DRIVER.put_if(conn, "k", b"x", WriteCondition(if_match="v1"))


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
        await DRIVER.copy_if(conn, "src", "dst", WriteCondition(if_match="v1"))
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
            "CopyObjectRequest",
            "DeleteObjectRequest",
            "ObjectIdentifier",
        )
    }
    assert {"IfMatch"} <= members["PutObjectRequest"]
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
