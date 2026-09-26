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

from mirage.accessor.github import GitHubAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.api.client import SessionArg
from mirage.core.github.client import github_get
from mirage.core.github.config import GitHubConfig
from mirage.core.github.lookup import lookup_retrying
from mirage.observe.context import record, start_op
from mirage.types import PathSpec, VFSName
from mirage.utils.errors import enoent
from mirage.utils.key_prefix import mount_prefix_of


async def read_bytes(config: GitHubConfig,
                     owner: str,
                     repo: str,
                     sha: str,
                     session: SessionArg = None) -> bytes:
    data = await github_get(
        config.token,
        "/repos/{owner}/{repo}/git/blobs/{sha}",
        base_url=config.base_url,
        session=session,
        owner=owner,
        repo=repo,
        sha=sha,
    )
    return base64.b64decode(data["content"])


async def read(
    accessor: GitHubAccessor,
    path_spec: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
) -> bytes:
    """Read a file's blob and record the sha it was fetched by.

    The sha comes from the mount's listing, filling it if a verdict cleared
    it, never from a one-directory probe: a read reseeds the listing so the
    stats after it answer from the index again. The blob endpoint is
    content-addressed, so the recorded sha names exactly the bytes returned
    however old the listing is. That is also the documented limit of
    ``read: fresh`` here: a file read for the first time comes from the
    listing, and the next read's probe corrects it.

    Args:
        accessor (GitHubAccessor): backend handle.
        path_spec (PathSpec): the file to read.
        index (IndexCacheStore): the mount's index.

    Returns:
        bytes: the blob's content.

    Raises:
        IsADirectoryError: the path is a directory.
        FileNotFoundError: nothing exists at the path.
    """
    virtual = path_spec.virtual
    prefix = mount_prefix_of(path_spec.virtual, path_spec.vfs_path)
    rel = path_spec.mount_path.strip("/")
    if not rel:
        raise IsADirectoryError(virtual)
    key = prefix + "/" + rel if prefix else "/" + rel
    entry = (await lookup_retrying(accessor, index, prefix, key)).entry
    if entry is None:
        raise enoent(virtual)
    if entry.resource_type == "folder":
        raise IsADirectoryError(virtual)
    timer = start_op()
    data = await read_bytes(accessor.config, accessor.owner, accessor.repo,
                            entry.id, accessor.pool)
    record("read",
           virtual,
           VFSName.GITHUB,
           len(data),
           timer,
           fingerprint=entry.id)
    return data
