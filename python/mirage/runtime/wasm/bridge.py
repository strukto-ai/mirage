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
from typing import Any, Callable

from mirage.types import PathSpec


class SyncDispatch:
    """Sync facade over the async workspace dispatch.

    The preview1 host functions run on the wasm worker thread; each
    workspace op hops to the workspace loop via
    `run_coroutine_threadsafe` and blocks the worker until it completes
    (the same bridge shape as monty's OS callbacks). The worker thread
    carries the launching task's contextvars, so session mount modes
    are enforced inside the op exactly as for shell commands.
    """

    def __init__(self, dispatch: Callable,
                 loop: asyncio.AbstractEventLoop) -> None:
        self._dispatch = dispatch
        self._loop = loop

    def call(self, op: str, path: str, **kwargs: Any) -> Any:
        """Run one workspace op and return its result.

        Args:
            op (str): dispatch op name (read, write, stat, ...).
            path (str): guest-absolute virtual path.
        """
        coro = self._dispatch(op, PathSpec.from_str_path(path), **kwargs)
        future = asyncio.run_coroutine_threadsafe(coro, self._loop)
        try:
            result, _ = future.result()
        except AttributeError as exc:
            # execute_op raises AttributeError for an op the mount's
            # resource does not register; surface ENOTSUP to the guest.
            raise NotImplementedError(str(exc)) from exc
        return result
