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


import dataclasses
import enum
import logging
import types
import typing
from typing import Any, Literal, Union, get_args, get_origin

from pydantic import BaseModel, SecretStr
from pydantic_core import PydanticUndefined

from mirage.commands.cli.mcp.constants import NAME as MCP_CLI
from mirage.commands.cli.specs import cli_spec_for, known_cli_names
from mirage.core.mcp.config import MCPConfig
from mirage.machine.config import MachineConfig
from mirage.machine.registry import known_providers, machine_class
from mirage.resources.types import EntryKind
from mirage.runtime.constants import (
    HOST,
    IN_PROCESS,
    SECRET_CONFIG_FIELDS,
    WORKER,
)
from mirage.runtime.python.local import LocalRuntime
from mirage.runtime.python.monty import MontyRuntime
from mirage.runtime.sandlock import SandlockRuntime
from mirage.runtime.table import in_process_runtimes, runtime_class
from mirage.server.resources.types import Field, FieldType, TypeTable
from mirage.vfs.registry import known_vfs_names, resolve_class, resolve_entry
from mirage.vfs.secrets import secret_field_names

logger = logging.getLogger(__name__)

SCALARS: dict[type, FieldType] = {
    bool: "boolean",
    int: "number",
    float: "number",
    str: "string",
    SecretStr: "string",
}

LISTS = (list, tuple, set, frozenset)


def members(annotation: Any) -> list[Any]:
    """An annotation's members without None: ``str | None`` is ``[str]``.

    Args:
        annotation (Any): the annotation.
    """
    if get_origin(annotation) in (Union, types.UnionType):
        return [a for a in get_args(annotation) if a is not type(None)]
    return [annotation]


def nested_model(annotation: Any) -> type[BaseModel] | None:
    found = members(annotation)
    if (
        len(found) == 1
        and isinstance(found[0], type)
        and issubclass(found[0], BaseModel)
    ):
        return found[0]
    return None


def kind_of(annotation: Any) -> tuple[FieldType, list[str] | None] | None:
    """The field type a config writes for ``annotation``, with its
    options, or None for one a config cannot write (a function, a map).

    Args:
        annotation (Any): the field's annotation.
    """
    found = members(annotation)
    if len(found) > 1:
        if any(kind_of(m) == ("string", None) for m in found):
            return ("string", None)
        return None
    one = found[0]
    if get_origin(one) is Literal:
        values = list(get_args(one))
        numeric = all(
            isinstance(v, (int, float)) and not isinstance(v, bool)
            for v in values
        )
        return ("number" if numeric else "string", [str(v) for v in values])
    if isinstance(one, type) and issubclass(one, enum.Enum):
        return ("string", [str(m.value) for m in one])
    if get_origin(one) in LISTS:
        element = get_args(one)[:1]
        if element and kind_of(element[0]) == ("string", None):
            return ("list", None)
        return None
    if isinstance(one, type) and one in SCALARS:
        return (SCALARS[one], None)
    return None


def described(
    name: str,
    kind: tuple[FieldType, list[str] | None],
    secret: bool,
    required: bool,
    description: str | None,
    default: Any,
) -> Field:
    field = Field(name=name, type=kind[0], secret=secret, required=required)
    if kind[1] is not None:
        field["options"] = kind[1]
    if description:
        field["description"] = description
    if isinstance(default, (str, int, float, bool)):
        field["default"] = default
    return field


def model_fields(model: type[BaseModel]) -> list[Field]:
    """A config model's fields as a config writes them: wire names, a
    nested block's fields as ``block.field`` in its ``group``, and only
    the fields a config can hold.

    Args:
        model (type[BaseModel]): the config model.
    """
    secret = set(secret_field_names(model))
    out: list[Field] = []
    for attr, info in model.model_fields.items():
        name = info.alias or attr
        block = nested_model(info.annotation)
        if block is not None:
            for inner in model_fields(block):
                inner["name"] = f"{name}.{inner['name']}"
                inner["group"] = name
                out.append(inner)
            continue
        kind = kind_of(info.annotation)
        if kind is None:
            continue
        default = None if info.default is PydanticUndefined else info.default
        out.append(
            described(
                name,
                kind,
                attr in secret,
                info.is_required(),
                info.description,
                default,
            )
        )
    return out


