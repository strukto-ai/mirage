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
from mirage.types import PathSpec


async def mkdir(accessor: HfBucketsAccessor,
                path: PathSpec,
                parents: bool = False,
                index: IndexCacheStore = NULL_INDEX) -> None:
    # Not "object stores have no directories": s3 and gridfs are object
    # stores too and both put a zero-byte `key/` marker, which is what
    # keeps an empty directory visible there. OpenDAL's hf service cannot
    # store one and refuses client-side, before any request is sent:
    # create_dir is unsupported, and a write to a slash-terminated path
    # is IsADirectory. So an hf directory exists only while it holds a
    # key, and `mkdir x` then `rmdir x` is ENOENT here but fine on s3.
    return None
