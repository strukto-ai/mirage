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
from mirage.context import reset_current_session, set_current_session
from mirage.types import HiddenPaths, PathSpec
from mirage.utils.glob_walk import (DEFAULT_MAX_GLOB_MATCHES, expand_pattern,
                                    glob_pattern, has_glob, is_word_shaped,
                                    literal_word, make_resolve_glob,
                                    mark_escaped_globs, mark_globs,
                                    resolve_glob_with, spell_match,
                                    unmark_globs)
from mirage.workspace.expand.node import _unescape_unquoted
from mirage.workspace.session.session import Session

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


def test_mark_globs_roundtrips_and_hides_from_has_glob():
    marked = mark_globs("a*b?c[d")
    assert not has_glob(marked)
    assert unmark_globs(marked) == "a*b?c[d"
    assert len(marked) == len("a*b?c[d")
    # Nothing else moves, and a text with no glob character is untouched.
    assert mark_globs("page.md") == "page.md"
    assert unmark_globs("page.md") == "page.md"


def test_mark_globs_is_per_character():
    # The word bash globs on the `?` alone: only the star is quoted.
    word = mark_globs("*") + "?.txt"
    assert has_glob(word)
    assert unmark_globs(word) == "*?.txt"
    assert glob_pattern(word) == "[*]?.txt"


def test_glob_pattern_makes_a_marked_char_literal():
    assert glob_pattern(mark_globs("*")) == "[*]"
    assert glob_pattern(mark_globs("?")) == "[?]"
    assert glob_pattern(mark_globs("[")) == "[[]"
    # A live glob character is left alone, so the two mix in one segment.
    assert glob_pattern("*" + mark_globs("?")) == "*[?]"
    assert glob_pattern("plain.txt") == "plain.txt"


def test_mark_escaped_globs_reads_backslashes_like_bash():

    def marked(text: str) -> bool:
        return has_glob(_unescape_unquoted(mark_escaped_globs(text)))

    assert marked("Demo_*")
    assert marked("x?")
    assert marked("[ab]")
    assert not marked("page.md")
    assert not marked("\\*.txt")
    assert not marked("a\\?b")
    assert not marked("\\[ab]")
    assert marked("a\\*b*c")
    # An escaped backslash does not quote what follows it.
    assert marked("\\\\*")
    assert not marked("\\\\\\*")
    # A trailing backslash quotes nothing.
    assert not marked("a\\")


def test_literal_word_freezes_a_pattern_that_carried_marks():
    spec = PathSpec(virtual="/data/" + mark_globs("*") + "?.txt",
                    directory="/data/",
                    resource_path=mark_globs("*") + "?.txt",
                    pattern=mark_globs("*") + "?.txt",
                    resolved=False)
    out = literal_word(spec)
    assert isinstance(out, PathSpec)
    # The word after quote removal, and no pattern left to glob again.
    assert out.virtual == "/data/*?.txt"
    assert out.pattern is None
    assert out.resolved


def test_literal_word_leaves_an_unmarked_spec_untouched():
    spec = PathSpec(virtual="/data/*.txt",
                    directory="/data/",
                    resource_path="*.txt",
                    pattern="*.txt",
                    resolved=False)
    assert literal_word(spec) is spec
    assert literal_word("plain") == "plain"


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


@pytest.mark.asyncio
async def test_make_resolve_glob_binds_readdir():
    resolve = make_resolve_glob(fake_readdir)
    spec = glob_spec("/notion/pages/Demo_page__*/page.md", "/notion")
    result = await resolve(NOOPAccessor(), [spec], None)
    assert [p.virtual
            for p in result] == ["/notion/pages/Demo_page__uuid1/page.md"]


@pytest.mark.asyncio
async def test_make_resolve_glob_passthrough():
    resolve = make_resolve_glob(fake_readdir)
    resolved_spec = PathSpec.from_str_path("/notion/pages/Roadmap__uuid2",
                                           "pages/Roadmap__uuid2")
    result = await resolve(NOOPAccessor(), [resolved_spec], None)
    assert result[0] is resolved_spec


@pytest.mark.asyncio
async def test_make_resolve_glob_truncates_at_cap():
    resolve = make_resolve_glob(fake_readdir, max_glob_matches=1)
    spec = glob_spec("/notion/pages/*", "/notion")
    result = await resolve(NOOPAccessor(), [spec], None)
    assert len(result) == 1


def test_make_resolve_glob_default_cap():
    assert DEFAULT_MAX_GLOB_MATCHES == 10000


@pytest.mark.asyncio
async def test_make_resolve_glob_zero_match_word_keeps_literal():
    resolve = make_resolve_glob(fake_readdir)
    spec = glob_spec("/notion/pages/*.nope", "/notion")
    out = await resolve(NOOPAccessor(), [spec], None)
    assert len(out) == 1
    assert out[0].virtual == "/notion/pages/*.nope"
    assert out[0].pattern is None
    assert out[0].resolved


@pytest.mark.asyncio
async def test_make_resolve_glob_zero_match_dir_shape_stays_empty():
    resolve = make_resolve_glob(fake_readdir)
    spec = glob_spec("/notion/pages/*.nope", "/notion").dir
    out = await resolve(NOOPAccessor(), [spec], None)
    assert out == []


@pytest.mark.asyncio
async def test_make_resolve_glob_index_defaults_to_null():
    resolve = make_resolve_glob(fake_readdir)
    spec = glob_spec("/notion/pages/Demo*", "/notion")
    result = await resolve(NOOPAccessor(), [spec])
    assert [p.virtual for p in result] == ["/notion/pages/Demo_page__uuid1"]


@pytest.mark.asyncio
async def test_resolve_glob_with_drops_hidden_matches():
    sess = Session(session_id="narrowed",
                   hidden_paths=HiddenPaths(patterns=("*.json", )))
    token = set_current_session(sess)
    try:
        spec = glob_spec("/notion/pages/Demo_page__uuid1/page.*", "/notion")
        result = await resolve_glob_with(fake_readdir, NOOPAccessor(), [spec],
                                         None)
    finally:
        reset_current_session(token)
    assert [r.virtual
            for r in result] == ["/notion/pages/Demo_page__uuid1/page.md"]


@pytest.mark.asyncio
async def test_resolve_glob_with_all_hidden_falls_back_to_literal():
    sess = Session(session_id="narrowed",
                   hidden_paths=HiddenPaths(patterns=("*.json", )))
    token = set_current_session(sess)
    try:
        spec = glob_spec("/notion/pages/Roadmap__uuid2/page.*", "/notion")
        result = await resolve_glob_with(fake_readdir, NOOPAccessor(), [spec],
                                         None)
    finally:
        reset_current_session(token)
    assert len(result) == 1
    assert result[0].resolved
    assert result[0].pattern is None
    assert result[0].virtual == "/notion/pages/Roadmap__uuid2/page.*"
