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
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.ssh.utils import join_root
from mirage.errors.fs import eacces, enoent
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.dates import epoch_to_iso
from mirage.utils.filetype import content_type_for_path
from mirage.utils.quote import single_quote

logger = logging.getLogger(__name__)

FIND = "env LC_ALL=C find -L"
TREE_FORMAT = "%y %m %s %T@ %A@ %U %G %P\\0"
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
    is_dir = attrs.type == asyncssh.FILEXFER_TYPE_DIRECTORY
    mod_str = epoch_to_iso(attrs.mtime) if attrs.mtime is not None else ""
    return FileStat(
        name=name,
        size=None if is_dir else attrs.size,
        modified=mod_str,
        fingerprint=mod_str or None,
        type=FileType.DIRECTORY if is_dir else FileType.FILE,
        content=None if is_dir else content_type_for_path(name),
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
    index: IndexCacheStore = NULL_INDEX,
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


def tree_command(scope: str) -> str:
    """The remote find that lists ``scope`` and everything below it,
    links followed, one NUL-ended record per entry.

    Args:
        scope (str): the remote directory.
    """
    return f"{FIND} {single_quote(scope)} -printf {single_quote(TREE_FORMAT)}"


async def tree(
    accessor: SSHAccessor,
    path_spec: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
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
        index (IndexCacheStore): unused; the find answers directly.
    """
    scope = join_root(accessor.config.root, path_spec.mount_path)
    try:
        status, out, err = await accessor.run(tree_command(scope))
    except (asyncssh.Error, OSError) as exc:
        logger.debug("ssh tree left to the walk: %s", exc)
        return None
    if status != 0 or err or not out.endswith(b"\0"):
        return None
    rows: dict[str, FileStat] = {}
    top = False
    for record in out.split(b"\0")[:-1]:
        try:
            kind, mode, size, mtime, atime, _, _, rel = record.decode().split(
                " ", 7
            )
            attrs = asyncssh.SFTPAttrs(
                type=FIND_TYPES[kind],
                size=int(size),
                permissions=int(mode, 8),
                atime=int(atime.split(".")[0]),
                mtime=int(mtime.split(".")[0]),
            )
        except (UnicodeDecodeError, ValueError, KeyError) as exc:
            logger.debug("ssh tree left to the walk: %s", exc)
            return None
        if not rel:
            top = kind == "d"
            continue
        rows[rel] = attrs_to_file_stat(rel.rsplit("/", 1)[-1], attrs)
    return rows if top else None
