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
from mirage.ops.structure import (child_mount_names, merge_readdir,
                                  structure_listing, structure_stat)
from mirage.types import FileType, MountMode
from mirage.workspace.session import Session

PREFIXES = ["/base/", "/base/inner/", "/base/inner/deep/", "/other/", "/"]


class _Links:
    """A NamespaceLinks double answering a fixed link table."""

    def __init__(self, targets: dict[str, str]) -> None:
        self._targets = targets

    def symlink_targets(self) -> dict[str, str]:
        return self._targets


@pytest.fixture
def scoped_session():
    """Bind a session granted only /base/inner (and its descendants)."""
    session = Session(session_id="agent",
                      mount_modes={"/base/inner": MountMode.EXEC})
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
    # /base/inner is granted, so listing /base still shows the way to
    # it; /other is not granted, so its name never surfaces.
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
    assert structure_listing(PREFIXES, None, "/base/ghost") is None
    assert structure_listing(PREFIXES, None, "/base") == ["/base/inner"]
    links = _Links({"/base/ghost/lnk": "/base"})
    assert structure_listing(PREFIXES, links,
                             "/base/ghost") == ["/base/ghost/lnk"]


def test_link_ancestors_synthesize_like_mount_prefixes():
    # ln permits a link below a directory chain no backend serves; every
    # ancestor of the link must list and stat, or the link is reachable
    # by exact path yet invisible to any walk from above.
    links = _Links({"/ghost/deep/lnk": "/base"})
    assert structure_listing([], links, "/") == ["/ghost"]
    assert structure_listing([], links, "/ghost") == ["/ghost/deep"]
    assert structure_listing([], links, "/ghost/deep") == ["/ghost/deep/lnk"]
    st = structure_stat([], links, "/ghost")
    assert st is not None and st.type is FileType.DIRECTORY
    # The link itself is not structure: its stat is the lstat surface's.
    assert structure_stat([], links, "/ghost/deep/lnk") is None


def test_structure_stat_agrees_with_the_listing():
    st = structure_stat(PREFIXES, None, "/base")
    assert st is not None and st.type is FileType.DIRECTORY
    assert st.name == "base"
    assert structure_stat(PREFIXES, None, "/base/ghost") is None


def test_structure_answers_hide_ungranted_mounts(scoped_session):
    # /top exists only because an ungranted mount sits below it: to
    # this session the namespace must deny knowing anything there.
    assert structure_listing(["/top/secret/"], None, "/top") is None
    assert structure_stat(["/top/secret/"], None, "/top") is None
    # The granted mount keeps answering through the same session.
    assert structure_stat(PREFIXES, None, "/base") is not None
