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

from pathlib import Path

import asyncssh

from mirage.types import PathSpec


def _resolve_path(path: PathSpec) -> str:
    if isinstance(path, str):
        path = PathSpec(original=path, directory=path)
    if isinstance(path, PathSpec):
        return path.strip_prefix
    return path


def _key(path: str) -> str:
    return path.lstrip("/")


def _abs(config, path: PathSpec) -> str:
    path = _resolve_path(path)
    root = config.root.rstrip("/")
    rel = _key(path)
    if not rel:
        return root or "/"
    return f"{root}/{rel}"


def _connect_kwargs(config) -> dict:
    kwargs: dict = {"host": config.host}
    if config.hostname:
        kwargs["host"] = config.hostname
    if config.port:
        kwargs["port"] = config.port
    if config.username:
        kwargs["username"] = config.username
    if config.identity_file:
        kwargs["client_keys"] = [str(Path(config.identity_file).expanduser())]
    if config.known_hosts is not None:
        kwargs["known_hosts"] = config.known_hosts
    else:
        kwargs["known_hosts"] = None
    kwargs["login_timeout"] = config.timeout
    return kwargs


async def connect(config) -> asyncssh.SSHClientConnection:
    return await asyncssh.connect(**_connect_kwargs(config))
