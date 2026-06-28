import pytest

from mirage.core.qdrant.search import search_rows_output
from mirage.types import PathSpec


def _ps(path: str) -> PathSpec:
    return PathSpec(original=path, directory=path, prefix="/db")


@pytest.mark.asyncio
async def test_search_emits_canonical_path_with_score(accessor):
    out = (await search_rows_output(accessor,
                                    "a small white dog", [_ps("/db/animals")],
                                    top_k=2,
                                    threshold=0.0,
                                    mount_prefix="/db")).decode()
    first = out.splitlines()[0]
    assert first.startswith("/db/animals/dog/small/4.txt:")


@pytest.mark.asyncio
async def test_search_body_is_source_text(accessor):
    out = (await search_rows_output(accessor,
                                    "a small white dog", [_ps("/db/animals")],
                                    top_k=1,
                                    threshold=0.0,
                                    mount_prefix="/db")).decode()
    assert "a small white dog" in out
    assert "label:" not in out
    assert "score:" not in out


@pytest.mark.asyncio
async def test_search_top_k_limits_results(accessor):
    out = (await search_rows_output(accessor,
                                    "a small white dog", [_ps("/db/animals")],
                                    top_k=1,
                                    threshold=0.0,
                                    mount_prefix="/db")).decode()
    headers = [ln for ln in out.splitlines() if ln.startswith("/db/")]
    assert len(headers) == 1


@pytest.mark.asyncio
async def test_search_empty_query_raises(accessor):
    with pytest.raises(ValueError):
        await search_rows_output(accessor,
                                 "", [_ps("/db/animals")],
                                 top_k=2,
                                 threshold=0.0,
                                 mount_prefix="/db")
