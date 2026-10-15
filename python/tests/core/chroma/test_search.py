import pytest

from mirage.core.chroma import search
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key


@pytest.mark.asyncio
async def test_search_segments_scopes_folder_to_candidate_slugs(
    chroma_accessor,
):
    result = await search.search_segments(
        chroma_accessor,
        "setup",
        [
            PathSpec(
                vfs_path=mount_key("/knowledge/guides", "/knowledge"),
                virtual="/knowledge/guides",
                directory="/knowledge/guides",
            )
        ],
        top_k=3,
    )

    assert result == [
        (
            "/knowledge/guides/quickstart",
            "/knowledge/guides/quickstart:0.90\nquickstart chunk",
        )
    ]
    assert chroma_accessor.collection.queries[0]["where"] == {
        "page_slug": {"$in": ["guides/quickstart"]}
    }
    assert chroma_accessor.collection.queries[0]["query_texts"] == ["setup"]
    assert chroma_accessor.collection.queries[0]["n_results"] == 3


@pytest.mark.asyncio
async def test_search_segments_empty_paths_searches_collection(
    chroma_accessor,
):
    result = await search.search_segments(
        chroma_accessor, "setup", [], mount_prefix="/knowledge/"
    )

    assert result == [
        (
            "/knowledge/guides/quickstart",
            "/knowledge/guides/quickstart:0.90\nquickstart chunk",
        ),
        (
            "/knowledge/api/reference",
            "/knowledge/api/reference:0.75\napi chunk",
        ),
    ]
    assert "where" not in chroma_accessor.collection.queries[0]


# A page is its chunks joined by line breaks, so a chunk holding the text
# is the page holding it; Chroma matches case, so -i asks nothing.
@pytest.mark.asyncio
async def test_files_containing_names_the_pages_a_chunk_holds_text_in(
    chroma_accessor,
):
    under = [
        PathSpec(vfs_path="", virtual="/knowledge", directory="/knowledge")
    ]
    out = await search.files_containing(chroma_accessor, "first", under, False)
    assert out is not None
    assert [p.virtual for p in out] == ["/knowledge/guides/quickstart"]
    assert chroma_accessor.collection.get_calls[-1]["where_document"] == {
        "$contains": "first"
    }
    assert (
        await search.files_containing(chroma_accessor, "nowhere", under, False)
        == []
    )
    assert (
        await search.files_containing(chroma_accessor, "first", under, True)
        is None
    )


@pytest.mark.asyncio
async def test_files_containing_asks_only_the_walked_pages_below_the_root(
    chroma_accessor,
):
    under = [
        PathSpec.from_str_path(
            "/knowledge/api", mount_key("/knowledge/api", "/knowledge")
        )
    ]
    assert (
        await search.files_containing(chroma_accessor, "first", under, False)
        == []
    )
    assert chroma_accessor.collection.get_calls[-1]["where"] == {
        "page_slug": {"$in": ["api/reference"]}
    }
