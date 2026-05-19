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

import fnmatch

from mirage.accessor.s3 import S3Accessor
from mirage.core.s3._client import (_client_kwargs, _prefix, _strip_prefix,
                                    async_session)
from mirage.types import PathSpec


async def find(
    accessor: S3Accessor,
    path: PathSpec,
    name: str | None = None,
    type: str | None = None,
    min_size: int | None = None,
    max_size: int | None = None,
    maxdepth: int | None = None,
    name_exclude: str | None = None,
    or_names: list[str] | None = None,
    mtime_min: float | None = None,
    mtime_max: float | None = None,
    iname: str | None = None,
    path_pattern: str | None = None,
    mindepth: int | None = None,
) -> list[str]:
    """Find objects under a prefix with filtering.

    Args:
        accessor (S3Accessor): S3 accessor.
        path (PathSpec | str): Prefix path.
        name (str | None): Glob pattern to match entry name.
        type (str | None): "file" or "directory".
        min_size (int | None): Minimum object size.
        max_size (int | None): Maximum object size.
        maxdepth (int | None): Maximum directory depth.
        name_exclude (str | None): Glob pattern to exclude.
        or_names (list[str] | None): Alternative name patterns (OR logic).
        mtime_min (float | None): Minimum modification time as timestamp.
        mtime_max (float | None): Maximum modification time as timestamp.
        iname (str | None): Case-insensitive glob pattern for basename.
        path_pattern (str | None): Glob pattern to match full path.
        mindepth (int | None): Minimum depth to include.
    """
    if isinstance(path, str):
        path = PathSpec(original=path, directory=path)
    if isinstance(path, PathSpec):
        path = path.strip_prefix
    config = accessor.config
    pfx = _prefix(path, config)
    results: list[str] = []
    session = async_session(config)
    async with session.client(**_client_kwargs(config)) as client:
        paginator = client.get_paginator("list_objects_v2")
        async for page in paginator.paginate(Bucket=config.bucket, Prefix=pfx):
            for obj in page.get("Contents") or []:
                key = obj["Key"]
                if key == pfx:
                    continue
                relative = key[len(pfx):]
                depth = relative.count("/") + 1
                if maxdepth is not None and depth > maxdepth:
                    continue
                if mindepth is not None and depth < mindepth:
                    continue
                entry_name = key.rsplit("/", 1)[-1]
                if or_names:
                    if not any(
                            fnmatch.fnmatch(entry_name, p) for p in or_names):
                        continue
                elif name and not fnmatch.fnmatch(entry_name, name):
                    continue
                if iname is not None and not fnmatch.fnmatch(
                        entry_name.lower(), iname.lower()):
                    continue
                full_path = "/" + _strip_prefix(key, config)
                if path_pattern is not None and not fnmatch.fnmatch(
                        full_path, path_pattern):
                    continue
                if name_exclude and fnmatch.fnmatch(entry_name, name_exclude):
                    continue
                if type == "file" and key.endswith("/"):
                    continue
                if type == "directory" and not key.endswith("/"):
                    continue
                size = obj.get("Size", 0)
                if min_size is not None and size < min_size:
                    continue
                if max_size is not None and size > max_size:
                    continue
                results.append(full_path)
    return sorted(results)
