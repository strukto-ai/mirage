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

from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.commands.builtin.gmail import COMMANDS
from mirage.types import PathSpec

LABELS = [{"id": "INBOX", "type": "system"}]

RAW_MESSAGE = {
    "id": "m1",
    "internalDate": "1754300000000",
    "payload": {
        "mimeType":
        "multipart/mixed",
        "headers": [{
            "name": "Subject",
            "value": "Report"
        }],
        "parts": [
            {
                "mimeType": "text/plain",
                "body": {
                    "data": "text"
                }
            },
            {
                "filename": "report.pdf",
                "body": {
                    "attachmentId": "att1",
                    "size": 1024
                },
            },
        ],
    },
}


def _find_command():
    for fn in COMMANDS:
        for rc in getattr(fn, "_registered_commands", []):
            if rc.name == "find" and rc.filetype is None:
                return fn
    raise AssertionError("factory find not registered for gmail")


def _spec(virtual: str) -> PathSpec:
    return PathSpec(virtual=virtual,
                    directory=virtual,
                    resource_path=virtual.strip("/"))


async def _run(paths, *texts: str, **flags) -> list[str]:
    find = _find_command()
    with patch("mirage.core.gmail.readdir.list_labels",
               new_callable=AsyncMock,
               return_value=LABELS), \
         patch("mirage.core.gmail.readdir.list_messages",
               new_callable=AsyncMock,
               return_value=[{"id": "m1"}]), \
         patch("mirage.core.gmail.readdir.get_message_raw",
               new_callable=AsyncMock,
               return_value=RAW_MESSAGE):
        stdout, _io = await find(AsyncMock(),
                                 paths,
                                 *texts,
                                 index=RAMIndexCacheStore(),
                                 **flags)
    data = stdout if isinstance(stdout, bytes) else b""
    return data.decode().splitlines()


@pytest.mark.asyncio
async def test_type_f_lists_attachments():
    lines = await _run([_spec("/")], type="f")
    assert "/INBOX/2025-08-04/Report__m1.gmail.json" in lines
    assert "/INBOX/2025-08-04/Report__m1/report.pdf" in lines
    assert "/INBOX/2025-08-04/Report__m1" not in lines


@pytest.mark.asyncio
async def test_type_d_lists_attachment_dir_not_attachment():
    lines = await _run([_spec("/")], type="d")
    assert "/INBOX/2025-08-04/Report__m1" in lines
    assert "/INBOX/2025-08-04/Report__m1/report.pdf" not in lines
