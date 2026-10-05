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

from mirage.workspace.mount.namespace.view import (
    link_view,
    registry_child_mounts,
)


class _FakeMount:
    def __init__(self, prefix: str) -> None:
        self.prefix = prefix


class _FakeRegistry:
    """Enough of MountRegistry for the child_mounts fact to bind against."""

    def __init__(self, prefixes: list[str]) -> None:
        self._prefixes = prefixes

    def mounts(self) -> list[_FakeMount]:
        return [_FakeMount(p) for p in self._prefixes]


class _FakeLinks:
    def __init__(self, targets: dict[str, str]) -> None:
        self._targets = targets

    def symlink_targets(self) -> dict[str, str]:
        return self._targets


def test_registry_child_mounts_derives_from_the_mount_table():
    reg = _FakeRegistry(["/base/", "/base/inner/", "/dev/"])
    assert registry_child_mounts(reg, None, None, "/base") == ["inner"]
    assert registry_child_mounts(reg, None, None, "/") == ["base", "dev"]
    assert registry_child_mounts(reg, None, None, "/dev") == []


def test_registry_child_mounts_includes_link_ancestors():
    # A link below a directory chain no backend serves synthesizes its
    # ancestors, exactly as a nested mount prefix does, so `ls /` shows
    # the way to it.
    reg = _FakeRegistry(["/base/"])
    links = _FakeLinks({"/ghost/deep/lnk": "/base"})
    assert registry_child_mounts(reg, links, None, "/") == ["base", "ghost"]
    assert registry_child_mounts(reg, links, None, "/ghost") == ["deep"]


class _FakeNamespace:
    """Enough of Namespace for _link_view to bind against."""

    def __init__(self, has_links: bool = True) -> None:
        self._has_links = has_links

    def has_links(self) -> bool:
        return self._has_links

    def link_stat_at(self, path: str) -> None:
        return None

    def link_stats_under(self, directory: str) -> list:
        return []

    def link_stats_below(self, directory: str) -> list:
        return []

    def follow(self, path: str) -> str:
        return path


async def _dispatch(*args, **kwargs):
    return None, None


def test_a_view_is_offered_whenever_the_workspace_holds_links():
    assert link_view(_FakeNamespace(), _dispatch) is not None


def test_empty_namespace_still_offers_a_live_view():
    """A captured view must remain usable when the first link appears."""
    view = link_view(_FakeNamespace(has_links=False), _dispatch)
    assert view is not None
    assert view.children("/") == []
    assert view.stat_at("/missing") is None


def test_no_view_without_a_namespace():
    assert link_view(None, _dispatch) is None
