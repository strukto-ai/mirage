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

from dataclasses import replace

from mcp.types import TextContent

try:
    from fastmcp.client.client import CallToolResult
except ImportError as exc:
    raise ImportError(
        "`openenv` not installed. Install with: "
        "pip install 'openenv @ git+https://github.com/openenv/OpenEnv'"
    ) from exc

from mirage.agents.openenv.types import MirageObservation, Refusal, ToolName
from mirage.io.types import IOResult
from mirage.types import PolicyDecision
from mirage.workspace.tools.tool_operations import ToolResult


def refusal_of(decision: PolicyDecision | None) -> Refusal | None:
    """A policy's record as the observation carries it.

    Args:
        decision (PolicyDecision | None): The record off a line's
            result; None when nothing refused it.
    """
    if decision is None:
        return None
    return Refusal(
        kind=decision.kind,
        reason=decision.reason,
        policy=decision.policy,
        ask_id=decision.ask_id,
    )


async def io_to_observation(io: IOResult, cwd: str) -> MirageObservation:
    """A finished shell line as an observation; its streams are drained
    before the status is read.

    Args:
        io (IOResult): The line's result.
        cwd (str): The session's working directory after the line.
    """
    stdout = await io.stdout_str()
    stderr = await io.stderr_str()
    return MirageObservation(
        tool="shell",
        stdout=stdout,
        stderr=stderr,
        exit_code=io.exit_code,
        refusal=refusal_of(io.decision),
        cwd=cwd,
    )


def tool_to_observation(
    tool: ToolName, result: ToolResult, cwd: str
) -> MirageObservation:
    """A file tool's answer as an observation: stdout when it succeeded,
    stderr and exit code 1 when it failed.

    Args:
        tool (ToolName): The tool that answered.
        result (ToolResult): Its answer.
        cwd (str): The session's working directory.
    """
    if result.is_error:
        return MirageObservation(
            tool=tool, stderr=result.text, exit_code=1, cwd=cwd
        )
    return MirageObservation(tool=tool, stdout=result.text, cwd=cwd)


def with_text_data(result: CallToolResult) -> CallToolResult:
    """A tool's result with its text as ``data``, the value a FastMCP
    tool that returns a string hands back.

    FastMCP fills ``data`` only from structured content and Mirage's
    tools answer in text, so without this OpenEnv's
    ``MCPToolClient.call_tool`` would return None. An error, or a result
    that already has ``data``, is left as it is.

    Args:
        result (CallToolResult): What FastMCP's client parsed.
    """
    if result.is_error or result.data is not None:
        return result
    text = "".join(
        block.text
        for block in result.content
        if isinstance(block, TextContent)
    )
    return replace(result, data=text)
