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

from collections.abc import Mapping
from dataclasses import dataclass

from mirage.types import JsonValue


@dataclass(frozen=True)
class MCPTool:
    """One tool as an MCP server lists it.

    Args:
        name (str): the tool's MCP name.
        description (str): its description, possibly several lines.
        input_schema (Mapping[str, JsonValue]): the JSON schema of its
            arguments object.
        annotations (Mapping[str, JsonValue]): its MCP annotations, as
            MCP spells them (``readOnlyHint``).
    """

    name: str
    description: str
    input_schema: Mapping[str, JsonValue]
    annotations: Mapping[str, JsonValue]


@dataclass(frozen=True)
class MCPSource:
    """What a CLI is built from: the server's title and its tools.

    Args:
        title (str): the server's title, the root's description.
        tools (tuple[MCPTool, ...]): every tool, in the server's order.
    """

    title: str
    tools: tuple[MCPTool, ...]
