# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import pytest

from mirage.core.lancedb.search import search_rows_output
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key


def _ps(path: str) -> PathSpec:
    return PathSpec(resource_path=mount_key(path, "/db"),
                    virtual=path,
                    directory=path)


@pytest.mark.asyncio
async def test_search_emits_canonical_path_with_score(accessor):
    out = (await search_rows_output(accessor,
                                    "a small white dog", [_ps("/db/animals")],
                                    top_k=2,
                                    threshold=0.0,
                                    mount_prefix="/db")).decode()
    first = out.splitlines()[0]
    assert first.startswith("/db/animals/dog/small/4.md:")


@pytest.mark.asyncio
async def test_search_body_matches_card(accessor):
    out = (await search_rows_output(accessor,
                                    "a small white dog", [_ps("/db/animals")],
                                    top_k=1,
                                    threshold=0.0,
                                    mount_prefix="/db")).decode()
    assert "# a small white dog" in out
    assert "label: dog" in out
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
