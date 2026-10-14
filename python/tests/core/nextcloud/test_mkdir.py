import pytest
from opendal.exceptions import Unexpected

from mirage.core.nextcloud.mkdir import mkdir
from mirage.types import PathSpec


@pytest.mark.asyncio
async def test_mkdir_creates_the_collection(make_acc):
    acc = make_acc({})
    await mkdir(acc, PathSpec.from_str_path("/newdir"))
    assert "newdir/" in acc._fake.dirs


@pytest.mark.asyncio
async def test_mkdir_refuses_a_missing_parent_without_parents(make_acc):
    """opendal's create_dir is MKCOL over the whole chain either way.

    So a bare ``mkdir a/b/c`` looks ``a/b`` up first, as mkdir(2) does.
    """
    acc = make_acc({})
    with pytest.raises(FileNotFoundError, match="'/a/b/c'$"):
        await mkdir(acc, PathSpec.from_str_path("/a/b/c"))
    assert acc._fake.dirs == set()


@pytest.mark.asyncio
async def test_mkdir_without_parents_creates_one_level(make_acc):
    acc = make_acc({"a/b/x": b""})
    await mkdir(acc, PathSpec.from_str_path("/a/b/c"))
    assert "a/b/c/" in acc._fake.dirs


@pytest.mark.asyncio
async def test_mkdir_parents_creates_the_whole_chain(make_acc):
    acc = make_acc({})
    await mkdir(acc, PathSpec.from_str_path("/a/b/c"), parents=True)
    assert "a/b/c/" in acc._fake.dirs


def _refuse_create(acc) -> None:
    async def create_dir(key: str) -> None:
        raise Unexpected("Unexpected (permanent) at create_dir, status 409")

    acc._fake.create_dir = create_dir


@pytest.mark.asyncio
async def test_mkdir_refuses_a_name_a_file_holds(make_acc):
    """MKCOL's 405 on a taken name reads as done; the stat after names it."""
    acc = make_acc({"mkp/f": b"x"})
    with pytest.raises(FileExistsError):
        await mkdir(acc, PathSpec.from_str_path("/mkp/f"))


@pytest.mark.asyncio
async def test_mkdir_under_a_file_is_enotdir(make_acc):
    acc = make_acc({"mkp/f": b"x"})
    _refuse_create(acc)
    with pytest.raises(NotADirectoryError, match="'/mkp/f/g'$"):
        await mkdir(acc, PathSpec.from_str_path("/mkp/f/g"))


@pytest.mark.asyncio
async def test_mkdir_under_a_deeper_file_names_the_operand(make_acc):
    acc = make_acc({"mkp/f": b"x"})
    with pytest.raises(NotADirectoryError, match="'/mkp/f/g/h'$"):
        await mkdir(acc, PathSpec.from_str_path("/mkp/f/g/h"))


@pytest.mark.asyncio
async def test_mkdir_parents_names_the_file_it_stops_at(make_acc):
    acc = make_acc({"mkp/f": b"x"})
    _refuse_create(acc)
    with pytest.raises(NotADirectoryError, match="'/mkp/f'$"):
        await mkdir(acc, PathSpec.from_str_path("/mkp/f/g/h"), parents=True)


@pytest.mark.asyncio
async def test_mkdir_keeps_a_refusal_no_file_explains(make_acc):
    acc = make_acc({"mkp/x": b""})
    _refuse_create(acc)
    with pytest.raises(Unexpected):
        await mkdir(acc, PathSpec.from_str_path("/mkp/g"))


@pytest.mark.asyncio
async def test_mkdir_raises_a_probe_that_fails_after_create(make_acc):
    """A probe that fails after MKCOL landed raises, the collection made."""
    acc = make_acc({})

    async def stat(key: str) -> None:
        raise Unexpected("Unexpected (temporary) at stat, status 503")

    acc._fake.stat = stat
    with pytest.raises(Unexpected):
        await mkdir(acc, PathSpec.from_str_path("/newdir"))
    assert "newdir/" in acc._fake.dirs
