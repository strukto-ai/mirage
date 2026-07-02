import pytest

from mirage.core.qdrant.stat import stat
from mirage.types import FileType, PathSpec


def _ps(path: str) -> PathSpec:
    return PathSpec(virtual=path,
                    directory=path,
                    resource_path=path.strip("/"))


@pytest.mark.asyncio
async def test_stat_group_dir_is_directory(accessor):
    s = await stat(accessor, _ps("/animals/cat"))
    assert s.type == FileType.DIRECTORY
    assert s.name == "cat"


@pytest.mark.asyncio
async def test_stat_json_is_text_with_size(accessor):
    s = await stat(accessor, _ps("/animals/cat/big/1.json"))
    assert s.type == FileType.TEXT
    assert s.size and s.size > 0


@pytest.mark.asyncio
async def test_stat_txt_is_text_with_size(accessor):
    s = await stat(accessor, _ps("/animals/cat/big/1.txt"))
    assert s.type == FileType.TEXT
    assert s.size and s.size > 0


@pytest.mark.asyncio
async def test_stat_blob_is_image(accessor):
    s = await stat(accessor, _ps("/animals/cat/big/1.png"))
    assert s.type == FileType.IMAGE_PNG
    assert s.size == len(b"PNG-1")


@pytest.mark.asyncio
async def test_stat_unknown_raises(accessor):
    with pytest.raises(FileNotFoundError):
        await stat(accessor, _ps("/animals/cat/big/1.weird/x"))
