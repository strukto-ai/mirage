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

from mirage.commands.builtin.rg_glob import (Overrides, Verdict, compile_glob,
                                             override_glob, walk_candidate)
from mirage.commands.errors import UsageError


@pytest.mark.parametrize("glob, path, hit", [
    ("*.py", "a.py", True),
    ("*.py", "sub/a.py", False),
    ("?.py", "a.py", True),
    ("?.py", "ab.py", False),
    ("**", "a/b/c", True),
    ("**/c", "c", True),
    ("**/c", "a/b/c", True),
    ("a/**/c", "a/c", True),
    ("a/**/c", "a/x/y/c", True),
    ("a/**", "a/b/c", True),
    ("a**", "ab/c", False),
    ("[ab].*", "b.py", True),
    ("[!ab].*", "b.py", False),
    ("[^ab].*", "c.py", True),
    ("[a-c]x", "bx", True),
    ("[]]x", "]x", True),
    ("*.{py,md}", "c.md", True),
    ("*.{py,md}", "c.rs", False),
    ("\\*x", "*x", True),
    ("\\*x", "ax", False),
])
def test_compile_glob_keeps_single_stars_inside_a_component(glob, path, hit):
    # globset with literal separators, which ripgrep builds -g with.
    assert bool(compile_glob(glob).fullmatch(path)) is hit


def test_compile_glob_folds_case_on_request():
    assert compile_glob("*.PY", case_insensitive=True).fullmatch("a.py")
    assert not compile_glob("*.PY").fullmatch("a.py")


@pytest.mark.parametrize("glob, reason", [
    ("[", "unclosed character class; missing ']'"),
    ("a{b", "unclosed alternate group; missing '}' "
     "(maybe escape '{' with '[{]'?)"),
    ("a}b", "unopened alternate group; missing '{' "
     "(maybe escape '}' with '[}]'?)"),
    ("{a,{b}}", "nested alternate groups are not allowed"),
    ("a\\", "dangling '\\'"),
])
def test_compile_glob_refuses_in_globsets_words(glob, reason):
    with pytest.raises(UsageError) as info:
        compile_glob(glob)
    assert str(info.value) == f"rg: error parsing glob '{glob}': {reason}"
    assert info.value.exit_code == 2


def test_a_refusal_names_the_glob_as_typed():
    # `-g '['` is compiled as `**/[` but refused as typed (ripgrep 14.1.1).
    with pytest.raises(UsageError) as info:
        override_glob("[", False)
    assert "'['" in str(info.value)


@pytest.mark.parametrize("line", ["", "#comment", "   "])
def test_a_line_that_says_nothing_is_no_glob(line):
    assert override_glob(line, False) is None


def test_an_unslashed_glob_matches_at_any_depth():
    glob = override_glob("*.py", False)
    assert glob is not None and glob.keep and not glob.dir_only
    assert glob.matcher.fullmatch("a.py")
    assert glob.matcher.fullmatch("sub/deep/a.py")


def test_a_slash_anchors_the_glob_to_the_walk_root():
    anchored = override_glob("/a.txt", False)
    assert anchored is not None
    assert anchored.matcher.fullmatch("a.txt")
    assert not anchored.matcher.fullmatch("sub/a.txt")
    inner = override_glob("sub/*.txt", False)
    assert inner is not None and not inner.matcher.fullmatch("x/sub/a.txt")


def test_negation_and_its_escape():
    negated = override_glob("!*.txt", False)
    assert negated is not None and not negated.keep
    literal = override_glob("\\!x", False)
    assert literal is not None and literal.keep
    assert literal.matcher.fullmatch("!x")


def test_a_trailing_slash_speaks_only_for_directories():
    glob = override_glob("sub/", False)
    assert glob is not None and glob.dir_only
    assert glob.matcher.fullmatch("sub")


def test_dir_double_star_keeps_below_but_not_the_directory():
    glob = override_glob("sub/**", False)
    assert glob is not None
    assert glob.matcher.fullmatch("sub/d.txt")
    assert glob.matcher.fullmatch("sub/deep/f.txt")
    assert not glob.matcher.fullmatch("sub")


def test_trailing_spaces_are_dropped_unless_escaped():
    trimmed = override_glob("*.py  ", False)
    assert trimmed is not None and trimmed.matcher.fullmatch("a.py")
    kept = override_glob("a\\ ", False)
    assert kept is not None and kept.matcher.fullmatch("a ")


def test_overrides_let_the_last_matching_glob_decide():
    # ripgrep 14.1.1: `-g '!*.txt' -g a.txt` keeps a.txt, the reverse
    # order drops it.
    later = Overrides(["!*.txt", "a.txt"], [], False)
    assert later.verdict("a.txt", False) is Verdict.WHITELIST
    earlier = Overrides(["a.txt", "!*.txt"], [], False)
    assert earlier.verdict("a.txt", False) is Verdict.IGNORE


def test_a_plain_glob_drops_every_file_it_does_not_match():
    overrides = Overrides(["*.py"], [], False)
    assert overrides.verdict("a.txt", False) is Verdict.IGNORE
    # A directory it does not match is still walked.
    assert overrides.verdict("sub", True) is Verdict.NONE


def test_only_negated_globs_leave_the_rest_alone():
    overrides = Overrides(["!*.txt"], [], False)
    assert overrides.verdict("a.py", False) is Verdict.NONE
    assert overrides.verdict("a.txt", False) is Verdict.IGNORE


def test_iglob_folds_case_and_comes_after_every_glob():
    overrides = Overrides(["!*.py"], ["*.PY"], False)
    assert overrides.verdict("a.py", False) is Verdict.WHITELIST
    assert Overrides(["*.PY"], [], True).verdict("a.py",
                                                 False) is Verdict.WHITELIST


def test_no_globs_say_nothing():
    assert Overrides([], [], False).verdict("a", False) is Verdict.NONE


@pytest.mark.parametrize("shown, cwd, candidate", [
    ("./sub/a.py", "/data", "sub/a.py"),
    ("sub/a.py", "/data", "sub/a.py"),
    ("/data/rgt/a.py", "/data", "rgt/a.py"),
    ("/data/rgt/a.py", "/", "data/rgt/a.py"),
    ("/elsewhere/a.py", "/data", "/elsewhere/a.py"),
])
def test_walk_candidate_matches_from_the_working_directory(
        shown, cwd, candidate):
    assert walk_candidate(shown, cwd) == candidate
