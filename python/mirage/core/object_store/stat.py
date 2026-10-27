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

from mirage.core.object_store.driver import A, C, ObjectStoreDriver, StatFn
from mirage.errors.fs import eacces, enoent
from mirage.observe.context import revision_for
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils import key_prefix as kp
from mirage.utils.filetype import content_type_for_path
from mirage.utils.key_prefix import raw_path_of


async def proves_directory(
    driver: ObjectStoreDriver[A, C],
    conn: C,
    pfx: str,
    named: PathSpec,
) -> bool:
    """Whether any key sits under ``pfx``; a refused probe is EACCES.

    A grant without ListBucket refuses the probe as well as the key, so
    the refusal is named for the path the caller reports. Mirrors TS
    ``provesDirectory``.

    Args:
        driver (ObjectStoreDriver): the store's native surface.
        conn (C): the open connection.
        pfx (str): the key prefix, slash-terminated.
        named (PathSpec): the path a refusal names.
    """
    try:
        return await driver.probe_prefix(conn, pfx)
    except PermissionError as exc:
        raise eacces(named) from exc


def make_stat(driver: ObjectStoreDriver[A, C]) -> StatFn[A]:
    """Build the stat ladder over one driver: the object, then the prefix.

    Args:
        driver (ObjectStoreDriver): the store's native surface.
    """

    async def stat(accessor: A, path_spec: PathSpec) -> FileStat:
        virtual = path_spec.virtual
        path = raw_path_of(path_spec)

        # A trailing slash signals the caller treats the path as a
        # directory. These stores allow an object at key "csv" AND deeper
        # keys under "csv/" to coexist; without this hint the file lookup
        # would win and `ls` on the slashed path would list the file
        # itself instead of the prefix.
        hints_directory = path.endswith("/")

        stripped = path.strip("/")

        if not stripped:
            return FileStat(name="/", type=FileType.DIRECTORY)

        kpfx = driver.key_prefix_of(accessor)
        key = kp.apply(kpfx, path)
        refused: PermissionError | None = None
        async with driver.connect(accessor) as conn:
            # Point lookup first — works for files. Skipped when the path
            # hints a directory (trailing slash), so a coexisting object
            # of the same name does not shadow the prefix.
            if not hints_directory:
                pinned = revision_for(virtual)
                try:
                    if pinned is not None and driver.head_revision is not None:
                        meta = await driver.head_revision(conn, key, pinned)
                    else:
                        meta = await driver.head(conn, key)
                except PermissionError as exc:
                    # A grant scoped below refuses a directory's own key.
                    refused, meta = exc, None
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
            if await proves_directory(driver, conn, pfx, path_spec):
                return FileStat(
                    name=path.rstrip("/").rsplit("/", 1)[-1] or "/",
                    type=FileType.DIRECTORY,
                )

        if refused is not None:
            raise eacces(path_spec) from refused
        raise enoent(virtual)

    return stat
