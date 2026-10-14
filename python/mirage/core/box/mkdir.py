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

from mirage.accessor.box import BoxAccessor
from mirage.core.box.api import create_folder, list_folder_items
from mirage.core.box.client import BoxApiError
from mirage.core.box.resolve import path_parts, resolve_chain, root_id
from mirage.errors.fs import eexist, enoent, enotdir
from mirage.types import PathSpec
from mirage.utils.key_prefix import mounted_path


async def mkdir(
    accessor: BoxAccessor, path: PathSpec, parents: bool = False
) -> None:
    parts = path_parts(path)
    if not parts:
        return
    tm = accessor.token_manager
    if parents:
        cur_id = root_id(accessor)
        for i, name in enumerate(parts):
            children = await list_folder_items(tm, cur_id)
            match = next((c for c in children if c["name"] == name), None)
            if match is not None:
                if match.get("type") != "folder":
                    # `mkdir -p` passes only a directory at the operand and
                    # names the file it stops at above it, as GNU does.
                    if i == len(parts) - 1:
                        raise eexist(path)
                    level = "/" + "/".join(parts[: i + 1])
                    raise enotdir(mounted_path(path, level))
                cur_id = match["id"]
            else:
                created = await create_folder(tm, cur_id, name)
                cur_id = created["id"]
    else:
        chain = await resolve_chain(accessor, parts[:-1])
        # A level that resolved but is a file is ENOTDIR, the parent itself
        # included; one that is not there at all is ENOENT, as mkdir(2)
        # tells them apart.
        if chain and chain[-1].get("type") != "folder":
            raise enotdir(path.virtual)
        if len(chain) < len(parts) - 1:
            raise enoent(path.virtual)
        parent_id = chain[-1]["id"] if chain else root_id(accessor)
        # Box 409s a name already taken, by a file or a folder: EEXIST,
        # named here because BoxApiError carries no errno.
        try:
            await create_folder(tm, parent_id, parts[-1])
        except BoxApiError as exc:
            if exc.status == 409:
                raise eexist(path) from exc
            raise
