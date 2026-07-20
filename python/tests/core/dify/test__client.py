import httpx
import pytest

from mirage.accessor.dify import DifyAccessor
from mirage.core.dify import _client
from mirage.resource.dify.config import DifyConfig


def config() -> DifyConfig:
    return DifyConfig(
        api_key="secret",
        base_url="https://dify.example/v1/",
        dataset_id="dataset-1",
    )


def accessor() -> DifyAccessor:
    return DifyAccessor(config())


class SleepRecorder:

    def __init__(self) -> None:
        self.delays: list[float] = []

    async def __call__(self, delay: float) -> None:
        self.delays.append(delay)


@pytest.mark.asyncio
async def test_accessor_reuses_client_and_closes_it():
    dify_accessor = accessor()
    first = dify_accessor.get_client()
    second = dify_accessor.get_client()

    assert first is second
    assert str(first.base_url) == "https://dify.example/v1/"
    assert first.headers["authorization"] == "Bearer secret"
    assert first.timeout == httpx.Timeout(30.0)

    await dify_accessor.close()

    assert first.is_closed is True
    assert dify_accessor._client is None


@pytest.mark.asyncio
async def test_accessor_uses_configured_request_timeout():
    dify_accessor = DifyAccessor(
        DifyConfig(
            api_key="secret",
            base_url="https://dify.example/v1",
            dataset_id="dataset-1",
            request_timeout=12.5,
        ))

    client = dify_accessor.get_client()

    assert client.timeout == httpx.Timeout(12.5)

    await dify_accessor.close()


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

    dify_accessor = accessor()
    try:
        documents = await _client.list_all_documents(dify_accessor)
    finally:
        await dify_accessor.close()

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
    sleep = SleepRecorder()
    monkeypatch.setattr(_client.asyncio, "sleep", sleep)
    httpx_mock.add_response(status_code=429, json={"message": "rate limit"})
    httpx_mock.add_response(json={"ok": True})

    dify_accessor = accessor()
    try:
        payload = await _client.dify_get(dify_accessor,
                                         "/datasets/dataset-1/documents")
    finally:
        await dify_accessor.close()

    assert payload == {"ok": True}
    assert sleep.delays == [1.0]


@pytest.mark.asyncio
async def test_dify_get_honors_retry_after(monkeypatch, httpx_mock):
    sleep = SleepRecorder()
    monkeypatch.setattr(_client.asyncio, "sleep", sleep)
    httpx_mock.add_response(status_code=429,
                            headers={"Retry-After": "3"},
                            json={"message": "rate limit"})
    httpx_mock.add_response(json={"ok": True})

    dify_accessor = accessor()
    try:
        payload = await _client.dify_get(dify_accessor,
                                         "/datasets/dataset-1/documents")
    finally:
        await dify_accessor.close()

    assert payload == {"ok": True}
    assert sleep.delays == [3.0]


@pytest.mark.asyncio
async def test_dify_get_raises_after_retryable_errors(monkeypatch, httpx_mock):
    sleep = SleepRecorder()
    monkeypatch.setattr(_client.asyncio, "sleep", sleep)
    for _ in range(4):
        httpx_mock.add_response(status_code=503,
                                json={"message": "unavailable"})

    dify_accessor = accessor()
    try:
        with pytest.raises(httpx.HTTPStatusError) as exc_info:
            await _client.dify_get(dify_accessor,
                                   "/datasets/dataset-1/documents")
    finally:
        await dify_accessor.close()

    assert exc_info.value.response.status_code == 503
    assert sleep.delays == [1, 2, 4]


@pytest.mark.asyncio
async def test_dify_get_uses_configured_retry_policy(monkeypatch, httpx_mock):
    sleep = SleepRecorder()
    monkeypatch.setattr(_client.asyncio, "sleep", sleep)
    for _ in range(2):
        httpx_mock.add_response(status_code=503,
                                headers={"Retry-After": "10"},
                                json={"message": "unavailable"})

    dify_accessor = DifyAccessor(
        DifyConfig(
            api_key="secret",
            base_url="https://dify.example/v1",
            dataset_id="dataset-1",
            retry_attempts=2,
            retry_max_delay=0.5,
        ))
    try:
        with pytest.raises(httpx.HTTPStatusError):
            await _client.dify_get(dify_accessor,
                                   "/datasets/dataset-1/documents")
    finally:
        await dify_accessor.close()

    assert len(httpx_mock.get_requests()) == 2
    assert sleep.delays == [0.5]


@pytest.mark.asyncio
async def test_dify_get_retries_transport_errors(monkeypatch, httpx_mock):
    sleep = SleepRecorder()
    monkeypatch.setattr(_client.asyncio, "sleep", sleep)
    httpx_mock.add_exception(httpx.ConnectError("connection failed"))
    httpx_mock.add_response(json={"ok": True})

    dify_accessor = accessor()
    try:
        payload = await _client.dify_get(dify_accessor,
                                         "/datasets/dataset-1/documents")
    finally:
        await dify_accessor.close()

    assert payload == {"ok": True}
    assert sleep.delays == [1]


@pytest.mark.asyncio
async def test_dify_get_raises_http_status_errors(httpx_mock):
    httpx_mock.add_response(status_code=401, json={"message": "unauthorized"})

    dify_accessor = accessor()
    try:
        with pytest.raises(httpx.HTTPStatusError) as exc_info:
            await _client.dify_get(dify_accessor,
                                   "/datasets/dataset-1/documents")
    finally:
        await dify_accessor.close()

    assert exc_info.value.response.status_code == 401


@pytest.mark.asyncio
async def test_dify_post_sends_json_and_retries_server_error(
        monkeypatch, httpx_mock):
    sleep = SleepRecorder()
    monkeypatch.setattr(_client.asyncio, "sleep", sleep)
    httpx_mock.add_response(status_code=500, json={"message": "temporary"})
    httpx_mock.add_response(json={"ok": True})

    dify_accessor = accessor()
    try:
        payload = await _client.dify_post(dify_accessor,
                                          "/datasets/dataset-1/retrieve",
                                          {"query": "hello"})
    finally:
        await dify_accessor.close()

    assert payload == {"ok": True}
    assert sleep.delays == [1.0]
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

    dify_accessor = accessor()
    try:
        segments = await _client.get_document_segments(dify_accessor, "doc-1")
    finally:
        await dify_accessor.close()

    assert [item["content"] for item in segments] == ["first", "second"]
    requests = httpx_mock.get_requests()
    assert requests[0].url.params["status"] == "completed"
    assert requests[0].url.params["enabled"] == "true"
    assert requests[0].url.params["page"] == "1"
    assert requests[1].url.params["page"] == "2"
