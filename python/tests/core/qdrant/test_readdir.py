import pytest

from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.core.qdrant.naming import group_name
from mirage.core.qdrant.readdir import _blob_size, readdir
from mirage.core.qdrant.render import blob_bytes, render_json, render_text
from mirage.types import PathSpec
from mirage.utils.sanitize import NAME_MAX_BYTES, byte_len


def _ps(path: str) -> PathSpec:
    return PathSpec(virtual=path, directory=path, vfs_path=path.strip("/"))


def _names(paths: list[str]) -> set[str]:
    return {p.rsplit("/", 1)[-1] for p in paths}


@pytest.mark.asyncio
async def test_root_lists_collection(accessor):
    out = await readdir(accessor, _ps("/"))
    assert _names(out) == {"animals"}


@pytest.mark.asyncio
async def test_collection_lists_groups(accessor):
    out = await readdir(accessor, _ps("/animals"))
    assert _names(out) == {"cat", "dog"}


@pytest.mark.asyncio
async def test_group_lists_next_level(accessor):
    out = await readdir(accessor, _ps("/animals/cat"))
    assert _names(out) == {"big", "small"}


@pytest.mark.asyncio
async def test_leaf_lists_row_files(accessor):
    out = await readdir(accessor, _ps("/animals/cat/big"))
    assert _names(out) == {"1.json", "1.txt", "1.png"}


@pytest.mark.asyncio
async def test_leaf_seeds_exact_rendered_sizes(accessor):
    index = RAMIndexCacheStore()
    await readdir(accessor, _ps("/animals/cat/big"), index)
    config = accessor.config
    row = {
        "label": "cat",
        "kind": "big",
        "name": "a big orange cat",
        "image_bytes": "UE5HLTE=",
        "id": 1,
    }
    json_lookup = await index.get("/animals/cat/big/1.json")
    assert json_lookup.entry is not None
    assert json_lookup.entry.size == len(render_json(row, config))
    txt_lookup = await index.get("/animals/cat/big/1.txt")
    assert txt_lookup.entry is not None
    assert txt_lookup.entry.size == len(render_text(row, config))
    blob_lookup = await index.get("/animals/cat/big/1.png")
    assert blob_lookup.entry is not None
    assert blob_lookup.entry.size == len(blob_bytes("UE5HLTE="))


def test_blob_size_leaves_undecodable_values_unknown():
    # An undecodable blob must leave that one size unknown rather than take
    # the whole directory listing down with it.
    assert _blob_size("UE5HLTE=") == 5
    assert _blob_size(42) is None


def _globbed(path: str, pattern: str) -> PathSpec:
    return PathSpec(virtual=path,
                    directory=path,
                    vfs_path=path.strip("/"),
                    pattern=pattern)


def _ids(paths: list[str]) -> set[str]:
    return {p.rsplit("/", 1)[-1].split(".")[0] for p in paths}


@pytest.mark.asyncio
async def test_a_row_glob_reaches_past_the_cap(capped):
    # The cap covers ids 1..5, so filtering it would answer nothing.
    # Qdrant has no prefix condition, so the scroll keeps paging and
    # tests each page until it has as many MATCHES as the cap allows.
    out = await readdir(capped, _globbed("/all", "45*"))
    assert _ids(out) == {"45", "450", "451", "452", "453"}
    assert (await capped.client()).pages > 1


@pytest.mark.asyncio
async def test_a_glob_with_no_literal_head_stays_capped(capped):
    out = await readdir(capped, _globbed("/all", "*9.json"))
    assert _ids(out) == {"1", "2", "3", "4", "5"}
    assert (await capped.client()).pages == 1


@pytest.mark.asyncio
async def test_a_basename_glob_reaches_a_source_past_the_cap(basename_capped):
    out = await readdir(basename_capped, _globbed("/", "target*"))
    assert _names(out) == {"target-late.pdf"}
    assert (await basename_capped.client()).pages > 1

    # Resolving the rendered directory name must use the same targeted scan,
    # otherwise a basename found by the glob cannot subsequently be opened.
    document = await readdir(basename_capped, _ps("/target-late.pdf"))
    assert _names(document) == {"600.json"}


