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

from mirage.accessor.base import NOOPAccessor
from mirage.commands.builtin.generic_bind.adapter import make_resolve_glob
from mirage.types import PathSpec

TREE = {
    "/notion/pages": [
        "/notion/pages/Demo_page__uuid1",
        "/notion/pages/Roadmap__uuid2",
    ],
    "/notion/pages/Demo_page__uuid1": [
        "/notion/pages/Demo_page__uuid1/page.md",
        "/notion/pages/Demo_page__uuid1/page.json",
    ],
    "/notion/pages/Roadmap__uuid2": [
        "/notion/pages/Roadmap__uuid2/page.json",
    ],
}


async def fake_readdir(accessor, path, index=None):
    key = path.virtual.rstrip("/") or "/"
    if key not in TREE:
        raise FileNotFoundError(key)
    return TREE[key]


def glob_spec(virtual: str, prefix: str) -> PathSpec:
    last_slash = virtual.rfind("/")
    return PathSpec(
        virtual=virtual,
        directory=virtual[:last_slash + 1],
        resource_path=virtual[len(prefix):].strip("/"),
        pattern=virtual[last_slash + 1:],
        resolved=False,
    )


@pytest.mark.asyncio
async def test_resolve_glob_mid_path_pattern():
    resolve = make_resolve_glob(fake_readdir)
    spec = glob_spec("/notion/pages/Demo_page__*/page.md", "/notion")
    result = await resolve(NOOPAccessor(), [spec], None)
    assert [p.virtual
            for p in result] == ["/notion/pages/Demo_page__uuid1/page.md"]


@pytest.mark.asyncio
async def test_resolve_glob_last_component():
    resolve = make_resolve_glob(fake_readdir)
    spec = glob_spec("/notion/pages/Demo*", "/notion")
    result = await resolve(NOOPAccessor(), [spec], None)
    assert [p.virtual for p in result] == ["/notion/pages/Demo_page__uuid1"]


@pytest.mark.asyncio
async def test_resolve_glob_passthrough():
    resolve = make_resolve_glob(fake_readdir)
    resolved_spec = PathSpec.from_str_path("/notion/pages/Roadmap__uuid2",
                                           "pages/Roadmap__uuid2")
    result = await resolve(NOOPAccessor(), [resolved_spec], None)
    assert result[0] is resolved_spec


@pytest.mark.asyncio
async def test_resolve_glob_truncates(caplog):
    resolve = make_resolve_glob(fake_readdir, max_glob_matches=1)
    spec = glob_spec("/notion/pages/*", "/notion")
    result = await resolve(NOOPAccessor(), [spec], None)
    assert len(result) == 1


@pytest.mark.asyncio
async def test_resolve_glob_zero_match_word_keeps_literal():
    resolve = make_resolve_glob(fake_readdir)
    spec = glob_spec("/notion/pages/*.nope", "/notion")
    out = await resolve(NOOPAccessor(), [spec], None)
    assert len(out) == 1
    assert out[0].virtual == "/notion/pages/*.nope"
    assert out[0].pattern is None
    assert out[0].resolved


@pytest.mark.asyncio
async def test_resolve_glob_zero_match_dir_shape_stays_empty():
    resolve = make_resolve_glob(fake_readdir)
    spec = glob_spec("/notion/pages/*.nope", "/notion").dir
    out = await resolve(NOOPAccessor(), [spec], None)
    assert out == []
