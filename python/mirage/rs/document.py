from __future__ import annotations

import json
from collections.abc import Iterable, Mapping
from typing import Any

from mirage.rs.stream import open_stream


def _document_wire(value: Any) -> Any:
    if value is None:
        return "null"
    if isinstance(value, str):
        return {"text": list(map(ord, value))}
    if isinstance(value, (list, tuple)):
        return {"list": [_document_wire(item) for item in value]}
    if isinstance(value, Mapping):
        return {
            "map": [
                [_document_wire(key), _document_wire(item)]
                for key, item in value.items()
            ]
        }
    return "invalid"


def _document_from(value: Any) -> Any:
    if value == "null":
        return None
    if "text" in value:
        return "".join(map(chr, value["text"]))
    if "list" in value:
        return [_document_from(item) for item in value["list"]]
    if "map" in value:
        return {
            _document_from(key): _document_from(item)
            for key, item in value["map"]
        }
    raise ValueError("invalid configuration document response")


def validate_document(
    op: str,
    raw: Any,
    where: str,
    *,
    names: str | None = None,
    root: str = "",
    reason: str = "",
) -> Any:
    """Validate and normalize one field in the shared document engine.

    Args:
        op (str): the field's document operation.
        raw (Any): the document value as supplied by the caller.
        where (str): field location for diagnostics.
        names (str | None): what a nonblank string field names.
        root (str): the enclosing mount for an under-mount check.
        reason (str): the reason used by a rule that does not state one.
    """
    stream = open_stream(
        "document",
        {
            "op": op,
            "raw": _document_wire(raw),
            "where_": list(map(ord, where)),
            "dialect": "python",
            "names": names,
            "root": list(map(ord, root)),
            "reason": list(map(ord, reason)),
        },
    )
    answer = json.loads(stream.finish())
    if "error" in answer:
        raise ValueError(answer["error"])
    return _document_from(answer["value"])


def units(value: str) -> list[int]:
    """Text as the code points the stream reads, lone surrogates kept.

    Args:
        value (str): the text.
    """
    return [*map(ord, value)]


def from_units(value: Iterable[int]) -> str:
    """Code points from the stream back as text.

    Args:
        value (Iterable[int]): the code points.
    """
    return "".join(map(chr, value))
