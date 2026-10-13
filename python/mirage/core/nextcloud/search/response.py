from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from http import HTTPStatus
from xml.etree import ElementTree

from mirage.core.nextcloud.search.constants import (
    CONTENT_LENGTH,
    LAST_MODIFIED,
    RESOURCE_TYPE,
)
from mirage.core.nextcloud.search.target import relative_path
from mirage.core.nextcloud.search.types import (
    Property,
    SearchEntry,
    SearchTarget,
    XmlElement,
)
from mirage.core.nextcloud.search.xml import dav
from mirage.types import FindType


def successful_status(status: str) -> bool:
    parts = status.split()
    return len(parts) >= 2 and parts[1] == str(HTTPStatus.OK.value)


def successful_properties(response: XmlElement) -> list[XmlElement]:
    properties: list[XmlElement] = []
    for propstat in response.findall(dav("propstat")):
        status = propstat.findtext(dav("status"), "")
        prop = propstat.find(dav("prop"))
        if successful_status(status) and prop is not None:
            properties.append(prop)
    if not properties:
        raise ValueError(
            "Nextcloud Files Search result has no successful properties"
        )
    return properties


def find_text(properties: list[XmlElement], field: Property) -> str | None:
    for prop in properties:
        value = prop.findtext(field.tag)
        if value is not None:
            return value
    return None


def has_collection(properties: list[XmlElement]) -> bool:
    for prop in properties:
        resource_type = prop.find(RESOURCE_TYPE.tag)
        if (
            resource_type is not None
            and resource_type.find(dav("collection")) is not None
        ):
            return True
    return False


def modified_text(value: str | None) -> str | None:
    """A getlastmodified value as the ISO time a listing records.

    Args:
        value (str | None): the property's text.
    """
    if value is None:
        return None
    try:
        modified = parsedate_to_datetime(value)
    except (TypeError, ValueError):
        try:
            modified = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError as exc:
            raise ValueError(
                f"invalid Nextcloud Files Search timestamp: {value}"
            ) from exc
    if modified.tzinfo is None:
        modified = modified.replace(tzinfo=timezone.utc)
    return modified.isoformat()


def content_length(properties: list[XmlElement]) -> int | None:
    value = find_text(properties, CONTENT_LENGTH)
    if value is None:
        return None
    try:
        return int(value)
    except ValueError as exc:
        raise ValueError(
            f"invalid Nextcloud Files Search size: {value}"
        ) from exc


def parse_response(response: XmlElement, target: SearchTarget) -> SearchEntry:
    href = response.findtext(dav("href"))
    if href is None:
        raise ValueError("Nextcloud Files Search result is missing href")
    properties = successful_properties(response)
    folder = has_collection(properties)
    return SearchEntry(
        key=relative_path(href, target),
        kind=FindType.DIRECTORY if folder else FindType.FILE,
        size=None if folder else content_length(properties),
        modified=modified_text(find_text(properties, LAST_MODIFIED)),
    )


def parse_page(content: bytes, target: SearchTarget) -> list[SearchEntry]:
    root = ElementTree.fromstring(content)
    if root.tag != dav("multistatus"):
        raise ValueError("invalid Nextcloud Files Search response")
    return [
        parse_response(response, target)
        for response in root.findall(dav("response"))
    ]
