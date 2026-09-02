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
from pydantic import SecretStr

from mirage.fuse.backend import (FSKIT_MOUNT_ROOT, MountBackend,
                                 check_mountpoint, check_platform, check_sizes,
                                 check_writes, prepare_backend,
                                 require_kernel_backend, resolve_backend)
from mirage.resource.notion import NotionConfig, NotionResource
from mirage.resource.ram import RAMResource
from mirage.types import MountMode
from mirage.workspace import Workspace
from mirage.workspace.mount.spec import Mount


def _notion():
    # Notion page.json is class N in the size rollout (a per-file block
    # fetch would be needed), so it stays size-unknown permanently and is
    # the stable guinea pig for the fskit size guard.
    return NotionResource(config=NotionConfig(api_key=SecretStr("k")))


@pytest.mark.parametrize("value,expected", [
    (None, MountBackend.VFS),
    ("", MountBackend.VFS),
    ("vfs", MountBackend.VFS),
    ("fuse", MountBackend.FUSE),
    ("fskit", MountBackend.FSKIT),
    ("FSKIT", MountBackend.FSKIT),
    (MountBackend.FSKIT, MountBackend.FSKIT),
])
def test_resolve_backend(value, expected):
    assert resolve_backend(value) is expected


def test_resolve_backend_rejects_unknown():
    with pytest.raises(ValueError, match="unknown mount backend"):
        resolve_backend("auto")


def test_no_auto_backend():
    # Deliberate: auto-selecting fskit would silently break every API-backed
    # mount, so the only safe value is also the default. New backends may be
    # added; "auto" may not.
    assert "auto" not in [b.value for b in MountBackend]
    assert [b.value for b in MountBackend] == ["vfs", "fuse", "fskit", "nfs"]


def test_missing_backend_is_vfs_everywhere():
    # One meaning for "absent": the Mount dataclass default, an absent YAML
    # key, and None here all land on VFS. resolve_backend never reinterprets
    # a missing value as a kernel mount.
    assert resolve_backend(None) is MountBackend.VFS
    assert Mount(RAMResource()).backend is MountBackend.VFS


def test_require_kernel_backend_rejects_vfs():
    with pytest.raises(ValueError, match="does not register a mountpoint"):
        require_kernel_backend(MountBackend.VFS)


def test_prepare_backend_rejects_vfs():
    with pytest.raises(ValueError, match="does not register a mountpoint"):
        prepare_backend("vfs")


def test_prepare_backend_asserts_macos_for_fskit(monkeypatch):
    # The macOS assert must be unskippable: every mount path goes through
    # prepare_backend, so a new one cannot pick up fskit and forget it.
    monkeypatch.setattr("mirage.fuse.backend.sys.platform", "linux")
    with pytest.raises(RuntimeError, match="macOS-only"):
        prepare_backend("fskit")


def test_prepare_backend_runs_every_fskit_guard(monkeypatch, caplog):
    monkeypatch.setattr("mirage.fuse.backend.sys.platform", "darwin")
    ws = Workspace({"/notion/": _notion()}, mode=MountMode.READ)
    # mountpoint guard
    with pytest.raises(ValueError, match="only mounts under /Volumes"):
        prepare_backend("fskit", mountpoint="/tmp/x")
    # size guard: warns but the mount proceeds
    with caplog.at_level("WARNING", logger="mirage.fuse.backend"):
        assert prepare_backend("fskit", ops=ws.ops,
                               mountpoint="/Volumes/m") is MountBackend.FSKIT
    assert "will read as empty" in caplog.text
    # both satisfied
    ram = Workspace({"/": RAMResource()}, mode=MountMode.WRITE)
    assert prepare_backend("fskit", ops=ram.ops,
                           mountpoint="/Volumes/m") is MountBackend.FSKIT


def test_check_platform_allows_fuse_everywhere(monkeypatch):
    monkeypatch.setattr("sys.platform", "linux")
    check_platform(MountBackend.FUSE)


def test_check_platform_rejects_fskit_off_darwin(monkeypatch):
    monkeypatch.setattr("mirage.fuse.backend.sys.platform", "linux")
    with pytest.raises(RuntimeError, match="macOS-only"):
        check_platform(MountBackend.FSKIT)


