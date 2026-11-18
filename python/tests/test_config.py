import pytest

from mirage.config import WorkspaceConfig
from mirage.workspace.workspace import Workspace


@pytest.mark.parametrize(
    "value, expected", [(1024, 1024), ("1MB", 1048576), (None, 67108864)]
)
@pytest.mark.asyncio
async def test_workspace_body_limit_reaches_constructor(value, expected):
    config = WorkspaceConfig.model_validate(
        {"mounts": {}, "max_body_bytes": value}
    )
    ws = Workspace(**config.to_workspace_kwargs())
    try:
        assert ws.registry.body_limit == expected
    finally:
        await ws.close()


@pytest.mark.parametrize("value", [-1, "lots", "-1MB"])
def test_workspace_body_limit_rejects_invalid_sizes(value):
    with pytest.raises(ValueError, match="max_body_bytes"):
        WorkspaceConfig.model_validate({"mounts": {}, "max_body_bytes": value})


def test_workspace_body_limit_does_not_allow_unknown_siblings():
    with pytest.raises(ValueError, match="max_body_byte"):
        WorkspaceConfig.model_validate(
            {"mounts": {}, "max_body_bytes": 10, "max_body_byte": 10}
        )


def test_a_machine_mount_names_a_machine_the_document_defines():
    machines = {"gpu": {"provider": "docker", "container": "c"}}
    config = WorkspaceConfig.model_validate(
        {"mounts": {"/tmp": "@gpu"}, "machines": machines}
    )
    assert config.mounts["/tmp"].config["machines"] == ["gpu"]
    with pytest.raises(
        ValueError, match="no machine 'cpu' \\(machines: 'gpu'\\)"
    ):
        WorkspaceConfig.model_validate(
            {"mounts": {"/tmp": "@cpu"}, "machines": machines}
        )
    with pytest.raises(ValueError, match="no machine 'cpu'"):
        WorkspaceConfig.model_validate(
            {
                "mounts": {
                    "/tmp": {
                        "vfs": "machine",
                        "config": {"root": "/tmp", "default_machine": "cpu"},
                    }
                },
                "machines": machines,
            }
        )


@pytest.mark.parametrize("selected", ["gpu", [1]])
def test_machine_mount_requires_a_list_of_machine_names(selected):
    with pytest.raises(
        ValueError, match="machines must be a list of machine names"
    ):
        WorkspaceConfig.model_validate(
            {
                "mounts": {
                    "/tmp": {
                        "vfs": "machine",
                        "config": {"machines": selected},
                    }
                },
                "machines": {"gpu": {"provider": "docker", "container": "c"}},
            }
        )


def test_at_machine_is_that_machine_s_files_at_its_own_path():
    config = WorkspaceConfig.model_validate(
        {"mounts": {"/tmp/": "@gpu", "/data": {"vfs": "ram"}}}
    )
    block = config.mounts["/tmp/"]
    assert (block.vfs, block.config) == (
        "machine",
        {"root": "/tmp", "machines": ["gpu"]},
    )
    mount = config.to_workspace_kwargs()["mounts"]["/tmp/"]
    assert (
        mount.vfs.name,
        mount.vfs.config.root,
        mount.vfs.config.machines,
        mount.vfs_ref,
    ) == ("machine", "/tmp", ("gpu",), "machine")
