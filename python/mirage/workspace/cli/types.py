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

from dataclasses import dataclass

from pydantic import BaseModel

from mirage.commands.cli.types import CLISpec
from mirage.types import JsonValue


@dataclass(frozen=True)
class CLIInstall:
    """One installed CLI: a head word bound to a program tree.

    The installed name is the dispatch key, not the spec's own name:
    two installations of the same spec under different names (two
    accounts) are two independent entries whose help and errors
    attribute to their installed head.

    Args:
        name (str): installed head word (the YAML ``clis:`` key or the
            first argument of ``register_cli``).
        spec (CLISpec): the program tree the head dispatches into.
        config (BaseModel | dict[str, JsonValue] | None): the
            installation's validated ``config_model`` instance, handed
            to every leaf ``fn``; a script spec has no model, so its
            mapping passes through as-is (the program consumes it);
            None without either.
    """
    name: str
    spec: CLISpec
    config: "BaseModel | dict[str, JsonValue] | None" = None
