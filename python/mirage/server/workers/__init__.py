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

from typing import TYPE_CHECKING

from mirage.utils.loader import lazy_exports

if TYPE_CHECKING:
    from mirage.server.workers.config import (
        resolve_worker_type,
        resolve_workers,
    )
    from mirage.server.workers.pool import WorkerPool
    from mirage.server.workers.proxy import WorkerProxy, build_worker_proxy
    from mirage.server.workers.types import WorkerType

_EXPORTS: dict[str, tuple[str, ...]] = {
    "mirage.server.workers.config": ("resolve_worker_type", "resolve_workers"),
    "mirage.server.workers.pool": ("WorkerPool",),
    "mirage.server.workers.proxy": ("WorkerProxy", "build_worker_proxy"),
    "mirage.server.workers.types": ("WorkerType",),
}

__all__ = [
    "WorkerPool",
    "WorkerProxy",
    "WorkerType",
    "build_worker_proxy",
    "resolve_worker_type",
    "resolve_workers",
]

__getattr__ = lazy_exports(__name__, _EXPORTS)
