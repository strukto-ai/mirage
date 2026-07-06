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

from mirage.workspace.mount.namespace import Namespace


@pytest.fixture
def namespace(registry):
    return Namespace(registry)


def test_resolve_delegates_to_registry(namespace, registry):
    assert namespace.resolve("/data/hello.txt") == registry.resolve(
        "/data/hello.txt")


def test_resolve_follow_noop_without_links(namespace):
    assert namespace.resolve(
        "/data/hello.txt", follow=True) == namespace.resolve("/data/hello.txt",
                                                             follow=False)


def test_resolve_unknown_path_raises(namespace):
    with pytest.raises(ValueError, match="no mount"):
        namespace.resolve("/unknown/x.txt")


def test_mount_for_delegates_to_registry(namespace, registry):
    assert namespace.mount_for("/data/hello.txt") is registry.mount_for(
        "/data/hello.txt")


def test_symlink_readlink_roundtrip_verbatim(namespace):
    namespace.symlink("/data/link", "/data/hello.txt", 1.0)
    assert namespace.is_link("/data/link")
    assert namespace.readlink("/data/link") == "/data/hello.txt"


def test_readlink_missing_returns_none(namespace):
    assert namespace.readlink("/data/nope") is None


def test_symlink_stores_relative_target_verbatim(namespace):
    namespace.symlink("/data/link", "hello.txt", 1.0)
    assert namespace.readlink("/data/link") == "hello.txt"


def test_unlink_removes_link(namespace):
    namespace.symlink("/data/link", "/data/hello.txt", 1.0)
    assert namespace.unlink("/data/link") is True
    assert namespace.is_link("/data/link") is False
    assert namespace.unlink("/data/link") is False


def test_rename_moves_link(namespace):
    namespace.symlink("/data/a", "/data/hello.txt", 1.0)
    assert namespace.rename("/data/a", "/data/b") is True
    assert namespace.is_link("/data/a") is False
    assert namespace.readlink("/data/b") == "/data/hello.txt"


def test_resolve_follows_link_to_target_mount(namespace):
    namespace.symlink("/data/link", "/data/hello.txt", 1.0)
    assert namespace.resolve(
        "/data/link", follow=True) == namespace.resolve("/data/hello.txt")


def test_resolve_no_follow_keeps_link_path(namespace, registry):
    namespace.symlink("/data/link", "/data/hello.txt", 1.0)
    assert namespace.resolve("/data/link",
                             follow=False) == registry.resolve("/data/link")


def test_resolve_cycle_raises(namespace):
    from mirage.utils.path import CycleError
    namespace.symlink("/data/a", "/data/b", 1.0)
    namespace.symlink("/data/b", "/data/a", 1.0)
    with pytest.raises(CycleError):
        namespace.resolve("/data/a", follow=True)


def test_follow_resolves_prefix_links(namespace):
    namespace.symlink("/data/link", "/data/real", 1.0)
    assert namespace.follow("/data/link/f.txt") == "/data/real/f.txt"
    assert namespace.follow("/data/other") == "/data/other"


def test_follow_identity_without_links(namespace):
    assert namespace.follow("/data/x") == "/data/x"


def test_links_under_returns_direct_children_only(namespace):
    namespace.symlink("/data/a", "/t1", 1.0)
    namespace.symlink("/data/sub/b", "/t2", 1.0)
    namespace.symlink("/other/c", "/t3", 1.0)
    assert namespace.links_under("/data") == {"a": "/t1"}
    assert namespace.links_under("/data/sub") == {"b": "/t2"}


def test_purge_under_drops_nested_entries(namespace):
    namespace.symlink("/data/sub/a", "/t1", 1.0)
    namespace.symlink("/data/sub/deep/b", "/t2", 1.0)
    namespace.symlink("/data/keep", "/t3", 1.0)
    assert namespace.purge_under("/data/sub") == 2
    assert namespace.is_link("/data/keep") is True
    assert namespace.is_link("/data/sub/a") is False


def test_set_attrs_creates_overlay_node(namespace):
    namespace.set_attrs("/data/f.txt", mode=0o601, uid=500, gid="dev")
    meta = namespace.meta_for("/data/f.txt")
    assert meta.target is None
    assert meta.mode == 0o601
    assert meta.uid == 500
    assert meta.gid == "dev"
    assert namespace.is_link("/data/f.txt") is False


def test_set_attrs_partial_update_keeps_fields(namespace):
    namespace.set_attrs("/data/f.txt", mode=0o600)
    namespace.set_attrs("/data/f.txt", uid="alice")
    meta = namespace.meta_for("/data/f.txt")
    assert meta.mode == 0o600
    assert meta.uid == "alice"


def test_set_attrs_on_link_keeps_target(namespace):
    namespace.symlink("/data/link", "/t1", 1.0)
    namespace.set_attrs("/data/link", mtime=2.0)
    meta = namespace.meta_for("/data/link")
    assert meta.target == "/t1"
    assert meta.mtime == 2.0
    assert namespace.readlink("/data/link") == "/t1"


def test_overlay_nodes_are_not_links(namespace):
    namespace.set_attrs("/data/f.txt", mode=0o600)
    assert namespace.symlink_targets() == {}
    assert namespace.has_links() is False
    assert namespace.links_under("/data") == {}


def test_unlink_drops_overlay_node(namespace):
    namespace.set_attrs("/data/f.txt", mode=0o600)
    namespace.unlink("/data/f.txt")
    assert namespace.meta_for("/data/f.txt") is None


def test_rename_moves_overlay_node(namespace):
    namespace.set_attrs("/data/f.txt", mode=0o600)
    namespace.rename("/data/f.txt", "/data/g.txt")
    assert namespace.meta_for("/data/f.txt") is None
    assert namespace.meta_for("/data/g.txt").mode == 0o600


def test_clear_times_keeps_mode_and_ownership(namespace):
    namespace.set_attrs("/data/f.txt",
                        mode=0o601,
                        uid=500,
                        mtime=1.0,
                        atime="2026-03-04T12:00:00+00:00")
    namespace.clear_times("/data/f.txt")
    meta = namespace.meta_for("/data/f.txt")
    assert meta.mtime is None
    assert meta.atime is None
    assert meta.mode == 0o601
    assert meta.uid == 500


def test_clear_times_drops_time_only_node(namespace):
    namespace.set_attrs("/data/f.txt", mtime=1.0)
    namespace.clear_times("/data/f.txt")
    assert namespace.meta_for("/data/f.txt") is None


def test_clear_times_leaves_links_alone(namespace):
    namespace.symlink("/data/link", "/t1", 1.0)
    namespace.clear_times("/data/link")
    assert namespace.meta_for("/data/link").mtime == 1.0


def test_unlink_glob_matches_segment_wise(namespace):
    namespace.set_attrs("/data/a.log", mode=0o600)
    namespace.set_attrs("/data/sub/b.log", mode=0o600)
    namespace.set_attrs("/data/keep.txt", mode=0o600)
    assert namespace.unlink_glob("/data/*.log") == 1
    assert namespace.meta_for("/data/a.log") is None
    assert namespace.meta_for("/data/sub/b.log") is not None
    assert namespace.meta_for("/data/keep.txt") is not None


def test_unlink_glob_purges_under_matched_dirs(namespace):
    namespace.set_attrs("/data/sub/deep/a.txt", mode=0o600)
    namespace.set_attrs("/data/other.txt", mode=0o600)
    assert namespace.unlink_glob("/data/s*") == 1
    assert namespace.meta_for("/data/sub/deep/a.txt") is None
    assert namespace.meta_for("/data/other.txt") is not None
