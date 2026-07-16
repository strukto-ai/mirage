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

from mirage.workspace.mount.namespace import Namespace, NodeMeta
from mirage.workspace.mount.namespace.ram import RAMNamespaceStore


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


@pytest.mark.asyncio
async def test_symlink_readlink_roundtrip_verbatim(namespace):
    await namespace.symlink("/data/link", "/data/hello.txt", 1.0)
    assert namespace.is_link("/data/link")
    assert namespace.readlink("/data/link") == "/data/hello.txt"


def test_readlink_missing_returns_none(namespace):
    assert namespace.readlink("/data/nope") is None


@pytest.mark.asyncio
async def test_symlink_stores_relative_target_verbatim(namespace):
    await namespace.symlink("/data/link", "hello.txt", 1.0)
    assert namespace.readlink("/data/link") == "hello.txt"


@pytest.mark.asyncio
async def test_unlink_removes_link(namespace):
    await namespace.symlink("/data/link", "/data/hello.txt", 1.0)
    assert await namespace.unlink("/data/link") is True
    assert namespace.is_link("/data/link") is False
    assert await namespace.unlink("/data/link") is False


@pytest.mark.asyncio
async def test_rename_moves_link(namespace):
    await namespace.symlink("/data/a", "/data/hello.txt", 1.0)
    assert await namespace.rename("/data/a", "/data/b") is True
    assert namespace.is_link("/data/a") is False
    assert namespace.readlink("/data/b") == "/data/hello.txt"


@pytest.mark.asyncio
async def test_resolve_follows_link_to_target_mount(namespace):
    await namespace.symlink("/data/link", "/data/hello.txt", 1.0)
    assert namespace.resolve(
        "/data/link", follow=True) == namespace.resolve("/data/hello.txt")


@pytest.mark.asyncio
async def test_resolve_no_follow_keeps_link_path(namespace, registry):
    await namespace.symlink("/data/link", "/data/hello.txt", 1.0)
    assert namespace.resolve("/data/link",
                             follow=False) == registry.resolve("/data/link")


@pytest.mark.asyncio
async def test_resolve_cycle_raises(namespace):
    from mirage.utils.path import CycleError
    await namespace.symlink("/data/a", "/data/b", 1.0)
    await namespace.symlink("/data/b", "/data/a", 1.0)
    with pytest.raises(CycleError):
        namespace.resolve("/data/a", follow=True)


@pytest.mark.asyncio
async def test_follow_resolves_prefix_links(namespace):
    await namespace.symlink("/data/link", "/data/real", 1.0)
    assert namespace.follow("/data/link/f.txt") == "/data/real/f.txt"
    assert namespace.follow("/data/other") == "/data/other"


def test_follow_identity_without_links(namespace):
    assert namespace.follow("/data/x") == "/data/x"


@pytest.mark.asyncio
async def test_links_under_returns_direct_children_only(namespace):
    await namespace.symlink("/data/a", "/t1", 1.0)
    await namespace.symlink("/data/sub/b", "/t2", 1.0)
    await namespace.symlink("/other/c", "/t3", 1.0)
    assert namespace.links_under("/data") == {"a": "/t1"}
    assert namespace.links_under("/data/sub") == {"b": "/t2"}


@pytest.mark.asyncio
async def test_purge_under_drops_nested_entries(namespace):
    await namespace.symlink("/data/sub/a", "/t1", 1.0)
    await namespace.symlink("/data/sub/deep/b", "/t2", 1.0)
    await namespace.symlink("/data/keep", "/t3", 1.0)
    assert await namespace.purge_under("/data/sub") == 2
    assert namespace.is_link("/data/keep") is True
    assert namespace.is_link("/data/sub/a") is False


@pytest.mark.asyncio
async def test_set_attrs_creates_overlay_node(namespace):
    await namespace.set_attrs("/data/f.txt", mode=0o601, uid=500, gid="dev")
    meta = namespace.meta_for("/data/f.txt")
    assert meta.target is None
    assert meta.mode == 0o601
    assert meta.uid == 500
    assert meta.gid == "dev"
    assert namespace.is_link("/data/f.txt") is False


@pytest.mark.asyncio
async def test_set_attrs_partial_update_keeps_fields(namespace):
    await namespace.set_attrs("/data/f.txt", mode=0o600)
    await namespace.set_attrs("/data/f.txt", uid="alice")
    meta = namespace.meta_for("/data/f.txt")
    assert meta.mode == 0o600
    assert meta.uid == "alice"


