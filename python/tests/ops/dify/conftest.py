from types import SimpleNamespace

import pytest

from mirage.cache.index import RAMIndexCacheStore
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key


@pytest.fixture
def dify_accessor() -> SimpleNamespace:
    return SimpleNamespace(config=SimpleNamespace(dataset_id="dataset-1",
                                                  slug_metadata_name="slug"))


@pytest.fixture
def dify_index() -> RAMIndexCacheStore:
    return RAMIndexCacheStore()


@pytest.fixture
def guide_path() -> PathSpec:
    return PathSpec.from_str_path(
        "/knowledge/guides/quickstart",
        mount_key("/knowledge/guides/quickstart", "/knowledge"))
