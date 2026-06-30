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
