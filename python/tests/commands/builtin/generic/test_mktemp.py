import pytest

from mirage.commands.builtin.generic.mktemp import mktemp
from mirage.utils.ids import SeededIdSource


@pytest.mark.asyncio
async def test_mktemp_makes_only_the_fallback_tmp():
    # A workspace root starts with no /tmp, so the fallback directory is
    # made on first use, and only when nothing named another one.
    made: list[str] = []
    files: set[str] = set()

    async def mkdir_fn(path):
        made.append(path.virtual)

    async def write_bytes_fn(path, data):
        if "/tmp" not in made:
            raise FileNotFoundError(path.virtual)
        files.add(path.virtual)

    out, io = await mktemp(mkdir_fn=mkdir_fn, write_bytes_fn=write_bytes_fn)
    assert io.exit_code == 0
    assert made == ["/tmp"]
    assert files == {out.decode().rstrip("\n")}


@pytest.mark.asyncio
async def test_mktemp_draws_again_when_a_name_is_taken():
    # GNU creates exclusively and tries another name, so a taken name is
    # never written over.
    probed: list[str] = []
    written: list[str] = []

    async def exists_fn(path):
        probed.append(path.virtual)
        return len(probed) == 1

    async def mkdir_fn(path):
        raise AssertionError("a file create makes no directory")

    async def write_bytes_fn(path, data):
        written.append(path.virtual)

    out, io = await mktemp(
        "x.XXX",
        mkdir_fn=mkdir_fn,
        write_bytes_fn=write_bytes_fn,
        cwd="/data",
        exists_fn=exists_fn,
    )
    assert io.exit_code == 0
    assert len(probed) == 2 and probed[0] != probed[1]
    assert written == [probed[1]]
    assert out == (probed[1][len("/data/") :] + "\n").encode()


@pytest.mark.asyncio
async def test_mktemp_gives_up_when_every_name_is_taken():
    written: list[str] = []

    async def exists_fn(path):
        return True

    async def write_bytes_fn(path, data):
        written.append(path.virtual)

    out, io = await mktemp(
        "x.XXX",
        mkdir_fn=write_bytes_fn,
        write_bytes_fn=write_bytes_fn,
        cwd="/data",
        exists_fn=exists_fn,
    )
    assert (out, io.exit_code, written) == (None, 1, [])
    assert io.stderr == (
        b"mktemp: failed to create file via template 'x.XXX': File exists\n"
    )


@pytest.mark.asyncio
async def test_mktemp_draws_its_name_from_the_id_source():
    # Pinned by mktemp.test.ts too: one seed names the same file on both
    # hosts.
    async def refuse(path, *_):
        raise AssertionError("-u creates nothing")

    for _ in range(2):
        out, io = await mktemp(
            "x.XXXXXX",
            mkdir_fn=refuse,
            write_bytes_fn=refuse,
            dry_run=True,
            ids=SeededIdSource(5),
        )
        assert io.exit_code == 0
        assert out == b"x.MNjKYk\n"
