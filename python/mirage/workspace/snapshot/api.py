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

from mirage.workspace.snapshot.manifest import split_manifest_and_blobs
from mirage.workspace.snapshot.state import to_state_dict
from mirage.workspace.snapshot.tar_io import write_tar


async def snapshot(ws, target, *, compress: str | None = None) -> None:
    """Serialize a Workspace to a tar archive.

    Fingerprints come from ``ws._ops.records`` (each read carries the
    backend's version marker captured at the moment of the read), so
    no live network round-trips are needed at snapshot time. Kept as
    ``async def`` for API stability and future-proofing.

    Workspace.load and Workspace.copy own the inverse direction
    (construction). Snapshot does not construct Workspace — that
    keeps the dependency direction unidirectional: workspace → snapshot.

    Args:
        ws: the workspace to snapshot.
        target: filesystem path (str/Path) OR a writable file-like
            object (BytesIO, etc.).
        compress: None | "gz" | "bz2" | "xz".
    """
    state = to_state_dict(ws)
    manifest, blobs = split_manifest_and_blobs(state)
    write_tar(target, manifest, blobs, compress=compress)
