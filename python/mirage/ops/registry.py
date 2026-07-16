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

import inspect
from dataclasses import dataclass
from typing import Callable

from mirage.types import PathSpec


@dataclass
class RegisteredOp:
    name: str
    resource: str
    filetype: str | None
    fn: Callable
    write: bool = False


def op(
    name: str,
    *,
    resource: str | list[str],
    filetype: str | None = None,
    write: bool = False,
) -> Callable:

    def decorator(fn: Callable) -> Callable:
        resources = (resource if isinstance(resource, list) else [resource])
        ops = getattr(fn, "_registered_ops", [])
        for p in resources:
            ro = RegisteredOp(
                name=name,
                resource=p,
                filetype=filetype,
                fn=fn,
                write=write,
            )
            ops.append(ro)
        setattr(fn, "_registered_ops", ops)
        return fn

    return decorator


class OpsRegistry:

    def __init__(self) -> None:
        self._registered: dict[tuple[str, str | None, str | None],
                               RegisteredOp] = {}

    def register(self, fn_or_op) -> None:
        if isinstance(fn_or_op, RegisteredOp):
            key = (fn_or_op.name, fn_or_op.filetype, fn_or_op.resource)
            self._registered[key] = fn_or_op
        elif hasattr(fn_or_op, "_registered_ops"):
            for ro in fn_or_op._registered_ops:
                key = (ro.name, ro.filetype, ro.resource)
                self._registered[key] = ro
        else:
            raise TypeError(
                f"Expected @op-decorated function or RegisteredOp, "
                f"got {type(fn_or_op)}")

    def unregister_resource(self, resource_kind: str) -> None:
        keys = [
            k for k, ro in self._registered.items()
            if ro.resource == resource_kind
        ]
        for k in keys:
            del self._registered[k]

    def resolve(
        self,
        name: str,
        resource: str,
        filetype: str | None = None,
    ) -> Callable:
        if filetype:
            key: tuple[str, str | None,
                       str | None] = (name, filetype, resource)
            if key in self._registered:
                return self._registered[key].fn

        key = (name, None, resource)
        if key in self._registered:
            return self._registered[key].fn

        key = (name, None, None)
        if key in self._registered:
            return self._registered[key].fn

        raise KeyError(f"no op registered: {name!r} for resource {resource!r}")

    async def call(
        self,
        name: str,
        resource: str,
        accessor: object,
        path: PathSpec,
        *args,
        filetype: str | None = None,
        **kwargs,
    ):
        levels = []
        if filetype:
            key: tuple[str, str | None,
                       str | None] = (name, filetype, resource)
            if key in self._registered:
                levels.append(self._registered[key].fn)

        key = (name, None, resource)
        if key in self._registered:
            levels.append(self._registered[key].fn)

        key = (name, None, None)
        if key in self._registered:
            levels.append(self._registered[key].fn)

        if not levels:
            raise KeyError(
                f"no op registered: {name!r} for resource {resource!r}")

        for fn in levels:
            result = fn(accessor, path, *args, **kwargs)
            if inspect.isawaitable(result):
                result = await result
            if result is not None:
                return result

        return None
