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
