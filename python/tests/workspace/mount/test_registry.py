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

from mirage.cache.file.ram import RAMFileCacheStore
from mirage.commands.registry import command
from mirage.commands.spec.types import CommandSpec
from mirage.io.types import IOResult
from mirage.resource.base import BaseResource
from mirage.resource.ram import RAMResource
from mirage.resource.ssh import SSHConfig, SSHResource
from mirage.types import MountMode, PathSpec
from mirage.workspace.mount import MountCommandUnsupported, MountRegistry

# ── mount_for ──────────────────────────────────


def test_mount_for_exact(registry):
    mount = registry.mount_for("/data/file.txt")
    assert mount.prefix == "/data/"


def test_mount_for_nested_path(registry):
    mount = registry.mount_for("/data/sub/deep/file.txt")
    assert mount.prefix == "/data/"


def test_mount_for_prefix_root(registry):
    mount = registry.mount_for("/data")
    assert mount.prefix == "/data/"


def test_mount_for_no_match(registry):
    with pytest.raises(ValueError, match="no mount"):
        registry.mount_for("/unknown/file.txt")


def test_mount_for_dev_default(registry):
    mount = registry.mount_for("/dev/null")
    assert mount.prefix == "/dev/"


# ── longest prefix match ──────────────────────


def test_nested_prefix_longest_match(nested_registry):
    mount = nested_registry.mount_for("/data/sub/deep.txt")
    assert mount.prefix == "/data/sub/"


def test_nested_prefix_outer(nested_registry):
    mount = nested_registry.mount_for("/data/file.txt")
    assert mount.prefix == "/data/"


# ── descendant_mounts ──────────────────────────


def test_descendant_mounts_under_root(multi_registry):
    descs = multi_registry.descendant_mounts("/")
    prefixes = [m.prefix for m in descs]
    # /dev/ is auto-mounted by the registry; ours are /s3/, /disk/, /ram/.
    assert "/disk/" in prefixes
    assert "/ram/" in prefixes
    assert "/s3/" in prefixes


def test_descendant_mounts_under_root_sorted(multi_registry):
    descs = multi_registry.descendant_mounts("/")
    prefixes = [m.prefix for m in descs]
    assert prefixes == sorted(prefixes)


def test_descendant_mounts_at_a_mount_root_is_empty(registry):
    # /data/ is a mount; nothing is below it.
    assert registry.descendant_mounts("/data") == []
    assert registry.descendant_mounts("/data/") == []


def test_descendant_mounts_inside_a_mount_is_empty(registry):
    assert registry.descendant_mounts("/data/sub") == []


def test_descendant_mounts_nested(nested_registry):
    # Top: /data/, /data/sub/.
    descs = nested_registry.descendant_mounts("/")
    prefixes = [m.prefix for m in descs]
    assert "/data/" in prefixes
    assert "/data/sub/" in prefixes
    # Below /data/, the only descendant is /data/sub/.
    descs2 = nested_registry.descendant_mounts("/data")
    assert [m.prefix for m in descs2] == ["/data/sub/"]
    # /data/ as a mount root returns its own children only (excludes self).
    assert "/data/" not in [m.prefix for m in descs2]


def test_descendant_mounts_excludes_self(nested_registry):
    descs = nested_registry.descendant_mounts("/data")
    assert all(m.prefix != "/data/" for m in descs)


def test_descendant_mounts_unrelated_path(multi_registry):
    # A path in /s3/ has no mount nested below it.
    assert multi_registry.descendant_mounts("/s3/data") == []


# ── resolve ────────────────────────────────────


def test_resolve_strips_prefix(registry):
    prov, pp, mode = registry.resolve("/data/hello.txt")
    assert pp == "/hello.txt"
    assert prov.name == "ram"


def test_resolve_root_path(registry):
    _, pp, _ = registry.resolve("/data")
    assert pp == "/"


def test_resolve_trailing_slash(registry):
    _, pp, _ = registry.resolve("/data/sub/")
    assert pp.endswith("/")


