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

from mirage.utils.path import (CycleError, expand_tilde, gnu_basename,
                               gnu_dirname, norm, parent, resolve_path,
                               resolve_symlinks)


def test_norm_strips_and_adds_leading_slash():
    assert norm("a/b") == "/a/b"
    assert norm("/a/b/") == "/a/b"
    assert norm("///a///") == "/a"
    assert norm("") == "/"
    assert norm("/") == "/"


def test_parent_of_normalized_key():
    assert parent("/a/b") == "/a"
    assert parent("/a") == "/"
    assert parent("/") == "/"
    assert parent("/a/b/c") == "/a/b"


def test_basename_simple():
    assert gnu_basename("/a/b/c.txt") == "c.txt"


def test_basename_no_slash():
    assert gnu_basename("c.txt") == "c.txt"


def test_basename_trailing_slash():
    assert gnu_basename("/a/b/") == "b"


def test_basename_multiple_trailing_slashes():
    assert gnu_basename("/a/b///") == "b"


def test_basename_root():
    assert gnu_basename("/") == "/"


def test_basename_empty():
    assert gnu_basename("") == ""


def test_basename_strip_suffix():
    assert gnu_basename("/a/b/c.txt", ".txt") == "c"


def test_basename_suffix_equal_to_base_not_stripped():
    assert gnu_basename("/a/.txt", ".txt") == ".txt"


def test_basename_suffix_not_matching():
    assert gnu_basename("/a/c.txt", ".md") == "c.txt"


def test_dirname_simple():
    assert gnu_dirname("/a/b/c.txt") == "/a/b"


def test_dirname_relative_nested():
    assert gnu_dirname("a/b") == "a"


def test_dirname_trailing_slash():
    assert gnu_dirname("/a/b/") == "/a"


def test_dirname_single_absolute():
    assert gnu_dirname("/a") == "/"


def test_dirname_single_relative():
    assert gnu_dirname("a") == "."


def test_dirname_root():
    assert gnu_dirname("/") == "/"


def test_dirname_empty():
    assert gnu_dirname("") == "."


def test_resolve_relative_against_cwd():
    assert resolve_path("file.txt", "/data/") == "/data/file.txt"


def test_resolve_parent_traversal():
    assert resolve_path("../file.txt", "/data/sub/") == "/data/file.txt"


def test_resolve_absolute_ignores_cwd():
    assert resolve_path("/abs/path", "/ignored") == "/abs/path"


def test_resolve_current_dir_segment():
    assert resolve_path("./x", "/a/b") == "/a/b/x"


def test_expand_tilde_alone():
    assert expand_tilde("~", "/home/u") == "/home/u"


def test_expand_tilde_with_subpath():
    assert expand_tilde("~/file.txt", "/home/u") == "/home/u/file.txt"


def test_expand_tilde_root_home():
    assert expand_tilde("~/file.txt", "/") == "/file.txt"


def test_expand_tilde_user_unchanged():
    assert expand_tilde("~other/x", "/home/u") == "~other/x"


def test_expand_tilde_non_leading_unchanged():
    assert expand_tilde("a~b", "/home/u") == "a~b"


def test_expand_tilde_plain_word_unchanged():
    assert expand_tilde("file.txt", "/home/u") == "file.txt"


def test_resolve_symlinks_no_links_unchanged():
    assert resolve_symlinks("/foo/bar/baz", {}) == "/foo/bar/baz"


def test_resolve_symlinks_single_hop():
    assert resolve_symlinks("/foo/bar/baz", {"/foo/bar": "/abc"}) == "/abc/baz"


def test_resolve_symlinks_exact_match():
    assert resolve_symlinks("/foo/bar", {"/foo/bar": "/abc"}) == "/abc"


def test_resolve_symlinks_multi_hop_until_stable():
    links = {"/foo/bar": "/abc", "/abc": "/bcd", "/bcd/baz": "/xyz"}
    assert resolve_symlinks("/foo/bar/baz", links) == "/xyz"


def test_resolve_symlinks_longest_prefix_wins():
    links = {"/foo": "/wrong", "/foo/bar": "/abc"}
    assert resolve_symlinks("/foo/bar/baz", links) == "/abc/baz"


def test_resolve_symlinks_boundary_not_substring():
    assert resolve_symlinks("/foo/barbaz",
                            {"/foo/bar": "/abc"}) == "/foo/barbaz"


def test_resolve_symlinks_cross_mount_target():
    assert resolve_symlinks("/ram/link/x",
                            {"/ram/link": "/s3/data"}) == "/s3/data/x"


def test_resolve_symlinks_relative_target_against_link_dir():
    assert resolve_symlinks(
        "/ram/sub/dlink",
        {"/ram/sub/dlink": "deep.txt"}) == "/ram/sub/deep.txt"


def test_resolve_symlinks_relative_target_with_suffix():
    assert resolve_symlinks("/ram/sub/dlink/x",
                            {"/ram/sub/dlink": "peer"}) == "/ram/sub/peer/x"


def test_resolve_symlinks_cycle_raises():
    with pytest.raises(CycleError):
        resolve_symlinks("/a", {"/a": "/b", "/b": "/a"})


def test_resolve_symlinks_self_cycle_raises():
    with pytest.raises(CycleError):
        resolve_symlinks("/a/x", {"/a": "/a/y"})
