import asyncio
import logging
from collections.abc import AsyncIterator
from typing import Any

import httpx

from mirage.resource.dify.config import DifyConfig

logger = logging.getLogger(__name__)


async def dify_get(config: DifyConfig,
                   endpoint: str,
                   params: dict[str, Any] | None = None) -> dict[str, Any]:
    url = f"{config.base_url}{endpoint}"
    headers = {"Authorization": f"Bearer {config.api_key}"}
    last_error: httpx.HTTPStatusError | None = None
    for attempt in range(4):
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.get(url, headers=headers, params=params)
        if response.status_code == 429 and attempt < 3:
            logger.warning("Dify rate limited request to %s", endpoint)
            await asyncio.sleep(2**attempt)
            continue
        if 500 <= response.status_code < 600 and attempt < 1:
            await asyncio.sleep(1)
            continue
        try:
            response.raise_for_status()
        except httpx.HTTPStatusError as exc:
            last_error = exc
            break
        return response.json()
    if last_error is not None:
        raise last_error
    raise RuntimeError(f"Dify request failed: {endpoint}")


async def dify_post(config: DifyConfig, endpoint: str,
                    body: dict[str, Any]) -> dict[str, Any]:
    url = f"{config.base_url}{endpoint}"
    headers = {"Authorization": f"Bearer {config.api_key}"}
    last_error: httpx.HTTPStatusError | None = None
    for attempt in range(4):
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.post(url, headers=headers, json=body)
        if response.status_code == 429 and attempt < 3:
            logger.warning("Dify rate limited request to %s", endpoint)
            await asyncio.sleep(2**attempt)
            continue
        if 500 <= response.status_code < 600 and attempt < 1:
            await asyncio.sleep(1)
            continue
        try:
            response.raise_for_status()
        except httpx.HTTPStatusError as exc:
            last_error = exc
            break
        return response.json()
    if last_error is not None:
        raise last_error
    raise RuntimeError(f"Dify request failed: {endpoint}")


async def list_all_documents(config: DifyConfig) -> list[dict[str, Any]]:
    documents: list[dict[str, Any]] = []
    page = 1
    while True:
        payload = await dify_get(
            config,
            f"/datasets/{config.dataset_id}/documents",
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


async def get_document_detail(config: DifyConfig,
                              document_id: str) -> dict[str, Any]:
    return await dify_get(
        config, f"/datasets/{config.dataset_id}/documents/{document_id}")


async def get_document_segments(config: DifyConfig,
                                document_id: str) -> list[dict[str, Any]]:
    segments: list[dict[str, Any]] = []
    async for page in iter_segment_pages(config, document_id):
        segments.extend(page)
    return segments


async def iter_segment_pages(
    config: DifyConfig,
    document_id: str,
) -> AsyncIterator[list[dict[str, Any]]]:
    page = 1
    while True:
        payload = await dify_get(
            config,
            f"/datasets/{config.dataset_id}/documents/{document_id}/segments",
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
