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

import functools
from typing import Callable

from mirage.resource.base import BaseResource
from mirage.types import PathSpec
from mirage.utils.key_prefix import strip_mount
from mirage.workspace.mount.registry import MountRegistry


def resource_storage_id(resource: BaseResource) -> str:
    """Storage identity of a resource, with a fallback for custom ones.

    ``BaseResource`` supplies ``storage_id``, but a third-party resource
    may implement the protocol without inheriting it. Falling back to
    object identity keeps such a resource correct when it is mounted
    twice, instead of reading as two separate stores.

    Args:
        resource (BaseResource): The mounted resource.
    """
    fn = getattr(resource, "storage_id", None)
    if fn is None:
        return f"resource:{id(resource):x}"
    return fn()


def storage_key(registry: MountRegistry, path: PathSpec) -> str:
    """Identify the bytes an operand addresses, across mounts.

    ``cp`` and ``mv`` compare two operands to decide whether they name
    the same file. Within one mount the mount-relative path answers
    that, but across mounts it does not: two prefixes can address one
    store, and there a move would copy an object over itself and then
    unlink the source.

    The resource's storage id and the mount-relative path are joined
    into one path-like string rather than kept as separate components,
    so nested backings collapse onto the same key. Two disk mounts
    rooted at ``/srv/data`` and ``/srv/data/sub`` make ``/a/sub/x`` and
    ``/b/x`` the same file, and both render as
    ``disk:/srv/data/sub/x``. A delimiter between the two parts would
    keep them apart and let the move through.

    The mount-relative path keeps its leading slash so the generics'
    ``startswith(key + "/")`` containment test still marks a directory
    as an ancestor of its children, and only within one storage.

    Args:
        registry (MountRegistry): Mount set the operand is addressed in.
        path (PathSpec): The operand.
    """
    entry = registry.try_mount_for(path.virtual)
    if entry is None:
        # Outside every mount there is no storage to name, so fall back
        # to the path itself; such an operand fails on its own when the
        # command tries to read it.
        return path.virtual.rstrip("/")
    rel = strip_mount(path.virtual, entry.prefix.rstrip("/")).rstrip("/")
    return resource_storage_id(entry.resource) + rel


def make_storage_key(registry: MountRegistry) -> Callable[[PathSpec], str]:
    """Bind ``storage_key`` to one mount set for the transfer generics.

    Args:
        registry (MountRegistry): Mount set the operands are addressed in.
    """
    return functools.partial(storage_key, registry)
