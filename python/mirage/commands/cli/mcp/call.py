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

import json
import math
from collections.abc import Iterator

from mcp import types

from mirage.accessor.mcp import MCPAccessor, timed_out
from mirage.commands.config import Context
from mirage.core.render.json import compact_json_text
from mirage.io.types import IOResult
from mirage.types import PathSpec


def causes(error: BaseException) -> Iterator[str]:
    """The leaf errors inside an exception group, one each.

    Args:
        error (BaseException): what connecting or calling raised.
    """
    if isinstance(error, BaseExceptionGroup):
        for inner in error.exceptions:
            yield from causes(inner)
    else:
        yield f"{type(error).__name__}: {error}"


def command_name(tool_name: str) -> str:
    """The subcommand a tool becomes: underscores read as dashes.

    Args:
        tool_name (str): the MCP tool name.
    """
    return tool_name.replace("_", "-")


def _whole(digits: str) -> int:
    """Read a whole number, refusing one too large for a double, which
    JSON.parse reads as Infinity.

    Args:
        digits (str): the number's digits.
    """
    _finite(digits)
    return int(digits)


def _finite(constant: str) -> float:
    """Refuse ``NaN``, ``Infinity`` and a number too large for a double,
    which JSON cannot carry; read any other number as a float.

    Args:
        constant (str): the constant or number the parser met.
    """
    value = float(constant)
    if not math.isfinite(value):
        raise ValueError(f"{constant} is not a finite number")
    return value


def render(result: types.CallToolResult) -> str:
    """A tool's answer as text: text blocks as they are, others as JSON.

    Args:
        result (types.CallToolResult): what the tool returned.
    """
    parts = [
        block.text
        if block.type == "text"
        else compact_json_text(
            block.model_dump(mode="json", by_alias=True, exclude_none=True)
        )
        for block in result.content
    ]
    if not parts and result.structured_content is not None:
        parts.append(compact_json_text(result.structured_content))
    text = "\n".join(parts)
    return text if not text or text.endswith("\n") else text + "\n"


def _refuse(message: str, code: int) -> tuple[None, IOResult]:
    return None, IOResult(exit_code=code, stderr=f"{message}\n".encode())


async def call_tool(
    tool: str,
    accessor: MCPAccessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[bytes | None, IOResult]:
    """Run one MCP tool with the JSON object given as its operand.

    Args:
        tool (str): the tool's MCP name.
        accessor (MCPAccessor): the install's server.
        paths (list[PathSpec]): unused; a tool takes no path.
        texts (list[str]): at most one JSON object.
        ctx (Context): the command context.
    """
    command = command_name(tool)
    if len(texts) > 1:
        return _refuse(f"{command}: takes one JSON object", 2)
    try:
        arguments = (
            json.loads(
                texts[0],
                parse_constant=_finite,
                parse_float=_finite,
                parse_int=_whole,
            )
            if texts
            else {}
        )
    except ValueError:
        # The parser's own wording differs by host, so neither host prints it.
        return _refuse(f"{command}: invalid JSON", 2)
    if not isinstance(arguments, dict):
        return _refuse(f"{command}: JSON must be an object", 2)
    try:
        result = await accessor.call_tool(tool, arguments)
    except Exception as error:
        if timed_out(error):
            return _refuse(f"{command}: MCP server timed out", 1)
        reason = "; ".join(causes(error))
        return _refuse(f"{command}: MCP server failed: {reason}", 1)
    out = render(result).encode()
    if result.is_error:
        stderr = out or f"{command}: the tool reported an error\n".encode()
        return None, IOResult(exit_code=1, stderr=stderr)
    return out, IOResult()
