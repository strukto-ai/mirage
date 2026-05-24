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
    data = config.model_dump(mode="json")
    for name in secret_field_names(config):
        if getattr(config, name) is None:
            continue
        data[name] = REDACTED_SECRET
    return data


def secret_field_names(config: type[BaseModel] | BaseModel) -> list[str]:
    model = config if isinstance(config, type) else type(config)
    fields = model.model_fields
    return [
        name for name, field in fields.items()
        if _is_secret_annotation(field.annotation)
    ]


def has_redacted_secret(
    config: Mapping[str, Any] | None,
    config_cls: type[BaseModel] | None = None,
) -> bool:
    if config is None:
        return False
    if config_cls is None:
        return _contains_redacted_secret(config)
    return any(
        _contains_redacted_secret(config.get(name))
        for name in secret_field_names(config_cls))


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
