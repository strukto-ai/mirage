import pytest

from mirage import MountMode, Workspace
from mirage.core.dify import tree
from mirage.resource.dify import DifyConfig, DifyResource


async def list_documents(config):
    return [{
        "id": "doc-1",
        "name": "Quickstart",
        "doc_metadata": [{
            "name": "slug",
            "value": "guides/quickstart"
        }],
        "enabled": True,
        "indexing_status": "completed",
        "archived": False,
        "tokens": 5,
        "data_source_type": "upload_file",
        "data_source_detail_dict": {
            "upload_file": {
                "size": 321
            }
        },
        "created_at": 1716282000,
    }]


def resource() -> DifyResource:
    return DifyResource(
        DifyConfig(
            api_key="secret",
            base_url="https://dify.example/v1",
            dataset_id="dataset-1",
        ))


def test_workspace_mount_registers_dify_commands_and_ops():
    workspace = Workspace({"/knowledge": resource()}, mode=MountMode.READ)
    mount = workspace.mount("/knowledge/")

    assert "awk" in mount.commands()
    assert "ls" in mount.commands()
    assert "cat" in mount.commands()
    assert "cut" in mount.commands()
    assert "rg" in mount.commands()
    assert "sed" in mount.commands()
    assert "sort" in mount.commands()
    assert "stat" in mount.commands()
    assert "tree" in mount.commands()
    assert "uniq" in mount.commands()
    assert "du" in mount.commands()
    assert "read" in mount.registered_ops()
    assert "stat" in mount.registered_ops()


@pytest.mark.asyncio
async def test_workspace_executes_dify_ls(monkeypatch):
    monkeypatch.setattr(tree, "list_all_documents", list_documents)
    workspace = Workspace({"/knowledge": resource()}, mode=MountMode.READ)

    result = await workspace.execute("ls /knowledge")

    assert result.exit_code == 0
    assert await result.stdout_str() == "guides\n"
