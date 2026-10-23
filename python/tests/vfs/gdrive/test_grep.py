from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch

import pytest

from mirage.accessor.gdrive import GDriveAccessor
from mirage.core.google.client import TokenManager
from mirage.core.google.config import GoogleConfig
from mirage.types import FileStat, FileType, MountMode
from mirage.vfs.gdrive import GoogleDriveConfig, GoogleDriveVFS
from mirage.workspace import Workspace


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "kind,module",
    [("gdoc", "gdocs"), ("gsheet", "gsheets"), ("gslide", "gslides")],
)
async def test_grep_i_keeps_rendered_google_json(kind, module):
    config = GoogleConfig(
        client_id="test", client_secret="test", refresh_token="test"
    )
    vfs = GoogleDriveVFS(
        config=GoogleDriveConfig(client_id="test", refresh_token="test")
    )
    vfs.accessor = GDriveAccessor(
        config=config, token_manager=TokenManager(config)
    )
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
                            "file_id": "file1",
                            "resource_type": f"gdrive/{kind}",
                        },
                    ),
                )
            ],
            datetime.now(timezone.utc) + timedelta(hours=1),
        )
        with patch(
            f"mirage.core.{module}.api.google_get",
            new=AsyncMock(return_value={"title": "needle\0tail"}),
        ):
            io = await ws.shell(f"grep -I needle /drive/{name}")
            data = io.stdout
        assert io.exit_code == 0
        assert b"needle" in data
        assert b"\0" not in data
        assert not io.stderr
    finally:
        await ws.close()
