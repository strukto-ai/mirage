import pytest
from aioresponses import aioresponses

from mirage.accessor.sharepoint import SharePointConfig
from mirage.core.sharepoint._client import (GraphError, drive_ref_path,
                                            graph_get, graph_get_bytes,
                                            graph_list, headers, item_url)


def _cfg(**kw) -> SharePointConfig:
    return SharePointConfig(access_token="tok", **kw)


_BASE = "https://graph.microsoft.com/v1.0"
_DRIVE = "b!drive123"


def test_headers_carry_bearer_token():
    h = headers(_cfg())
    assert h["Authorization"] == "Bearer tok"


def test_headers_resolves_callable_token():
    h = headers(SharePointConfig(access_token=lambda: "live"))
    assert h["Authorization"] == "Bearer live"


def test_item_url_root_no_path():
    url = item_url(_DRIVE, "/")
    assert url == f"{_BASE}/drives/{_DRIVE}/root"


def test_item_url_root_children():
    url = item_url(_DRIVE, "/", action="/children")
    assert url == f"{_BASE}/drives/{_DRIVE}/root/children"


def test_item_url_nested_file():
    url = item_url(_DRIVE, "/docs/report.docx")
    assert url == f"{_BASE}/drives/{_DRIVE}/root:/docs/report.docx"


def test_item_url_nested_content():
    url = item_url(_DRIVE, "/docs/report.docx", action="/content")
    assert url == f"{_BASE}/drives/{_DRIVE}/root:/docs/report.docx:/content"


def test_item_url_nested_children():
    url = item_url(_DRIVE, "/folder", action="/children")
    assert url == f"{_BASE}/drives/{_DRIVE}/root:/folder:/children"


def test_item_url_quotes_spaces():
    url = item_url(_DRIVE, "/My Folder/a b.txt")
    assert url == f"{_BASE}/drives/{_DRIVE}/root:/My%20Folder/a%20b.txt"


def test_drive_ref_path_root():
    assert drive_ref_path(_DRIVE) == f"/drives/{_DRIVE}/root:"


def test_drive_ref_path_folder():
    p = drive_ref_path(_DRIVE, "sub/dir")
    assert p == f"/drives/{_DRIVE}/root:/sub/dir"


@pytest.mark.asyncio
async def test_graph_get_returns_parsed_json():
    url = f"{_BASE}/drives/{_DRIVE}/root"
    with aioresponses() as m:
        m.get(url, payload={"id": "01ABC", "name": "root"})
        result = await graph_get(_cfg(), url)
    assert result["id"] == "01ABC"


@pytest.mark.asyncio
async def test_graph_get_raises_grapherror():
    url = f"{_BASE}/drives/{_DRIVE}/root"
    with aioresponses() as m:
        m.get(url,
              status=404,
              payload={"error": {
                  "code": "itemNotFound",
                  "message": "no"
              }})
        with pytest.raises(GraphError) as exc:
            await graph_get(_cfg(), url)
    assert exc.value.status == 404
    assert exc.value.code == "itemNotFound"


@pytest.mark.asyncio
async def test_graph_list_follows_nextlink():
    url = f"{_BASE}/drives/{_DRIVE}/root/children"
    page2 = url + "?$skiptoken=x"
    with aioresponses() as m:
        m.get(url, payload={"value": [{"id": "a"}], "@odata.nextLink": page2})
        m.get(page2, payload={"value": [{"id": "b"}]})
        items = await graph_list(_cfg(), url)
    assert [i["id"] for i in items] == ["a", "b"]


@pytest.mark.asyncio
async def test_graph_get_bytes_returns_raw():
    url = f"{_BASE}/drives/{_DRIVE}/root:/a.txt:/content"
    with aioresponses() as m:
        m.get(url, body=b"hello")
        data = await graph_get_bytes(_cfg(), url)
    assert data == b"hello"


@pytest.mark.asyncio
async def test_retry_on_429():
    url = f"{_BASE}/drives/{_DRIVE}/root"
    with aioresponses() as m:
        m.get(url, status=429, headers={"Retry-After": "0"})
        m.get(url, payload={"id": "ok"})
        result = await graph_get(_cfg(), url)
    assert result["id"] == "ok"


@pytest.mark.asyncio
async def test_gives_up_after_max_retries():
    url = f"{_BASE}/drives/{_DRIVE}/root"
    with aioresponses() as m:
        for _ in range(3):
            m.get(url, status=429, headers={"Retry-After": "0"})
        with pytest.raises(GraphError) as exc:
            await graph_get(_cfg(max_retries=2), url)
    assert exc.value.status == 429


@pytest.mark.asyncio
async def test_401_refreshes_callable_token():
    url = f"{_BASE}/drives/{_DRIVE}/root"
    calls = {"n": 0}

    def provider():
        calls["n"] += 1
        return "fresh" if calls["n"] > 1 else "stale"

    with aioresponses() as m:
        m.get(url, status=401, payload={"error": {"code": "x"}})
        m.get(url, payload={"id": "ok"})
        result = await graph_get(SharePointConfig(access_token=provider), url)
    assert result["id"] == "ok"
    assert calls["n"] == 2
