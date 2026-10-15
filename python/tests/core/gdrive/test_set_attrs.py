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

from mirage.core.gdrive.set_attrs import set_attrs
from mirage.types import FileStat, FileType, PathSpec

MTIME = "2020-01-01T00:00:00+00:00"
ROW = FileStat(name="a.txt", type=FileType.FILE, extra={"file_id": "f1"})


@pytest.mark.parametrize(
    ("path", "sent", "residual"),
    [
        ("/a.txt", [{"modifiedTime": "2020-01-01T00:00:00Z"}], {"uid": 7}),
        ("/", [], {"uid": 7, "mtime": MTIME}),
    ],
)
@pytest.mark.asyncio
async def test_an_mtime_becomes_the_modified_time(
    gdrive_accessor, path, sent, residual
):
    with patch(
        "mirage.core.gdrive.set_attrs.patch_file", new_callable=AsyncMock
    ) as patched:
        got = await set_attrs(
            gdrive_accessor,
            PathSpec.from_str_path(path),
            None if path == "/" else ROW,
            uid=7,
            mtime=MTIME,
        )
    assert [call.args[1] for call in patched.await_args_list] == (
        ["f1"] if sent else []
    )
    assert [call.args[2] for call in patched.await_args_list] == sent
    assert got == residual
