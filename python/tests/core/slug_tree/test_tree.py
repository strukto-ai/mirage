import pytest

from mirage.core.slug_tree.tree import tree_key
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key

from .conftest import spec


def _names(listing) -> list[str]:
    return [row.name for row in listing.entries]


def test_tree_key_honors_prefix_and_patterns():
    assert (
        tree_key(spec("/knowledge/guides/quickstart")) == "/guides/quickstart"
    )
    assert tree_key(spec("/knowledge")) == "/"
    assert (
        tree_key(
            PathSpec(
                vfs_path="guides/quickstart",
                virtual="/guides/quickstart",
                directory="/guides",
            )
        )
        == "/guides/quickstart"
    )
    assert (
        tree_key(
            PathSpec(
                vfs_path=mount_key("/knowledge/guides/*.md", "/knowledge"),
                virtual="/knowledge/guides/*.md",
                directory="/knowledge/guides",
                pattern="*.md",
            )
        )
        == "/guides"
    )


@pytest.mark.asyncio
async def test_readdir_lists_folders_and_refuses_the_rest(tree):
    assert _names(await tree.readdir(None, spec("/knowledge"))) == [
        "api",
        "guides",
    ]
    assert _names(await tree.readdir(None, spec("/knowledge/guides"))) == [
        "quickstart"
    ]
    with pytest.raises(NotADirectoryError):
        await tree.readdir(None, spec("/knowledge/guides/quickstart"))
    with pytest.raises(FileNotFoundError):
        await tree.readdir(None, spec("/knowledge/nope"))


@pytest.mark.asyncio
async def test_one_fetch_seeds_every_folder_below(tree, load):
    listing = await tree.readdir(None, spec("/knowledge"))

    assert load.await_count == 1
    assert {
        key: [row.name for row in rows] for key, rows in listing.seeds.items()
    } == {
        "api": ["reference"],
        "guides": ["quickstart"],
    }