@pytest.mark.asyncio
async def test_a_narrowed_listing_is_not_cached_as_the_directory(capped):
    index = RAMIndexCacheStore()
    await readdir(capped, _globbed("/all", "45*"), index)
    listing = await index.list_dir("/all/")
    assert listing.entries is None
    plain = await readdir(capped, _ps("/all"), index)
    assert _ids(plain) == {"1", "2", "3", "4", "5"}


@pytest.mark.asyncio
async def test_document_lineage_uses_nested_fields_and_source_basename(
        lineage):
    root = await readdir(lineage, _ps("/"))
    assert _names(root) == {"refund-2026.pdf"}
    document = await readdir(lineage, _ps("/refund-2026.pdf"))
    assert _names(document) == {"004__1.json", "004__1.txt"}


@pytest.mark.asyncio
async def test_a_value_holding_the_division_slash_keeps_its_own_directory(
        slashed):
    root = await readdir(slashed, _ps("/"))
    assert _names(root) == {"a∕b", "a⁄∕b"}
    assert _ids(await readdir(slashed, _ps("/a∕b"))) == {"1"}
    assert _ids(await readdir(slashed, _ps("/a⁄∕b"))) == {"2"}


@pytest.mark.asyncio
async def test_blank_and_dot_led_values_list_and_open(edged):
    # A blank value listed as ``unknown`` and then filtered for that word;
    # a dot-led one was dropped as hidden and refused as a path. Both carry
    # the escape lead, so each lists and filters for its own value.
    assert _names(await readdir(edged, _ps("/"))) == {"⁄", "⁄.env"}
    assert _ids(await readdir(edged, _ps("/⁄"))) == {"1"}
    assert _ids(await readdir(edged, _ps("/⁄.env"))) == {"2"}


@pytest.mark.asyncio
async def test_a_basename_collision_past_the_cap_is_refused(
        basename_collision_capped):
    # The capped listing sees one source. Opening the directory must not
    # settle for it: the scan runs past the cap until the second source
    # with that basename shows up, and refuses rather than picking one.
    root = await readdir(basename_collision_capped, _ps("/"))
    assert _names(root) == {"report.pdf"}
    with pytest.raises(ValueError, match="basename collision"):
        await readdir(basename_collision_capped, _ps("/report.pdf"))
    assert (await basename_collision_capped.client()).pages > 1


@pytest.mark.asyncio
async def test_basename_collision_is_refused(lineage):
    from types import SimpleNamespace

    client = await lineage.client()
    client.points[0].payload["metadata"]["source"] = "s3://a/report.pdf"
    client.points.append(
        SimpleNamespace(id=2,
                        payload={"metadata": {
                            "source": "s3://b/report.pdf"
                        }}))

    with pytest.raises(ValueError, match="path collision"):
        await readdir(lineage, _ps("/"))


@pytest.mark.asyncio
async def test_a_basename_past_name_max_lists_within_it_and_opens(
        long_basename):
    # The rows under a leaf longer than NAME_MAX were unreachable over a
    # FUSE mount, which refuses the name. The directory is cut to fit, and
    # two leaves the cut would merge keep their own directories and rows.
    names = _names(await readdir(long_basename, _ps("/")))
    assert len(names) == 2
    for name in names:
        assert byte_len(name) <= NAME_MAX_BYTES
    first = group_name(f"s3://docs/{'r' * 300}a.pdf", basename=True)
    second = group_name(f"s3://docs/{'r' * 300}b.pdf", basename=True)
    assert names == {first, second}
    assert _ids(await readdir(long_basename, _ps(f"/{first}"))) == {"1"}
    assert _ids(await readdir(long_basename, _ps(f"/{second}"))) == {"2"}
