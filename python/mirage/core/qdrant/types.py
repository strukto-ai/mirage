from collections.abc import Callable
from typing import TYPE_CHECKING, TypeAlias

from mirage.types import JsonValue

if TYPE_CHECKING:
    from qdrant_client import models

QdrantRow = dict[str, JsonValue]
QdrantPoint: TypeAlias = "models.Record | models.ScoredPoint"
PointTest = Callable[[QdrantPoint], bool]
