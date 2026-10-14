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

from mirage.accessor.ram import RAMAccessor
from mirage.core.dev.device import active_pipe
from mirage.core.ram.dest import (
    check_dest_parents,
    check_rename,
    lookup_error,
)
from mirage.errors.fs import fs_error
from mirage.errors.types import FsCondition
from mirage.types import PathSpec
from mirage.utils.dates import now_iso
from mirage.utils.path import norm
from mirage.vfs.ram.store import RAMStore


def _move_subtree(store: RAMStore, s: str, d: str) -> None:
    """Re-key every descendant of a renamed directory.

    A synthetic-directory store keeps subdirectories as entries of their
    own, so moving only the files leaves those behind. The phantom tree
    the orphans imply makes the old name reappear in its parent's listing
    and then stat as missing -- the same shape ``check_dest_parents``
    refuses on the way in.

    Args:
        store (RAMStore): the backing store.
        s (str): normalized source key.
        d (str): normalized destination key.
    """
    prefix = s.rstrip("/") + "/"
    new_prefix = d.rstrip("/") + "/"
    for key in list(store.dirs):
        if key.startswith(prefix):
            store.dirs.discard(key)
            store.dirs.add(new_prefix + key[len(prefix) :])
    for key in list(store.files):
        if key.startswith(prefix):
            store.files[new_prefix + key[len(prefix) :]] = store.files.pop(key)
    for key in list(store.modified):
        if key.startswith(prefix):
            store.modified[new_prefix + key[len(prefix) :]] = (
                store.modified.pop(key)
            )
    for key in list(store.attrs):
        if key.startswith(prefix):
            store.attrs[new_prefix + key[len(prefix) :]] = store.attrs.pop(key)


async def rename(
    accessor: RAMAccessor, src_spec: PathSpec, dst_spec: PathSpec
) -> None:
    """Move one key, a directory with its subtree.

    A live descriptor at either end is the shell's to release, so moving
    one or over one is EPERM (GNU: ``mv /dev/fd/63 /dev/fd/62`` is
    "Operation not permitted").

    Args:
        accessor (RAMAccessor): the RAM accessor.
        src_spec (PathSpec): the key to move.
        dst_spec (PathSpec): where it goes.
    """
    src = src_spec.mount_path
    dst = dst_spec.mount_path
    store = accessor.store
    s, d = norm(src), norm(dst)
    if active_pipe(accessor, s) is not None:
        raise fs_error(src_spec, FsCondition.EPERM)
    if active_pipe(accessor, d) is not None:
        raise fs_error(dst_spec, FsCondition.EPERM)
    now = now_iso()
    check_dest_parents(store, dst_spec, d)
    check_rename(store, src_spec, s, dst_spec, d)
    if s in store.files:
        store.files[d] = store.files.pop(s)
        store.modified[d] = store.modified.pop(s, now)
        if s in store.attrs:
            store.attrs[d] = store.attrs.pop(s)
    elif s in store.dirs:
        store.dirs.discard(s)
        store.dirs.add(d)
        store.modified[d] = store.modified.pop(s, now)
        if s in store.attrs:
            store.attrs[d] = store.attrs.pop(s)
        _move_subtree(store, s, d)
    else:
        raise lookup_error(store, src_spec, s)
