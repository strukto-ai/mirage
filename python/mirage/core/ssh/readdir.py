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

import asyncio
import logging
from functools import partial

import asyncssh

from mirage.accessor.ssh import SSHAccessor
from mirage.core.ssh.constants import SCOPE_ERROR
from mirage.core.ssh.stat import attrs_to_file_stat
from mirage.core.ssh.utils import join_root
from mirage.errors.fs import eacces, listing_error
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.key_prefix import mount_prefix_of

logger = logging.getLogger(__name__)
# SFTP 3 has one code for every unresolvable name, so a component under a
# file arrives as SFTPNoSuchFile just like a component that is simply
# absent; later protocol versions split SFTPNotADirectory out. Both mean
# "this name does not resolve", which is what a probe asks.
UNRESOLVED = (
    asyncssh.SFTPNoSuchFile,
    asyncssh.SFTPNoSuchPath,
    asyncssh.SFTPNotADirectory,
)


async def _attrs_or_none(
    accessor: SSHAccessor, key: str
) -> asyncssh.SFTPAttrs | None:
    sftp = await accessor.sftp()
    try:
        return await sftp.stat(join_root(accessor.config.root, key))
    except UNRESOLVED:
        return None


async def _is_file(accessor: SSHAccessor, key: str) -> bool:
    attrs = await _attrs_or_none(accessor, key)
    return attrs is not None and attrs.type != asyncssh.FILEXFER_TYPE_DIRECTORY


async def _is_dir(accessor: SSHAccessor, key: str) -> bool:
    attrs = await _attrs_or_none(accessor, key)
    return attrs is not None and attrs.type == asyncssh.FILEXFER_TYPE_DIRECTORY


async def _row_of(
    accessor: SSHAccessor, remote: str, name: str, attrs: asyncssh.SFTPAttrs
) -> FileStat:
    """A listed entry as ``stat`` answers it.

    Readdir attrs are lstat-style, so a link is stat'ed once more, links
    followed, as ``stat`` reads it. A link that resolves to nothing the
    session may read keeps its listed name as a file.

    Args:
        accessor (SSHAccessor): the mount's connection.
        remote (str): the entry's remote path.
        name (str): its name.
        attrs (asyncssh.SFTPAttrs): its listed attributes.
    """
    if attrs.type != asyncssh.FILEXFER_TYPE_SYMLINK:
        return attrs_to_file_stat(name, attrs)
    sftp = await accessor.sftp()
    try:
        return attrs_to_file_stat(name, await sftp.stat(remote))
    except (*UNRESOLVED, asyncssh.SFTPPermissionDenied) as exc:
        logger.debug("ssh readdir: %s resolves to nothing: %s", remote, exc)
        return FileStat(name=name, type=FileType.FILE)


async def readdir(
    accessor: SSHAccessor, path_spec: PathSpec
) -> list[FileStat]:
    virtual = path_spec.virtual
    prefix = mount_prefix_of(path_spec.virtual, path_spec.vfs_path)
    path = path_spec.directory if path_spec.pattern else path_spec.virtual
    if prefix and path.startswith(prefix):
        rest = path[len(prefix) :]
        if prefix.endswith("/") or rest == "" or rest.startswith("/"):
            path = rest or "/"
    sftp = await accessor.sftp()
    try:
        remote_path = join_root(accessor.config.root, path)
        entries = await sftp.readdir(remote_path)
        found: list[tuple[str, asyncssh.SFTPAttrs]] = []
        for entry in entries:
            name = entry.filename
            if isinstance(name, bytes):
                name = name.decode()
            if name in (".", ".."):
                continue
            found.append((name, entry.attrs))
        found.sort(key=lambda pair: pair[0])
        if len(found) > SCOPE_ERROR:
            logger.warning(
                "ssh readdir: %s returned %d entries (limit %d)",
                virtual,
                len(found),
                SCOPE_ERROR,
            )
        base = remote_path.rstrip("/")
        return list(
            await asyncio.gather(
                *(
                    _row_of(accessor, f"{base}/{name}", name, attrs)
                    for name, attrs in found
                )
            )
        )
    except asyncssh.SFTPPermissionDenied as exc:
        raise eacces(virtual) from exc
    except UNRESOLVED:
        raise await listing_error(
            virtual,
            path,
            partial(_is_file, accessor),
            partial(_is_dir, accessor),
        )
