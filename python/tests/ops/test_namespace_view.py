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

from mirage.context import reset_current_session, set_current_session
from mirage.ops.namespace_view import (child_mount_names, merge_readdir,
                                       namespace_listing, namespace_names,
                                       namespace_stat, visible_child_segments)
from mirage.types import FileType, HiddenPaths
from mirage.workspace.session import SessionState

PREFIXES = ["/base/", "/base/inner/", "/base/inner/deep/", "/other/", "/"]


class _Links:
    """A NamespaceLinks double answering a fixed link table."""

    def __init__(self, targets: dict[str, str]) -> None:
        self._targets = targets

    def symlink_targets(self) -> dict[str, str]:
        return self._targets


@pytest.fixture
def scoped_session():
    """Bind a session whose role hides /other and /top/secret.

    Hiding is how a role puts a mount out of reach: naming mounts in a
    role narrows their modes and never decides whether they exist, so
    only a hide keeps a name out of a listing.
    """
    session = SessionState(session_id="agent",
                           hidden_paths=HiddenPaths(paths=("/other",
                                                           "/top/secret")))
    token = set_current_session(session)
    yield session
    reset_current_session(token)


def test_child_mount_names_lists_immediate_segments():
    assert child_mount_names(PREFIXES, "/base") == ["inner"]
    assert child_mount_names(PREFIXES, "/base/inner") == ["deep"]
    assert child_mount_names(PREFIXES, "/") == ["base", "other"]


def test_child_mount_names_excludes_the_parent_itself():
    assert child_mount_names(["/base/"], "/base") == []


def test_child_mount_names_keeps_hidden_names():
    assert child_mount_names(["/.dev/"], "/") == [".dev"]


def test_child_mount_names_filters_by_session(scoped_session):
    # /base is visible, so listing / and /base still show the way down;
    # /other is hidden, so its name never surfaces.
    assert child_mount_names(PREFIXES, "/") == ["base"]
    assert child_mount_names(PREFIXES, "/base") == ["inner"]


def test_merge_readdir_appends_mounts_and_links_as_paths():
    links = _Links({"/base/lnk": "/base/inner"})
    merged = merge_readdir(["/base/a.txt"], PREFIXES, links, "/base")
    assert merged == ["/base/a.txt", "/base/inner", "/base/lnk"]


def test_merge_readdir_dedupes_on_the_final_segment():
    # A backend that already lists a shadowed directory (any entry
    # shape) must not gain a duplicate from the mount table.
    for spelled in ("inner", "inner/", "/base/inner"):
        merged = merge_readdir([spelled], PREFIXES, None, "/base")
        assert merged == [spelled]


def test_merge_readdir_without_links_or_mounts_is_identity():
    assert merge_readdir(["/x/a"], ["/x/"], None, "/x") == ["/x/a"]


def test_structure_listing_answers_only_when_something_is_below():
    assert namespace_listing(PREFIXES, None, "/base/ghost") is None
    assert namespace_listing(PREFIXES, None, "/base") == ["/base/inner"]
    links = _Links({"/base/ghost/lnk": "/base"})
    assert namespace_listing(PREFIXES, links,
                             "/base/ghost") == ["/base/ghost/lnk"]


def test_link_ancestors_synthesize_like_mount_prefixes():
    # ln permits a link below a directory chain no backend serves; every
    # ancestor of the link must list and stat, or the link is reachable
    # by exact path yet invisible to any walk from above.
    links = _Links({"/ghost/deep/lnk": "/base"})
    assert namespace_listing([], links, "/") == ["/ghost"]
    assert namespace_listing([], links, "/ghost") == ["/ghost/deep"]
    assert namespace_listing([], links, "/ghost/deep") == ["/ghost/deep/lnk"]
    st = namespace_stat([], links, "/ghost")
    assert st is not None and st.type is FileType.DIRECTORY
    # The link itself is not structure: its stat is the lstat surface's.
    assert namespace_stat([], links, "/ghost/deep/lnk") is None


def test_structure_stat_agrees_with_the_listing():
    st = namespace_stat(PREFIXES, None, "/base")
    assert st is not None and st.type is FileType.DIRECTORY
    assert st.name == "base"
    assert namespace_stat(PREFIXES, None, "/base/ghost") is None


def test_structure_answers_hide_a_hidden_mount(scoped_session):
    # /top exists only because a hidden mount sits below it: to this
    # session the namespace must deny knowing anything there, or the
    # parent's existence hands back the child's name.
    assert namespace_listing(["/top/secret/"], None, "/top") is None
    assert namespace_stat(["/top/secret/"], None, "/top") is None
    # A visible mount keeps answering through the same session.
    assert namespace_stat(PREFIXES, None, "/base") is not None


def test_link_names_filter_by_owning_mount(scoped_session):
    # A link below a hidden mount must not leak that mount's name into
    # a listing child_mount_names had already filtered; a link inside a
    # visible mount keeps answering. Ownership is longest-match, the
    # same rule dispatch resolves the path by.
    links = _Links({"/other/leak": "/tgt", "/base/inner/ok": "/tgt"})
    assert namespace_names(PREFIXES, links, "/") == ["base"]
    assert namespace_listing(PREFIXES, links, "/base/inner") == [
        "/base/inner/deep", "/base/inner/ok"
    ]


def test_link_above_every_mount_stays_visible(scoped_session):
    # No mount owns /ghost/...: the link discloses nothing about any
    # hidden path, so a scoped session still sees the chain (it may
    # have created the link itself at a structure-only path).
    links = _Links({"/ghost/deep/lnk": "/base/inner"})
    assert namespace_listing(["/base/inner/"], links,
                             "/") == ["/base", "/ghost"]


@pytest.fixture
def hidden_mount_session():
    """Bind a session that hides the only mount under /ghost.

    The shape the predicate exists for: /ghost has no backend of its own
    and every verb applied to it answers ENOENT, so a listing must not
    hand back its name either.
    """
    session = SessionState(session_id="blind",
                           hidden_paths=HiddenPaths(paths=("/ghost/deep", )))
    token = set_current_session(session)
    yield session
    reset_current_session(token)


def test_visible_child_segments_tests_the_path_not_the_segment(
        hidden_mount_session):
    assert visible_child_segments(["/data", "/ghost/deep"], "/") == ["data"]


def test_visible_child_segments_keeps_a_segment_one_visible_path_owes(
        hidden_mount_session):
    # Any allowed path through the segment is enough, so a parent holding
    # one hidden mount and one visible mount still lists.
    got = visible_child_segments(["/ghost/deep", "/ghost/seen"], "/")
    assert got == ["ghost"]


def test_child_mount_names_withholds_a_hidden_mounts_only_ancestor(
        hidden_mount_session):
    assert child_mount_names(["/data", "/ghost/deep"], "/") == ["data"]
    assert child_mount_names(["/data", "/ghost/deep"], "/ghost") == []


def test_child_mount_names_unfiltered_without_a_session():
    assert child_mount_names(["/data", "/ghost/deep"],
                             "/") == ["data", "ghost"]


def test_link_names_withhold_a_hidden_links_only_ancestor(
        hidden_mount_session):
    # The link half of the same predicate: `ln` may put a link below a
    # directory chain no backend serves, and hiding the link has to take
    # the synthesized ancestor with it.
    links = _Links({"/ghost/deep/lk": "/data/x.txt"})
    assert namespace_names([], links, "/") == []
