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

import asyncio
import os as _real_os
import types

from mirage.bridge.sync import run_async_from_sync
from mirage.ops import Ops
from mirage.types import FileType


def _ops_exists(ops: Ops, path: str,
                loop: asyncio.AbstractEventLoop | None) -> bool:
    try:
        run_async_from_sync(ops.stat(path), loop)
        return True
    except (FileNotFoundError, ValueError):
        return False


def _ops_isfile(ops: Ops, path: str,
                loop: asyncio.AbstractEventLoop | None) -> bool:
    try:
        return run_async_from_sync(ops.stat(path),
                                   loop).type != FileType.DIRECTORY
    except (FileNotFoundError, ValueError):
        return False


def _ops_isdir(ops: Ops, path: str,
               loop: asyncio.AbstractEventLoop | None) -> bool:
    try:
        return run_async_from_sync(ops.stat(path),
                                   loop).type == FileType.DIRECTORY
    except (FileNotFoundError, ValueError):
        return False


def make_os_module(ops: Ops, loop: asyncio.AbstractEventLoop | None = None):
    """Create a patched os module that routes mounted paths through ops.

    Args:
        ops (Ops): The ops instance with mount table.
        loop (asyncio.AbstractEventLoop | None): Shared event loop.

    Returns:
        module: A patched os module.
    """
    patched = types.ModuleType("os")
    patched.__dict__.update(_real_os.__dict__)

    def _run(coro):
        return run_async_from_sync(coro, loop)

    patched.listdir = (
        lambda p:
        [e.rstrip("/").rsplit("/", 1)[-1] for e in _run(ops.readdir(p))]
        if ops.is_mounted(p) else _real_os.listdir(p))
    patched.remove = (lambda p: _run(ops.unlink(p))
                      if ops.is_mounted(p) else _real_os.remove(p))
    patched.rmdir = (lambda p: _run(ops.rmdir(p))
                     if ops.is_mounted(p) else _real_os.rmdir(p))
    patched.makedirs = (lambda p, **kw: _run(ops.mkdir(p))
                        if ops.is_mounted(p) else _real_os.makedirs(p, **kw))
    patched.rename = (lambda s, d: _run(ops.rename(s, d))
                      if ops.is_mounted(s) else _real_os.rename(s, d))
    patched.stat = (lambda p: _run(ops.stat(p))
                    if ops.is_mounted(p) else _real_os.stat(p))

    patched.path = types.ModuleType("os.path")
    patched.path.__dict__.update(_real_os.path.__dict__)
    patched.path.exists = (lambda p: _ops_exists(ops, p, loop)
                           if ops.is_mounted(p) else _real_os.path.exists(p))
    patched.path.isfile = (lambda p: _ops_isfile(ops, p, loop)
                           if ops.is_mounted(p) else _real_os.path.isfile(p))
    patched.path.isdir = (lambda p: _ops_isdir(ops, p, loop)
                          if ops.is_mounted(p) else _real_os.path.isdir(p))
    patched.path.getsize = (lambda p: _run(ops.stat(p)).size
                            if ops.is_mounted(p) else _real_os.path.getsize(p))

    return patched
