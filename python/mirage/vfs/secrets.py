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

from collections.abc import Iterable, Mapping
from typing import Any, get_args

from pydantic import BaseModel, SecretBytes, SecretStr

REDACTED_SECRET = "<REDACTED>"


def reveal_secret(value: Any) -> Any:
    if isinstance(value, (SecretStr, SecretBytes)):
        return value.get_secret_value()
    return value


def redacted_config_dump(config: BaseModel) -> dict[str, Any]:
    return _walk_config_dump(config, _base_dump(config), True)


def revealed_config_dump(config: BaseModel) -> dict[str, Any]:
    return _walk_config_dump(config, _base_dump(config), False)


def _base_dump(config: BaseModel) -> dict[str, Any]:
    """Dump every field pydantic can serialize, secrets excluded.

    A credential is not always a ``SecretStr``: ``MsGraphConfig`` and
    ``GoogleConfig`` both accept a provider callable, so the holder of
    the OAuth dance can hand over a fresh token per request instead of a
    long-lived one. pydantic cannot serialize a function, so dumping the
    whole model raised ``PydanticSerializationError`` and took the whole
    snapshot with it. The walk writes every secret field back off the
    model anyway, so excluding them here loses nothing.

    Args:
        config (BaseModel): the VFS config being dumped.

    Returns:
        dict[str, Any]: the JSON-mode dump, minus the secret fields.
    """
    return config.model_dump(mode="json",
                             exclude=set(secret_field_names(config)))


def _walk_config_dump(config: BaseModel, data: dict[str, Any],
                      redact: bool) -> dict[str, Any]:
    # Nested models carry their own secret annotations, so the walk
    # recurses instead of trusting the top-level field list: a missed
    # nested SecretStr would serialize as pydantic's mask, which reads
    # as a real credential and never demands a fresh override.
    secrets = set(secret_field_names(config))
    for name in type(config).model_fields:
        # A secret is absent from `data` by construction (_base_dump
        # excludes them) and is written back below off the model.
        if name not in data and name not in secrets:
            continue
        value = getattr(config, name)
        if name in secrets:
            if value is None:
                data[name] = None
            elif callable(value):
                # A provider callable has no serialized form, and
                # revealing it would mean calling it and freezing one
                # token into a snapshot that outlives it. Redacted in
                # both modes, which is already the contract that makes
                # `requires_vfs_override` demand a fresh VFS
                # at load.
                data[name] = REDACTED_SECRET
            else:
                data[name] = REDACTED_SECRET if redact else reveal_secret(
                    value)
        elif isinstance(value, BaseModel):
            data[name] = _walk_config_dump(value, data[name], redact)
        elif isinstance(value, (list, tuple)):
            data[name] = [
                _walk_config_dump(item, dumped, redact) if isinstance(
                    item, BaseModel) else dumped
                for item, dumped in zip(value, data[name])
            ]
    return data


def secret_field_names(config: type[BaseModel] | BaseModel) -> list[str]:
    model = config if isinstance(config, type) else type(config)
    fields = model.model_fields
    return [
        name for name, field in fields.items()
        if _is_secret_annotation(field.annotation)
    ]


def has_redacted_secret(config: Mapping[str, Any] | None) -> bool:
    """Whether a saved config carries the redaction marker anywhere.

    Every value is scanned, never just the secret fields of a config
    class: the class a saved mount resolves to is a guess when the
    VFS was an alias (MinIO saves its own config under the ``s3``
    type), and a guess that named the wrong fields let a mount rebuild
    with the literal marker as its key. TypeScript's
    ``hasRedactedSecret`` scans values the same way.

    Args:
        config (Mapping[str, Any] | None): the saved config dump.
    """
    if config is None:
        return False
    return _contains_redacted_secret(config)


def _contains_redacted_secret(value: Any) -> bool:
    if value == REDACTED_SECRET:
        return True
    if isinstance(value, Mapping):
        return any(_contains_redacted_secret(v) for v in value.values())
    if isinstance(value, Iterable) and not isinstance(value, (str, bytes)):
        return any(_contains_redacted_secret(v) for v in value)
    return False


def _is_secret_annotation(annotation: Any) -> bool:
    if annotation in (SecretStr, SecretBytes):
        return True
    return any(_is_secret_annotation(arg) for arg in get_args(annotation))
