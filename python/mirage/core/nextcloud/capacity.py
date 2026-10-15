from http import HTTPStatus
from xml.etree import ElementTree

from mirage.accessor.nextcloud import NextcloudAccessor
from mirage.core.nextcloud.constants import QUOTA_PROPFIND, SPACE_UNLIMITED
from mirage.core.nextcloud.dav import dav_request
from mirage.core.nextcloud.search.xml import dav
from mirage.types import CapacityResult, CapacityState


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
    available = root.findtext(f".//{dav('quota-available-bytes')}")
    used = root.findtext(f".//{dav('quota-used-bytes')}")
    if available is None or used is None:
        return CapacityResult(state=CapacityState.UNKNOWN)
    if int(available) == SPACE_UNLIMITED:
        return CapacityResult(state=CapacityState.ELASTIC)
    if int(available) < 0:
        return CapacityResult(state=CapacityState.UNKNOWN)
    return CapacityResult(
        state=CapacityState.QUOTA,
        total=int(used) + int(available),
        used=int(used),
        available=int(available),
    )
