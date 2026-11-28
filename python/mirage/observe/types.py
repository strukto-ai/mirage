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

from dataclasses import dataclass

from opentelemetry.metrics import Counter, Histogram


@dataclass(frozen=True)
class Instruments:
    """The instruments the observer records lines and mount calls on.

    Args:
        shell_duration (Histogram): how long typed lines ran, in
            seconds, by exit code.
        vfs_duration (Histogram): how long calls to mounts took, in
            seconds, by call and backend.
        vfs_io (Counter): the bytes calls to mounts moved, by call and
            backend.
    """

    shell_duration: Histogram
    vfs_duration: Histogram
    vfs_io: Counter
