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

from mirage.fuse.backend import (FSKIT_MOUNT_ROOT, MountBackend,
                                 check_mountpoint, check_platform, check_sizes,
                                 resolve_backend)
from mirage.resource.ram import RAMResource
from mirage.resource.slack import SlackConfig, SlackResource
from mirage.types import MountMode
from mirage.workspace import Workspace


def _slack():
    return SlackResource(config=SlackConfig(token="test-token"))


@pytest.mark.parametrize("value,expected", [
    (None, MountBackend.FUSE),
    ("", MountBackend.FUSE),
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
    # mount, so the only safe value is also the default.
    assert [b.value for b in MountBackend] == ["vfs", "fuse", "fskit"]


def test_resolve_backend_rejects_vfs():
    # vfs registers nothing with the kernel, so it is not a mount target.
    with pytest.raises(ValueError, match="does not register a mountpoint"):
        resolve_backend("vfs")


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


def test_check_sizes_passes_for_byte_stores():
    ws = Workspace({"/": RAMResource()}, mode=MountMode.WRITE)
    assert ws.ops.unsized_mounts() == []
    check_sizes(MountBackend.FSKIT, ws.ops, "")


def test_check_sizes_refuses_size_unknown_resource():
    ws = Workspace({"/slack/": _slack()}, mode=MountMode.READ)
    with pytest.raises(RuntimeError, match="would return empty files"):
        check_sizes(MountBackend.FSKIT, ws.ops, "")


def test_check_sizes_names_the_offending_mount():
    ws = Workspace({
        "/ram/": RAMResource(),
        "/slack/": _slack()
    },
                   mode=MountMode.READ)
    with pytest.raises(RuntimeError) as exc:
        check_sizes(MountBackend.FSKIT, ws.ops, "")
    message = str(exc.value)
    assert "/slack/ (slack)" in message
    assert "/ram/" not in message


def test_check_sizes_respects_the_root_prefix():
    ws = Workspace({
        "/ram/": RAMResource(),
        "/slack/": _slack()
    },
                   mode=MountMode.READ)
    # Scoping the mount to the byte-store subtree is the supported escape
    # hatch for a workspace that also holds API resources.
    check_sizes(MountBackend.FSKIT, ws.ops, "/ram/")


def test_check_sizes_ignores_fuse_backend():
    ws = Workspace({"/slack/": _slack()}, mode=MountMode.READ)
    check_sizes(MountBackend.FUSE, ws.ops, "")


def test_history_mount_does_not_block_a_root_fskit_mount():
    # /.bash_history is mounted into every workspace; it renders from
    # in-memory events, so it must not be treated as size-unknown.
    ws = Workspace({"/": RAMResource()}, mode=MountMode.WRITE)
    prefixes = [p for p, _ in ws.ops.unsized_mounts()]
    assert "/.bash_history/" not in prefixes
