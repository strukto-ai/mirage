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

from mirage.vfs.gmail import GmailVFS
from mirage.workspace import Workspace
from tests.fixtures.vfs_io import vfs_over

LABELS = [{"id": "INBOX", "type": "system"}]

RAW_MESSAGE = {
    "id": "m1",
    "internalDate": "1754300000000",
    "payload": {
        "mimeType": "multipart/mixed",
        "headers": [{"name": "Subject", "value": "Report"}],
        "parts": [
            {"mimeType": "text/plain", "body": {"data": "text"}},
            {
                "filename": "report.pdf",
                "body": {"attachmentId": "att1", "size": 1024},
            },
        ],
    },
}


async def _run(line: str) -> list[str]:
    ws = Workspace({"/gmail/": vfs_over(GmailVFS, AsyncMock())})
    with (
        patch(
            "mirage.core.gmail.readdir.list_labels",
            new_callable=AsyncMock,
            return_value=LABELS,
        ),
        patch(
            "mirage.core.gmail.readdir.list_messages",
            new_callable=AsyncMock,
            return_value=[{"id": "m1"}],
        ),
        patch(
            "mirage.core.gmail.readdir.get_message_raw",
            new_callable=AsyncMock,
            return_value=RAW_MESSAGE,
        ),
    ):
        result = await ws.shell(line)
        data = await result.stdout_str()
    return [line.removeprefix("/gmail") for line in data.splitlines()]


@pytest.mark.asyncio
async def test_type_f_lists_attachments():
    lines = await _run("find /gmail -type f")
    assert "/INBOX/2025-08-04/Report__m1.gmail.json" in lines
    assert "/INBOX/2025-08-04/Report__m1/report.pdf" in lines
    assert "/INBOX/2025-08-04/Report__m1" not in lines


@pytest.mark.asyncio
async def test_type_d_lists_attachment_dir_not_attachment():
    lines = await _run("find /gmail -type d")
    assert "/INBOX/2025-08-04/Report__m1" in lines
    assert "/INBOX/2025-08-04/Report__m1/report.pdf" not in lines
