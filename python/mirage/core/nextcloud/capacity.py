from http import HTTPStatus
from xml.etree import ElementTree

from mirage.accessor.nextcloud import NextcloudAccessor
from mirage.core.nextcloud.constants import QUOTA_PROPFIND, SPACE_UNLIMITED
from mirage.core.nextcloud.dav import answered, dav_request
from mirage.core.nextcloud.search.types import XmlElement
from mirage.types import CapacityResult, CapacityState


def quota_value(root: XmlElement, name: str) -> int | None:
    """A quota property's byte count, None when the server answered no
    whole number for it.

    Args:
        root (XmlElement): the PROPFIND multistatus.
        name (str): the DAV property, e.g. ``quota-used-bytes``.
    """
    text = answered(root, name) or ""
    return int(text) if text.removeprefix("-").isdigit() else None


async def capacity(accessor: NextcloudAccessor) -> CapacityResult:
    """The user's Nextcloud quota, for df, from the WebDAV quota
    properties of the mount's root. A user without a quota is ELASTIC;
    a quota Nextcloud has not computed is UNKNOWN.

    Args:
        accessor (NextcloudAccessor): Nextcloud accessor.
    """
    response = await dav_request(
        accessor,
        "PROPFIND",
        accessor.config.url.rstrip("/") + "/",
        headers={"Depth": "0", "Content-Type": "application/xml"},
        content=QUOTA_PROPFIND,
    )
    if response.status_code != HTTPStatus.MULTI_STATUS:
        response.raise_for_status()
        return CapacityResult(state=CapacityState.UNKNOWN)
    root = ElementTree.fromstring(response.content)
    available = quota_value(root, "quota-available-bytes")
    used = quota_value(root, "quota-used-bytes")
    if available == SPACE_UNLIMITED:
        return CapacityResult(state=CapacityState.ELASTIC)
    if available is None or used is None or available < 0:
        return CapacityResult(state=CapacityState.UNKNOWN)
    return CapacityResult(
        state=CapacityState.QUOTA,
        total=used + available,
        used=used,
        available=available,
    )
