from unittest.mock import AsyncMock

import pytest
from qdrant_client.http.exceptions import ResponseHandlingException

import mirage.utils.record_search as record_search_mod
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.core.qdrant.search import files_containing
from mirage.core.qdrant.tree import TREE, readdir
from mirage.core.vector.search import search_rows_output
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key


async def _search(accessor, query: str, path: str, top_k: int = 1) -> str:
    spec = PathSpec(
        vfs_path=mount_key(path, "/db"), virtual=path, directory=path
    )
    out = await search_rows_output(
        TREE,
        accessor,
        query,
        [spec],
        top_k=top_k,
        threshold=0.0,
        mount_prefix="/db",
    )
    return "\n".join(out)


@pytest.mark.asyncio
async def test_search_emits_canonical_path_with_score(accessor):
    out = await _search(accessor, "a small white dog", "/db/animals", 2)
    assert out.splitlines()[0].startswith("/db/animals/dog/small/4.txt:")


@pytest.mark.asyncio
async def test_search_body_is_source_text(accessor):
    out = await _search(accessor, "a small white dog", "/db/animals")
    assert "a small white dog" in out
    assert "label:" not in out
    assert "score:" not in out


@pytest.mark.asyncio
async def test_search_emits_document_lineage_path_for_nested_payload(lineage):
    out = await _search(lineage, "refund", "/db")
    assert out.startswith("/db/refund-2026.pdf/004__1.txt:")


BLOBS = [
    "/db/animals/cat/big/1.png",
    "/db/animals/cat/small/2.png",
    "/db/animals/dog/big/3.png",
    "/db/animals/dog/small/4.png",
]


async def _containing(accessor, text: str, path: str = "/db"):
    spec = PathSpec(
        vfs_path=mount_key(path, "/db"), virtual=path, directory=path
    )
    found = await files_containing(
        readdir, accessor, text, [spec], RAMIndexCacheStore()
    )
    return None if found is None else sorted(p.virtual for p in found)


# The listing keeps each .json and .txt file's text, so a file is read only
# when its text holds the word in any case; a blob is always read.
@pytest.mark.asyncio
async def test_only_files_whose_text_holds_it_are_read(accessor):
    assert await _containing(accessor, "Orange") == sorted(
        [
            "/db/animals/cat/big/1.json",
            "/db/animals/cat/big/1.txt",
            *BLOBS,
        ]
    )
    assert await _containing(accessor, "kind", "/db/animals/dog") == [
        "/db/animals/dog/big/3.json",
        "/db/animals/dog/big/3.png",
        "/db/animals/dog/small/4.json",
        "/db/animals/dog/small/4.png",
    ]


@pytest.mark.asyncio
async def test_a_file_too_large_to_keep_is_read(accessor, monkeypatch):
    monkeypatch.setattr(record_search_mod, "KEPT_TEXT_MAX", 10)
    found = await _containing(accessor, "orange", "/db/animals/cat/small")
    assert found == [
        "/db/animals/cat/small/2.json",
        "/db/animals/cat/small/2.png",
        "/db/animals/cat/small/2.txt",
    ]


@pytest.mark.asyncio
async def test_a_text_that_is_not_ascii_reads_every_file(accessor):
    assert await _containing(accessor, "caf\u00e9") is None


async def _listed_then(accessor, change) -> list[str] | None:
    path = "/db/animals/cat/small"
    spec = PathSpec(
        vfs_path=mount_key(path, "/db"), virtual=path, directory=path
    )
    index = RAMIndexCacheStore()
    await readdir(accessor, spec, index)
    change(await accessor.client())
    found = await files_containing(readdir, accessor, "striped", [spec], index)
    return None if found is None else sorted(p.virtual for p in found)


SMALL_CAT = [
    "/db/animals/cat/small/2.json",
    "/db/animals/cat/small/2.png",
    "/db/animals/cat/small/2.txt",
]


def _striped(client) -> None:
    client.points[1].payload["name"] = "a small striped cat"


def _dropped(client) -> None:
    del client.points[1]


def _refused(client) -> None:
    client.scroll = AsyncMock(
        side_effect=ResponseHandlingException(OSError("reset"))
    )


# A read fetches the point as it is now, so the text is checked against a
# listing made for the search, not the one the walk cached.
@pytest.mark.asyncio
async def test_a_text_changed_since_the_listing_is_found(accessor):
    assert await _listed_then(accessor, _striped) == SMALL_CAT


@pytest.mark.asyncio
async def test_a_point_gone_since_the_listing_is_read(accessor):
    assert await _listed_then(accessor, _dropped) == SMALL_CAT


# A listing that fails leaves every file to a read.
@pytest.mark.asyncio
async def test_a_failed_listing_reads_every_file(accessor):
    assert await _listed_then(accessor, _refused) is None
