import pytest

from mirage.commands.builtin.generic.comm import comm
from mirage.io.types import materialize
from mirage.types import PathSpec

_COMM_FILES = {
    "/left.txt": b"b\na\n",
    "/right.txt": b"b\nc\n",
}


async def _read_comm_file(path: PathSpec) -> bytes:
    return _COMM_FILES[path.virtual]


@pytest.mark.asyncio
async def test_check_order_unsorted_input_exits_nonzero():
    stdout, io = await comm(
        [
            PathSpec.from_str_path("/left.txt"),
            PathSpec.from_str_path("/right.txt"),
        ],
        read_bytes=_read_comm_file,
        check_order=True,
    )

    await materialize(stdout)
    stderr = await materialize(io.stderr)
    assert io.exit_code == 1
    assert stderr == b"comm: file 1 is not in sorted order\n"