@pytest.mark.parametrize("mountpoint", [
    FSKIT_MOUNT_ROOT,
    f"{FSKIT_MOUNT_ROOT}/mirage-abc",
    f"{FSKIT_MOUNT_ROOT}/nested/deep",
])
def test_check_mountpoint_accepts_volumes(mountpoint):
    check_mountpoint(MountBackend.FSKIT, mountpoint)


@pytest.mark.parametrize("mountpoint", [
    "/tmp/mirage-abc",
    "/Users/me/mnt",
    "/Volumes-not-really/x",
])
def test_check_mountpoint_rejects_non_volumes(mountpoint):
    with pytest.raises(ValueError, match="only mounts under /Volumes"):
        check_mountpoint(MountBackend.FSKIT, mountpoint)


def test_check_mountpoint_ignores_fuse_backend():
    # The /Volumes rule is an FSKit constraint, not a mirage one.
    check_mountpoint(MountBackend.FUSE, "/tmp/mirage-abc")


def test_check_writes_warns_for_writable_mount(caplog):
    ws = Workspace({"/": RAMResource()}, mode=MountMode.WRITE)
    with caplog.at_level("WARNING", logger="mirage.fuse.backend"):
        check_writes(MountBackend.FSKIT, ws.ops, "")
    assert "zeroed pages" in caplog.text
    assert "/ (ram)" in caplog.text


def test_check_writes_silent_for_read_mounts(caplog):
    ws = Workspace({"/": RAMResource()}, mode=MountMode.READ)
    with caplog.at_level("WARNING", logger="mirage.fuse.backend"):
        check_writes(MountBackend.FSKIT, ws.ops, "")
    assert caplog.text == ""


def test_check_writes_ignores_other_backends(caplog):
    ws = Workspace({"/": RAMResource()}, mode=MountMode.WRITE)
    with caplog.at_level("WARNING", logger="mirage.fuse.backend"):
        check_writes(MountBackend.FUSE, ws.ops, "")
    assert caplog.text == ""


def test_check_sizes_passes_for_byte_stores(caplog):
    ws = Workspace({"/": RAMResource()}, mode=MountMode.WRITE)
    assert ws.ops.unsized_mounts() == []
    with caplog.at_level("WARNING", logger="mirage.fuse.backend"):
        check_sizes(MountBackend.FSKIT, ws.ops, "")
    assert caplog.text == ""


def test_check_sizes_warns_for_size_unknown_resource(caplog):
    ws = Workspace({"/notion/": _notion()}, mode=MountMode.READ)
    with caplog.at_level("WARNING", logger="mirage.fuse.backend"):
        check_sizes(MountBackend.FSKIT, ws.ops, "")
    assert "will read as empty" in caplog.text


def test_check_sizes_names_the_offending_mount(caplog):
    ws = Workspace({
        "/ram/": RAMResource(),
        "/notion/": _notion()
    },
                   mode=MountMode.READ)
    with caplog.at_level("WARNING", logger="mirage.fuse.backend"):
        check_sizes(MountBackend.FSKIT, ws.ops, "")
    assert "/notion/ (notion)" in caplog.text
    assert "/ram/" not in caplog.text


def test_check_sizes_respects_the_root_prefix(caplog):
    ws = Workspace({
        "/ram/": RAMResource(),
        "/notion/": _notion()
    },
                   mode=MountMode.READ)
    # Scoping the mount to the byte-store subtree keeps the warning quiet
    # for a workspace that also holds API resources.
    with caplog.at_level("WARNING", logger="mirage.fuse.backend"):
        check_sizes(MountBackend.FSKIT, ws.ops, "/ram/")
    assert caplog.text == ""


def test_check_sizes_ignores_fuse_backend():
    ws = Workspace({"/notion/": _notion()}, mode=MountMode.READ)
    check_sizes(MountBackend.FUSE, ws.ops, "")


def test_history_mount_does_not_block_a_root_fskit_mount():
    # /.bash_history is mounted into every workspace; it renders from
    # in-memory events, so it must not be treated as size-unknown.
    ws = Workspace({"/": RAMResource()}, mode=MountMode.WRITE)
    prefixes = [p for p, _ in ws.ops.unsized_mounts()]
    assert "/.bash_history/" not in prefixes
