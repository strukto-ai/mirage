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


class NFSError(Exception):
    """Base for conditions the NFS adapter reports to the server layer."""


class StaleHandleError(NFSError):
    """A file id the adapter no longer knows.

    Answered to the client as ``NFS3ERR_STALE``. Raised rather than
    returned so a caller cannot mistake it for a valid path: an id is
    stale for the rest of the mount's life, never revalidated.
    """
