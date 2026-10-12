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

from mirage.accessor.ram import RAMAccessor
from mirage.core.dev.mixin import PipeFiles
from mirage.core.dev.pipe import DevicePipe


def active_device(accessor: RAMAccessor, key: str) -> str | None:
    """Return the live synthetic device at key, if the RAM store has one."""
    device_of = getattr(accessor.store.files, "device_of", None)
    return device_of(key) if device_of is not None else None


def active_pipe(accessor: RAMAccessor, key: str) -> DevicePipe | None:
    files = accessor.store.files
    return files.pipe_of(key) if isinstance(files, PipeFiles) else None
