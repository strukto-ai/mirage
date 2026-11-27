from datetime import datetime, timedelta, timezone

import pytest

from mirage.types import FileStat, FileType, MountMode
from mirage.vfs.gdrive import GoogleDriveConfig, GoogleDriveVFS
from mirage.workspace import Workspace

MIMES = {
    "gdoc": "application/vnd.google-apps.document",
    "gsheet": "application/vnd.google-apps.spreadsheet",
    "gslide": "application/vnd.google-apps.presentation",
}


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["gdoc", "gsheet", "gslide"])
async def test_grep_i_keeps_rendered_google_json(google_account, kind):
    # A title holding a NUL: the rendered JSON escapes it, so the file is
    # text to grep -I, and the raw byte never reaches the output.
    made = await google_account.create("needle\0tail", MIMES[kind])
    vfs = GoogleDriveVFS(config=google_account.config(GoogleDriveConfig))
    ws = Workspace({"/drive/": vfs}, mode=MountMode.READ)
    name = f"Report.{kind}.json"
    try:
        await ws.mount("/drive/").index_store.set_dir(
            "/drive",
            [
                (
                    name,
                    FileStat(
                        name=name,
                        type=FileType.FILE,
                        extra={
                            "file_id": made,
                            "resource_type": f"gdrive/{kind}",
                        },
                    ),
                )
            ],
            datetime.now(timezone.utc) + timedelta(hours=1),
        )
        io = await ws.shell(f"grep -I needle /drive/{name}")
        data = io.stdout
        assert io.exit_code == 0
        assert b"needle" in data
        assert b"\0" not in data
        assert not io.stderr
    finally:
        await ws.close()
