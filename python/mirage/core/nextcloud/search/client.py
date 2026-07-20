import logging
from http import HTTPStatus

import httpx

from mirage.accessor.nextcloud import NextcloudAccessor
from mirage.core.nextcloud.search.constants import (SEARCH_HEADERS,
                                                    SEARCH_METHOD,
                                                    SEARCH_PAGE_SIZE,
                                                    UNAVAILABLE_STATUS_CODES)
from mirage.core.nextcloud.search.query import request_body, supports_query
from mirage.core.nextcloud.search.response import parse_page
from mirage.core.nextcloud.search.target import search_target
from mirage.core.nextcloud.search.types import FilesSearchQuery, SearchEntry
from mirage.resource.secrets import reveal_secret
from mirage.types import PathSpec

logger = logging.getLogger(__name__)


def auth(accessor: NextcloudAccessor) -> httpx.BasicAuth | None:
    username = reveal_secret(accessor.config.username)
    if not username:
        return None
    password = reveal_secret(accessor.config.password) or ""
    return httpx.BasicAuth(username, password)


async def search_files(
    accessor: NextcloudAccessor,
    path: PathSpec,
    query: FilesSearchQuery,
) -> list[SearchEntry] | None:
    if not supports_query(query):
        return None
    target = search_target(accessor.config.url)
    if target is None:
        logger.debug("Nextcloud Files Search unavailable for URL %s",
                     accessor.config.url)
        return None
    entries: dict[str, SearchEntry] = {}
    offset = 0
    async with httpx.AsyncClient(
            auth=auth(accessor),
            follow_redirects=True,
            headers=SEARCH_HEADERS,
            timeout=accessor.config.timeout,
            verify=accessor.config.verify_ssl,
    ) as client:
        while True:
            response = await client.request(
                SEARCH_METHOD,
                target.endpoint,
                content=request_body(target, path, query, offset),
            )
            if response.status_code in UNAVAILABLE_STATUS_CODES:
                logger.debug(
                    "Nextcloud Files Search unavailable with HTTP %d",
                    response.status_code,
                )
                return None
            response.raise_for_status()
            if response.status_code != HTTPStatus.MULTI_STATUS:
                raise ValueError("Nextcloud Files Search returned HTTP "
                                 f"{response.status_code}, expected "
                                 f"{HTTPStatus.MULTI_STATUS.value}")
            page = parse_page(response.content, target)
            previous_count = len(entries)
            for entry in page:
                entries.setdefault(entry.key, entry)
            if page and len(entries) == previous_count:
                logger.debug(
                    "Nextcloud Files Search pagination made no progress")
                return None
            if len(page) < SEARCH_PAGE_SIZE:
                break
            offset += len(page)
    return list(entries.values())
