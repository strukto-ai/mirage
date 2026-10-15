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

from unittest.mock import AsyncMock, patch

import pytest

from mirage.core.box.checksum import checksum
from mirage.observe.context import RecordingScope
from mirage.types import FileStat, FileType, PathSpec

SCOPE = PathSpec(vfs_path="a.txt", virtual="/a.txt", directory="/a.txt")


async def _listed(index, sha1: str | None) -> None:
    await index.set_dir(
        "/",
        [
            (
                "a.txt",
                FileStat(
                    name="a.txt",
                    type=FileType.FILE,
                    extra={
                        "box_id": "200",
                        "resource_type": "box/file",
                        **({"sha1": sha1} if sha1 else {}),
                    },
                ),
            )
        ],
    )


@pytest.mark.asyncio
async def test_box_answers_its_live_sha1(accessor, index):
    await _listed(index, "0" * 40)
    with patch(
        "mirage.core.box.checksum.get_file_info",
        new_callable=AsyncMock,
        return_value={"id": "200", "sha1": "AB" * 20},
    ) as info:
        assert (
            await checksum(
                accessor, SCOPE, "sha1", (await index.get("/a.txt")).entry
            )
            == "ab" * 20
        )
    info.assert_awaited_once_with(accessor.token_manager, "200")


@pytest.mark.asyncio
@pytest.mark.parametrize("sha1", [None, ""])
async def test_box_without_a_sha1_reads(accessor, index, sha1):
    await _listed(index, None)
    with patch(
        "mirage.core.box.checksum.get_file_info",
        new_callable=AsyncMock,
        return_value={"id": "200", "sha1": sha1},
    ):
        assert (
            await checksum(
                accessor, SCOPE, "sha1", (await index.get("/a.txt")).entry
            )
            is None
        )


@pytest.mark.asyncio
async def test_box_keeps_no_md5(accessor, index):
    with patch(
        "mirage.core.box.checksum.get_file_info", new_callable=AsyncMock
    ) as info:
        assert (
            await checksum(
                accessor, SCOPE, "md5", (await index.get("/a.txt")).entry
            )
            is None
        )
    info.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "listed,token", [("ab" * 20, "ab" * 20), ("0" * 40, None)]
)
async def test_box_records_the_token_a_read_would(
    accessor, index, listed, token
):
    await _listed(index, listed)
    scope = RecordingScope()
    try:
        with patch(
            "mirage.core.box.checksum.get_file_info",
            new_callable=AsyncMock,
            return_value={"id": "200", "sha1": "AB" * 20},
        ):
            await checksum(
                accessor, SCOPE, "sha1", (await index.get("/a.txt")).entry
            )
    finally:
        scope.close()
    assert [(r.op, r.path, r.fingerprint) for r in scope.records] == [
        ("read", "/a.txt", token)
    ]
