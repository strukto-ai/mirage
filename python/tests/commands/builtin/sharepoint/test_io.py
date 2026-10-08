import pytest

import mirage.core.msgraph.client as graph_client
from mirage.accessor.sharepoint import SharePointAccessor, SharePointConfig
from mirage.cache.index import RAMIndexCacheStore
from mirage.types import PathSpec
from mirage.vfs.sharepoint import SharePointVFS
from tests.fixtures.vfs_io import vfs_over

_API = "https://graph.microsoft.com/v1.0"
_GRAPH = {
    f"{_API}/sites": {"value": [{"id": "site-id", "displayName": "Team"}]},
    f"{_API}/sites/site-id/drives": {
        "value": [{"id": "drive-id", "name": "Documents"}]
    },
    f"{_API}/drives/drive-id/root/children": {
        "value": [
            {"id": "1", "name": "a.txt", "size": 3, "file": {}},
            {"id": "2", "name": "b.txt", "size": 4, "file": {}},
        ]
    },
}


@pytest.mark.asyncio
@pytest.mark.parametrize("key", ["", "Team", "Team/Documents"])
async def test_du_walks_the_namespace_levels(monkeypatch, key):
    # An unscoped mount's root and site levels are directories like any
    # other, so du sums every library under them, one list per level.
    seen: list[str] = []

    async def _request(config, method, url, **kwargs):
        seen.append(url)
        return _GRAPH[url]

    monkeypatch.setattr(graph_client, "_request", _request)
    accessor = SharePointAccessor(SharePointConfig(access_token="tok"))
    path = PathSpec.from_str_path("/sp/" + key if key else "/sp", key)
    assert (
        await vfs_over(SharePointVFS, accessor).du_size(
            path, RAMIndexCacheStore()
        )
        == 7
    )
    assert seen == list(_GRAPH)
