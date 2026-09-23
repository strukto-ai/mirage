from unittest.mock import AsyncMock

import pytest

from mirage import MountMode, Workspace
from mirage.vfs.wandb import WandbConfig, WandbVFS


@pytest.mark.asyncio
async def test_mount_scopes_and_indexes_are_isolated() -> None:
    first = WandbVFS(WandbConfig(entities=["lab", "lab"]))
    second = WandbVFS(WandbConfig(entities=["other"]))
    first.accessor.client.request = AsyncMock()
    second.accessor.client.request = AsyncMock()
    workspaces = [Workspace({"/wandb": vfs}) for vfs in [first, second]]
    try:
        for ws, entity, excluded in zip(workspaces, ["lab", "other"],
                                        ["other", "lab"]):
            result = await ws.shell("ls /wandb")
            assert result.exit_code == 0
            assert result.stdout.decode().split() == [entity]
            assert (await ws.shell(f"ls /wandb/{excluded}")).exit_code != 0
        first.accessor.client.request.assert_not_awaited()
        second.accessor.client.request.assert_not_awaited()
    finally:
        for ws in workspaces:
            await ws.close()


@pytest.mark.asyncio
async def test_write_workspace_cannot_mutate_wandb_or_invoke_a_wandb_cli(
) -> None:
    vfs = WandbVFS(WandbConfig(entities=["lab"]))
    vfs.accessor.client.request = AsyncMock()
    ws = Workspace({"/wandb": vfs}, mode=MountMode.WRITE)
    try:
        for command in [
                "echo bad > /wandb/lab/project/run/summary.json",
                "mkdir /wandb/lab/new-project",
                "type -t wandb",
        ]:
            assert (await ws.shell(command)).exit_code != 0
        vfs.accessor.client.request.assert_not_awaited()
    finally:
        await ws.close()
