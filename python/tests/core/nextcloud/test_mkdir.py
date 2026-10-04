import pytest
from opendal.exceptions import Unexpected

from mirage.cache.context import push_cache_manager
from mirage.core.nextcloud.mkdir import mkdir
from mirage.types import PathSpec


class _RecordingInvalidator:
    """Collects the paths each invalidation hook was told about."""

    def __init__(self) -> None:
        self.writes: list[str] = []
        self.ancestors: list[str] = []
        self.unlinks: list[str] = []
        self.subtrees: list[str] = []

    async def invalidate_ancestors(self, path: PathSpec) -> None:
        self.ancestors.append(path.virtual)

    async def invalidate_after_write(self, path: PathSpec) -> None:
        self.writes.append(path.mount_path)

    async def invalidate_after_unlink(self, path: PathSpec) -> None:
        self.unlinks.append(path.mount_path)

    async def invalidate_subtree(self, path: PathSpec) -> None:
        self.subtrees.append(path.mount_path)

    async def cached_bytes(self, path: PathSpec) -> bytes | None:
        return None

    async def cached_size(self, path: PathSpec) -> int | None:
        return None


async def _record(
    accessor, path: PathSpec, **kwargs: bool
) -> _RecordingInvalidator:
    recorder = _RecordingInvalidator()
    previous = push_cache_manager(recorder)
    try:
        await mkdir(accessor, path, **kwargs)
    finally:
        push_cache_manager(previous)
    return recorder


@pytest.mark.asyncio
async def test_mkdir_creates_the_collection(make_acc):
    acc = make_acc({})
    await mkdir(acc, PathSpec.from_str_path("/newdir"))
    assert "newdir/" in acc._fake.dirs


@pytest.mark.asyncio
async def test_mkdir_invalidates_every_ancestor_without_parents(make_acc):
    """opendal's create_dir is MKCOL over the whole chain either way.

    So the ancestor walk cannot be gated on ``parents``: a bare
    ``mkdir a/b/c`` materializes ``a`` and ``a/b`` too, and their cached
    listings hid the new levels until the index TTL expired.
    """
    recorder = await _record(make_acc({}), PathSpec.from_str_path("/a/b/c"))
    assert recorder.writes == ["/a/b/c"]
    assert recorder.ancestors == ["/a/b/c"]


@pytest.mark.asyncio
async def test_mkdir_parents_invalidates_the_same_chain(make_acc):
    recorder = await _record(
        make_acc({}), PathSpec.from_str_path("/a/b/c"), parents=True
    )
    assert recorder.writes == ["/a/b/c"]
    assert recorder.ancestors == ["/a/b/c"]


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
    with pytest.raises(NotADirectoryError):
        await mkdir(acc, PathSpec.from_str_path("/mkp/f/g"))


@pytest.mark.asyncio
async def test_mkdir_keeps_a_refusal_no_file_explains(make_acc):
    acc = make_acc({})
    _refuse_create(acc)
    with pytest.raises(Unexpected):
        await mkdir(acc, PathSpec.from_str_path("/mkp/g"))
