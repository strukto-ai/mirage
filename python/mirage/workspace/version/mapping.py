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

from mirage.types import MountKey, ResourceStateKey, StateKey
from mirage.workspace.snapshot.state import to_state_dict

META_FORMAT = 1


def _tree_path(prefix: str, rel: str) -> str:
    p = prefix.strip("/")
    r = rel.lstrip("/")
    return f"{p}/{r}" if p else r


def to_tree_inputs(ws) -> tuple[dict[str, bytes], dict]:
    state = to_state_dict(ws)
    entries: dict[str, bytes] = {}
    mounts_meta: list[dict] = []
    for mount in state[StateKey.MOUNTS]:
        prefix = mount[MountKey.PREFIX]
        resource_state = dict(mount[MountKey.RESOURCE_STATE])
        files = resource_state.pop(ResourceStateKey.FILES, {})
        for rel, data in files.items():
            entries[_tree_path(prefix, rel)] = data
        mounts_meta.append({
            MountKey.INDEX: mount[MountKey.INDEX],
            MountKey.PREFIX: prefix,
            MountKey.MODE: mount[MountKey.MODE],
            MountKey.CONSISTENCY: mount[MountKey.CONSISTENCY],
            MountKey.RESOURCE_CLASS: mount[MountKey.RESOURCE_CLASS],
            MountKey.RESOURCE_STATE: resource_state,
        })
    meta = {"format": META_FORMAT, "mounts": mounts_meta, "pins": {}}
    return entries, meta
