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

import functools
from dataclasses import dataclass, replace
from typing import Any, Callable

from mirage.commands.safeguard import CommandSafeguard
from mirage.commands.spec import CommandSpec
from mirage.commands.spec.help import render_help
from mirage.commands.spec.types import OperandKind, Option
from mirage.io.stream import yield_bytes
from mirage.io.types import IOResult

_HELP_OPTION = Option(
    long="--help",
    value_kind=OperandKind.NONE,
    description="Show this help and exit",
)


def _with_help_support(
        name: str, spec: CommandSpec,
        fn: Callable[..., Any]) -> tuple[CommandSpec, Callable[..., Any]]:
    has_help = any(o.long == "--help" for o in spec.options)
    new_spec = spec if has_help else replace(
        spec, options=spec.options + (_HELP_OPTION, ))
    help_text = render_help(name, new_spec).encode()

    @functools.wraps(fn)
    async def wrapper(accessor, paths, *texts, **kwargs):
        if kwargs.get("help") is True:
            return yield_bytes(help_text), IOResult()
        return await fn(accessor, paths, *texts, **kwargs)

    return new_spec, wrapper


@dataclass
class RegisteredCommand:
    name: str
    spec: CommandSpec
    resource: str | None
    filetype: str | None
    fn: Callable[..., Any]
    provision_fn: Callable[..., Any] | None = None
    aggregate: Callable[..., Any] | None = None
    src: str | None = None
    dst: str | None = None
    write: bool = False
    safeguard: CommandSafeguard | None = None


def command(
    name: str,
    *,
    resource: str | list[str] | None,
    spec: CommandSpec,
    filetype: str | None = None,
    provision: Callable[..., Any] | None = None,
    dry_run: Callable[..., Any] | None = None,
    aggregate: Callable[..., Any] | None = None,
    write: bool = False,
    safeguard: CommandSafeguard | None = None,
) -> Callable[..., Any]:

    def decorator(fn: Callable[..., Any]) -> Callable[..., Any]:
        resources = (resource if isinstance(resource, list) else [resource])
        new_spec, wrapped_fn = _with_help_support(name, spec, fn)
        cmds = getattr(wrapped_fn, "_registered_commands", [])
        for p in resources:
            rc = RegisteredCommand(
                name=name,
                spec=new_spec,
                resource=p,
                filetype=filetype,
                fn=wrapped_fn,
                provision_fn=provision or dry_run,
                aggregate=aggregate,
                write=write,
                safeguard=safeguard,
            )
            cmds.append(rc)
        setattr(wrapped_fn, "_registered_commands", cmds)
        return wrapped_fn

    return decorator


def cross_command(
    name: str,
    *,
    src: str,
    dst: str,
    spec: CommandSpec,
) -> Callable[..., Any]:

    def decorator(fn: Callable[..., Any]) -> Callable[..., Any]:
        rc = RegisteredCommand(
            name=name,
            spec=spec,
            resource=f"{src}->{dst}",
            filetype=None,
            fn=fn,
            src=src,
            dst=dst,
        )
        cmds = getattr(fn, "_registered_commands", [])
        cmds.append(rc)
        setattr(fn, "_registered_commands", cmds)
        return fn

    return decorator
