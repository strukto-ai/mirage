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
from mirage.cache.index import NULL_INDEX, IndexCacheStore, LookupStatus
from mirage.core.api.client import SessionArg
from mirage.core.github.client import github_get
from mirage.core.github.config import GitHubConfig
from mirage.core.github.tree import ensure_live_index, refill_index
from mirage.types import PathSpec
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
    virtual = path_spec.virtual
    prefix = mount_prefix_of(path_spec.virtual, path_spec.resource_path)
    key = path_spec.mount_path.strip("/")
    key = prefix + "/" + key if key else prefix or "/"
    # Freshness is tracked per directory, never per entry, so a blob's row
    # is exactly as fresh as its parent's listing and `get` can never
    # report staleness of its own. The parent is therefore the probe:
    # after a write invalidated the index the row survives carrying the
    # *pre-write* blob sha, and reading it back served the old bytes. A
    # miss is not a probe either -- against a live index it is a real
    # absence, and refetching the whole tree on every ENOENT costs a
    # recursive-tree call per miss.
    await ensure_live_index(accessor, index, prefix)
    if not accessor.truncated:
        cut = key.rfind("/")
        parent = key[:cut] if cut > 0 else "/"
        if (await index.list_dir(parent)).status == LookupStatus.EXPIRED:
            await refill_index(accessor, index, prefix)
    result = await index.get(key)
    if result.status == LookupStatus.NOT_FOUND or result.entry is None:
        raise enoent(virtual)
    if result.entry.resource_type == "folder":
        raise IsADirectoryError(virtual)
    return await read_bytes(accessor.config, accessor.owner, accessor.repo,
                            result.entry.id, accessor.pool)
