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

from mirage.accessor.hf_buckets import HfBucketsAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.hf_buckets.driver import DRIVER
from mirage.core.hf_hub.lookup import refusals_denied
from mirage.core.object_store.stat import make_stat
from mirage.types import FileStat, PathSpec

_stat = make_stat(DRIVER)


async def stat(accessor: HfBucketsAccessor,
               path_spec: PathSpec,
               index: IndexCacheStore = NULL_INDEX) -> FileStat:
    """Stat one path, a refused bucket reading as permission denied.

    paths-info answers a missing path with an empty list, never an error,
    so a 401, 403 or 404 from it is about the bucket: an anonymous caller
    asking for one that does not exist gets 401. Answering that as "no
    such file" would let reconcile delete what a refreshed token can see.

    Args:
        accessor (HfBucketsAccessor): bucket accessor.
        path_spec (PathSpec): the path to stat.
        index (IndexCacheStore): the mount's index.

    Returns:
        FileStat: the entry, fingerprinted with the file's xet hash.
    """
    with refusals_denied(path_spec):
        return await _stat(accessor, path_spec, index)
