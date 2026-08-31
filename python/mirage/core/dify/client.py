from collections.abc import AsyncIterator
from typing import Any

from mirage.accessor.dify import DifyAccessor
from mirage.core.api.client import RetryPolicy, api_request, status_error
from mirage.resource.dify.config import DifyConfig


def _policy(config: DifyConfig) -> RetryPolicy:
    return RetryPolicy(statuses=frozenset({429})
                       | frozenset(range(500, 600)),
                       max_retries=config.retry_attempts - 1,
                       max_backoff=config.retry_max_delay,
                       delay_source="header",
                       retry_transport=True)


async def dify_request(
        accessor: DifyAccessor,
        method: str,
        endpoint: str,
        params: dict[str, Any] | None = None,
        json_body: dict[str, Any] | None = None) -> dict[str, Any]:
    url = accessor.config.base_url + endpoint
    headers = {"Authorization": f"Bearer {accessor.config.api_key}"}
    async with accessor._request_limiter.acquire():
        payload = await api_request(method,
                                    url,
                                    error_of=status_error,
                                    headers=headers,
                                    params=params,
                                    json_body=json_body,
                                    retry=_policy(accessor.config),
                                    session=accessor.pool)
    if not isinstance(payload, dict):
        raise ValueError("Dify response must be a JSON object")
    return payload


async def dify_get(accessor: DifyAccessor,
                   endpoint: str,
                   params: dict[str, Any] | None = None) -> dict[str, Any]:
    return await dify_request(accessor, "GET", endpoint, params=params)


async def dify_post(accessor: DifyAccessor, endpoint: str,
                    body: dict[str, Any]) -> dict[str, Any]:
    return await dify_request(accessor, "POST", endpoint, json_body=body)


async def list_all_documents(accessor: DifyAccessor) -> list[dict[str, Any]]:
    documents: list[dict[str, Any]] = []
    page = 1
    while True:
        payload = await dify_get(
            accessor,
            f"/datasets/{accessor.config.dataset_id}/documents",
            {
                "page": page,
                "limit": 100
            },
        )
        for document in payload.get("data") or []:
            if is_visible_document(document):
                documents.append(document)
        if not payload.get("has_more"):
            return documents
        page += 1


async def get_document_detail(accessor: DifyAccessor,
                              document_id: str) -> dict[str, Any]:
    return await dify_get(
        accessor,
        f"/datasets/{accessor.config.dataset_id}/documents/{document_id}")


async def get_document_segments(accessor: DifyAccessor,
                                document_id: str) -> list[dict[str, Any]]:
    segments: list[dict[str, Any]] = []
    async for page in iter_segment_pages(accessor, document_id):
        segments.extend(page)
    return segments


async def iter_segment_pages(
    accessor: DifyAccessor,
    document_id: str,
) -> AsyncIterator[list[dict[str, Any]]]:
    page = 1
    while True:
        payload = await dify_get(
            accessor,
            (f"/datasets/{accessor.config.dataset_id}/documents/"
             f"{document_id}/segments"),
            {
                "page": page,
                "limit": 100,
                "status": "completed",
                "enabled": "true",
            },
        )
        yield payload.get("data") or []
        if not payload.get("has_more"):
            return
        page += 1


def is_visible_document(document: dict[str, Any]) -> bool:
    return (document.get("enabled") is True
            and document.get("indexing_status") == "completed"
            and document.get("archived") is False)
