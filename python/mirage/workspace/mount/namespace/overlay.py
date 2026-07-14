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

from typing import Any

from mirage.core.timeutil import epoch_to_iso
from mirage.types import FileStat
from mirage.workspace.mount.namespace.namespace import NodeMeta


def merge_overlay_stat(meta: NodeMeta | None, stat: FileStat) -> FileStat:
    """Overlay namespace node attrs onto a backend stat.

    Backends without a native attribute slot store chmod/chown/touch
    results in the namespace node table; every stat surface (dispatch,
    the ops facade, FUSE) merges through here (overlay wins per-field)
    so they cannot disagree.

    Args:
        meta (NodeMeta | None): node entry for the (link-resolved) path.
        stat (FileStat): the backend-reported stat.
    """
    if meta is None:
        return stat
    update: dict[str, Any] = {}
    if meta.mode is not None:
        update["mode"] = meta.mode
    if meta.uid is not None:
        update["uid"] = meta.uid
    if meta.gid is not None:
        update["gid"] = meta.gid
    if meta.atime is not None:
        update["atime"] = meta.atime
    if meta.mtime is not None and meta.target is None:
        update["modified"] = epoch_to_iso(meta.mtime)
    if not update:
        return stat
    return stat.model_copy(update=update)
