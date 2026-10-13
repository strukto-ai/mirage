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

from mirage.accessor.ram import RAMAccessor
from mirage.core.dev.pipe import DevicePipe
from mirage.core.dev.stat import stat
from mirage.types import FileType, PathSpec
from mirage.vfs.dev.store import DevFiles, DevStore

FD = PathSpec(vfs_path="fd/63", virtual="/dev/fd/63", directory="/dev/fd/")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "attrs,modified,expected",
    [
        ({}, None, (0o600, None, None, None, None)),
        (
            {
                "mode": 0o640,
                "uid": 7,
                "gid": 8,
                "atime": "2020-01-02T03:04:05Z",
            },
            "2020-01-02T03:04:06Z",
            (0o640, 7, 8, "2020-01-02T03:04:05Z", "2020-01-02T03:04:06Z"),
        ),
    ],
)
async def test_fifo_reports_its_stored_attrs(attrs, modified, expected):
    store = DevStore(DevFiles("owner"))
    store.files.allocate_input(DevicePipe(True))
    store.attrs["/fd/63"] = attrs
    if modified is not None:
        store.modified["/fd/63"] = modified
    s = await stat(RAMAccessor(store), FD)
    assert (s.name, s.type, s.size) == ("63", FileType.FIFO, None)
    assert (s.mode, s.uid, s.gid, s.atime, s.modified) == expected
