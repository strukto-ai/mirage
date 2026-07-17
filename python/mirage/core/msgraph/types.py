from collections.abc import Mapping
from typing import Any, TypedDict


class DriveItem(TypedDict, total=False):
    id: str
    name: str
    size: int
    lastModifiedDateTime: str
    folder: Mapping[str, Any]
    file: Mapping[str, Any]


def parse_drive_item(raw: Mapping[str, Any]) -> DriveItem:
    item = DriveItem()
    item_id = raw.get("id")
    if isinstance(item_id, str):
        item["id"] = item_id
    name = raw.get("name")
    if isinstance(name, str):
        item["name"] = name
    size = raw.get("size")
    if isinstance(size, int) and not isinstance(size, bool):
        item["size"] = size
    modified = raw.get("lastModifiedDateTime")
    if isinstance(modified, str):
        item["lastModifiedDateTime"] = modified
    folder = raw.get("folder")
    if isinstance(folder, Mapping):
        item["folder"] = folder
    file = raw.get("file")
    if isinstance(file, Mapping):
        item["file"] = file
    return item
