from datetime import datetime
from unittest.mock import AsyncMock, MagicMock, Mock

import pytest
from botocore.exceptions import ClientError

from mirage.cache.context import WriteCondition
from mirage.core.object_store.driver import ConditionLost
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
    with pytest.raises(ConditionLost if case["lost"] else ClientError):
        await DRIVER.put_if(conn, "k", b"x", WriteCondition(if_match="v1"))


@pytest.mark.asyncio
async def test_a_copy_keeps_its_own_error_when_the_source_probe_fails():
    # The probe only decides which side a 404 names; failing, it must not
    # stand in for the copy's own error.
    missing = client_error("NoSuchKey", 404, "CopyObject")
    client = Mock()
    client.copy_object = AsyncMock(side_effect=missing)
    client.head_object = AsyncMock(
        side_effect=client_error("AccessDenied", 403, "CopyObject")
    )
    conn = S3Conn(client, S3Config(bucket="b"))
    with pytest.raises(ClientError) as raised:
        await DRIVER.copy_if(conn, "src", "dst", WriteCondition(if_match="v1"))
    assert raised.value is missing


@pytest.mark.asyncio
async def test_a_copy_whose_source_is_gone_keeps_its_own_error():
    # A 404 with the source gone names the source, not a lost version.
    missing = client_error("NoSuchKey", 404, "CopyObject")
    client = Mock()
    client.copy_object = AsyncMock(side_effect=missing)
    client.head_object = AsyncMock(
        side_effect=client_error("404", 404, "HeadObject")
    )
    conn = S3Conn(client, S3Config(bucket="b"))
    with pytest.raises(ClientError) as raised:
        await DRIVER.copy_if(conn, "src", "dst", WriteCondition(if_match="v1"))
    assert raised.value is missing
