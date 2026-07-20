import asyncio
import logging
from collections.abc import AsyncIterator
from functools import partial
from typing import Any

import httpx
from tenacity import (AsyncRetrying, RetryCallState, before_sleep_log,
                      retry_if_exception, stop_after_attempt)

from mirage.accessor.dify import DifyAccessor

logger = logging.getLogger(__name__)


async def dify_request(accessor: DifyAccessor, method: str, endpoint: str,
                       **request_kwargs: Any) -> dict[str, Any]:
    retrying = AsyncRetrying(
        sleep=asyncio.sleep,
        stop=stop_after_attempt(accessor.config.retry_attempts),
        wait=partial(_retry_delay, max_delay=accessor.config.retry_max_delay),
        retry=retry_if_exception(_is_retryable_error),
        before_sleep=before_sleep_log(logger, logging.WARNING),
        reraise=True,
    )
    response: httpx.Response = await retrying(_request_once, accessor, method,
                                              endpoint, **request_kwargs)
    payload = response.json()
    if not isinstance(payload, dict):
        raise ValueError("Dify response must be a JSON object")
    return payload


async def _request_once(accessor: DifyAccessor, method: str, endpoint: str,
                        **request_kwargs: Any) -> httpx.Response:
    response = await accessor.request(method, endpoint, **request_kwargs)
    response.raise_for_status()
    return response


def _is_retryable_error(error: BaseException) -> bool:
    if isinstance(error, httpx.TransportError):
        return True
    if not isinstance(error, httpx.HTTPStatusError):
        return False
    status_code = error.response.status_code
    return status_code == 429 or 500 <= status_code < 600


def _retry_delay(retry_state: RetryCallState, max_delay: float) -> float:
    outcome = retry_state.outcome
    error = outcome.exception() if outcome is not None else None
    retry_after: str | None = None
    if isinstance(error, httpx.HTTPStatusError):
        retry_after = error.response.headers.get("Retry-After")
    if retry_after is not None:
        try:
            return min(max_delay, max(0.0, float(retry_after)))
        except ValueError:
            logger.debug("Ignoring invalid Dify Retry-After value %r",
                         retry_after)
    return min(max_delay, float(2**(retry_state.attempt_number - 1)))


async def dify_get(accessor: DifyAccessor,
                   endpoint: str,
                   params: dict[str, Any] | None = None) -> dict[str, Any]:
    return await dify_request(accessor, "GET", endpoint, params=params)


async def dify_post(accessor: DifyAccessor, endpoint: str,
                    body: dict[str, Any]) -> dict[str, Any]:
    return await dify_request(accessor, "POST", endpoint, json=body)


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
