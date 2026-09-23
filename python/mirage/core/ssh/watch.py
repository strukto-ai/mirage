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

from collections.abc import AsyncIterator

import asyncssh

from mirage.accessor.ssh import SSHAccessor
from mirage.core.ssh.client import _abs
from mirage.core.ssh.config import SSHConfig
from mirage.core.timeutil import epoch_to_iso
from mirage.types import PathSpec, WalkEntry
from mirage.utils.key_prefix import mount_prefix_of
from mirage.watch.base import DeltaHook
from mirage.watch.delta import ListingDeltaHook
from mirage.watch.fingerprint import stat_fingerprint


async def _descend(
        sftp: asyncssh.SFTPClient, config: SSHConfig,
        path: str) -> AsyncIterator[tuple[str, bool, str | None, int | None]]:
    """Yield (mount-relative path, is_dir, mtime, size) under a path.

    One ``readdir`` per directory, which is one round trip per
    directory; SFTP has no recursive listing. Each entry already
    carries its attributes, so no extra stat is needed.

    Args:
        sftp (asyncssh.SFTPClient): Open SFTP channel.
        config (SSHConfig): Backend config, for the remote root.
        path (str): Mount-relative directory to descend into.
    """
    try:
        listing = await sftp.readdir(_abs(config, path))
    except asyncssh.SFTPNoSuchFile:
        return
    for entry in listing:
        filename = (entry.filename.decode("utf-8") if isinstance(
            entry.filename, bytes) else entry.filename)
        if filename in (".", ".."):
            continue
        child = f"{path.rstrip('/')}/{filename}"
        attrs = entry.attrs
        if attrs.type == asyncssh.FILEXFER_TYPE_DIRECTORY:
            yield child, True, None, None
            async for row in _descend(sftp, config, child):
                yield row
            continue
        modified = epoch_to_iso(
            attrs.mtime) if attrs.mtime is not None else None
        yield child, False, modified, attrs.size


class SSHWalk:
    """Recursive SFTP descent feeding the generic listing differ.

    Reads the remote host directly, never through mirage's caches, as
    the DeltaHook contract requires. Fingerprints on mtime, the same
    value ``ssh`` stat reports.

    Unlike the object stores, this costs one round trip per directory,
    because SFTP has no recursive listing to ask for. Poll cadence
    should account for the shape of the tree.
    """

    def __init__(self, accessor: SSHAccessor) -> None:
        """Args:
            accessor (SSHAccessor): Backend handle.
        """
        self._accessor = accessor

    async def __call__(self, root: PathSpec) -> AsyncIterator[WalkEntry]:
        """Yield every entry under ``root``.

        Args:
            root (PathSpec): Watch root (mount-virtual path).
        """
        accessor = self._accessor
        prefix = mount_prefix_of(root.virtual, root.vfs_path)
        sftp = await accessor.sftp()
        async for relative, is_dir, modified, size in _descend(
                sftp, accessor.config, root.mount_path):
            virtual = (prefix.rstrip("/") + relative if prefix else relative)
            if is_dir:
                yield WalkEntry(virtual=virtual, is_dir=True, fingerprint=None)
                continue
            yield WalkEntry(virtual=virtual,
                            is_dir=False,
                            fingerprint=stat_fingerprint(None, modified, size),
                            size=size,
                            modified=modified)


def build_delta_hook(accessor: SSHAccessor) -> DeltaHook:
    """Build the SSH delta hook.

    Args:
        accessor (SSHAccessor): Backend handle.
    """
    return ListingDeltaHook(SSHWalk(accessor))
