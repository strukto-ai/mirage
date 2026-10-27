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

from collections.abc import Awaitable, Callable
from typing import Any

import pytest
from botocore.exceptions import ClientError

from mirage.accessor.s3 import S3Accessor
from mirage.core.s3.checksum import checksum
from mirage.core.s3.client import is_denied
from mirage.core.s3.driver import DRIVER
from mirage.core.s3.read import read
from mirage.core.s3.stream import read_stream
from mirage.core.s3.types import S3Conn
from mirage.errors.classify import classify
from mirage.errors.types import FsCondition
from mirage.types import PathSpec
from mirage.vfs.s3.config import S3Config
from tests.core.s3.conftest import client_error

SPEC = PathSpec(vfs_path="k.txt", virtual="/s3/k.txt", directory="/s3/")


class FailingClient:
    """Fails every HEAD with one code and every request with a body with another."""

    def __init__(self, head_code: str, body_code: str) -> None:
        self.head_code = head_code
        self.body_code = body_code

    async def head_object(self, **kwargs: Any) -> dict[str, Any]:
        raise client_error(self.head_code, 403, "HeadObject")

    async def get_object(self, **kwargs: Any) -> dict[str, Any]:
        raise client_error(self.body_code, 403, "GetObject")

    async def list_objects_v2(self, **kwargs: Any) -> dict[str, Any]:
        raise client_error(self.body_code, 403, "ListObjectsV2")


async def _drain(accessor: S3Accessor, conn: S3Conn) -> list[bytes]:
    return [chunk async for chunk in read_stream(accessor, SPEC)]


DOORS: dict[str, tuple[Callable[..., Awaitable[Any]], str | None]] = {
    "read": (lambda accessor, conn: read(accessor, SPEC), "/s3/k.txt"),
    "stream": (_drain, "/s3/k.txt"),
    "checksum": (
        lambda accessor, conn: checksum(accessor, SPEC, "md5", True),
        "/s3/k.txt",
    ),
    "head": (lambda accessor, conn: DRIVER.head(conn, "k.txt"), None),
    "get": (
        lambda accessor, conn: DRIVER.get_versioned(conn, "k.txt", None),
        None,
    ),
    "move": (
        lambda accessor, conn: DRIVER.move_file(conn, "k.txt", "m.txt"),
        None,
    ),
    "probe": (lambda accessor, conn: DRIVER.probe_prefix(conn, "k/"), None),
}


def _wired(
    client: FailingClient, monkeypatch: pytest.MonkeyPatch
) -> tuple[S3Accessor, S3Conn]:
    config = S3Config(
        bucket="b",
        region="us-east-1",
        aws_access_key_id="fake",
        aws_secret_access_key="fake",
    )
    accessor = S3Accessor(config)

    async def cached_client(factory: Any) -> FailingClient:
        return client

    monkeypatch.setattr(accessor, "cached_client", cached_client)
    return accessor, S3Conn(client, config)


@pytest.mark.asyncio
@pytest.mark.parametrize("door", DOORS)
async def test_every_door_answers_a_refused_key_permission_denied(
    door, monkeypatch
):
    # A driver door has only the key, which carries the mount's prefix, so
    # it names nothing and the layer above names the operand.
    call, named = DOORS[door]
    accessor, conn = _wired(FailingClient("403", "AccessDenied"), monkeypatch)
    with pytest.raises(PermissionError) as raised:
        await call(accessor, conn)
    assert classify(raised.value) is FsCondition.EACCES
    assert raised.value.filename == named
    assert is_denied(raised.value.__cause__)


@pytest.mark.asyncio
@pytest.mark.parametrize("door", DOORS)
async def test_every_door_keeps_a_credential_failure_its_own(
    door, monkeypatch
):
    call, _ = DOORS[door]
    failing = FailingClient("SignatureDoesNotMatch", "SignatureDoesNotMatch")
    accessor, conn = _wired(failing, monkeypatch)
    with pytest.raises(ClientError):
        await call(accessor, conn)


@pytest.mark.asyncio
async def test_a_pinned_get_keeps_a_refusal_its_own(monkeypatch):
    # Only an unpinned get maps a refusal; a pinned one is a follow-up.
    _, conn = _wired(FailingClient("403", "AccessDenied"), monkeypatch)
    with pytest.raises(ClientError):
        await DRIVER.get_versioned(conn, "k.txt", "v1")
