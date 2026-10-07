from unittest.mock import patch

import pytest

from mirage.vfs.dev.dev import DevVFS
from mirage.workspace.workspace.workspace import Workspace


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line,code,output,count",
    [
        ("cat <(printf first) <(printf second)", 0, "firstsecond", 2),
        ("cat <(printf first) >(cat)", 2, "", 1),
        ('set -u; cat <(printf first) "$missing"', 127, "", 1),
    ],
)
async def test_prepared_inputs_release_on_success_or_refusal(
    line, code, output, count
):
    allocate = DevVFS.allocate_input
    release = DevVFS.release_input
    ws = Workspace({})
    try:
        with (
            patch.object(
                DevVFS, "allocate_input", autospec=True, side_effect=allocate
            ) as allocated,
            patch.object(
                DevVFS, "release_input", autospec=True, side_effect=release
            ) as released,
        ):
            result = await ws.shell(line)
            assert (result.exit_code, await result.stdout_str()) == (
                code,
                output,
            )
            assert allocated.call_count == count
            assert released.call_count == count
            assert (
                len({call.args[1] for call in released.call_args_list})
                == count
            )
    finally:
        await ws.close()
