import pytest

from mirage.commands.builtin.generic.tsort import tsort_generic
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key


def _spec(path: str) -> PathSpec:
    return PathSpec(
        vfs_path=mount_key(path, ""),
        virtual=path,
        directory=path,
        resolved=True,
    )


def _read_bytes(files: dict[str, bytes]):
    async def read_bytes(path: PathSpec) -> bytes:
        if path.virtual not in files:
            raise FileNotFoundError(path.virtual)
        return files[path.virtual]

    return read_bytes


@pytest.mark.asyncio
async def test_tsort_basic():
    rb = _read_bytes({"deps": b"a b\nb c\n"})
    out, io = await tsort_generic([_spec("deps")], read_bytes=rb)
    assert out == b"a\nb\nc\n"
    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_tsort_cycle_detection():
    rb = _read_bytes({"deps": b"a b\nb a\n"})
    out, io = await tsort_generic([_spec("deps")], read_bytes=rb)
    assert (out, io.exit_code) == (b"a\nb\n", 1)
    assert io.stderr == (
        b"tsort: deps: input contains a loop:\ntsort: a\ntsort: b\n"
    )


@pytest.mark.asyncio
async def test_tsort_stdin():
    out, io = await tsort_generic(
        [], read_bytes=_read_bytes({}), stdin=b"x y\ny z\n"
    )
    assert out == b"x\ny\nz\n"


def _loops(name: str, *loops: list[str]) -> bytes:
    return b"".join(
        f"tsort: {name}: input contains a loop:\n".encode()
        + b"".join(f"tsort: {member}\n".encode() for member in loop)
        for loop in loops
    )


@pytest.mark.asyncio
async def test_tsort_cuts_loops_until_a_name_is_free():
    # GNU 9.7: each cut drops the pair that closed the loop, and the loops
    # go on until one cut frees a name.
    out, io = await tsort_generic(
        [],
        read_bytes=_read_bytes({}),
        stdin=b"h f\nb f\ng b\nf h\nh b\nh g\nh h\n",
    )
    assert (out, io.exit_code) == (b"b\nf\nh\ng\n", 1)
    assert io.stderr == _loops(
        "-", ["f", "h"], ["b", "f", "h", "g"], ["b", "f", "h"]
    )


@pytest.mark.asyncio
async def test_tsort_repeats_a_loop_held_by_a_repeated_pair():
    out, io = await tsort_generic(
        [],
        read_bytes=_read_bytes({}),
        stdin=b"d f\nb c\nc a\nd f\nf d\nc f\nd c\n",
    )
    assert (out, io.exit_code) == (b"b\nf\nd\nc\na\n", 1)
    assert io.stderr == _loops("-", ["f", "d", "c"], ["f", "d"], ["f", "d"])


@pytest.mark.asyncio
async def test_tsort_breaks_one_loop_per_component_smallest_first():
    rb = _read_bytes({"deps": b"q r\nr q\na b\nb a\nm n\n"})
    out, io = await tsort_generic([_spec("deps")], read_bytes=rb)
    assert (out, io.exit_code) == (b"m\nn\na\nb\nq\nr\n", 1)
    assert io.stderr == _loops("deps", ["a", "b"], ["q", "r"])


@pytest.mark.asyncio
async def test_tsort_walks_back_to_the_next_name_after_it():
    # The step back from c can take a or g; GNU takes g, the next name
    # after c, so the loop is a g c rather than a c.
    out, io = await tsort_generic(
        [], read_bytes=_read_bytes({}), stdin=b"a g a c\nc a h d g c d g\n"
    )
    assert (out, io.exit_code) == (b"h\nd\na\ng\nc\n", 1)
    assert io.stderr == _loops("-", ["a", "g", "c"])


@pytest.mark.asyncio
async def test_tsort_orders_the_free_names_by_bytes():
    out, io = await tsort_generic(
        [], read_bytes=_read_bytes({}), stdin=b"m n\nc d\nx y\na d\na c\n"
    )
    # GNU 9.7: a m x go first, in byte order; c follows them, d waits on c.
    assert (out, io.exit_code) == (b"a\nm\nx\nc\nn\ny\nd\n", 0)