@pytest.mark.asyncio
async def test_set_attrs_on_link_keeps_target(namespace):
    await namespace.symlink("/data/link", "/t1", 1.0)
    await namespace.set_attrs("/data/link", mtime=2.0)
    meta = namespace.meta_for("/data/link")
    assert meta.target == "/t1"
    assert meta.mtime == 2.0
    assert namespace.readlink("/data/link") == "/t1"


@pytest.mark.asyncio
async def test_overlay_nodes_are_not_links(namespace):
    await namespace.set_attrs("/data/f.txt", mode=0o600)
    assert namespace.symlink_targets() == {}
    assert namespace.has_links() is False
    assert namespace.links_under("/data") == {}


@pytest.mark.asyncio
async def test_unlink_drops_overlay_node(namespace):
    await namespace.set_attrs("/data/f.txt", mode=0o600)
    await namespace.unlink("/data/f.txt")
    assert namespace.meta_for("/data/f.txt") is None


@pytest.mark.asyncio
async def test_rename_moves_overlay_node(namespace):
    await namespace.set_attrs("/data/f.txt", mode=0o600)
    await namespace.rename("/data/f.txt", "/data/g.txt")
    assert namespace.meta_for("/data/f.txt") is None
    assert namespace.meta_for("/data/g.txt").mode == 0o600


@pytest.mark.asyncio
async def test_clear_times_keeps_mode_and_ownership(namespace):
    await namespace.set_attrs("/data/f.txt",
                              mode=0o601,
                              uid=500,
                              mtime=1.0,
                              atime="2026-03-04T12:00:00+00:00")
    await namespace.clear_times("/data/f.txt")
    meta = namespace.meta_for("/data/f.txt")
    assert meta.mtime is None
    assert meta.atime is None
    assert meta.mode == 0o601
    assert meta.uid == 500


@pytest.mark.asyncio
async def test_clear_times_drops_time_only_node(namespace):
    await namespace.set_attrs("/data/f.txt", mtime=1.0)
    await namespace.clear_times("/data/f.txt")
    assert namespace.meta_for("/data/f.txt") is None


@pytest.mark.asyncio
async def test_clear_times_leaves_links_alone(namespace):
    await namespace.symlink("/data/link", "/t1", 1.0)
    await namespace.clear_times("/data/link")
    assert namespace.meta_for("/data/link").mtime == 1.0


@pytest.mark.asyncio
async def test_unlink_glob_matches_segment_wise(namespace):
    await namespace.set_attrs("/data/a.log", mode=0o600)
    await namespace.set_attrs("/data/sub/b.log", mode=0o600)
    await namespace.set_attrs("/data/keep.txt", mode=0o600)
    assert await namespace.unlink_glob("/data/*.log") == 1
    assert namespace.meta_for("/data/a.log") is None
    assert namespace.meta_for("/data/sub/b.log") is not None
    assert namespace.meta_for("/data/keep.txt") is not None


@pytest.mark.asyncio
async def test_unlink_glob_purges_under_matched_dirs(namespace):
    await namespace.set_attrs("/data/sub/deep/a.txt", mode=0o600)
    await namespace.set_attrs("/data/other.txt", mode=0o600)
    assert await namespace.unlink_glob("/data/s*") == 1
    assert namespace.meta_for("/data/sub/deep/a.txt") is None
    assert namespace.meta_for("/data/other.txt") is not None


@pytest.mark.asyncio
async def test_mutations_write_through_to_store(registry):
    store = RAMNamespaceStore()
    namespace = Namespace(registry, store=store)
    await namespace.symlink("/data/link", "/t1", 1.0)
    await namespace.set_attrs("/data/f.txt", mode=0o601)
    entries = await store.load()
    assert entries["/data/link"]["target"] == "/t1"
    assert entries["/data/f.txt"]["mode"] == 0o601
    await namespace.unlink("/data/f.txt")
    assert "/data/f.txt" not in await store.load()
    await namespace.rename("/data/link", "/data/moved")
    entries = await store.load()
    assert "/data/link" not in entries
    assert entries["/data/moved"]["target"] == "/t1"


@pytest.mark.asyncio
async def test_ensure_loaded_hydrates_from_store(registry):
    store = RAMNamespaceStore()
    await store.set("/data/link", {"target": "/t1", "mtime": 1.0})
    await store.set("/data/f.txt", {"mode": 0o601, "uid": 500})
    namespace = Namespace(registry, store=store)
    assert namespace.meta_for("/data/f.txt") is None
    await namespace.ensure_loaded()
    assert namespace.readlink("/data/link") == "/t1"
    assert namespace.meta_for("/data/f.txt").mode == 0o601
    assert namespace.meta_for("/data/f.txt").uid == 500


