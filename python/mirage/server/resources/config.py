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
from typing import Any

from mirage.resources.base import ResourceStore
from mirage.resources.memory import memory_resource_store
from mirage.server.daemon_config import DaemonConfigError, read_daemon_table
from mirage.server.env import ENV_RESOURCE_STORE
from mirage.server.paths import mirage_home
from mirage.server.resources.files import files_resource_store
from mirage.server.resources.types import ResourceStoreBackend


def resolve_resource_store(
    backend: str | None = None,
) -> ResourceStoreBackend:
    """Which store holds saved configs: ``backend`` when given, else
    ``$MIRAGE_RESOURCE_STORE``, else the ``resource_store`` key in
    config.toml's ``[daemon]`` table, else files. Mirrors TypeScript's
    ``resolveResourceStore``.

    Args:
        backend (str | None): the backend the caller set.

    Raises:
        DaemonConfigError: the backend is neither files nor memory.
    """
    value: Any = backend
    if value is None:
        value = os.environ.get(ENV_RESOURCE_STORE) or read_daemon_table(
            mirage_home()
        ).get("resource_store")
        if value is None or value == "":
            return ResourceStoreBackend.FILES
    try:
        return ResourceStoreBackend(value)
    except ValueError:
        raise DaemonConfigError(
            f"resource_store must be files or memory, got {value!r}"
        ) from None


def build_resource_store(backend: ResourceStoreBackend) -> ResourceStore:
    """The daemon's store for ``backend``, in its one fixed scope.

    Args:
        backend (ResourceStoreBackend): the backend to build.
    """
    if backend == ResourceStoreBackend.MEMORY:
        return memory_resource_store()
    return files_resource_store()
