from unittest.mock import AsyncMock

import pytest

from mirage.core.slug_tree.rows import dir_rows
from mirage.core.slug_tree.tree import SlugTree
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.key_prefix import mount_key
from mirage.utils.path import gnu_basename

FILES = {"/guides/quickstart": 5, "/api/reference": 3}


def spec(virtual: str) -> PathSpec:
    return PathSpec.from_str_path(virtual, mount_key(virtual, "/knowledge"))


def file_row(path: str, size: int) -> FileStat:
    return FileStat(
        name=gnu_basename(path),
        type=FileType.FILE,
        size=size,
        extra={"slug": path.strip("/")},
    )


async def load_rows(accessor):
    return dir_rows(FILES, file_row)


@pytest.fixture
def load() -> AsyncMock:
    return AsyncMock(wraps=load_rows)


@pytest.fixture
def tree(load) -> SlugTree:
    return SlugTree(load)
