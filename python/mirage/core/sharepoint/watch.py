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

from mirage.accessor.sharepoint import SharePointAccessor
from mirage.core.msgraph.client import id_segment
from mirage.core.msgraph.config import graph_api
from mirage.core.msgraph.watch import DeltaTarget, GraphDeltaHook
from mirage.core.sharepoint.resolve import drive_entries, resolve, site_entries
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_prefix_of
from mirage.watch.base import DeltaHook


def build_delta_hook(accessor: SharePointAccessor) -> DeltaHook:
    """Build the SharePoint delta hook: the ``/delta`` feed of each
    document library under the watch root (``GraphDeltaHook``).

    A mount scoped to one site and library reads that library's feed,
    placed under its ``key_prefix``. An unscoped mount reads the library
    the root is in, or each library of the site or tenant the root
    names, found again on every ping: a library added is read from then
    on, and one gone or no longer at the root's path is deleted.

    Args:
        accessor (SharePointAccessor): Backend handle.
    """
    config = accessor.config

    def drive(drive_id: str) -> str:
        return f"{graph_api(config)}/drives/{id_segment(drive_id)}"

    async def targets(root: PathSpec) -> list[DeltaTarget]:
        prefix = mount_prefix_of(root.virtual, root.vfs_path).rstrip("/")
        resolved = await resolve(accessor, root)
        if config.site is not None and config.drive is not None:
            if resolved.drive_id is None:
                return []
            return [
                DeltaTarget(
                    drive=drive(resolved.drive_id),
                    folder=config.key_prefix or "",
                    virtual=prefix or "/",
                )
            ]
        parts = root.vfs_path.strip("/").split("/")
        if resolved.drive_id is not None:
            return [
                DeltaTarget(
                    drive=drive(resolved.drive_id),
                    folder="",
                    virtual=f"{prefix}/{parts[0]}/{parts[1]}",
                )
            ]
        if resolved.level == "root":
            sites = await site_entries(accessor)
        elif resolved.level == "site" and resolved.site_id is not None:
            sites = [(parts[0], resolved.site_id)]
        else:
            return []
        found: list[DeltaTarget] = []
        for site, site_id in sites:
            for name, drive_id in await drive_entries(accessor, site_id):
                found.append(
                    DeltaTarget(
                        drive=drive(drive_id),
                        folder="",
                        virtual=f"{prefix}/{site}/{name}",
                    )
                )
        return found

    return GraphDeltaHook(config, accessor.pool, targets)
