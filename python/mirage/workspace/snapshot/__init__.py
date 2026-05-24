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

from mirage.workspace.snapshot.api import snapshot
from mirage.workspace.snapshot.config import MountArgs
from mirage.workspace.snapshot.drift import (ContentDriftError,
                                             capture_fingerprints, check_drift,
                                             install_fingerprints,
                                             live_only_mount_prefixes)
from mirage.workspace.snapshot.manifest import (resolve_manifest,
                                                split_manifest_and_blobs)
from mirage.workspace.snapshot.state import (apply_state_dict,
                                             build_mount_args,
                                             requires_resource_override,
                                             to_state_dict)
from mirage.workspace.snapshot.tar_io import read_tar, write_tar
from mirage.workspace.snapshot.utils import (BLOB_REF_KEY, FORMAT_VERSION,
                                             is_safe_blob_path,
                                             norm_mount_prefix)

__all__ = [
    "snapshot",
    "to_state_dict",
    "build_mount_args",
    "requires_resource_override",
    "apply_state_dict",
    "MountArgs",
    "split_manifest_and_blobs",
    "resolve_manifest",
    "write_tar",
    "read_tar",
    "BLOB_REF_KEY",
    "FORMAT_VERSION",
    "is_safe_blob_path",
    "norm_mount_prefix",
    "ContentDriftError",
    "capture_fingerprints",
    "check_drift",
    "install_fingerprints",
    "live_only_mount_prefixes",
]
