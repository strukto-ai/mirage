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

from typing import Callable

from mirage.types import PathSpec
from mirage.utils.key_prefix import strip_mount
from mirage.workspace.mount.registry import MountRegistry


def make_storage_key(registry: MountRegistry) -> Callable[[PathSpec], str]:
    """Build the transfer generics' identity function for a mount set.

    ``cp`` and ``mv`` compare two operands to decide whether they name the
    same file. Within one mount the mount-relative path answers that, but
    across mounts it does not: two prefixes can address one store (two
    disk mounts on a shared root, one bucket mounted twice, the same
    resource object mounted at two prefixes), and there a move would copy
    an object over itself and then unlink the source. Pairing the
    resource's ``storage_id`` with the mount-relative path makes the
    comparison about bytes rather than about spelling.

    The mount-relative path keeps its leading slash so the generics'
    ``startswith(key + "/")`` containment test still marks a directory as
    an ancestor of its children, and only within one storage.

    Args:
        registry (MountRegistry): Mount set the operands are addressed in.
    """

    def storage_key(path: PathSpec) -> str:
        try:
            entry = registry.mount_for(path.virtual)
        except ValueError:
            # Outside every mount there is no storage to name, so fall
            # back to the path itself; such an operand fails on its own
            # when the command tries to read it.
            return path.virtual.rstrip("/")
        rel = strip_mount(path.virtual, entry.prefix.rstrip("/"))
        return f"{entry.resource.storage_id()}:{rel.rstrip('/') or '/'}"

    return storage_key
