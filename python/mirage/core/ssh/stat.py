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

import logging

import asyncssh

from mirage.accessor.ssh import SSHAccessor
from mirage.core.posix.stat import parse_tree, tree_command
from mirage.core.posix.utils import join_root
from mirage.core.ssh.constants import SFTP_KINDS
from mirage.errors.fs import eacces, enoent, exdev
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.dates import epoch_to_iso
from mirage.utils.filetype import content_type_for_path
from mirage.utils.path import posix_normpath
from mirage.utils.stat_view import mode_type

logger = logging.getLogger(__name__)

FIND_TYPES = {
    "d": asyncssh.FILEXFER_TYPE_DIRECTORY,
    "f": asyncssh.FILEXFER_TYPE_REGULAR,
}


def attrs_to_file_stat(name: str, attrs: asyncssh.SFTPAttrs) -> FileStat:
    """A remote inode's attributes as ``stat`` renders them.

    Fields setattr applies natively (mode, times) read from the remote
    inode, so external chmod/utime stays visible, mirroring disk.
    Ownership can never be applied natively (chown over SFTP needs
    privileges), so it lives wholly in the namespace overlay; server-side
    uid/gid numbers would also be machine-dependent noise. A directory
    has no rendered byte length, so its size is None whatever the remote
    inode reports.

    Args:
        name (str): the entry's name.
        attrs (asyncssh.SFTPAttrs): its attributes, links followed.
    """
    kind = (
        SFTP_KINDS.get(attrs.type)
        or mode_type(attrs.permissions or 0)
        or FileType.FILE
    )
    mod_str = epoch_to_iso(attrs.mtime) if attrs.mtime is not None else ""
    return FileStat(
        name=name,
        size=None if kind == FileType.DIRECTORY else attrs.size,
        modified=mod_str,
        fingerprint=mod_str or None,
        type=kind,
        content=content_type_for_path(name) if kind == FileType.FILE else None,
        mode=(
            attrs.permissions & 0o7777
            if attrs.permissions is not None
            else None
        ),
        atime=epoch_to_iso(attrs.atime) if attrs.atime is not None else None,
    )


async def stat(
    accessor: SSHAccessor,
    path_spec: PathSpec,
) -> FileStat:
    virtual = path_spec.virtual
    path = path_spec.mount_path
    sftp = await accessor.sftp()
    try:
        attrs = await sftp.stat(join_root(accessor.config.root, path))
    except asyncssh.SFTPPermissionDenied as exc:
        raise eacces(virtual) from exc
    except asyncssh.SFTPNoSuchFile:
        raise enoent(virtual)
    return attrs_to_file_stat(
        path.rstrip("/").rsplit("/", 1)[-1] or "/", attrs
    )


async def realpath(accessor: SSHAccessor, path: PathSpec) -> str:
    """Resolve remote links to a key under the configured root.

    Args:
        accessor (SSHAccessor): the mount's connection.
        path (PathSpec): the path to resolve on the remote server.
    """
    sftp = await accessor.sftp()
    try:
        root = posix_normpath(await sftp.realpath(accessor.config.root))
        remote = posix_normpath(
            await sftp.realpath(join_root(root, path.mount_path))
        )
    except asyncssh.SFTPPermissionDenied as exc:
        raise eacces(path) from exc
    except asyncssh.SFTPNoSuchFile as exc:
        raise enoent(path) from exc
    prefix = root.rstrip("/") + "/"
    if not root.startswith("/") or (
        remote != root and not remote.startswith(prefix)
    ):
        raise exdev(path)
    return "" if remote == root else remote[len(prefix) :]


async def tree(
    accessor: SSHAccessor,
    path_spec: PathSpec,
) -> dict[str, FileStat] | None:
    """Every file and directory under a directory, each as ``stat``
    answers it, from one find on the server, where a walk sends a
    readdir per directory.

    Only an exit of 0 with nothing on stderr, a directory at ``path``,
    and entries that are each a directory or a regular file answer: a
    server that runs no commands, a find without ``-printf`` (busybox,
    BSD), an entry it could not read, a link loop, a broken link or a
    special file leaves the walk to readdir, which reports each as it
    does today.

    Args:
        accessor (SSHAccessor): the mount's connection.
        path_spec (PathSpec): the directory.
    """
    scope = join_root(accessor.config.root, path_spec.mount_path)
    try:
        status, out, err = await accessor.run(tree_command(scope))
    except (asyncssh.Error, OSError) as exc:
        logger.debug("ssh tree left to the walk: %s", exc)
        return None
    found = parse_tree(out) if status == 0 and not err else None
    if found is None:
        return None
    rows: dict[str, FileStat] = {}
    top = False
    for row in found:
        if row.kind not in FIND_TYPES:
            return None
        if not row.rel:
            top = row.kind == "d"
            continue
        rows[row.rel] = attrs_to_file_stat(
            row.rel.rsplit("/", 1)[-1],
            asyncssh.SFTPAttrs(
                type=FIND_TYPES[row.kind],
                size=row.size,
                permissions=row.mode,
                atime=row.atime,
                mtime=row.mtime,
            ),
        )
    return rows if top else None
