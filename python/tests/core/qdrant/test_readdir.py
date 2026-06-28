import pytest

from mirage.core.qdrant.readdir import is_dir_name, readdir
from mirage.resource.qdrant.config import QdrantConfig
from mirage.types import PathSpec


def _ps(path: str) -> PathSpec:
    return PathSpec(original=path, directory=path)


def _names(paths: list[str]) -> set[str]:
    return {p.rsplit("/", 1)[-1] for p in paths}


@pytest.mark.asyncio
async def test_root_lists_collection(accessor):
    out = await readdir(accessor, _ps("/"))
    assert _names(out) == {"animals"}


@pytest.mark.asyncio
async def test_collection_lists_groups(accessor):
    out = await readdir(accessor, _ps("/animals"))
    assert _names(out) == {"cat", "dog"}


@pytest.mark.asyncio
async def test_group_lists_next_level(accessor):
    out = await readdir(accessor, _ps("/animals/cat"))
    assert _names(out) == {"big", "small"}


@pytest.mark.asyncio
async def test_leaf_lists_row_files(accessor):
    out = await readdir(accessor, _ps("/animals/cat/big"))
    assert _names(out) == {"1.json", "1.txt", "1.png"}


def test_is_dir_name_classifies_row_files():
    cfg = QdrantConfig(text_field="name", blob_field="img", blob_ext="png")
    assert is_dir_name("/animals/cat", config=cfg) is True
    assert is_dir_name("/animals/cat/big/1.json", config=cfg) is False
    assert is_dir_name("/animals/cat/big/1.txt", config=cfg) is False
    assert is_dir_name("/animals/cat/big/1.png", config=cfg) is False
    no_extra = QdrantConfig()
    assert is_dir_name("/animals/cat/big/1.png", config=no_extra) is True
    assert is_dir_name("/animals/cat/big/1.txt", config=no_extra) is True
    assert is_dir_name("/animals/cat/big/1.json", config=no_extra) is False
