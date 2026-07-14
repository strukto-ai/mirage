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

from mirage.accessor.github_ci import GitHubCIAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.commands.builtin.constants import SCOPE_ERROR
from mirage.core.github_ci.readdir import readdir
from mirage.types import PathSpec
from mirage.utils.glob_walk import resolve_glob_with
from mirage.utils.key_prefix import mount_prefix_of


def is_cross_run_root(path: PathSpec) -> bool:
    original = path.virtual if isinstance(path, PathSpec) else path
    prefix = mount_prefix_of(path.virtual, path.resource_path) if isinstance(
        path, PathSpec) else ""
    if prefix and original.startswith(prefix):
        rest = original[len(prefix):]
        if prefix.endswith("/") or rest == "" or rest.startswith("/"):
            original = rest or "/"
    return original.strip("/") in ("", "runs")


async def resolve_glob(
    accessor: GitHubCIAccessor,
    paths: list[PathSpec],
    index: IndexCacheStore = NULL_INDEX,
) -> list[PathSpec]:
    return await resolve_glob_with(readdir, accessor, paths, index,
                                   SCOPE_ERROR)
