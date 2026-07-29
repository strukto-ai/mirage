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

from mirage.resource.ram.store import RAMStore
from mirage.types import PathSpec
from mirage.utils.errors import eexist, enoent, enotdir
from mirage.utils.key_prefix import mounted_path
from mirage.utils.path import ancestors


def check_dest_parents(store: RAMStore, dst_spec: PathSpec, d: str) -> None:
    """Reject a destination whose parent chain is not all directories.

    Mirrors how ``rename(2)`` resolves the destination: a component that
    does not exist is ENOENT, a component that is a plain file is ENOTDIR
    (at any depth). Without this the store grows a key under a directory
    it never recorded, and that orphan makes both the phantom directory
    and its real parent unlistable.

    Shared by every op that places a key at a caller-supplied path
    (``rename``, ``copy``, ``create``, ``write_bytes``): none of them
    creates parents (that is ``mkdir -p``), so all owe the destination the
    same probe. The real-filesystem backends get this from the kernel.

    Args:
        store (RAMStore): The backing store.
        dst_spec (PathSpec): Destination operand, reported in the error.
        d (str): Normalized destination key.

    Raises:
        NotADirectoryError: A parent component is a plain file.
        FileNotFoundError: A parent component does not exist.
    """
    for ancestor in ancestors(d):
        if ancestor in store.dirs:
            continue
        if ancestor in store.files:
            raise enotdir(dst_spec)
        raise enoent(dst_spec)


def check_mkdir_target(store: RAMStore, spec: PathSpec, key: str,
                       parents: bool) -> None:
    """Reject a ``mkdir`` the store cannot satisfy.

    The companion of :func:`check_dest_parents` for the one op that may
    create its own parents, and the two flag modes fail differently
    because GNU implements them differently:

    * Plain ``mkdir`` issues one ``mkdir(2)`` on the whole path, so an
      existing target is EEXIST whichever kind it is. Its parent chain
      stays :func:`check_dest_parents`' job, which reports the operand
      because that is what the kernel resolves.
    * ``mkdir -p`` walks the chain itself, creating as it goes, so it
      reports the *component* it tripped on rather than the operand:
      ``mkdir -p a.txt/sub`` is "cannot create directory 'a.txt': Not a
      directory". Reaching the target itself as a plain file is EEXIST,
      not ENOTDIR. An existing directory anywhere in the chain is
      success, which is what makes ``-p`` idempotent.

    Without this a store has no kernel to refuse a directory key that
    collides with a file key: ``-p`` added it anyway, the directory
    shadowed the file, and reading it started reporting EISDIR while the
    bytes stayed orphaned in the store. Pinned against GNU coreutils in
    docker.

    Args:
        store (RAMStore): The backing store.
        spec (PathSpec): The operand, reported when the target is to
            blame.
        key (str): Normalized target key.
        parents (bool): Whether ``-p`` was given.

    Raises:
        FileExistsError: The target already exists (plain ``mkdir``), or
            ``-p`` reached it as a plain file.
        NotADirectoryError: ``-p`` crossed a component that is a plain
            file.
    """
    if not parents:
        if key in store.dirs or key in store.files:
            raise eexist(spec)
        return
    for component in (*ancestors(key), key):
        if component not in store.files:
            continue
        named = mounted_path(spec, component)
        if component == key:
            raise eexist(named)
        raise enotdir(named)
