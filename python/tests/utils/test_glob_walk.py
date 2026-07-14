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

import dataclasses

import pytest

from mirage.accessor.base import NOOPAccessor
from mirage.types import PathSpec
from mirage.utils.glob_walk import (expand_pattern, has_glob, is_word_shaped,
                                    resolve_glob_with, spell_match)

TREE = {
    "/notion": ["/notion/pages", "/notion/databases"],
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
    "/": ["/alpha", "/beta.txt"],
    "/alpha": ["/alpha/b.txt"],
}

CALLS: list[str] = []


async def fake_readdir(accessor, path, index=None):
    CALLS.append(path.virtual)
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


@pytest.fixture(autouse=True)
def clear_calls():
    CALLS.clear()


def test_has_glob():
    assert has_glob("Demo_*")
    assert has_glob("x?")
    assert has_glob("[ab]")
    assert not has_glob("page.md")


@pytest.mark.asyncio
async def test_mid_path_glob_never_lists_pattern_dir():
    spec = glob_spec("/notion/pages/Demo_page__*/page.md", "/notion")
    matched = await expand_pattern(fake_readdir, NOOPAccessor(), spec, None)
    assert [m.virtual
            for m in matched] == ["/notion/pages/Demo_page__uuid1/page.md"]
    assert matched[0].resource_path == "pages/Demo_page__uuid1/page.md"
    assert all("*" not in c for c in CALLS)


@pytest.mark.asyncio
async def test_last_component_glob():
    spec = glob_spec("/notion/pages/Demo*", "/notion")
    matched = await expand_pattern(fake_readdir, NOOPAccessor(), spec, None)
    assert [m.virtual for m in matched] == ["/notion/pages/Demo_page__uuid1"]
    assert matched[0].resolved


@pytest.mark.asyncio
async def test_multiple_glob_segments():
    spec = glob_spec("/notion/pages/*__uuid*/page.json", "/notion")
    matched = await expand_pattern(fake_readdir, NOOPAccessor(), spec, None)
    assert [m.virtual for m in matched] == [
        "/notion/pages/Demo_page__uuid1/page.json",
        "/notion/pages/Roadmap__uuid2/page.json",
    ]


@pytest.mark.asyncio
async def test_zero_match_returns_empty():
    spec = glob_spec("/notion/pages/Missing__*/page.md", "/notion")
    matched = await expand_pattern(fake_readdir, NOOPAccessor(), spec, None)
    assert matched == []


@pytest.mark.asyncio
async def test_non_directory_intermediate_skipped():
    spec = glob_spec("/*/b.txt", "")
    matched = await expand_pattern(fake_readdir, NOOPAccessor(), spec, None)
    assert [m.virtual for m in matched] == ["/alpha/b.txt"]


@pytest.mark.asyncio
async def test_directory_shaped_spec():
    spec = PathSpec(
        virtual="/notion/pages/",
        directory="/notion/pages/",
        resource_path="pages",
        pattern="Demo*",
        resolved=False,
    )
    matched = await expand_pattern(fake_readdir, NOOPAccessor(), spec, None)
    assert [m.virtual for m in matched] == ["/notion/pages/Demo_page__uuid1"]


@pytest.mark.asyncio
async def test_root_mount_glob():
    spec = glob_spec("/a*", "")
    matched = await expand_pattern(fake_readdir, NOOPAccessor(), spec, None)
    assert [m.virtual for m in matched] == ["/alpha"]
    assert matched[0].resource_path == "alpha"


def test_spell_match_relative_midpath():
    assert spell_match("s*/x.txt", "/data/sub/x.txt", 2) == "sub/x.txt"


def test_spell_match_keeps_typed_head():
    assert spell_match("./sub/*.txt", "/data/sub/a.txt", 1) == "./sub/a.txt"
    assert spell_match("../s*/x.txt", "/data/sub/x.txt", 2) == "../sub/x.txt"