def test_resolve_mode(registry):
    _, _, mode = registry.resolve("/data/file.txt")
    assert mode == MountMode.WRITE


def test_resolve_no_match(registry):
    with pytest.raises(ValueError):
        registry.resolve("/unknown/path")


# ── multi mount (s3 + disk + ram) ──────────────


def test_multi_mount_resolves_s3(multi_registry):
    mount = multi_registry.mount_for("/s3/data/report.csv")
    assert mount.prefix == "/s3/"
    assert mount.resource.name == "s3"


def test_multi_mount_resolves_disk(multi_registry):
    mount = multi_registry.mount_for("/disk/readme.txt")
    assert mount.prefix == "/disk/"
    assert mount.resource.name == "disk"


def test_multi_mount_resolves_ram(multi_registry):
    mount = multi_registry.mount_for("/ram/hello.txt")
    assert mount.prefix == "/ram/"
    assert mount.resource.name == "ram"


def test_multi_mount_modes(multi_registry):
    _, _, s3_mode = multi_registry.resolve("/s3/file.txt")
    _, _, disk_mode = multi_registry.resolve("/disk/file.txt")
    _, _, ram_mode = multi_registry.resolve("/ram/file.txt")
    assert s3_mode == MountMode.READ
    assert disk_mode == MountMode.WRITE
    assert ram_mode == MountMode.WRITE


def test_multi_mount_resource_paths(multi_registry):
    _, pp_s3, _ = multi_registry.resolve("/s3/data/report.csv")
    _, pp_disk, _ = multi_registry.resolve("/disk/readme.txt")
    _, pp_ram, _ = multi_registry.resolve("/ram/hello.txt")
    assert pp_s3 == "/data/report.csv"
    assert pp_disk == "/readme.txt"
    assert pp_ram == "/hello.txt"


# ── mount ──────────────────────────────────────


def test_mount_returns_mount_object():
    reg = MountRegistry()
    p = RAMResource()
    m = reg.mount("/test/", p, MountMode.READ)
    assert m.prefix == "/test/"
    assert m.resource is p


def test_mount_normalizes_prefix():
    reg = MountRegistry()
    m = reg.mount("/test/", RAMResource(), MountMode.READ)
    assert m.prefix == "/test/"


def test_mount_duplicate_raises(registry):
    with pytest.raises(ValueError, match="duplicate"):
        registry.mount("/data/", RAMResource())


# ── mounts listing ─────────────────────────────


def test_mounts_returns_all(multi_registry):
    prefixes = {m.prefix for m in multi_registry.mounts()}
    assert "/s3/" in prefixes
    assert "/disk/" in prefixes
    assert "/ram/" in prefixes
    assert "/dev/" in prefixes


def test_mounts_count(multi_registry):
    assert len(multi_registry.mounts()) == 4


# ── group_by_mount ─────────────────────────────


def test_group_by_mount(multi_registry):
    groups = multi_registry.group_by_mount(
        ["/s3/a.txt", "/s3/b.txt", "/disk/c.txt"])
    assert len(groups) == 2
    s3_group = [g for g in groups if g[0].prefix == "/s3/"][0]
    assert len(s3_group[1]) == 2
    disk_group = [g for g in groups if g[0].prefix == "/disk/"][0]
    assert len(disk_group[1]) == 1


def test_group_by_mount_single(multi_registry):
    groups = multi_registry.group_by_mount(["/ram/hello.txt"])
    assert len(groups) == 1


# ── get_resource_type ──────────────────────────


def test_get_resource_type_s3(multi_registry):
    assert multi_registry.get_resource_type("/s3/file.txt") == "s3"


def test_get_resource_type_disk(multi_registry):
    assert multi_registry.get_resource_type("/disk/file.txt") == "disk"


def test_get_resource_type_ram(multi_registry):
    assert multi_registry.get_resource_type("/ram/file.txt") == "ram"


def test_get_resource_type_none(multi_registry):
    assert multi_registry.get_resource_type(None) is None


