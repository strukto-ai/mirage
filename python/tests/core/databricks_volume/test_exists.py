import pytest

from mirage.core.databricks_volume.exists import exists
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key

from .conftest import file_metadata


@pytest.mark.asyncio
async def test_exists_true_for_file(accessor, files, remote_root):
    files.metadata[f"{remote_root}/reports/latest.md"] = file_metadata(size=6)
    path = PathSpec.from_str_path(
        "/volume/reports/latest.md",
        mount_key("/volume/reports/latest.md", "/volume"))
    assert await exists(accessor, path) is True


@pytest.mark.asyncio
async def test_exists_false_for_missing_path(accessor):
    path = PathSpec.from_str_path("/volume/missing.md",
                                  mount_key("/volume/missing.md", "/volume"))
    assert await exists(accessor, path) is False
