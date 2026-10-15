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

import base64
from collections.abc import AsyncIterator
from contextlib import aclosing

from mirage.accessor.github import GitHubAccessor
from mirage.core.api.client import SessionArg
from mirage.core.github.client import blob_path, github_get, stream_blob
from mirage.core.github.config import GitHubConfig
from mirage.errors.fs import eisdir, enoent
from mirage.observe.context import record, record_stream, start_op
from mirage.types import FileStat, FileType, PathSpec, VFSName


async def read_bytes(
    config: GitHubConfig,
    owner: str,
    repo: str,
    sha: str,
    session: SessionArg = None,
) -> bytes:
    data = await github_get(
        config.token,
        blob_path(owner, repo, sha),
        base_url=config.base_url,
        session=session,
    )
    return base64.b64decode(data["content"])


async def read(
    accessor: GitHubAccessor,
    path_spec: PathSpec,
    entry: FileStat | None = None,
) -> bytes:
    """Read a file's blob and record the sha it was fetched by.

    The sha comes from the file's row, as its folder's listing names it.
    The blob endpoint is content-addressed, so the recorded sha names
    exactly the bytes returned however old the listing is. That is also
    the documented limit of ``read: fresh`` here: a file read for the
    first time comes from the listing, and the next read's probe corrects
    it.

    Args:
        accessor (GitHubAccessor): backend handle.
        path_spec (PathSpec): the file to read.
        entry (FileStat | None): the file's row.

    Returns:
        bytes: the blob's content.

    Raises:
        IsADirectoryError: the path is a directory.
        FileNotFoundError: nothing exists at the path.
    """
    sha = _blob_sha(path_spec, entry)
    timer = start_op()
    data = await read_bytes(
        accessor.config, accessor.owner, accessor.repo, sha, accessor.pool
    )
    record(
        "read",
        path_spec.virtual,
        VFSName.GITHUB,
        len(data),
        timer,
        fingerprint=sha,
    )
    return data


async def read_stream(
    accessor: GitHubAccessor,
    path_spec: PathSpec,
    entry: FileStat | None = None,
) -> AsyncIterator[bytes]:
    """Stream a file's blob as it downloads, recorded by its sha.

    The blob comes as GitHub's raw media type, the bytes themselves rather
    than base64 inside JSON. The sha is the row's, as :func:`read` takes
    it, and recorded up front: the blob endpoint is content-addressed, so
    it names the bytes however far the stream is read.

    Args:
        accessor (GitHubAccessor): backend handle.
        path_spec (PathSpec): the file to read.
        entry (FileStat | None): the file's row.

    Raises:
        IsADirectoryError: the path is a directory.
        FileNotFoundError: nothing exists at the path.
    """
    sha = _blob_sha(path_spec, entry)
    rec = record_stream(
        "read", path_spec.virtual, VFSName.GITHUB, fingerprint=sha
    )
    async with aclosing(
        stream_blob(
            accessor.config,
            accessor.owner,
            accessor.repo,
            sha,
            accessor.pool,
        )
    ) as source:
        async for chunk in source:
            if rec is not None:
                rec.bytes += len(chunk)
            yield chunk


def _blob_sha(path_spec: PathSpec, entry: FileStat | None) -> str:
    """The blob sha of the file at ``path_spec``, off its row.

    Args:
        path_spec (PathSpec): the file.
        entry (FileStat | None): the file's row.

    Raises:
        IsADirectoryError: the path is a directory.
        FileNotFoundError: nothing exists at the path.
    """
    if not path_spec.mount_path.strip("/"):
        raise eisdir(path_spec.virtual)
    if entry is None:
        raise enoent(path_spec.virtual)
    if entry.type is FileType.DIRECTORY:
        raise eisdir(path_spec.virtual)
    return str(entry.extra["sha"])
