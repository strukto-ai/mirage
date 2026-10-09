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

from mirage.runtime.python.monty.loader import StatResult
from mirage.runtime.types import VFSStat


def stat_result(st: VFSStat) -> Any:
    # Monty reads a 0.0 as epoch zero rather than substituting the host
    # clock, so an unknown mtime stays unknown instead of becoming now.
    mtime = (st.mtime_ns or 0) / 1_000_000_000
    if st.is_dir:
        return StatResult.dir_stat(mode=st.mode, mtime=mtime)
    return StatResult.file_stat(size=st.size, mode=st.mode, mtime=mtime)
