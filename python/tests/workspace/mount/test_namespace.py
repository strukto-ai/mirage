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
