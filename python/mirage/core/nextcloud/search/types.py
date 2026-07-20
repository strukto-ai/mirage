from dataclasses import dataclass, field
from enum import StrEnum
from typing import Generic, TypeAlias, TypeVar
from xml.etree import ElementTree

from mirage.commands.builtin.find_eval import PredNode
from mirage.types import FindType

Bound = TypeVar("Bound", int, float)
XmlElement: TypeAlias = ElementTree.Element


class Namespace(StrEnum):
    DAV = "DAV:"
    OWNCLOUD = "http://owncloud.org/ns"
    SEARCHDAV = "https://github.com/icewind1991/SearchDAV/ns"


class Comparison(StrEnum):
    EQUAL = "eq"
    GREATER_THAN_OR_EQUAL = "gte"
    LESS_THAN_OR_EQUAL = "lte"
    LIKE = "like"


class BooleanOperation(StrEnum):
    AND = "and"
    OR = "or"


@dataclass(frozen=True, slots=True)
class Property:
    namespace: Namespace
    name: str

    @property
    def tag(self) -> str:
        return f"{{{self.namespace}}}{self.name}"


@dataclass(frozen=True, slots=True)
class Bounds(Generic[Bound]):
    lower: Bound | None = None
    upper: Bound | None = None

    @property
    def constrained(self) -> bool:
        return self.lower is not None or self.upper is not None

    def contains(self, value: Bound) -> bool:
        if self.lower is not None and value < self.lower:
            return False
        if self.upper is not None and value > self.upper:
            return False
        return True


@dataclass(frozen=True, slots=True)
class FilesSearchQuery:
    tree: PredNode
    size: Bounds[int] = field(default_factory=Bounds)
    modified: Bounds[float] = field(default_factory=Bounds)


@dataclass(frozen=True, slots=True)
class SearchEntry:
    key: str
    name: str
    kind: FindType
    size: int | None
    modified: float | None


@dataclass(frozen=True, slots=True)
class SearchTarget:
    endpoint: str
    resource_scope: str


@dataclass(frozen=True, slots=True)
class CompiledPredicate:
    condition: XmlElement | None
