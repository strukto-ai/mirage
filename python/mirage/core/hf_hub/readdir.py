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
from functools import partial

from mirage.accessor.hf_hub import HfHubAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.hf_hub.lookup import key_of, lookup, probe_dir, probe_file
from mirage.types import PathSpec
from mirage.utils.errors import listing_error
from mirage.utils.key_prefix import mount_prefix_of

log = logging.getLogger(__name__)


async def readdir(
    accessor: HfHubAccessor,
    path_spec: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
) -> list[str]:
    """List one directory of the repository.

    Args:
        accessor (HfHubAccessor): backend handle.
        path_spec (PathSpec): the directory to list.
        index (IndexCacheStore): the mount's index, which holds the whole
            listing rather than a cache in front of one.

    Returns:
        list[str]: mount-absolute paths of the directory's children.

    Raises:
        FileNotFoundError: no component of the path exists.
        NotADirectoryError: the path, or a component of it, is a file.
    """
    prefix = mount_prefix_of(path_spec.virtual, path_spec.vfs_path)
    path = (path_spec.dir if path_spec.pattern else path_spec).mount_path
    found = await lookup(accessor, index, prefix, key_of(prefix, path))
    if found.children is not None:
        return found.children
    # A git tree implies every directory above a path it holds, so this
    # store cannot hold an orphan and the one-probe form is the right
    # one; both probes are dictionary lookups against a listing already
    # in memory, so the walk costs no requests.
    raise await listing_error(path_spec, path,
                              partial(probe_file, accessor, index, prefix),
                              partial(probe_dir, accessor, index, prefix))
