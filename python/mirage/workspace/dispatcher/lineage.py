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

from mirage.context.session_context import require_paths_writable
from mirage.types import MountMode, PathSpec
from mirage.workspace.mount.mount import MountEntry

# The prefix governing a path no mount owns. Inside a workspace there
# is always one -- ``Workspace`` synthesizes a root when no spec claims
# it -- so a session statement about ``/`` (a ``mounts: {"/": "read"}``
# cap, a mode-carrying show entry) is scored against that root and
# reaches ``/toplink``. This constant is what remains when the registry
# has no root at all: a Dispatcher built outside a workspace.
BARE_PREFIX = "/"


def turf_of(mount: MountEntry | None) -> str:
    """The prefix a namespace path is governed by.

    A node-table entry (a symlink, an attr overlay) is namespace state
    with no backend behind it, but it lives at a path, and the mount
    whose subtree holds that path is what a session statement about it
    is scored against. Its lineage is therefore the same longest-prefix
    rule dispatch resolves the path by, and the prefix is the whole of
    what the rule needs: it is the key a profile's per-mount mode is
    written under.

    Args:
        mount (MountEntry | None): the mount owning the path
            (``try_mount_for``), None when no mount does.
    """
    if mount is None:
        return BARE_PREFIX
    return mount.prefix


def require_turf_writable(mount: MountEntry | None, path: PathSpec) -> None:
    """Refuse a mutation outside the mount mode or session's grant.

    A symlink create, a link unlink or rename endpoint, and the
    no-mount attr overlay all mutate namespace state at a path, and a
    session handed a read-only view of that path must not reach any of
    them, or a read-only grant would stop a file while waving its
    sibling link through. Same voice as the backend gate:
    ``ReadOnlyError`` with EROFS stamped and the operand as
    ``filename``.

    Mount mode is an authorization ceiling for both backend and namespace
    writes. Backend capabilities are resolved only after admission.

    Args:
        mount (MountEntry | None): the mount owning the path
            (``try_mount_for``), None when no mount does.
        path (PathSpec): the path being written.

    Raises:
        ReadOnlyError: the mount or session's mode is read-only.
    """
    require_paths_writable(
        [path], turf_of(mount),
        mount.mode if mount is not None else MountMode.WRITE)
