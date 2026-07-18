import pytest

from mirage.commands.builtin.databricks_volume.io import resolve_glob
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key
from tests.core.databricks_volume.conftest import file_entry


@pytest.mark.asyncio
async def test_resolve_file_path(accessor, index):
    scope = PathSpec.from_str_path("/volume/readme.md",
                                   mount_key("/volume/readme.md", "/volume"))
    result = await resolve_glob(accessor, [scope], index)
    assert result == [scope]


@pytest.mark.asyncio
async def test_resolve_glob_pattern(accessor, files, index, remote_root):
    files.directories[f"{remote_root}/src"] = [
        file_entry(f"{remote_root}/src/main.py"),
        file_entry(f"{remote_root}/src/util.py"),
        file_entry(f"{remote_root}/src/data.json"),
    ]
    scope = PathSpec(
        resource_path=mount_key("/volume/src/*.py", "/volume"),
        virtual="/volume/src/*.py",
        directory="/volume/src",
        pattern="*.py",
        resolved=False,
    )
    result = await resolve_glob(accessor, [scope], index)
    originals = sorted(path.virtual for path in result)
    assert originals == ["/volume/src/main.py", "/volume/src/util.py"]


@pytest.mark.asyncio
async def test_resolve_directory_path(accessor, index):
    scope = PathSpec(
        resource_path=mount_key("/volume/src", "/volume"),
        virtual="/volume/src",
        directory="/volume/src",
        resolved=False,
    )
    result = await resolve_glob(accessor, [scope], index)
    assert result == [scope]
