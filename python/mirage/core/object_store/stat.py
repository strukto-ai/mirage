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

from mirage.cache.index import NULL_INDEX, IndexCacheStore, ResourceType
from mirage.core.object_store.driver import A, C, ObjectStoreDriver, StatFn
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils import key_prefix as kp
from mirage.utils.errors import enoent
from mirage.utils.filetype import content_type_for_path
from mirage.utils.key_prefix import mount_prefix_of


def make_stat(driver: ObjectStoreDriver[A, C]) -> StatFn[A]:
    """Build the index-first stat ladder over one driver.

    Args:
        driver (ObjectStoreDriver): the store's native surface.
    """

    async def stat(accessor: A,
                   path_spec: PathSpec,
                   index: IndexCacheStore = NULL_INDEX) -> FileStat:
        virtual = path_spec.virtual
        original_prefix = mount_prefix_of(path_spec.virtual,
                                          path_spec.resource_path)
        path = path_spec.virtual
        if original_prefix and path.startswith(original_prefix):
            path = path[len(original_prefix):] or "/"

        # A trailing slash signals the caller treats the path as a
        # directory. These stores allow an object at key "csv" AND deeper
        # keys under "csv/" to coexist; without this hint the file lookup
        # would win and `ls` on the slashed path would list the file
        # itself instead of the prefix.
        hints_directory = path.endswith("/")

        stripped = path.strip("/")

        if not stripped:
            return FileStat(name="/", type=FileType.DIRECTORY)

        # Fast path: check the index cache populated by readdir().
        # readdir() stores entries with resource_type="folder" or "file"
        # and file sizes, so stat can return instantly for known paths.
        virtual_key = (original_prefix + "/" +
                       stripped if original_prefix else "/" + stripped)
        lookup = await index.get(virtual_key)
        if lookup.entry is not None:
            entry = lookup.entry
            # Store "folders" are synthetic prefixes with no object,
            # so readdir() records no time or size for them.
            if entry.resource_type == ResourceType.FOLDER:
                return FileStat(name=entry.name, type=FileType.DIRECTORY)
            # TODO: propagate the fingerprint into IndexCacheEntry so this
            # fast path can also carry it.
            return FileStat(
                name=entry.name,
                size=entry.size,
                modified=entry.remote_time or None,
                type=FileType.FILE,
                content=content_type_for_path(entry.name),
            )
        # If the parent directory was already listed by readdir() but
        # this path is not among its children, it does not exist.
        # This avoids expensive network calls for paths that shells
        # probe speculatively (e.g. .git, HEAD, .hg during cd).
        parent = virtual_key.rsplit("/", 1)[0] or "/"
        parent_listing = await index.list_dir(parent)
        if parent_listing.entries is not None:
            raise enoent(virtual)

        # Slow path: no index cache available, or parent directory not
        # yet listed. Hit the store.
        kpfx = driver.key_prefix_of(accessor)
        key = kp.apply(kpfx, path)
        async with driver.connect(accessor) as conn:
            # Point lookup first — works for files. Skipped when the path
            # hints a directory (trailing slash), so a coexisting object
            # of the same name does not shadow the prefix.
            if not hints_directory:
                meta = await driver.head(conn, key)
                if meta is not None:
                    return FileStat(
                        name=path.rstrip("/").rsplit("/", 1)[-1],
                        size=meta.size,
                        modified=meta.modified,
                        type=FileType.FILE,
                        content=content_type_for_path(path),
                        fingerprint=meta.fingerprint,
                        revision=meta.revision,
                        extra=dict(meta.extra),
                    )

            # No object (or it was skipped) — check whether the path is a
            # valid prefix (directory): a marker or any deeper key proves
            # it.
            pfx = key.rstrip("/") + "/" if key else ""
            if await driver.probe_prefix(conn, pfx):
                return FileStat(
                    name=path.rstrip("/").rsplit("/", 1)[-1] or "/",
                    type=FileType.DIRECTORY,
                )

        raise enoent(virtual)

    return stat
