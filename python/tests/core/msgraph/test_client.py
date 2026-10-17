import pytest
from aioresponses import aioresponses
from yarl import URL

from mirage.accessor.onedrive import OneDriveAccessor, OneDriveConfig
from mirage.core.msgraph.client import (
    GraphError,
    _retry_after,
    encoded_path,
    graph_batch,
    graph_get,
    graph_get_bytes,
    graph_list,
    graph_post_monitor,
    headers,
    id_segment,
)
from mirage.core.msgraph.config import MsGraphConfig

_ROOT = "https://graph.microsoft.com/v1.0/me/drive/root"


def _accessor(**kw) -> OneDriveAccessor:
    return OneDriveAccessor(OneDriveConfig(access_token="tok", **kw))


@pytest.mark.parametrize(
    "value,expected",
    [
        ("b!abc-_x", "b!abc-_x"),
        ("usr@example.com", "usr%40example.com"),
        (
            "guest_contoso.com#EXT#@fabrikam.com",
            "guest_contoso.com%23EXT%23%40fabrikam.com",
        ),
        (
            "contoso.sharepoint.com,site-guid,web-guid",
            "contoso.sharepoint.com%2Csite-guid%2Cweb-guid",
        ),
        ("a b", "a%20b"),
        ("plain/slash", "plain%2Fslash"),
    ],
)
def test_id_segment_matches_encodeuricomponent(value, expected):
    """Pin the escaping to what TypeScript's `encodeURIComponent` does.

    The two spellings must agree character for character: ref paths built
    from an escaped id are sent in a JSON body Graph reads literally, so
    escaping `!` on one side only would break copy and rename there.
    """
    assert id_segment(value) == expected


def test_id_segment_escapes_the_guest_upn_fragment():
    # The failure this exists to prevent: `#` interpolated raw starts a
    # URL fragment, so Graph is asked for a truncated path and answers
    # 404 for a user that exists.
    assert "#" not in id_segment("guest_contoso.com#EXT#@fabrikam.com")


@pytest.mark.parametrize(
    "path,expected",
    [
        ("a b/c.txt", "a%20b/c.txt"),
        ("/a(1)/b!*'.txt", "a(1)/b!*'.txt"),
        ("x#y/z?.md", "x%23y/z%3F.md"),
    ],
)
def test_encoded_path_escapes_each_segment_like_typescript(path, expected):
    assert encoded_path(path) == expected


@pytest.mark.parametrize(
    "token,expected",
    [
        ("tok", "Bearer tok"),
        (lambda: "live", "Bearer live"),
    ],
)
def test_headers_carry_the_bearer_token(token, expected):
    assert headers(MsGraphConfig(access_token=token))["Authorization"] == (
        expected
    )


@pytest.mark.asyncio
async def test_graph_get_returns_parsed_json():
    with aioresponses() as m:
        m.get(_ROOT, payload={"id": "01ABC", "name": "root"})
        result = await graph_get(_accessor(), _ROOT)
    assert result["id"] == "01ABC"


@pytest.mark.asyncio
async def test_graph_get_raises_grapherror_with_status():
    with aioresponses() as m:
        m.get(
            _ROOT,
            status=404,
            payload={"error": {"code": "itemNotFound", "message": "nope"}},
        )
        with pytest.raises(GraphError) as exc:
            await graph_get(_accessor(), _ROOT)
    assert exc.value.status == 404
    assert exc.value.code == "itemNotFound"


@pytest.mark.asyncio
async def test_graph_post_monitor_requires_location_header():
    url = _ROOT + ":/a.txt:/copy"
    with aioresponses() as m:
        m.post(url, status=202, payload={})
        with pytest.raises(GraphError) as exc:
            await graph_post_monitor(_accessor(), url)
    assert exc.value.code == "missingMonitor"


