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

import os
from pathlib import Path

from mirage.core.disk.fingerprint import token_of


def folder_version(path: Path, now_ns: int) -> str | None:
    """Stat a host folder and return its listing version.

    Args:
        path (Path): the host folder, already checked by ``resolve_inside``.
        now_ns (int): the wall clock, read before this call.

    Returns:
        str | None: the folder's fingerprint, see :func:`token_of`.
    """
    return token_of(os.stat(path), now_ns)
