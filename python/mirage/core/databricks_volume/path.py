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

import posixpath

from mirage.resource.databricks_volume.config import DatabricksVolumeConfig
from mirage.types import PathSpec


def volume_root(config: DatabricksVolumeConfig) -> str:
    return posixpath.join("/Volumes", config.catalog, config.schema_name,
                          config.volume)


def _assert_inside_root(root: str, path: str, message: str) -> None:
    if path == root or path.startswith(root + "/"):
        return
    raise ValueError(message)


def configured_root(config: DatabricksVolumeConfig) -> str:
    root_relative = config.root_path.strip("/")
    if root_relative:
        return posixpath.normpath(
            posixpath.join(volume_root(config), root_relative))
    return posixpath.normpath(volume_root(config))


def backend_path(config: DatabricksVolumeConfig, path: PathSpec | str) -> str:
    if isinstance(path, PathSpec):
        raw = path.strip_prefix
    else:
        raw = path
    relative = raw.strip("/")
    root = configured_root(config)
    parts = [root]
    if relative:
        parts.append(relative)
    remote_path = posixpath.normpath(posixpath.join(*parts))
    _assert_inside_root(
        root,
        remote_path,
        f"path escapes Databricks volume root: {raw}",
    )
    return remote_path


def virtual_path(config: DatabricksVolumeConfig,
                 backend: str,
                 prefix: str = "") -> str:
    root = configured_root(config)
    remote_path = posixpath.normpath(backend)
    _assert_inside_root(
        root,
        remote_path,
        f"backend path is outside Databricks volume root: {backend}",
    )
    relative = remote_path.removeprefix(root).strip("/")
    path = "/" + relative if relative else "/"
    return prefix.rstrip(
        "/") + path if prefix and path != "/" else prefix or path
