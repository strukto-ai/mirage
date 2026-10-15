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

from mirage.accessor.hf_hub import HfHubAccessor
from mirage.core.hf_hub.lookup import refusals_denied
from mirage.core.hf_hub.repo import head_commit, mount_version
from mirage.core.hf_hub.tree import fetch_tree, tree_listing
from mirage.types import DirListing, PathSpec


async def readdir(accessor: HfHubAccessor, path_spec: PathSpec) -> DirListing:
    """A folder's listing, with every folder below it as seeds.

    One paged walk answers the whole repository, at the commit the
    revision's head names: the head first, and the tree walked at that
    commit, so the version the listing carries is the one its rows are
    at, never a later one a commit landing between the two requests
    would give. A Hub that names no head walks the branch and versions
    nothing.

    Args:
        accessor (HfHubAccessor): backend handle.
        path_spec (PathSpec): the folder, or a glob word in it.

    Raises:
        FileNotFoundError: nothing is at the path.
        NotADirectoryError: the path, or a folder above it, is a file.
        PermissionError: the Hub declined to show the repository.
    """
    rel = (path_spec.dir if path_spec.pattern else path_spec).mount_path
    with refusals_denied(path_spec):
        head = await head_commit(accessor) or None
        tree = await fetch_tree(accessor, head)
    return tree_listing(
        tree,
        rel.strip("/"),
        mount_version(head, accessor.key_prefix),
        path_spec.virtual,
    )