def dataclass_fields(config: type) -> list[Field]:
    """A config dataclass's fields, its credentials secret.

    Args:
        config (type): an engine's or a machine's ``config_cls``.
    """
    hints = typing.get_type_hints(config)
    out: list[Field] = []
    for f in dataclasses.fields(config):
        kind = kind_of(hints[f.name])
        if kind is None:
            continue
        required = (
            f.default is dataclasses.MISSING
            and f.default_factory is dataclasses.MISSING
        )
        default = None if f.default is dataclasses.MISSING else f.default
        out.append(
            described(
                f.name,
                kind,
                f.name in SECRET_CONFIG_FIELDS,
                required,
                None,
                default,
            )
        )
    return out


def vfs_model(name: str) -> type[BaseModel] | None:
    """The config model a registered VFS is built from, or None when it
    takes none or its extra is not installed.

    Args:
        name (str): the registry name.
    """
    entry = resolve_entry(name)
    if entry is None:
        return None
    try:
        ref = entry.config_path
        if ref is None:
            ref = getattr(resolve_class(entry.vfs_path), "CONFIG_CLS", None)
        model = resolve_class(ref) if isinstance(ref, str) else ref
    except ImportError as e:
        logger.debug("vfs %s is not installed: %s", name, e)
        return None
    if isinstance(model, type) and issubclass(model, BaseModel):
        return model
    return None


def vfs_types() -> TypeTable:
    """Every registered VFS that takes a config, with its fields."""
    out: TypeTable = {}
    for name in known_vfs_names():
        model = vfs_model(name)
        if model is not None:
            out[name] = model_fields(model)
    return out


def cli_types() -> TypeTable:
    """Every registered CLI that takes a config, and ``mcp``, with its
    fields."""
    out: TypeTable = {MCP_CLI: model_fields(MCPConfig)}
    for name in known_cli_names():
        try:
            model = cli_spec_for(name).config_model
        except ImportError as e:
            logger.debug("cli %s is not installed: %s", name, e)
            continue
        if model is not None:
            out[name] = model_fields(model)
    return dict(sorted(out.items()))


def machine_types() -> TypeTable:
    """Every machine provider and engine provider, with its fields: an
    ``in_process`` machine's are those of each runtime it may run, none
    required, and a ``host`` machine's include its ``sandbox`` block's as
    ``sandbox.<field>`` in that group."""
    captures = described("captures", ("list", None), False, False, None, None)
    engine: dict[str, Field] = {}
    for name in in_process_runtimes():
        try:
            config = runtime_class(name).config_cls
        except ImportError as e:
            logger.debug("runtime %s is not installed: %s", name, e)
            continue
        for field in dataclass_fields(config):
            field["required"] = False
            engine.setdefault(field["name"], field)
    base = {f.name for f in dataclasses.fields(MachineConfig)}
    sandbox = [
        field
        for field in dataclass_fields(SandlockRuntime.config_cls)
        if field["name"] not in base
    ]
    for field in sandbox:
        field["name"] = f"sandbox.{field['name']}"
        field["group"] = "sandbox"
    out: TypeTable = {
        IN_PROCESS: [
            described(
                "runtime",
                ("string", in_process_runtimes()),
                False,
                True,
                None,
                None,
            ),
            *engine.values(),
            captures,
        ],
        WORKER: [*dataclass_fields(MontyRuntime.config_cls), captures],
        HOST: [*dataclass_fields(LocalRuntime.config_cls), *sandbox, captures],
    }
    for provider in known_providers():
        try:
            cls = machine_class(provider)
        except ImportError as e:
            logger.debug("machine %s is not installed: %s", provider, e)
            continue
        out[provider] = dataclass_fields(cls.config_cls)
    return dict(sorted(out.items()))


TYPES = {
    "vfs": vfs_types,
    "cli": cli_types,
    "machine": machine_types,
}


def types_of(kind: EntryKind) -> TypeTable:
    """The types an entry of ``kind`` can be, each with its fields, read
    off mirage's registries and config schemas.

    Args:
        kind (EntryKind): the entry kind.
    """
    return TYPES[kind]()
