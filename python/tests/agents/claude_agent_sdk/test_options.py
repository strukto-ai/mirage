import pytest

claude_agent_sdk = pytest.importorskip("claude_agent_sdk")

from mirage import RAMVFS, MountMode, Workspace  # noqa: E402
from mirage.agents.claude_agent_sdk.options import build_options  # noqa: E402


@pytest.fixture
def workspace():
    return Workspace({"/": RAMVFS()}, mode=MountMode.WRITE)


@pytest.mark.asyncio
async def test_build_options_returns_claude_agent_options(workspace):
    options = await build_options(workspace)
    assert isinstance(options, claude_agent_sdk.ClaudeAgentOptions)


@pytest.mark.asyncio
async def test_build_options_has_mirage_server(workspace):
    options = await build_options(workspace)
    assert "mirage" in options.mcp_servers


@pytest.mark.asyncio
async def test_build_options_allowed_tools(workspace):
    options = await build_options(workspace)
    assert "mcp__mirage__*" in options.allowed_tools


@pytest.mark.asyncio
async def test_build_options_disables_builtin_tools(workspace):
    options = await build_options(workspace)
    assert options.tools == []


@pytest.mark.asyncio
async def test_build_options_custom_system_prompt(workspace):
    options = await build_options(workspace, system_prompt="custom prompt")
    assert options.system_prompt == "custom prompt"


@pytest.mark.asyncio
async def test_build_options_default_system_prompt(workspace):
    options = await build_options(workspace)
    assert options.system_prompt is not None
    assert len(options.system_prompt) > 0