@pytest.mark.asyncio
async def test_replace_nodes_wins_over_store_content(registry):
    store = RAMNamespaceStore()
    await store.set("/data/stale", {"mode": 0o600})
    namespace = Namespace(registry, store=store)
    await namespace.replace_nodes({"/data/fresh": NodeMeta(mode=0o601)})
    await namespace.ensure_loaded()
    assert namespace.meta_for("/data/stale") is None
    assert namespace.meta_for("/data/fresh").mode == 0o601
    assert "/data/stale" not in await store.load()


@pytest.mark.asyncio
async def test_drop_attrs_removes_applied_fields(namespace):
    await namespace.set_attrs("/data/f.txt", mode=0o601, uid=500)
    await namespace.drop_attrs("/data/f.txt", ["mode"])
    meta = namespace.meta_for("/data/f.txt")
    assert meta.mode is None
    assert meta.uid == 500


@pytest.mark.asyncio
async def test_drop_attrs_deletes_emptied_node(namespace):
    await namespace.set_attrs("/data/f.txt", mode=0o601)
    await namespace.drop_attrs("/data/f.txt", ["mode"])
    assert namespace.meta_for("/data/f.txt") is None


@pytest.mark.asyncio
async def test_drop_attrs_keeps_link_target(namespace):
    await namespace.symlink("/data/link", "/t1", 1.0)
    await namespace.drop_attrs("/data/link", ["target", "mtime"])
    assert namespace.readlink("/data/link") == "/t1"
    assert namespace.meta_for("/data/link").mtime is None


@pytest.mark.asyncio
async def test_drop_attrs_missing_node_is_noop(namespace):
    await namespace.drop_attrs("/data/nope.txt", ["mode"])
    assert namespace.meta_for("/data/nope.txt") is None


@pytest.mark.asyncio
async def test_drop_overlay_removes_orphaned_node(namespace):
    await namespace.set_attrs("/data/f.txt", mode=0o601, uid=500)
    assert await namespace.drop_overlay("/data/f.txt") is True
    assert namespace.meta_for("/data/f.txt") is None


@pytest.mark.asyncio
async def test_drop_overlay_keeps_symlink(namespace):
    await namespace.symlink("/data/link", "/data/target", 1.0)
    assert await namespace.drop_overlay("/data/link") is False
    assert namespace.readlink("/data/link") == "/data/target"


@pytest.mark.asyncio
async def test_drop_overlay_missing_node_is_noop(namespace):
    assert await namespace.drop_overlay("/data/nope.txt") is False


def test_user_defaults_before_resolution(namespace):
    assert namespace.user == "default"


@pytest.mark.asyncio
async def test_explicit_claim_wins_and_writes_through(registry):
    store = RAMNamespaceStore()
    await store.set_user("bob")
    namespace = Namespace(registry, store=store, user="alice")
    assert namespace.user == "alice"
    await namespace.ensure_loaded()
    assert namespace.user == "alice"
    assert await store.load_user() == "alice"


@pytest.mark.asyncio
async def test_bare_launch_adopts_stored_user(registry):
    store = RAMNamespaceStore()
    await store.set_user("alice")
    namespace = Namespace(registry, store=store)
    await namespace.ensure_loaded()
    assert namespace.user == "alice"


@pytest.mark.asyncio
async def test_bare_launch_empty_store_stays_default(registry):
    store = RAMNamespaceStore()
    namespace = Namespace(registry, store=store)
    await namespace.ensure_loaded()
    assert namespace.user == "default"
    assert await store.load_user() is None


@pytest.mark.asyncio
async def test_replace_nodes_still_resolves_user(registry):
    store = RAMNamespaceStore()
    await store.set_user("bob")
    namespace = Namespace(registry, store=store, user="alice")
    await namespace.replace_nodes({"/data/fresh": NodeMeta(mode=0o601)})
    assert namespace.user == "alice"
    assert await store.load_user() == "alice"


def test_node_meta_fields_roundtrip():
    meta = NodeMeta(target="/t1", mtime=2.0, mode=0o640, uid=500, gid="dev")
    fields = meta.to_fields()
    assert "atime" not in fields
    restored = NodeMeta.from_fields(fields)
    assert restored == meta


def test_node_meta_from_fields_ignores_unknown_keys():
    restored = NodeMeta.from_fields({"mode": 0o600, "bogus": "x"})
    assert restored.mode == 0o600
    assert restored.target is None
