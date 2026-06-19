import pytest
from pydantic import SecretStr

from mirage.accessor.onedrive import OneDriveAccessor, OneDriveConfig
from mirage.cache.index.config import IndexEntry
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.commands.builtin.onedrive.ls import ls
from mirage.io.types import materialize
from mirage.types import PathSpec


@pytest.fixture
def accessor():
    return OneDriveAccessor(
        OneDriveConfig(access_token=SecretStr("test-token")))


@pytest.fixture
def index():
    return RAMIndexCacheStore()


@pytest.mark.asyncio
async def test_ls_lists_cached_onedrive_entries(accessor, index):
    await index.set_dir(
        "/",
        [("file.txt",
          IndexEntry(id="file-id", name="file.txt", resource_type="file"))],
    )

    stdout, io = await ls(accessor, [PathSpec(original="/", directory="/")],
                          index=index)

    assert await materialize(stdout) == b"file.txt\n"
    assert io.exit_code == 0
