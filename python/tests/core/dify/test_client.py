import aiohttp
import pytest
from aioresponses import aioresponses
from yarl import URL

from mirage.accessor.dify import DifyAccessor
from mirage.core.api import client as api_client
from mirage.core.dify import client
from mirage.resource.dify.config import DifyConfig

BASE = "https://dify.example/v1"
DOCUMENTS = f"{BASE}/datasets/dataset-1/documents"


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
async def test_accessor_reuses_session_and_closes_it():
    dify_accessor = accessor()
    first = dify_accessor.pool.get()
    second = dify_accessor.pool.get()

    assert first is second
    assert first.timeout == aiohttp.ClientTimeout(total=30.0)

    await dify_accessor.close()

    assert first.closed is True
    assert dify_accessor.pool._session is None


@pytest.mark.asyncio
async def test_accessor_uses_configured_request_timeout():
    dify_accessor = DifyAccessor(
        DifyConfig(
            api_key="secret",
            base_url="https://dify.example/v1",
            dataset_id="dataset-1",
            request_timeout=12.5,
        ))

    session = dify_accessor.pool.get()

    assert session.timeout == aiohttp.ClientTimeout(total=12.5)

    await dify_accessor.close()


@pytest.mark.asyncio
async def test_list_all_documents_paginates_and_filters():
    dify_accessor = accessor()
    with aioresponses() as m:
        m.get(f"{DOCUMENTS}?limit=100&page=1",
              payload={
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
        m.get(f"{DOCUMENTS}?limit=100&page=2",
              payload={
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
        try:
            documents = await client.list_all_documents(dify_accessor)
        finally:
            await dify_accessor.close()
        first = m.requests[("GET", URL(f"{DOCUMENTS}?limit=100&page=1"))]
        second = m.requests[("GET", URL(f"{DOCUMENTS}?limit=100&page=2"))]

    assert [item["id"] for item in documents] == ["doc-1", "doc-3"]
    assert documents[0]["data_source_detail_dict"]["upload_file"]["size"] == 10

    assert len(first) == 1
    assert len(second) == 1
    assert first[0].kwargs["headers"]["Authorization"] == "Bearer secret"
    assert first[0].kwargs["params"] == {"page": 1, "limit": 100}
    assert second[0].kwargs["params"] == {"page": 2, "limit": 100}


@pytest.mark.asyncio
async def test_dify_get_retries_rate_limit(monkeypatch):
    sleep = SleepRecorder()
    monkeypatch.setattr(api_client.asyncio, "sleep", sleep)
    dify_accessor = accessor()
    with aioresponses() as m:
        m.get(DOCUMENTS, status=429, payload={"message": "rate limit"})
        m.get(DOCUMENTS, payload={"ok": True})
        try:
            payload = await client.dify_get(dify_accessor,
                                            "/datasets/dataset-1/documents")
        finally:
            await dify_accessor.close()

    assert payload == {"ok": True}
    assert sleep.delays == [1.0]


@pytest.mark.asyncio
async def test_dify_get_honors_retry_after(monkeypatch):
    sleep = SleepRecorder()
    monkeypatch.setattr(api_client.asyncio, "sleep", sleep)
    dify_accessor = accessor()
    with aioresponses() as m:
        m.get(DOCUMENTS,
              status=429,
              headers={"Retry-After": "3"},
              payload={"message": "rate limit"})
        m.get(DOCUMENTS, payload={"ok": True})
        try:
            payload = await client.dify_get(dify_accessor,
                                            "/datasets/dataset-1/documents")
        finally:
            await dify_accessor.close()

    assert payload == {"ok": True}
    assert sleep.delays == [3.0]


@pytest.mark.asyncio
async def test_dify_get_raises_after_retryable_errors(monkeypatch):
    sleep = SleepRecorder()
    monkeypatch.setattr(api_client.asyncio, "sleep", sleep)
    dify_accessor = accessor()
    with aioresponses() as m:
        for _ in range(4):
            m.get(DOCUMENTS, status=503, payload={"message": "unavailable"})
        try:
            with pytest.raises(aiohttp.ClientResponseError) as exc_info:
                await client.dify_get(dify_accessor,
                                      "/datasets/dataset-1/documents")
        finally:
            await dify_accessor.close()

    assert exc_info.value.status == 503
    assert sleep.delays == [1, 2, 4]


@pytest.mark.asyncio
async def test_dify_get_uses_configured_retry_policy(monkeypatch):
    sleep = SleepRecorder()
    monkeypatch.setattr(api_client.asyncio, "sleep", sleep)
    dify_accessor = DifyAccessor(
        DifyConfig(
            api_key="secret",
            base_url="https://dify.example/v1",
            dataset_id="dataset-1",
            retry_attempts=2,
            retry_max_delay=0.5,
        ))
    with aioresponses() as m:
        for _ in range(2):
            m.get(DOCUMENTS, status=503, payload={"message": "unavailable"})
        try:
            with pytest.raises(aiohttp.ClientResponseError):
                await client.dify_get(dify_accessor,
                                      "/datasets/dataset-1/documents")
        finally:
            await dify_accessor.close()
        sent = m.requests[("GET", URL(DOCUMENTS))]

    assert len(sent) == 2
    assert sleep.delays == [0.5]


@pytest.mark.asyncio
async def test_dify_get_retries_transport_errors(monkeypatch):
    sleep = SleepRecorder()
    monkeypatch.setattr(api_client.asyncio, "sleep", sleep)
    dify_accessor = accessor()
    with aioresponses() as m:
        m.get(DOCUMENTS,
              exception=aiohttp.ClientConnectionError("connection failed"))
        m.get(DOCUMENTS, payload={"ok": True})
        try:
            payload = await client.dify_get(dify_accessor,
                                            "/datasets/dataset-1/documents")
        finally:
            await dify_accessor.close()

    assert payload == {"ok": True}
    assert sleep.delays == [1]


@pytest.mark.asyncio
async def test_dify_get_raises_http_status_errors():
    dify_accessor = accessor()
    with aioresponses() as m:
        m.get(DOCUMENTS, status=401, payload={"message": "unauthorized"})
        try:
            with pytest.raises(aiohttp.ClientResponseError) as exc_info:
                await client.dify_get(dify_accessor,
                                      "/datasets/dataset-1/documents")
        finally:
            await dify_accessor.close()

    assert exc_info.value.status == 401


@pytest.mark.asyncio
async def test_dify_post_sends_json_and_retries_server_error(monkeypatch):
    sleep = SleepRecorder()
    monkeypatch.setattr(api_client.asyncio, "sleep", sleep)
    url = f"{BASE}/datasets/dataset-1/retrieve"
    dify_accessor = accessor()
    with aioresponses() as m:
        m.post(url, status=500, payload={"message": "temporary"})
        m.post(url, payload={"ok": True})
        try:
            payload = await client.dify_post(dify_accessor,
                                             "/datasets/dataset-1/retrieve",
                                             {"query": "hello"})
        finally:
            await dify_accessor.close()
        sent = m.requests[("POST", URL(url))]

    assert payload == {"ok": True}
    assert sleep.delays == [1.0]
    assert len(sent) == 2
    assert sent[0].kwargs["headers"]["Authorization"] == "Bearer secret"
    assert sent[0].kwargs["json"] == {"query": "hello"}


@pytest.mark.asyncio
async def test_get_document_segments_paginates_with_server_filters():
    segments_url = f"{DOCUMENTS}/doc-1/segments"
    page_1 = f"{segments_url}?enabled=true&limit=100&page=1&status=completed"
    page_2 = f"{segments_url}?enabled=true&limit=100&page=2&status=completed"
    dify_accessor = accessor()
    with aioresponses() as m:
        m.get(page_1,
              payload={
                  "data": [{
                      "content": "first"
                  }],
                  "has_more": True,
              })
        m.get(page_2,
              payload={
                  "data": [{
                      "content": "second"
                  }],
                  "has_more": False,
              })
        try:
            segments = await client.get_document_segments(
                dify_accessor, "doc-1")
        finally:
            await dify_accessor.close()
        first = m.requests[("GET", URL(page_1))]
        second = m.requests[("GET", URL(page_2))]

    assert [item["content"] for item in segments] == ["first", "second"]
    assert first[0].kwargs["params"] == {
        "page": 1,
        "limit": 100,
        "status": "completed",
        "enabled": "true",
    }
    assert second[0].kwargs["params"]["page"] == 2
