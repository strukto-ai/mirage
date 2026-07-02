import pytest

from mirage.core.chroma import search
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key


@pytest.mark.asyncio
async def test_search_segments_scopes_folder_to_candidate_slugs(
        chroma_accessor, chroma_index):
    result = await search.search_segments(
        chroma_accessor,
        "setup",
        [
            PathSpec(resource_path=mount_key("/knowledge/guides",
                                             "/knowledge"),
                     virtual="/knowledge/guides",
                     directory="/knowledge/guides")
        ],
        chroma_index,
        top_k=3,
    )

    assert result == b"/knowledge/guides/quickstart:0.90\nquickstart chunk\n"
    assert chroma_accessor.collection.queries[0]["where"] == {
        "page_slug": {
            "$in": ["guides/quickstart"]
        }
    }
    assert chroma_accessor.collection.queries[0]["query_texts"] == ["setup"]
    assert chroma_accessor.collection.queries[0]["n_results"] == 3


@pytest.mark.asyncio
async def test_search_segments_empty_paths_searches_collection(
        chroma_accessor, chroma_index):
    result = await search.search_segments(chroma_accessor,
                                          "setup", [],
                                          chroma_index,
                                          mount_prefix="/knowledge/")

    assert result == (b"/knowledge/guides/quickstart:0.90\nquickstart chunk\n"
                      b"/knowledge/api/reference:0.75\napi chunk\n")
    assert "where" not in chroma_accessor.collection.queries[0]


def test_validate_args():
    with pytest.raises(ValueError, match="query is required"):
        search.validate_args("", 10)
    with pytest.raises(ValueError, match="top-k must be positive"):
        search.validate_args("docs", 0)
