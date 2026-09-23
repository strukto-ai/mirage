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

from mirage.accessor._hf import _HfAccessor
from mirage.core.opendal.watch import OpendalWalk
from mirage.watch.base import DeltaHook
from mirage.watch.delta import ListingDeltaHook


def build_delta_hook(accessor: _HfAccessor) -> DeltaHook:
    """Build the delta hook shared by every Hugging Face VFS.

    One recursive tree listing per pull, fingerprinted on the Hub's
    ETag. A mount pinned to an immutable ``revision`` cannot report a
    change, because the revision it reads is frozen by definition; the
    hook is only meaningful against a moving ref such as ``main``.

    Args:
        accessor (_HfAccessor): Backend handle for any of the four hf
            VFS classes.
    """
    return ListingDeltaHook(OpendalWalk(accessor))
