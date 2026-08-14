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
from unittest.mock import AsyncMock

import pytest

from mirage.io import IOResult
from mirage.shell import parse
from mirage.shell.helpers import get_parts
from mirage.utils.glob_walk import glob_pattern, unmark_globs
from mirage.workspace.expand.parts import expand_parts, expand_words
from mirage.workspace.session import Session


def _words(cmd: str, env=None, stdout: bytes = b""):
    parts = get_parts(parse(cmd).named_children[0])
    session = Session(session_id="t", cwd="/", env=env or {})
    execute_fn = AsyncMock(return_value=IOResult(stdout=stdout))
    return asyncio.run(expand_words(parts, session, execute_fn))


def _read(cmd: str, **kw) -> tuple[str, str]:
    """One word's literal spelling and the pattern a matcher would see."""
    word = _words(cmd, **kw)[1]
    return unmark_globs(word), glob_pattern(word)


# `pattern` is what fnmatch is handed: a live metacharacter stays bare,
# one that quoting made literal arrives as its own character class.
@pytest.mark.parametrize("cmd,literal,pattern", [
    ("c /data/*.txt", "/data/*.txt", "/data/*.txt"),
    ("c '/data/*.txt'", "/data/*.txt", "/data/[*].txt"),
    ('c "/data/*.txt"', "/data/*.txt", "/data/[*].txt"),
    ("c /data/\\*.txt", "/data/*.txt", "/data/[*].txt"),
    ("c '/data/?.txt'", "/data/?.txt", "/data/[?].txt"),
    ("c '/data/[a].txt'", "/data/[a].txt", "/data/[[]a].txt"),
    ("c $'/data/*.txt'", "/data/*.txt", "/data/[*].txt"),
    ("c /data/a.txt", "/data/a.txt", "/data/a.txt"),
])
def test_quoting_decides_each_metacharacter(cmd, literal, pattern):
    assert _read(cmd) == (literal, pattern)


# The heart of it: quoting is per character, so one word can carry both
# a live metacharacter and a quoted one (GNU bash 5.2.37, pinned).
@pytest.mark.parametrize("cmd,literal,pattern", [
    ('c "/data/"*.txt', "/data/*.txt", "/data/*.txt"),
    ("c '/data/*'.txt", "/data/*.txt", "/data/[*].txt"),
    ("c '/data/'x\\*.txt", "/data/x*.txt", "/data/x[*].txt"),
    ('c "/data/*"?.txt', "/data/*?.txt", "/data/[*]?.txt"),
    ("c '/data/*'?.txt", "/data/*?.txt", "/data/[*]?.txt"),
    ("c '/data/*'*.txt", "/data/**.txt", "/data/[*]*.txt"),
    ("c /data/*'?'.txt", "/data/*?.txt", "/data/*[?].txt"),
])
def test_a_word_mixes_live_and_quoted_metacharacters(cmd, literal, pattern):
    assert _read(cmd) == (literal, pattern)


def test_unquoted_expansion_value_is_live():
    assert _read("c $p", env={"p":
                              "/data/*.txt"}) == ("/data/*.txt", "/data/*.txt")


def test_quoted_expansion_value_is_literal():
    assert _read('c "$p"',
                 env={"p": "/data/*.txt"}) == ("/data/*.txt", "/data/[*].txt")


def test_quoted_expansion_beside_a_live_metacharacter():
    # bash: `"$p"?.txt` with p='*' globs on the `?` alone.
    assert _read('c "$p"?.txt', env={"p": "*"}) == ("*?.txt", "[*]?.txt")


def test_command_substitution_words_are_live():
    words = _words("c $(inner)", stdout=b"*.txt plain")
    assert [glob_pattern(w) for w in words[1:]] == ["*.txt", "plain"]


def test_brace_quoted_alternative_stays_literal():
    words = _words("c {'*',x}")
    assert [(unmark_globs(w), glob_pattern(w))
            for w in words[1:]] == [("*", "[*]"), ("x", "x")]


def test_brace_literal_template_glob_is_live():
    words = _words("c {a,b}*")
    assert [glob_pattern(w) for w in words[1:]] == ["a*", "b*"]


def test_brace_escaped_template_glob_is_literal():
    words = _words("c {a,b}.\\*")
    assert [(unmark_globs(w), glob_pattern(w))
            for w in words[1:]] == [("a.*", "a.[*]"), ("b.*", "b.[*]")]


def test_brace_unquoted_expansion_atom_is_live():
    words = _words("c {$p,x}", env={"p": "*.txt"})
    assert [glob_pattern(w) for w in words[1:]] == ["*.txt", "x"]


def test_expand_parts_is_the_unmarked_view():
    cmd = "c '/data/*.txt' \"/data/\"*.txt {a,b}* '/data/*'?.txt"
    parts = get_parts(parse(cmd).named_children[0])
    session = Session(session_id="t", cwd="/", env={})
    execute_fn = AsyncMock(return_value=IOResult())
    words = asyncio.run(expand_words(parts, session, execute_fn))
    texts = asyncio.run(expand_parts(parts, session, execute_fn))
    assert texts == [unmark_globs(w) for w in words]
    # No mark ever reaches a caller of expand_parts.
    assert all(w == unmark_globs(w) for w in texts)
