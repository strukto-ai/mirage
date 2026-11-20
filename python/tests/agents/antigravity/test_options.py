import pytest

antigravity = pytest.importorskip("google.antigravity")

from mirage import RAMVFS, MountMode, Workspace  # noqa: E402
from mirage.agents.antigravity.options import build_config  # noqa: E402
from mirage.workspace.store.ram import RAMWorkspaceStateStore  # noqa: E402


@pytest.fixture
def workspace():
    return Workspace({"/": RAMVFS()}, mode=MountMode.WRITE)


@pytest.mark.asyncio
async def test_build_config_returns_local_agent_config(workspace):
    config = await build_config(workspace)
    assert isinstance(config, antigravity.LocalAgentConfig)


@pytest.mark.asyncio
async def test_build_config_registers_mirage_tools(workspace):
    config = await build_config(workspace)
    assert [tool.__name__ for tool in config.tools] == [
        "shell",
        "read",
        "write",
        "edit",
        "ls",
        "grep",
        "glob",
    ]


@pytest.mark.asyncio
async def test_build_config_turns_off_builtin_tools_and_subagents(workspace):
    config = await build_config(workspace)
    assert config.capabilities.enabled_tools == [
        antigravity.BuiltinTools.FINISH
    ]
    assert config.capabilities.enable_subagents is False


@pytest.mark.asyncio
async def test_build_config_custom_system_prompt(workspace):
    config = await build_config(workspace, system_prompt="custom prompt")
    assert config.system_instructions == "custom prompt"


@pytest.mark.asyncio
async def test_build_config_default_system_prompt(workspace):
    config = await build_config(workspace)
    assert isinstance(config.system_instructions, str)
    assert "/" in config.system_instructions


@pytest.mark.asyncio
async def test_a_stored_sessions_profile_picks_its_tools():
    store = RAMWorkspaceStateStore()
    ram = RAMVFS()
    writer = Workspace(
        {"/": ram}, mode=MountMode.WRITE, workspace_id="shared", store=store
    )
    writer.create_session("reader", profile={"mounts": {"/": "read"}})
    await writer.ensure_sessions_loaded()
    await writer.flush_sessions()
    attached = Workspace(
        {"/": ram}, mode=MountMode.WRITE, workspace_id="shared", store=store
    )
    try:
        config = await build_config(attached, session_id="reader")
    finally:
        await writer.close()
        await attached.close()
    assert [tool.__name__ for tool in config.tools] == [
        "shell",
        "read",
        "ls",
        "grep",
        "glob",
    ]
