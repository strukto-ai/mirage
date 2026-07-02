import pytest
from aioresponses import aioresponses

from mirage.accessor.onedrive import OneDriveConfig
from mirage.core.onedrive._client import (GraphError, drive_base, graph_get,
                                          graph_get_bytes, graph_list, headers,
                                          item_url, split_path)
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key


def test_split_path_strips_real_prefix():
    p = PathSpec(resource_path=mount_key("/od/a.txt", "/od"),
                 virtual="/od/a.txt",
                 directory="/od/a.txt")
    assert split_path(p) == ("/od", "a.txt")


def test_split_path_does_not_strip_sibling_prefix_match():
    # `/data` must not be stripped from the sibling `/database.txt`; the
    # boundary guard lives in mount_key, whose output split_path returns.
    p = PathSpec(resource_path=mount_key("/database.txt", "/data"),
                 virtual="/database.txt",
                 directory="/database.txt")
    assert split_path(p) == ("", "database.txt")


def test_headers_resolves_callable_token():
    h = headers(OneDriveConfig(access_token=lambda: "live-token"))
    assert h["Authorization"] == "Bearer live-token"


def _cfg(**kw) -> OneDriveConfig:
    return OneDriveConfig(access_token="tok", **kw)


def test_drive_base_defaults_to_me_drive():
    assert drive_base(_cfg()) == "https://graph.microsoft.com/v1.0/me/drive"


def test_drive_base_uses_drive_id():
    base = drive_base(_cfg(drive_id="b!abc"))
    assert base == "https://graph.microsoft.com/v1.0/drives/b!abc"


def test_drive_base_uses_site_default_drive():
    base = drive_base(_cfg(site_id="site123"))
    assert base == "https://graph.microsoft.com/v1.0/sites/site123/drive"


def test_item_url_root_children():
    url = item_url(_cfg(), "/", action="/children")
    assert url == "https://graph.microsoft.com/v1.0/me/drive/root/children"


def test_item_url_nested_metadata_no_action():
    url = item_url(_cfg(), "/Docs/report.docx")
    assert url == (
        "https://graph.microsoft.com/v1.0/me/drive/root:/Docs/report.docx")


def test_item_url_nested_content():
    url = item_url(_cfg(), "/Docs/report.docx", action="/content")
    assert url == ("https://graph.microsoft.com/v1.0/me/drive"
                   "/root:/Docs/report.docx:/content")


def test_item_url_nested_children():
    url = item_url(_cfg(), "/Docs", action="/children")
    assert url == (
        "https://graph.microsoft.com/v1.0/me/drive/root:/Docs:/children")


def test_item_url_applies_key_prefix():
    url = item_url(_cfg(key_prefix="team/files"), "/a.txt", action="/content")
    assert url == ("https://graph.microsoft.com/v1.0/me/drive"
                   "/root:/team/files/a.txt:/content")


def test_item_url_quotes_spaces():
    url = item_url(_cfg(), "/My Folder/a b.txt")
    assert url == ("https://graph.microsoft.com/v1.0/me/drive"
                   "/root:/My%20Folder/a%20b.txt")


def test_headers_carry_bearer_token():
    h = headers(_cfg())
    assert h["Authorization"] == "Bearer tok"


_ROOT = "https://graph.microsoft.com/v1.0/me/drive/root"


@pytest.mark.asyncio
async def test_graph_get_returns_parsed_json():
    with aioresponses() as m:
        m.get(_ROOT, payload={"id": "01ABC", "name": "root"})
        result = await graph_get(_cfg(), _ROOT)
    assert result["id"] == "01ABC"


@pytest.mark.asyncio
async def test_graph_get_raises_grapherror_with_status():
    with aioresponses() as m:
        m.get(_ROOT,
              status=404,
              payload={"error": {
                  "code": "itemNotFound",
                  "message": "nope"
              }})
        with pytest.raises(GraphError) as exc:
            await graph_get(_cfg(), _ROOT)
    assert exc.value.status == 404
    assert exc.value.code == "itemNotFound"


@pytest.mark.asyncio
async def test_graph_list_follows_odata_nextlink():
    page2 = _ROOT + "/children?$skiptoken=abc"
    with aioresponses() as m:
        m.get(_ROOT + "/children",
              payload={
                  "value": [{
                      "id": "a"
                  }],
                  "@odata.nextLink": page2
              })
        m.get(page2, payload={"value": [{"id": "b"}]})
        items = await graph_list(_cfg(), _ROOT + "/children")
    assert [i["id"] for i in items] == ["a", "b"]


@pytest.mark.asyncio
async def test_graph_get_bytes_returns_raw_content():
    url = _ROOT + ":/a.txt:/content"
    with aioresponses() as m:
        m.get(url, body=b"hello bytes")
        data = await graph_get_bytes(_cfg(), url)
    assert data == b"hello bytes"


@pytest.mark.asyncio
async def test_request_retries_on_429_then_succeeds():
    with aioresponses() as m:
        m.get(_ROOT, status=429, headers={"Retry-After": "0"})
        m.get(_ROOT, payload={"id": "ok"})
        result = await graph_get(_cfg(), _ROOT)
    assert result["id"] == "ok"


@pytest.mark.asyncio
async def test_request_gives_up_after_max_retries():
    with aioresponses() as m:
        for _ in range(3):
            m.get(_ROOT, status=429, headers={"Retry-After": "0"})
        with pytest.raises(GraphError) as exc:
            await graph_get(_cfg(max_retries=2), _ROOT)
    assert exc.value.status == 429


@pytest.mark.asyncio
async def test_401_refreshes_callable_token_once_then_succeeds():
    calls = {"n": 0}

    def provider():
        calls["n"] += 1
        return "fresh" if calls["n"] > 1 else "stale"

    with aioresponses() as m:
        m.get(_ROOT,
              status=401,
              payload={"error": {
                  "code": "InvalidAuthenticationToken"
              }})
        m.get(_ROOT, payload={"id": "ok"})
        result = await graph_get(OneDriveConfig(access_token=provider), _ROOT)
    assert result["id"] == "ok"
    assert calls["n"] == 2


@pytest.mark.asyncio
async def test_401_with_static_token_does_not_retry():
    with aioresponses() as m:
        m.get(_ROOT, status=401, payload={"error": {"code": "x"}})
        with pytest.raises(GraphError) as exc:
            await graph_get(_cfg(), _ROOT)
    assert exc.value.status == 401
