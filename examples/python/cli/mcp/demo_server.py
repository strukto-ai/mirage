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
from pathlib import Path

from mcp.server import MCPServer
from mcp.types import ToolAnnotations
from pydantic import BaseModel

# A deterministic MCP server over stdio, so the converters run without
# credentials or network access. Its tools cover a flat input, a nested
# input, a tool that reports an error and a slow write to cancel.
server = MCPServer("demo")


class Owner(BaseModel):
    name: str
    email: str


@server.tool(annotations=ToolAnnotations(readOnlyHint=True))
def add_numbers(a: int, b: int) -> str:
    """Add two integers."""
    return str(a + b)


@server.tool()
def create_ticket(title: str, labels: list[str], owner: Owner) -> str:
    """Create a ticket owned by one person."""
    labels_text = ", ".join(labels) or "none"
    return f"{title} [{labels_text}] owned by {owner.name} <{owner.email}>"


@server.tool(annotations=ToolAnnotations(destructiveHint=True))
def delete_project(project: str) -> str:
    """Delete a project. This demo refuses every project."""
    raise ValueError(f"project {project} is protected")


@server.tool()
async def slow_write(path: str) -> str:
    """Write PATH.started, then PATH two seconds later."""
    Path(f"{path}.started").touch()
    await asyncio.sleep(2)
    Path(path).touch()
    return path


if __name__ == "__main__":
    server.run()
