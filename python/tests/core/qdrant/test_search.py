import pytest

from mirage.commands.builtin.utils.output import format_records
from mirage.core.qdrant.tree import TREE
from mirage.core.vector.search import search_results
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key


async def _search(accessor, query: str, path: str, top_k: int = 1) -> str:
    spec = PathSpec(
        vfs_path=mount_key(path, "/db"), virtual=path, directory=path
    )
    out = await search_results(
        TREE,
        accessor,
        query,
        [spec],
        top_k=top_k,
        threshold=0.0,
        mount_prefix="/db",
    )
    return format_records([text for _, text in out]).decode()


@pytest.mark.asyncio
async def test_search_emits_canonical_path_with_score(accessor):
    out = await _search(accessor, "a small white dog", "/db/animals", 2)
    assert out.splitlines()[0].startswith("/db/animals/dog/small/4.txt:")


@pytest.mark.asyncio
async def test_search_body_is_source_text(accessor):
    out = await _search(accessor, "a small white dog", "/db/animals")
    assert "a small white dog" in format_records([text for _, text in out])
    assert "label:" not in format_records([text for _, text in out])
    assert "score:" not in format_records([text for _, text in out])


@pytest.mark.asyncio
async def test_search_emits_document_lineage_path_for_nested_payload(lineage):
    out = await _search(lineage, "refund", "/db")
    assert out.startswith("/db/refund-2026.pdf/004__1.txt:")
