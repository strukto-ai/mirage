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
import pytest_asyncio

from mirage.vfs.gmail import GmailVFS
from mirage.workspace import Workspace
from tests.fixtures.google_account import GoogleAccount
from tests.fixtures.vfs_io import vfs_over


@pytest_asyncio.fixture
async def report(google_account: GoogleAccount) -> str:
    """One message in INBOX, on 2025-08-04, with a PDF attached; its id."""
    await google_account.reset()
    return await google_account.message(
        "Report",
        "text",
        date="Mon, 4 Aug 2025 09:33:20 +0000",
        attachments=(("report.pdf", "application/pdf", b"%PDF-1.4"),),
    )


async def _run(account: GoogleAccount, line: str) -> list[str]:
    ws = Workspace({"/gmail/": vfs_over(GmailVFS, account.gmail_accessor())})
    result = await ws.shell(line)
    data = await result.stdout_str()
    return [line.removeprefix("/gmail") for line in data.splitlines()]


@pytest.mark.asyncio
async def test_type_f_lists_attachments(google_account, report):
    lines = await _run(google_account, "find /gmail -type f")
    assert f"/INBOX/2025-08-04/Report__{report}.gmail.json" in lines
    assert f"/INBOX/2025-08-04/Report__{report}/report.pdf" in lines
    assert f"/INBOX/2025-08-04/Report__{report}" not in lines


@pytest.mark.asyncio
async def test_type_d_lists_attachment_dir_not_attachment(
    google_account, report
):
    lines = await _run(google_account, "find /gmail -type d")
    assert f"/INBOX/2025-08-04/Report__{report}" in lines
    assert f"/INBOX/2025-08-04/Report__{report}/report.pdf" not in lines