def test_spell_match_bare_and_absolute():
    assert spell_match("*.txt", "/data/a.txt", 1) == "a.txt"
    assert spell_match("/data/s*/x.txt", "/data/sub/x.txt",
                       2) == "/data/sub/x.txt"


def test_is_word_shaped():
    word = glob_spec("/data/s*/x.txt", "")
    assert is_word_shaped(word)
    assert not is_word_shaped(word.dir)


@pytest.mark.asyncio
async def test_matches_spelled_from_typed_word():
    spec = glob_spec("/alpha/*.txt", "")
    typed = dataclasses.replace(spec, raw_path="alpha/*.txt")
    matched = await expand_pattern(fake_readdir, NOOPAccessor(), typed, None)
    assert [m.raw_path for m in matched] == ["alpha/b.txt"]
    assert [m.virtual for m in matched] == ["/alpha/b.txt"]


@pytest.mark.asyncio
async def test_dir_shaped_matches_keep_virtual():
    spec = glob_spec("/alpha/*.txt", "").dir
    matched = await expand_pattern(fake_readdir, NOOPAccessor(), spec, None)
    assert [m.raw_path for m in matched] == ["/alpha/b.txt"]


@pytest.mark.asyncio
async def test_resolve_glob_with_passes_resolved_through():
    spec = PathSpec.from_str_path("/alpha/b.txt", "alpha/b.txt")
    result = await resolve_glob_with(fake_readdir, NOOPAccessor(), [spec],
                                     None)
    assert result == [spec]
    assert CALLS == []


@pytest.mark.asyncio
async def test_resolve_glob_with_expands_pattern():
    spec = glob_spec("/alpha/*.txt", "")
    result = await resolve_glob_with(fake_readdir, NOOPAccessor(), [spec],
                                     None)
    assert [p.virtual for p in result] == ["/alpha/b.txt"]
    assert result[0].resolved


@pytest.mark.asyncio
async def test_resolve_glob_with_expands_mid_path_pattern():
    spec = glob_spec("/notion/pages/Demo_page__*/page.md", "/notion")
    result = await resolve_glob_with(fake_readdir, NOOPAccessor(), [spec],
                                     None)
    assert [p.virtual
            for p in result] == ["/notion/pages/Demo_page__uuid1/page.md"]
    assert all("*" not in c for c in CALLS)


@pytest.mark.asyncio
async def test_resolve_glob_with_unmatched_word_stays_literal():
    spec = glob_spec("/notion/pages/Missing__*/page.md", "/notion")
    result = await resolve_glob_with(fake_readdir, NOOPAccessor(), [spec],
                                     None)
    assert len(result) == 1
    assert result[0].virtual == "/notion/pages/Missing__*/page.md"
    assert result[0].resolved
    assert result[0].pattern is None


@pytest.mark.asyncio
async def test_resolve_glob_with_unmatched_dir_shaped_dropped():
    spec = PathSpec(
        virtual="/notion/pages/",
        directory="/notion/pages/",
        resource_path="pages",
        pattern="Missing*",
        resolved=False,
    )
    result = await resolve_glob_with(fake_readdir, NOOPAccessor(), [spec],
                                     None)
    assert result == []


@pytest.mark.asyncio
async def test_resolve_glob_with_cap_truncates_and_warns(caplog):
    spec = glob_spec("/notion/pages/*", "/notion")
    with caplog.at_level("WARNING"):
        result = await resolve_glob_with(fake_readdir, NOOPAccessor(), [spec],
                                         None, 1)
    assert [p.virtual for p in result] == ["/notion/pages/Demo_page__uuid1"]
    assert "exceeds limit" in caplog.text


@pytest.mark.asyncio
async def test_resolve_glob_with_no_cap_keeps_all_matches():
    spec = glob_spec("/notion/pages/*", "/notion")
    result = await resolve_glob_with(fake_readdir, NOOPAccessor(), [spec],
                                     None)
    assert len(result) == 2
