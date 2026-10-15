from urllib.parse import quote

import httpx

from mirage.accessor.nextcloud import NextcloudAccessor
from mirage.core.nextcloud.search.client import auth
from mirage.core.nextcloud.util import nextcloud_key
from mirage.types import PathSpec


def dav_url(
    accessor: NextcloudAccessor, path: PathSpec, folder: bool = False
) -> str:
    """The WebDAV URL of a path, its segments percent-encoded.

    Args:
        accessor (NextcloudAccessor): Nextcloud accessor.
        path (PathSpec): a path on the mount.
        folder (bool): end the URL with a slash, as a collection's.
    """
    key = quote(nextcloud_key(path).rstrip("/"))
    url = str(accessor.config.url).rstrip("/") + ("/" + key if key else "")
    return url + "/" if folder else url


async def dav_request(
    accessor: NextcloudAccessor,
    method: str,
    url: str,
    headers: dict[str, str] | None = None,
    content: bytes | None = None,
) -> httpx.Response:
    """Send one WebDAV request with the mount's credentials.

    Args:
        accessor (NextcloudAccessor): Nextcloud accessor.
        method (str): the WebDAV method.
        url (str): the target, from :func:`dav_url`.
        headers (dict[str, str] | None): extra request headers.
        content (bytes | None): the request body.
    """
    config = accessor.config
    async with httpx.AsyncClient(
        auth=auth(accessor),
        timeout=config.timeout,
        verify=config.verify_ssl,
    ) as client:
        return await client.request(
            method, url, headers=headers, content=content
        )
