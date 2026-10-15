from http import HTTPStatus
from xml.etree import ElementTree

from mirage.accessor.nextcloud import NextcloudAccessor
from mirage.core.nextcloud.constants import QUOTA_PROPFIND, SPACE_UNLIMITED
from mirage.core.nextcloud.dav import dav_request
from mirage.core.nextcloud.search.response import successful_status
from mirage.core.nextcloud.search.types import XmlElement
from mirage.core.nextcloud.search.xml import dav
from mirage.types import CapacityResult, CapacityState


def quota_value(root: XmlElement, name: str) -> int | None:
    """A quota property's byte count from a property group the server
    answered, None when no such group holds a whole number.

    Args:
        root (XmlElement): the PROPFIND multistatus.
        name (str): the DAV property, e.g. ``quota-used-bytes``.
    """
    for propstat in root.iter(dav("propstat")):
        if not successful_status(propstat.findtext(dav("status"), "")):
            continue
        text = (propstat.findtext(f"{dav('prop')}/{dav(name)}") or "").strip()
        if text.removeprefix("-").isdigit():
            return int(text)
    return None


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
