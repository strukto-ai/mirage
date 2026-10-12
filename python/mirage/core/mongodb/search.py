# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========


from collections.abc import AsyncIterator
from contextlib import aclosing
from typing import Any

from mirage.accessor.mongodb import MongoDBAccessor
from mirage.core.mongodb.client import iter_documents
from mirage.core.mongodb.readdir import entity_guard
from mirage.core.mongodb.scope import detect_scope
from mirage.core.mongodb.stream import (
    _apply_elision,
    _elision_paths,
    render_doc,
)
from mirage.core.mongodb.types import PRIMARY_KEY
from mirage.types import PathSpec
from mirage.utils.record_search import record_queries

# The words a document's line holds whatever its keys and strings say:
# Extended JSON's type wrappers and their keys, the JSON literals, a
# double's NaN and Infinity and a date's Z.
RECORD_KEYS = frozenset(
    {
        "oid",
        "date",
        "numberlong",
        "numberint",
        "numberdouble",
        "numberdecimal",
        "binary",
        "base64",
        "subtype",
        "uuid",
        "regularexpression",
        "pattern",
        "options",
        "code",
        "scope",
        "symbol",
        "timestamp",
        "t",
        "i",
        "minkey",
        "maxkey",
        "dbpointer",
        "ref",
        "id",
        "undefined",
        "true",
        "false",
        "null",
        "nan",
        "infinity",
        "z",
    }
)
# Value types whose line spells letters no key or string of the document
# holds (a binary's base64, a regex's pattern, code, a symbol), so a
# document holding one is always a candidate.
_OPAQUE = [
    "binData",
    "regex",
    "javascript",
    "javascriptWithScope",
    "symbol",
    "dbPointer",
]
# How deep the walk looks into nested documents and arrays; a document
# nested deeper is a candidate.
DEPTH = 8
# A line spells a character outside ASCII as a `\uXXXX` escape on one host,
# whose letters a text starting with `u` or a hex letter can begin inside.
_ESCAPE_STARTS = frozenset("abcdefu")

_Expr = dict[str, Any]


def _step(level: str, test: _Expr) -> _Expr:
    """One level of the walk: test each key and string of the values at
    ``level``, and gather what nests inside them for the next.

    Args:
        level (str): the variable holding ``{hit, next}`` for this level.
        test (dict[str, Any]): the expression matching ``$$value``.
    """
    return {
        "$reduce": {
            "input": f"$${level}.next",
            "initialValue": {"hit": f"$${level}.hit", "next": []},
            "in": {
                "$switch": {
                    "branches": [
                        {
                            "case": {"$eq": [{"$type": "$$this"}, "string"]},
                            "then": {
                                "hit": {
                                    "$or": [
                                        "$$value.hit",
                                        _bind(test, "$$this"),
                                    ]
                                },
                                "next": "$$value.next",
                            },
                        },
                        {
                            "case": {"$eq": [{"$type": "$$this"}, "object"]},
                            "then": {
                                "$let": {
                                    "vars": {
                                        "pairs": {"$objectToArray": "$$this"}
                                    },
                                    "in": {
                                        "hit": {
                                            "$or": [
                                                "$$value.hit",
                                                {
                                                    "$anyElementTrue": [
                                                        {
                                                            "$map": {
                                                                "input": "$$pairs",
                                                                "as": "pair",
                                                                "in": _bind(
                                                                    test,
                                                                    "$$pair.k",
                                                                ),
                                                            }
                                                        }
                                                    ]
                                                },
                                            ]
                                        },
                                        "next": {
                                            "$concatArrays": [
                                                "$$value.next",
                                                "$$pairs.v",
                                            ]
                                        },
                                    },
                                }
                            },
                        },
                        {
                            "case": {"$eq": [{"$type": "$$this"}, "array"]},
                            "then": {
                                "hit": "$$value.hit",
                                "next": {
                                    "$concatArrays": ["$$value.next", "$$this"]
                                },
                            },
                        },
                        {
                            "case": {"$in": [{"$type": "$$this"}, _OPAQUE]},
                            "then": {"hit": True, "next": "$$value.next"},
                        },
                    ],
                    "default": "$$value",
                }
            },
        }
    }


def _bind(test: _Expr, value: str) -> _Expr:
    return {"$let": {"vars": {"tested": value}, "in": test}}


def holds_filter(queries: list[str]) -> _Expr:
    """A find filter for the documents whose line may hold one of
    ``queries``: a key or a string at any depth holds it in any case, a
    string holds a character the line may spell as an escape, or a value
    is one the walk cannot see into.

    Args:
        queries (list[str]): texts of ASCII letters and spaces.
    """
    words: _Expr = {
        "$regexMatch": {
            "input": "$$tested",
            "regex": "|".join(queries),
            "options": "i",
        }
    }
    test = words
    if any(query[0].lower() in _ESCAPE_STARTS for query in queries):
        test = {
            "$or": [
                words,
                {
                    "$regexMatch": {
                        "input": "$$tested",
                        "regex": "[^\\x00-\\x7f]",
                    }
                },
            ]
        }
    body: _Expr = {
        "$or": [
            f"$$s{DEPTH}.hit",
            {"$gt": [{"$size": f"$$s{DEPTH}.next"}, 0]},
        ]
    }
    for depth in reversed(range(DEPTH)):
        body = {
            "$let": {
                "vars": {f"s{depth + 1}": _step(f"s{depth}", test)},
                "in": body,
            }
        }
    return {
        "$expr": {
            "$let": {
                "vars": {"s0": {"hit": False, "next": ["$$ROOT"]}},
                "in": body,
            }
        }
    }


async def lines_containing(
    accessor: MongoDBAccessor, path: PathSpec, text: str
) -> AsyncIterator[bytes] | None:
    """The lines of a collection's or view's documents.jsonl that may hold
    ``text``, streamed in the ``_id`` order a plain read takes.

    MongoDB walks each document's keys and strings on the server
    (``holds_filter``), so only the documents that may match are sent;
    grep matches each line itself. ``text`` goes through
    ``record_queries`` for the words of Extended JSON's wrappers and for
    escapes. None for any other file and for a text that could match
    outside a key or a string.

    Args:
        accessor (MongoDBAccessor): backend handle.
        path (PathSpec): the file grep would read.
        text (str): plain text every match holds.
    """
    match = detect_scope(path)
    if match.kind != "documents":
        return None
    queries = record_queries(text, RECORD_KEYS, whole_word=False)
    if queries is None:
        return None
    await entity_guard(accessor, match, path.virtual)
    return _matching(
        accessor, match.slots["database"], match.slots["name"], queries
    )


async def _matching(
    accessor: MongoDBAccessor,
    database: str,
    name: str,
    queries: list[str],
) -> AsyncIterator[bytes]:
    elide = _elision_paths(accessor.config, database, name)
    async with aclosing(
        iter_documents(
            accessor.client,
            database,
            name,
            filter=holds_filter(queries),
            sort=[(PRIMARY_KEY, 1)],
        )
    ) as documents:
        async for doc in documents:
            if elide:
                doc = _apply_elision(doc, elide)
            yield (render_doc(doc) + "\n").encode()