@pytest.mark.asyncio
async def test_graph_list_follows_odata_nextlink():
    page2 = _ROOT + "/children?$skiptoken=abc"
    with aioresponses() as m:
        m.get(
            _ROOT + "/children",
            payload={"value": [{"id": "a"}], "@odata.nextLink": page2},
        )
        m.get(page2, payload={"value": [{"id": "b"}]})
        items = await graph_list(_accessor(), _ROOT + "/children")
    assert [i["id"] for i in items] == ["a", "b"]


@pytest.mark.asyncio
async def test_graph_get_bytes_returns_raw_content():
    url = _ROOT + ":/a.txt:/content"
    with aioresponses() as m:
        m.get(url, body=b"hello bytes")
        data = await graph_get_bytes(_accessor(), url)
    assert data == b"hello bytes"


@pytest.mark.asyncio
async def test_request_retries_on_429_then_succeeds():
    with aioresponses() as m:
        m.get(_ROOT, status=429, headers={"Retry-After": "0"})
        m.get(_ROOT, payload={"id": "ok"})
        result = await graph_get(_accessor(), _ROOT)
    assert result["id"] == "ok"


@pytest.mark.asyncio
async def test_request_gives_up_after_max_retries():
    with aioresponses() as m:
        for _ in range(3):
            m.get(_ROOT, status=429, headers={"Retry-After": "0"})
        with pytest.raises(GraphError) as exc:
            await graph_get(_accessor(max_retries=2), _ROOT)
    assert exc.value.status == 429


@pytest.mark.asyncio
async def test_401_refreshes_callable_token_once_then_succeeds():
    calls = {"n": 0}

    def provider():
        calls["n"] += 1
        return "fresh" if calls["n"] > 1 else "stale"

    with aioresponses() as m:
        m.get(
            _ROOT,
            status=401,
            payload={"error": {"code": "InvalidAuthenticationToken"}},
        )
        m.get(_ROOT, payload={"id": "ok"})
        accessor = OneDriveAccessor(OneDriveConfig(access_token=provider))
        result = await graph_get(accessor, _ROOT)
    assert result["id"] == "ok"
    assert calls["n"] == 2


@pytest.mark.asyncio
async def test_401_with_static_token_does_not_retry():
    with aioresponses() as m:
        m.get(_ROOT, status=401, payload={"error": {"code": "x"}})
        with pytest.raises(GraphError) as exc:
            await graph_get(_accessor(), _ROOT)
    assert exc.value.status == 401


@pytest.mark.asyncio
async def test_graph_batch_sends_relative_urls_and_answers_in_order():
    api = "https://graph.example/v1.0"
    urls = [
        f"{api}/me/drive/root:/a:/children",
        f"{api}/me/drive/root/children",
    ]
    with aioresponses() as m:
        m.post(
            f"{api}/$batch",
            payload={
                "responses": [
                    {"id": "1", "status": 200, "body": {"value": [1]}},
                    {
                        "id": "0",
                        "status": 429,
                        "headers": {"retry-after": "7"},
                        "body": "throttled",
                    },
                ]
            },
        )
        answers = await graph_batch(
            _accessor(graph_base_url=api), urls + [urls[0]]
        )
        sent = m.requests[("POST", URL(f"{api}/$batch"))][0].kwargs["json"]
    assert sent == {
        "requests": [
            {"id": "0", "method": "GET", "url": "/me/drive/root:/a:/children"},
            {"id": "1", "method": "GET", "url": "/me/drive/root/children"},
            {"id": "2", "method": "GET", "url": "/me/drive/root:/a:/children"},
        ]
    }
    assert answers == [
        (429, {}, 7.0),
        (200, {"value": [1]}, 0.0),
        (0, {}, 0.0),
    ]


@pytest.mark.parametrize(
    "headers,wait",
    [
        ({"Retry-After": "3"}, 3.0),
        ({"Retry-After": "900"}, 30.0),
        ({"Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT"}, 0.0),
        ({}, 0.0),
    ],
)
def test_a_batched_retry_after_is_a_capped_count_of_seconds(headers, wait):
    assert _retry_after(headers) == wait
