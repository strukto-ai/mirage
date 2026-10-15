import pytest

from mirage.core.dify import tree
from mirage.types import ContentType, FileType, PathSpec
from mirage.utils.key_prefix import mount_key
from mirage.vfs.dify import DifyVFS
from tests.fixtures.mounted import Mounted

from .conftest import document


async def list_documents(config):
    return [document("doc-1", "Quickstart", slug="guides/quickstart")]


@pytest.fixture(autouse=True)
def documents(monkeypatch):
    monkeypatch.setattr(tree, "list_all_documents", list_documents)


@pytest.mark.asyncio
async def test_stat_answers_from_the_listing(dify_accessor, guide_path):
    item = await Mounted(DifyVFS, dify_accessor, "/knowledge").stat(guide_path)

    assert item.name == "quickstart"
    assert item.content == ContentType.TEXT
    assert item.size is None
    assert item.extra["document_id"] == "doc-1"
    assert item.extra["source_size"] == 123
    assert item.modified == "2024-05-21T09:00:00Z"
    assert item.birthtime == "2024-05-21T09:00:00Z"
    assert item.extra["slug"] == "guides/quickstart"


@pytest.mark.asyncio
async def test_stat_of_a_directory(dify_accessor):
    guides = PathSpec.from_str_path(
        "/knowledge/guides", mount_key("/knowledge/guides", "/knowledge")
    )

    item = await Mounted(DifyVFS, dify_accessor, "/knowledge").stat(guides)

    assert item.name == "guides"
    assert item.type == FileType.DIRECTORY
