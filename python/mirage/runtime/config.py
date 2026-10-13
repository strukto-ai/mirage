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

import os
import re
from dataclasses import dataclass, fields
from typing import Any, TypeVar

from mirage.cache.file.utils import parse_limit

T = TypeVar("T", bound="RuntimeConfig")


def memory_limit(value: str | int | None) -> int | None:
    """A runtime's ``max_memory`` in bytes, None for no cap.

    Spelled as sandlock spells its own (``10M``, ``512M``, ``1G``), or a
    count of bytes.

    Args:
        value (str | int | None): the setting as configured.

    Raises:
        ValueError: the setting is not a size.
    """
    if value is None:
        return None
    if isinstance(value, bool) or not (
        (isinstance(value, int) and value >= 0)
        or (
            isinstance(value, str)
            and re.fullmatch(r"\d+([KMG]B?)?", value.strip(), re.IGNORECASE)
        )
    ):
        raise ValueError(
            f"max_memory must be a size like 10M or 1G, got {value!r}"
        )
    return parse_limit(value)


@dataclass(frozen=True, slots=True)
class RuntimeConfig:
    """How a runtime's engine is set up: its implementation knobs.

    Every runtime is constructed the same way (captures, config); what
    differs between runtimes lives here. Each runtime class names its
    own config subclass (config_cls), so an option the runtime does not
    have is simply not a field there and fails loud at construction. In
    yaml this is the runtime entry's ``config`` block, mirroring a
    mount's.
    """

    @classmethod
    def coerce(
        cls: type[T], value: "RuntimeConfig | dict[str, Any] | None"
    ) -> T:
        """A constructor's config argument as this runtime's config.

        Args:
            value (RuntimeConfig | dict | None): an instance, its dict
                form (a yaml ``config`` block), or None for the
                defaults. Unknown keys fail loud.
        """
        if value is None:
            return cls()
        if isinstance(value, cls):
            return value
        if isinstance(value, RuntimeConfig):
            value = {f.name: getattr(value, f.name) for f in fields(value)}
        return cls(**value)


@dataclass(frozen=True, slots=True)
class HomeConfig(RuntimeConfig):
    """Config for runtimes whose engine lives in a directory or binary.

    Args:
        home (str | None): where the engine is (a wasm build dir, an
            interpreter path). None falls back to the runtime's own
            environment variable, then its built-in default.
    """

    home: str | None = None


def resolve_home(config: HomeConfig, env_var: str) -> str | None:
    """Where a runtime's engine is: the config's ``home``, else
    ``env_var``'s value, else None for the runtime's built-in default.

    Args:
        config (HomeConfig): the runtime's config.
        env_var (str): the environment variable the runtime reads.
    """
    return config.home or os.environ.get(env_var) or None
