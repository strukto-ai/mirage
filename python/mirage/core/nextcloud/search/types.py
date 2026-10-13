from dataclasses import dataclass
from enum import StrEnum
from typing import TypeAlias
from xml.etree import ElementTree

from mirage.types import FindType

XmlElement: TypeAlias = ElementTree.Element


class Namespace(StrEnum):
    DAV = "DAV:"
    OWNCLOUD = "http://owncloud.org/ns"
    SEARCHDAV = "https://github.com/icewind1991/SearchDAV/ns"


@dataclass(frozen=True, slots=True)
class Property:
    namespace: Namespace
    name: str

    @property
    def tag(self) -> str:
        return f"{{{self.namespace}}}{self.name}"


@dataclass(frozen=True, slots=True)
class SearchEntry:
    key: str
    kind: FindType
    size: int | None
    modified: str | None


@dataclass(frozen=True, slots=True)
class SearchTarget:
    endpoint: str
    vfs_scope: str
