import pytest

claude_agent_sdk = pytest.importorskip("claude_agent_sdk")

from mirage import RAMVFS, MountMode, Workspace  # noqa: E402
from mirage.agents.claude_agent_sdk.options import build_options  # noqa: E402


@pytest.fixture
def workspace():
    return Workspace({"/": RAMVFS()}, mode=MountMode.WRITE)


def test_build_options_returns_claude_agent_options(workspace):
    options = build_options(workspace)
    assert isinstance(options, claude_agent_sdk.ClaudeAgentOptions)


def test_build_options_has_mirage_server(workspace):
    options = build_options(workspace)
    assert "mirage" in options.mcp_servers


def test_build_options_allowed_tools(workspace):
    options = build_options(workspace)
    assert "mcp__mirage__*" in options.allowed_tools


def test_build_options_disables_builtin_tools(workspace):
    options = build_options(workspace)
    assert options.tools == []


def test_build_options_custom_system_prompt(workspace):
    options = build_options(workspace, system_prompt="custom prompt")
    assert options.system_prompt == "custom prompt"


def test_build_options_default_system_prompt(workspace):
    options = build_options(workspace)
    assert options.system_prompt is not None
    assert len(options.system_prompt) > 0
