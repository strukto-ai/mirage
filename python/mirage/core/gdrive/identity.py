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

from mirage.accessor.gdrive import GDriveAccessor
from mirage.core.gdrive.resolve import resolve_key
from mirage.core.gdrive.versions import capture_file_metadata
from mirage.ops.types import LiveFileIdentity
from mirage.types import PathSpec
from mirage.utils.errors import eisdir


async def live_identity(accessor: GDriveAccessor,
                        path: PathSpec) -> LiveFileIdentity:
    """Bounded identity lookup: resolve the file id, then its metadata.

    Two calls, both bypassing the index: Drive is id-addressed, so the
    path must be resolved to an id before its metadata can be fetched.

    Args:
        accessor (GDriveAccessor): backend accessor.
        path (PathSpec): the path to check.
    """
    key = path.resource_path
    if not key:
        raise eisdir(path.virtual)
    node = await resolve_key(accessor, key)
    if node is None:
        return LiveFileIdentity(exists=False, revision=None, fingerprint=None)
    if node.is_folder:
        raise eisdir(path.virtual)
    fingerprint, revision = await capture_file_metadata(
        accessor.token_manager, node.id)
    return LiveFileIdentity(exists=True,
                            revision=revision,
                            fingerprint=fingerprint)
