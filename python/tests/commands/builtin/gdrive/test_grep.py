from unittest.mock import AsyncMock, patch

import pytest

from mirage.accessor.gdrive import GDriveAccessor
from mirage.cache.index.config import IndexEntry
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.commands.builtin.gdrive import COMMANDS
from mirage.commands.config import CommandOpts
from mirage.commands.registry import CommandCatalog
from mirage.core.google.client import TokenManager
from mirage.core.google.config import GoogleConfig
from mirage.io.types import materialize
from mirage.types import PathSpec


@pytest.mark.asyncio
@pytest.mark.parametrize("kind,module", [("gdoc", "gdocs"),
                                         ("gsheet", "gsheets"),
                                         ("gslide", "gslides")])
async def test_grep_i_keeps_rendered_google_json(kind, module):
    config = GoogleConfig(client_id="test",
                          client_secret="test",
                          refresh_token="test")
    accessor = GDriveAccessor(config=config,
                              token_manager=TokenManager(config))
    index = RAMIndexCacheStore()
    name = f"Report.{kind}.json"
    path = PathSpec(virtual=f"/drive/{name}",
                    directory=f"/drive/{name}",
                    vfs_path=name,
                    resolved=True)
    await index.set_dir("/drive", [(path.virtual.rsplit("/", 1)[-1],
                                    IndexEntry(id="file1",
                                               name="Report",
                                               resource_type=f"gdrive/{kind}",
                                               vfs_name=name))])
    cmd = CommandCatalog(COMMANDS).require("grep")
    with patch(f"mirage.core.{module}.read.google_get",
               new=AsyncMock(return_value={"title": "needle\0tail"})):
        out, io = await cmd.fn(
            accessor, [path], ["needle"],
            CommandOpts(index=index, flags={"args_I": True}))
        data = await materialize(out)
    assert io.exit_code == 0
    assert b"needle" in data
    assert b"\0" not in data
    assert not io.stderr


@pytest.mark.asyncio
@pytest.mark.parametrize("flags,code", [({}, 0), ({
    "args_I": True
}, 1), ({
    "text": True
}, 0)])
async def test_grep_classifies_raw_drive_download(flags, code):
    config = GoogleConfig(client_id="test",
                          client_secret="test",
                          refresh_token="test")
    accessor = GDriveAccessor(config=config,
                              token_manager=TokenManager(config))
    index = RAMIndexCacheStore()
    path = PathSpec(virtual="/drive/report.pdf",
                    directory="/drive/report.pdf",
                    vfs_path="report.pdf",
                    resolved=True)
    await index.set_dir("/drive", [(path.virtual.rsplit("/", 1)[-1],
                                    IndexEntry(id="pdf1",
                                               name="report.pdf",
                                               resource_type="gdrive/file",
                                               vfs_name="report.pdf"))])
    cmd = CommandCatalog(COMMANDS).require("grep")
    with patch("mirage.core.gdrive.read.download_file",
               new=AsyncMock(return_value=b"needle\0tail\n")):
        out, io = await cmd.fn(accessor, [path], ["needle"],
                               CommandOpts(index=index, flags=flags))
        data = await materialize(out)
    assert io.exit_code == code
    assert data == (b"needle\0tail\n" if flags.get("text") else b"")
    assert bool(io.stderr) == (not flags)
