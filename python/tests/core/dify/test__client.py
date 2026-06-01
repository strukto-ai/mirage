import httpx
import pytest

from mirage.core.dify import _client
from mirage.resource.dify.config import DifyConfig


def config() -> DifyConfig:
    return DifyConfig(
        api_key="secret",
        base_url="https://dify.example/v1/",
        dataset_id="dataset-1",
    )


@pytest.mark.asyncio
async def test_list_all_documents_paginates_and_filters(httpx_mock):
    httpx_mock.add_response(
        json={
            "data": [
                {
                    "id": "doc-1",
                    "enabled": True,
                    "indexing_status": "completed",
                    "archived": False,
                    "data_source_detail_dict": {
                        "upload_file": {
                            "size": 10
                        }
                    },
                },
                {
                    "id": "doc-2",
                    "enabled": False,
                    "indexing_status": "completed",
                    "archived": False,
                },
            ],
            "has_more":
            True,
        })
    httpx_mock.add_response(
        json={
            "data": [
                {
                    "id": "doc-3",
                    "enabled": True,
                    "indexing_status": "completed",
                    "archived": False,
                },
                {
                    "id": "doc-4",
                    "enabled": True,
                    "indexing_status": "indexing",
                    "archived": False,
                },
            ],
            "has_more":
            False,
        })

    documents = await _client.list_all_documents(config())

    assert [item["id"] for item in documents] == ["doc-1", "doc-3"]
    assert documents[0]["data_source_detail_dict"]["upload_file"]["size"] == 10

    requests = httpx_mock.get_requests()
    assert len(requests) == 2
    assert requests[0].headers["authorization"] == "Bearer secret"
    assert requests[0].url.params["page"] == "1"
    assert requests[0].url.params["limit"] == "100"
    assert requests[1].url.params["page"] == "2"


@pytest.mark.asyncio
async def test_dify_get_retries_rate_limit(monkeypatch, httpx_mock):
    sleeps: list[int] = []

    async def sleep(delay: int) -> None:
        sleeps.append(delay)

    monkeypatch.setattr(_client.asyncio, "sleep", sleep)
    httpx_mock.add_response(status_code=429, json={"message": "rate limit"})
    httpx_mock.add_response(json={"ok": True})

    payload = await _client.dify_get(config(), "/datasets/dataset-1/documents")

    assert payload == {"ok": True}
    assert sleeps == [1]


@pytest.mark.asyncio
async def test_dify_get_raises_http_status_errors(httpx_mock):
    httpx_mock.add_response(status_code=401, json={"message": "unauthorized"})

    with pytest.raises(httpx.HTTPStatusError) as exc_info:
        await _client.dify_get(config(), "/datasets/dataset-1/documents")

    assert exc_info.value.response.status_code == 401


@pytest.mark.asyncio
async def test_dify_post_sends_json_and_retries_server_error(
        monkeypatch, httpx_mock):
    sleeps: list[int] = []

    async def sleep(delay: int) -> None:
        sleeps.append(delay)

    monkeypatch.setattr(_client.asyncio, "sleep", sleep)
    httpx_mock.add_response(status_code=500, json={"message": "temporary"})
    httpx_mock.add_response(json={"ok": True})

    payload = await _client.dify_post(config(), "/datasets/dataset-1/retrieve",
                                      {"query": "hello"})

    assert payload == {"ok": True}
    assert sleeps == [1]
    requests = httpx_mock.get_requests()
    assert len(requests) == 2
    assert requests[0].headers["authorization"] == "Bearer secret"
    assert requests[0].read() == b'{"query":"hello"}'


@pytest.mark.asyncio
async def test_get_document_segments_paginates_with_server_filters(httpx_mock):
    httpx_mock.add_response(json={
        "data": [{
            "content": "first"
        }],
        "has_more": True,
    })
    httpx_mock.add_response(json={
        "data": [{
            "content": "second"
        }],
        "has_more": False,
    })

    segments = await _client.get_document_segments(config(), "doc-1")

    assert [item["content"] for item in segments] == ["first", "second"]
    requests = httpx_mock.get_requests()
    assert requests[0].url.params["status"] == "completed"
    assert requests[0].url.params["enabled"] == "true"
    assert requests[0].url.params["page"] == "1"
    assert requests[1].url.params["page"] == "2"
