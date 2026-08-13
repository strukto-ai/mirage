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

from mirage.types import HiddenPaths, HiddenVars
from mirage.utils.hidden import path_hidden, var_hidden


def test_none_hides_nothing():
    assert path_hidden(None, "/a/b") is False
    assert var_hidden(None, "SECRET") is False


def test_empty_spec_hides_nothing():
    assert path_hidden(HiddenPaths(), "/a/b") is False
    assert var_hidden(HiddenVars(), "SECRET") is False


def test_exact_path_hides_itself_and_its_subtree():
    # A name you cannot see cannot be a parent you traverse, so hiding
    # a path always hides everything under it.
    h = HiddenPaths(paths=("/s3/secrets", ))
    assert path_hidden(h, "/s3/secrets")
    assert path_hidden(h, "/s3/secrets/a.txt")
    assert path_hidden(h, "/s3/secrets/deep/b")
    assert not path_hidden(h, "/s3")
    assert not path_hidden(h, "/s3/secretsfoo")
    assert not path_hidden(h, "/s3/other")


def test_exact_path_spelling_is_normalized():
    assert path_hidden(HiddenPaths(paths=("/s3/secrets/", )), "/s3/secrets")
    assert path_hidden(HiddenPaths(paths=("s3/secrets", )), "/s3/secrets/a")


def test_exact_path_at_a_mount_root_covers_the_mount():
    # Subtractive mount hiding is a one-line prefix entry; the grant
    # table (mount_modes) stays the additive spelling.
    h = HiddenPaths(paths=("/s3", ))
    assert path_hidden(h, "/s3")
    assert path_hidden(h, "/s3/any/depth")
    assert not path_hidden(h, "/other")


def test_component_pattern_applies_inside_every_mount():
    # A pattern with no "/" matches any single name component, so
    # "hide *.key everywhere" is one entry, not one per mount.
    h = HiddenPaths(patterns=("*.key", ))
    assert path_hidden(h, "/a/b.key")
    assert path_hidden(h, "/other/deep/c.key")
    assert path_hidden(h, "/a/b.key/inside.txt")
    assert not path_hidden(h, "/a/bkey")
    assert not path_hidden(h, "/a/keyed")


def test_anchored_pattern_matches_the_full_virtual_path():
    h = HiddenPaths(patterns=("/config/*.pem", ))
    assert path_hidden(h, "/config/x.pem")
    assert path_hidden(h, "/config/x.pem/sub")
    assert not path_hidden(h, "/other/x.pem")


def test_anchored_star_crosses_slashes_like_find_path():
    # Deliberate: fnmatch's "*" is not slash-aware, the same semantics
    # GNU find -path applies to its patterns.
    h = HiddenPaths(patterns=("/config/*.pem", ))
    assert path_hidden(h, "/config/nested/x.pem")


def test_patterns_share_the_repo_fnmatch_dialect():
    # [^...] negates like [!...] (bash/glibc), because the matcher is
    # utils/fnmatch, not stdlib fnmatch.
    h = HiddenPaths(patterns=("[^a]*.key", ))
    assert path_hidden(h, "/x/b.key")
    assert not path_hidden(h, "/x/a.key")


def test_var_names_are_exact():
    h = HiddenVars(names=("SLACK_TOKEN", ))
    assert var_hidden(h, "SLACK_TOKEN")
    assert not var_hidden(h, "SLACK_TOKEN2")
    assert not var_hidden(h, "PATH")


def test_var_patterns_are_globs_over_names():
    h = HiddenVars(patterns=("AWS_*", "*_SECRET"))
    assert var_hidden(h, "AWS_ACCESS_KEY_ID")
    assert var_hidden(h, "DB_SECRET")
    assert not var_hidden(h, "HOME")