def test_get_resource_type_unknown(multi_registry):
    assert multi_registry.get_resource_type("/unknown/f") is None


# ── find_resource_by_name ──────────────────────


def test_find_resource_s3(multi_registry):
    prov = multi_registry.find_resource_by_name("s3")
    assert prov is not None
    assert prov.name == "s3"


def test_find_resource_disk(multi_registry):
    prov = multi_registry.find_resource_by_name("disk")
    assert prov is not None
    assert prov.name == "disk"


def test_find_resource_ram(multi_registry):
    prov = multi_registry.find_resource_by_name("ram")
    assert prov is not None


def test_find_resource_none(multi_registry):
    assert multi_registry.find_resource_by_name(None) is None


def test_find_resource_missing(multi_registry):
    assert multi_registry.find_resource_by_name("nonexistent") is None


# ── mount_for_command ──────────────────────────


def test_mount_for_command_cat(registry):
    mount = registry.mount_for_command("cat")
    assert mount is not None


def test_mount_for_command_nonexistent(registry):
    assert registry.mount_for_command("nonexistent_cmd") is None


def test_mount_for_command_grep(multi_registry):
    mount = multi_registry.mount_for_command("grep")
    assert mount is not None


# ── resolve_mount cache redirect ───────────────


def _remote_registry_with_cache():
    reg = MountRegistry()
    reg.mount("/ssh/", SSHResource(SSHConfig(host="example", root="/srv")),
              MountMode.WRITE)
    cache = RAMFileCacheStore()
    reg.attach_file_cache(cache)
    return reg, cache


@pytest.mark.asyncio
async def test_resolve_mount_keeps_cached_read_on_real_mount():
    # Warm reads are served in place by with_read_cache, so a cached
    # read-only command stays on its real mount (keeping its safeguards and
    # custom handlers) instead of being redirected to the cache mount.
    reg, cache = _remote_registry_with_cache()
    await cache.set("/ssh/a.txt", b"hi")
    scope = PathSpec(resource_path="ssh/a.txt",
                     virtual="/ssh/a.txt",
                     directory="/ssh",
                     resolved=True)
    mount = await reg.resolve_mount("cat", [scope], "/ssh")
    assert mount.prefix == "/ssh/"


@pytest.mark.asyncio
async def test_resolve_mount_keeps_cached_write_on_remote():
    reg, cache = _remote_registry_with_cache()
    await cache.set("/ssh/a.txt", b"hi")
    scope = PathSpec(resource_path="ssh/a.txt",
                     virtual="/ssh/a.txt",
                     directory="/ssh",
                     resolved=True)
    mount = await reg.resolve_mount("rm", [scope], "/ssh")
    assert mount.prefix == "/ssh/"


class _LimitedResource(BaseResource):
    name = "limited"


class _FallbackResource(BaseResource):
    name = "fallback"


@command("fallback-only", resource="fallback", spec=CommandSpec())
async def _fallback_only(_store, paths, *texts, **kw):
    return b"fallback", IOResult()


def _path_bound_registry_with_default():
    reg = MountRegistry()
    reg.mount("/limited/", _LimitedResource(), MountMode.WRITE)
    fallback = _FallbackResource()
    fallback.register(_fallback_only)
    reg.mount("/", fallback, MountMode.WRITE)
    return reg


@pytest.mark.asyncio
async def test_resolve_mount_rejects_path_bound_unsupported_command():
    reg = _path_bound_registry_with_default()
    scope = PathSpec(resource_path="limited/file.txt",
                     virtual="/limited/file.txt",
                     directory="/limited",
                     resolved=True)
    with pytest.raises(
            MountCommandUnsupported,
            match="fallback-only: not supported on the limited backend"):
        await reg.resolve_mount("fallback-only", [scope], "/limited")


@pytest.mark.asyncio
async def test_resolve_mount_allows_default_without_path_binding():
    reg = _path_bound_registry_with_default()
    mount = await reg.resolve_mount("fallback-only", [], "/limited")
    assert mount is not None
    assert mount.prefix == "/"
