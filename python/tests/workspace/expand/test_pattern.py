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

import asyncio

import pytest

from mirage.shell.helpers import get_case_items
from mirage.shell.parse import parse
from mirage.utils.fnmatch import fnmatch
from mirage.utils.glob_walk import escape_glob
from mirage.workspace.expand.pattern import _unquoted_pattern, expand_pattern
from mirage.workspace.session import Session


async def _fail_exec(*args: object, **kwargs: object) -> None:
    raise AssertionError("pattern expansion must not run commands here")


def _expand(snippet: str, env: dict[str, str] | None = None) -> str:
    root = parse(f"case x in {snippet}) :;; esac")
    patterns = get_case_items(root.children[0])[0][0]
    assert len(patterns) == 1
    session = Session(session_id="t", env=env or {})
    return asyncio.run(expand_pattern(patterns[0], session, _fail_exec))


@pytest.mark.parametrize("text,expected", [
    ("plain", "plain"),
    ("a*b", "a[*]b"),
    ("?x[", "[?]x[[]"),
    ("]", "]"),
])
def test_escape_glob_wraps_specials_in_classes(text, expected):
    assert escape_glob(text) == expected


def test_escaped_text_matches_itself_and_nothing_else():
    assert fnmatch("a*b", escape_glob("a*b"))
    assert not fnmatch("aXb", escape_glob("a*b"))
    assert fnmatch("[^a]", escape_glob("[^a]"))
    assert not fnmatch("b", escape_glob("[^a]"))


@pytest.mark.parametrize("text,expected", [
    ("a*", "a*"),
    (r"a\*b", "a[*]b"),
    (r"\?", "[?]"),
    ("a\\", "a\\"),
])
def test_unquoted_pattern_backslash_escapes(text, expected):
    assert _unquoted_pattern(text) == expected


def test_single_quoted_pattern_is_literal():
    assert _expand("'*'") == "[*]"


def test_double_quoted_pattern_is_literal():
    assert _expand('"*"') == "[*]"


def test_unquoted_word_keeps_globs_live():
    assert _expand("*") == "*"


def test_quoted_expansion_is_literal():
    assert _expand('"$x"', env={"x": "*"}) == "[*]"


def test_unquoted_expansion_stays_a_live_pattern():
    assert _expand("$x", env={"x": "*"}) == "*"


def test_ansi_c_pattern_decodes_then_escapes():
    assert _expand(r"$'a\t*'") == "a\t[*]"


def test_translated_string_pattern_is_literal():
    assert _expand('$"a?"') == "a[?]"


def test_concatenation_mixes_literal_and_live_segments():
    assert _expand("'a'*") == "a*"
    assert _expand("'*'\"?\"") == "[*][?]"


def test_tilde_expands_in_an_unquoted_pattern():
    assert _expand("~/x", env={"HOME": "/home/u"}) == "/home/u/x"


def test_escaped_tilde_stays_literal():
    assert _expand(r"\~", env={"HOME": "/home/u"}) == "~"
