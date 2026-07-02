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

import asyncio
import json
from functools import partial

import pytest

from mirage.accessor.s3 import S3Accessor
from mirage.commands.builtin.generic_bind.adapter import CommandIO
from mirage.commands.builtin.generic_bind.builders.jq import jq as jq_builder
from mirage.core.jq import JQ_EMPTY, jq_eval
from mirage.types import MountMode, PathSpec

from .conftest import collect, jq, mem_ws, run_raw, write_to_backend


async def _const_bytes(data, accessor, path, index=None):
    return data


async def _collect_jq(ops, accessor, paths, expr):
    out, _ = await jq_builder(ops, accessor, paths, expr)
    if isinstance(out, bytes):
        return out
    if hasattr(out, "__aiter__"):
        return b"".join([chunk async for chunk in out])
    return b"".join(out)


def test_jq_dot_returns_full_object(backend):
    data = {"a": 1, "b": 2}
    write_to_backend(backend, "/tmp/f.json", json.dumps(data).encode())
    result = jq(backend, "/tmp/f.json", ".")
    assert result == data


def test_jq_key_access(backend):
    write_to_backend(backend, "/tmp/f.json", b'{"name": "alice"}')
    assert jq(backend, "/tmp/f.json", ".name") == "alice"


def test_jq_nested_key(backend):
    write_to_backend(backend, "/tmp/f.json", b'{"a": {"b": 42}}')
    assert jq(backend, "/tmp/f.json", ".a.b") == 42


def test_jq_array_iteration(backend):
    write_to_backend(backend, "/tmp/f.json", b'{"items": [1, 2, 3]}')
    result = jq(backend, "/tmp/f.json", ".items[]")
    assert result == [1, 2, 3]


def test_jq_invalid_expression_raises(backend):
    write_to_backend(backend, "/tmp/f.json", b'{"a": 1}')
    with pytest.raises(ValueError):
        jq(backend, "/tmp/f.json", "a.b")


def test_jq_pipe(backend):
    write_to_backend(backend, "/tmp/f.json", b'{"items": [1, 2, 3]}')
    result = jq(backend, "/tmp/f.json", ".items | length")
    assert result == 3


def test_jq_select(backend):
    write_to_backend(backend, "/tmp/f.json", b'[{"a": 1}, {"a": 2}, {"a": 3}]')
    result = jq(backend, "/tmp/f.json", ".[] | select(.a > 1)")
    assert result == [{"a": 2}, {"a": 3}]


def test_jq_map(backend):
    write_to_backend(backend, "/tmp/f.json", b'[1, 2, 3]')
    result = jq(backend, "/tmp/f.json", "map(. > 1)")
    assert result == [False, True, True]


def test_jq_keys(backend):
    write_to_backend(backend, "/tmp/f.json", b'{"b": 1, "a": 2}')
    result = jq(backend, "/tmp/f.json", "keys")
    assert result == ["a", "b"]


def test_jq_values_passes_through_non_null(backend):
    write_to_backend(backend, "/tmp/f.json", b'{"a": 1, "b": 2}')
    result = jq(backend, "/tmp/f.json", "values")
    assert result == {"a": 1, "b": 2}


def test_jq_values_drops_null(backend):
    write_to_backend(backend, "/tmp/f.json", b'{"a": 1}')
    assert jq(backend, "/tmp/f.json", ".missing | values") is JQ_EMPTY


def test_jq_object_values_via_spread(backend):
    write_to_backend(backend, "/tmp/f.json", b'{"a": 1, "b": 2}')
    result = jq(backend, "/tmp/f.json", "[.[]]")
    assert result == [1, 2]


def test_jq_array_slice(backend):
    write_to_backend(backend, "/tmp/f.json", b'[10, 20, 30, 40, 50]')
    result = jq(backend, "/tmp/f.json", ".[1:3]")
    assert result == [20, 30]


def test_jq_length(backend):
    write_to_backend(backend, "/tmp/f.json", b'[1, 2, 3]')
    result = jq(backend, "/tmp/f.json", "length")
    assert result == 3


def test_jq_string_interpolation():
    result = jq_eval({"name": "world"}, '"Hello \\(.name)"')
    assert result == "Hello world"


def test_jq_string_interpolation_nested():
    result = jq_eval({"a": 1, "b": 2}, '"\\(.a) + \\(.b)"')
    assert result == "1 + 2"


def test_jq_try_catch_returns_null_when_no_error():
    # In real jq, .missing.x is NOT an error; it returns null.
    # Hence catch is never triggered.
    assert jq_eval({}, 'try .missing.x catch "fallback"') is None


def test_jq_try_catch_triggered_on_real_error():
    assert jq_eval([1, 2, 3], 'try .name catch "fallback"') == "fallback"


def test_jq_try_no_catch_returns_null():
    assert jq_eval({}, "try .missing.x") is None


def test_jq_try_no_catch_swallows_real_error():
    assert jq_eval([1, 2, 3], "try .name") is JQ_EMPTY


class TestJqMapValues:

    def test_map_values_dict(self):
        result = jq_eval({"a": 1, "b": 2}, "map_values(. > 1)")
        assert result == {"a": False, "b": True}

    def test_map_values_list(self):
        result = jq_eval([1, 2, 3], "map_values(. > 1)")
        assert result == [False, True, True]

    def test_map_values_dict_arithmetic(self):
        result = jq_eval({"x": 10, "y": 20}, 'map_values(type)')
        assert result == {"x": "number", "y": "number"}


class TestJqHas:

    def test_has_present_key(self):
        assert jq_eval({"name": "alice"}, 'has("name")') is True

    def test_has_absent_key(self):
        assert jq_eval({"name": "alice"}, 'has("age")') is False

    def test_has_array_with_int_key(self):
        # In real jq, has() on arrays takes an integer index.
        assert jq_eval([1, 2, 3], "has(1)") is True
        assert jq_eval([1, 2, 3], "has(5)") is False


class TestJqContains:

    def test_contains_string_in_string(self):
        assert jq_eval("foobar", 'contains("foo")') is True

    def test_contains_string_not_found(self):
        assert jq_eval("foobar", 'contains("xyz")') is False

    def test_contains_element_requires_array_arg(self):
        # In real jq, contains(x) requires arg of same type.
        # For arrays, use contains([item]) — see test_contains_subarray.
        with pytest.raises(ValueError):
            jq_eval([1, 2, 3], "contains(2)")

    def test_contains_subarray(self):
        assert jq_eval([1, 2, 3], "contains([1, 2])") is True

    def test_contains_subarray_not_found(self):
        assert jq_eval([1, 2, 3], "contains([4, 5])") is False


class TestJqComparisons:

    def test_eq_true(self):
        assert jq_eval({"a": 1}, ".a == 1") is True

    def test_eq_false(self):
        assert jq_eval({"a": 1}, ".a == 2") is False

    def test_neq_true(self):
        assert jq_eval({"a": 1}, ".a != 2") is True

    def test_neq_false(self):
        assert jq_eval({"a": 1}, ".a != 1") is False

    def test_gt(self):
        assert jq_eval({"a": 5}, ".a > 3") is True

    def test_gt_false(self):
        assert jq_eval({"a": 1}, ".a > 3") is False

    def test_lt(self):
        assert jq_eval({"a": 1}, ".a < 3") is True

    def test_lt_false(self):
        assert jq_eval({"a": 5}, ".a < 3") is False

    def test_gte(self):
        assert jq_eval({"a": 3}, ".a >= 3") is True

    def test_gte_false(self):
        assert jq_eval({"a": 2}, ".a >= 3") is False

    def test_lte(self):
        assert jq_eval({"a": 3}, ".a <= 3") is True

    def test_lte_false(self):
        assert jq_eval({"a": 5}, ".a <= 3") is False

    def test_string_eq(self):
        assert jq_eval({"s": "hello"}, '.s == "hello"') is True


class TestJqPipes:

    def test_three_stage_pipe(self, backend):
        write_to_backend(backend, "/tmp/f.json",
                         b'{"data": {"items": [1, 2, 3]}}')
        result = jq(backend, "/tmp/f.json", ".data | .items | length")
        assert result == 3

    def test_pipe_with_iteration_and_select(self, backend):
        write_to_backend(backend, "/tmp/f.json",
                         b'[{"x": 1}, {"x": 5}, {"x": 10}]')
        result = jq(backend, "/tmp/f.json", ".[] | select(.x > 3)")
        assert result == [{"x": 5}, {"x": 10}]

    def test_pipe_keys_then_length(self):
        result = jq_eval({"a": 1, "b": 2, "c": 3}, "keys | length")
        assert result == 3

    def test_pipe_object_values_via_spread_then_sort(self):
        # Real jq: `values` returns the object as-is (it's the identity for
        # non-null). To get the object's values list, use [.[]].
        result = jq_eval({"a": 3, "b": 1, "c": 2}, "[.[]] | sort")
        assert result == [1, 2, 3]

    def test_pipe_map_then_select(self):
        data = [1, 2, 3, 4, 5]
        result = jq_eval(data, "map(select(. > 2))")
        assert result == [3, 4, 5]


class TestJqArrayAccess:

    def test_index_access(self):
        result = jq_eval({"items": ["a", "b", "c"]}, ".items[0]")
        assert result == "a"

    def test_index_access_last(self):
        result = jq_eval({"items": ["a", "b", "c"]}, ".items[2]")
        assert result == "c"

    def test_nested_array_iteration(self, backend):
        write_to_backend(backend, "/tmp/f.json",
                         b'{"users": [{"name": "alice"}, {"name": "bob"}]}')
        result = jq(backend, "/tmp/f.json", ".users[].name")
        assert result == ["alice", "bob"]

    def test_slice_from_start(self):
        result = jq_eval([1, 2, 3, 4, 5], ".[:2]")
        assert result == [1, 2]

    def test_slice_to_end(self):
        result = jq_eval([1, 2, 3, 4, 5], ".[3:]")
        assert result == [4, 5]


class TestJqEdgeCases:

    def test_empty_object(self):
        assert jq_eval({}, ".") == {}

    def test_empty_array(self):
        assert jq_eval([], ".") == []

    def test_deeply_nested(self):
        data = {"a": {"b": {"c": {"d": 42}}}}
        assert jq_eval(data, ".a.b.c.d") == 42

    def test_unicode_content(self, backend):
        data = {"name": "café", "emoji": "hello"}
        write_to_backend(backend, "/tmp/f.json", json.dumps(data).encode())
        result = jq(backend, "/tmp/f.json", ".name")
        assert result == "café"

    def test_json_literal_number(self):
        assert jq_eval({}, "42") == 42

    def test_json_literal_string(self):
        assert jq_eval({}, '"hello"') == "hello"

    def test_json_literal_array(self):
        assert jq_eval({}, "[1, 2, 3]") == [1, 2, 3]

    def test_length_of_string(self):
        assert jq_eval("hello", "length") == 5

    def test_length_of_dict(self):
        assert jq_eval({"a": 1, "b": 2}, "length") == 2

    def test_keys_of_array(self):
        assert jq_eval(["a", "b", "c"], "keys") == [0, 1, 2]

    def test_string_interpolation_with_nested_expr(self):
        data = {"items": [1, 2, 3]}
        result = jq_eval(data, '"count: \\(.items | length)"')
        assert result == "count: 3"

    def test_select_drops_non_matching(self):
        assert jq_eval({"a": 1}, "select(.a > 10)") is JQ_EMPTY

    def test_map_requires_iterable(self):
        # Real jq: map(.) on a non-iterable raises ValueError.
        with pytest.raises(ValueError):
            jq_eval(5, "map(.)")

    def test_missing_key_returns_null(self):
        # Real jq: missing keys silently return null (no exception).
        assert jq_eval({"a": 1}, ".b") is None

    def test_type_error_dot_on_list(self):
        with pytest.raises((TypeError, KeyError, ValueError)):
            jq_eval([1, 2, 3], ".name")

    def test_try_catch_type_error(self):
        result = jq_eval([1, 2], 'try .name catch "no key"')
        assert result == "no key"


class TestJqComplex:

    def test_map_select_keys(self):
        data = [{"a": 1, "b": 2}, {"a": 3, "b": 4}]
        result = jq_eval(data, "map(select(.a > 1)) | .[] | .b")
        assert result == [4]

    def test_iteration_pipe_type(self):
        data = [1, "hello", True, None, [1], {"a": 1}]
        result = jq_eval(data, ".[] | type")
        assert result == [
            "number", "string", "boolean", "null", "array", "object"
        ]

    def test_flatten_then_unique_then_sort(self):
        data = [[3, 1], [2, 1], [3, 2]]
        result = jq_eval(data, "flatten | unique | sort")
        assert result == [1, 2, 3]

    def test_map_length(self):
        data = ["hello", "hi", "hey"]
        result = jq_eval(data, "map(length)")
        assert result == [5, 2, 3]

    def test_select_with_has(self):
        data = [{"name": "alice"}, {"age": 30}, {"name": "bob"}]
        result = jq_eval(data, 'map(select(has("name")))')
        assert result == [{"name": "alice"}, {"name": "bob"}]


class TestJqArithmetic:

    def test_add_numbers(self):
        assert jq_eval({"a": 1, "b": 2}, ".a + .b") == 3

    def test_subtract(self):
        assert jq_eval({"a": 10, "b": 3}, ".a - .b") == 7

    def test_multiply(self):
        assert jq_eval({"a": 4, "b": 5}, ".a * .b") == 20

    def test_divide(self):
        assert jq_eval({"a": 10, "b": 2}, ".a / .b") == 5.0

    def test_add_string_concat(self):
        assert jq_eval({
            "a": "hello",
            "b": " world"
        }, ".a + .b") == "hello world"

    def test_add_literal_number(self):
        assert jq_eval({"a": 1}, ".a + 10") == 11


class TestJqObjectConstruction:

    def test_object_construction(self):
        data = {"name": "alice", "age": 30}
        result = jq_eval(data, "{name: .name}")
        assert result == {"name": "alice"}

    def test_object_construction_multiple_keys(self):
        data = {"x": 1, "y": 2, "z": 3}
        result = jq_eval(data, "{a: .x, b: .y}")
        assert result == {"a": 1, "b": 2}


class TestJqAlternative:

    def test_alternative_with_null(self):
        assert jq_eval({"a": None}, '.a // "default"') == "default"

    def test_alternative_with_value(self):
        assert jq_eval({"a": 42}, '.a // "default"') == 42

    def test_alternative_missing_key(self):
        assert jq_eval({}, '.missing // "fallback"') == "fallback"


class TestJqIfThenElse:

    def test_if_then_else_true(self):
        result = jq_eval({"x": 5}, 'if .x > 3 then "big" else "small" end')
        assert result == "big"

    def test_if_then_else_false(self):
        result = jq_eval({"x": 1}, 'if .x > 3 then "big" else "small" end')
        assert result == "small"


class TestJqSortByGroupBy:

    def test_sort_by(self):
        data = [{"a": 3}, {"a": 1}, {"a": 2}]
        result = jq_eval(data, "sort_by(.a)")
        assert result == [{"a": 1}, {"a": 2}, {"a": 3}]

    def test_group_by(self):
        data = [{"k": "a", "v": 1}, {"k": "b", "v": 2}, {"k": "a", "v": 3}]
        result = jq_eval(data, "group_by(.k)")
        assert result == [
            [{
                "k": "a",
                "v": 1
            }, {
                "k": "a",
                "v": 3
            }],
            [{
                "k": "b",
                "v": 2
            }],
        ]


class TestJqBugFixes:

    def test_double_array_iteration(self):
        data = [[1, 2], [3, 4]]
        result = jq_eval(data, ".[] | .[]")
        assert result == [1, 2, 3, 4]

    def test_double_array_iteration_with_tail(self):
        data = [["ab", "cd"], ["ef"]]
        result = jq_eval(data, ".[] | .[] | length")
        assert result == [2, 2, 2]

    def test_dot_key_on_list_raises(self):
        # Real jq raises ValueError "Cannot index array with string".
        with pytest.raises(ValueError):
            jq_eval([1, 2, 3], ".name")

    def test_contains_dict_subset(self):
        assert jq_eval({"a": 1, "b": 2}, 'contains({"a": 1})') is True

    def test_contains_dict_missing_key(self):
        assert jq_eval({"a": 1}, 'contains({"b": 2})') is False

    def test_contains_dict_wrong_value(self):
        assert jq_eval({"a": 1}, 'contains({"a": 2})') is False

    def test_contains_dict_full_match(self):
        assert jq_eval({"a": 1}, 'contains({"a": 1})') is True


class TestJqParensAndArrayConstruction:

    def test_parens_unwrap_single(self):
        assert jq_eval({"items": [1, 2, 3]}, "(.items | length)") == 3

    def test_parens_in_object_value(self):
        result = jq_eval({"items": [1, 2, 3]},
                         "{n: (.items | length), first: .items[0]}")
        assert result == {"n": 3, "first": 1}

    def test_array_construction_collects_spread(self):
        data = {"slides": [{"id": "a"}, {"id": "b"}, {"id": "c"}]}
        assert jq_eval(data, "[.slides[].id]") == ["a", "b", "c"]

    def test_array_construction_wraps_single_value(self):
        assert jq_eval({"x": 5}, "[.x]") == [5]

    def test_object_with_array_literal_value_does_not_split_inside(self):
        assert jq_eval({}, "{x: 1, y: [1,2,3]}") == {"x": 1, "y": [1, 2, 3]}

    def test_object_with_nested_object_value(self):
        result = jq_eval({"a": 1, "b": 2}, "{outer: {x: .a, y: .b}}")
        assert result == {"outer": {"x": 1, "y": 2}}

    def test_join_separator(self):
        assert jq_eval([1, 2, 3], 'join("-")') == "1-2-3"

    def test_join_empty_separator(self):
        assert jq_eval(["foo", "bar"], 'join("")') == "foobar"

    def test_array_construction_then_join(self):
        data = {"slides": [{"id": "a"}, {"id": "b"}]}
        assert jq_eval(data, '[.slides[].id] | join(",")') == "a,b"

    def test_full_slides_summary_expression(self):
        data = {
            "title":
            "Deck",
            "slides": [
                {
                    "objectId":
                    "s1",
                    "pageElements": [
                        {
                            "shape": {
                                "shapeType": "TITLE",
                                "text": {
                                    "textElements": [
                                        {
                                            "textRun": {
                                                "content": "Hello "
                                            }
                                        },
                                        {
                                            "textRun": {
                                                "content": "world"
                                            }
                                        },
                                    ]
                                },
                            }
                        },
                        {
                            "image": {
                                "url": "..."
                            }
                        },
                    ],
                },
                {
                    "objectId":
                    "s2",
                    "pageElements": [{
                        "shape": {
                            "shapeType": "TEXT_BOX",
                            "text": {
                                "textElements": [{
                                    "textRun": {
                                        "content": "Bye"
                                    }
                                }]
                            },
                        }
                    }],
                },
            ],
        }
        expr = ('{title: .title, slideCount: (.slides | length), '
                'slides: [.slides[] | {objectId, '
                'elements: [.pageElements[] | select(.shape != null) | '
                '{type: .shape.shapeType, '
                'text: [.shape.text.textElements[].textRun.content] '
                '| join("")}]}]}')
        assert jq_eval(data, expr) == {
            "title":
            "Deck",
            "slideCount":
            2,
            "slides": [
                {
                    "objectId": "s1",
                    "elements": [{
                        "type": "TITLE",
                        "text": "Hello world"
                    }],
                },
                {
                    "objectId": "s2",
                    "elements": [{
                        "type": "TEXT_BOX",
                        "text": "Bye"
                    }],
                },
            ],
        }


class TestJqRealLibjqExpressions:
    """Expressions that broke the homegrown parser before the libjq swap.
    Each is a real-world query an agent might run; if any of these fail
    again it means the engine regressed."""

    def _slides_doc(self) -> dict:
        return {
            "title":
            "Deck",
            "slides": [
                {
                    "objectId":
                    "s1",
                    "pageElements": [
                        {
                            "shape": {
                                "shapeType": "TITLE",
                                "text": {
                                    "textElements": [
                                        {
                                            "textRun": {
                                                "content": "Hello "
                                            }
                                        },
                                        {
                                            "paragraphMarker": {}
                                        },
                                        {
                                            "textRun": {
                                                "content": "world"
                                            }
                                        },
                                    ]
                                },
                            }
                        },
                    ],
                },
                {
                    "objectId":
                    "s2",
                    "pageElements": [{
                        "shape": {
                            "shapeType": "TEXT_BOX",
                            "text": {
                                "textElements": [{
                                    "textRun": {
                                        "content": "Bye"
                                    }
                                }]
                            },
                        }
                    }],
                },
            ],
        }

    def test_user_query_with_select_textRun_then_join(self):
        expr = ('[.slides[].pageElements[].shape.text.textElements[] | '
                'select(.textRun != null) | .textRun.content] | join("")')
        assert jq_eval(self._slides_doc(), expr) == "Hello worldBye"

    def test_user_query_array_per_slide_then_join(self):
        expr = ('[.slides[] | '
                '[.pageElements[].shape.text.textElements[].textRun.content] '
                '| join("")]')
        # paragraphMarker has no textRun -> jq returns null; join treats null
        # as empty -> "Hello world" for s1, "Bye" for s2.
        assert jq_eval(self._slides_doc(), expr) == ["Hello world", "Bye"]

    def test_user_query_full_summary_object(self):
        expr = ('{title: .title, '
                'slideCount: (.slides | length), '
                'slides: [.slides[] | {objectId, '
                'elements: [.pageElements[] | select(.shape != null) | '
                '{type: .shape.shapeType, '
                'text: [.shape.text.textElements[].textRun.content] '
                '| join("")}]}]}')
        assert jq_eval(self._slides_doc(), expr) == {
            "title":
            "Deck",
            "slideCount":
            2,
            "slides": [
                {
                    "objectId": "s1",
                    "elements": [{
                        "type": "TITLE",
                        "text": "Hello world"
                    }],
                },
                {
                    "objectId": "s2",
                    "elements": [{
                        "type": "TEXT_BOX",
                        "text": "Bye"
                    }],
                },
            ],
        }

    def test_recurse_then_select(self):
        # `recurse` (..) is a real jq builtin the homegrown didn't have.
        data = {"a": 1, "b": {"c": 2, "d": {"e": 3}}}
        result = jq_eval(data, "[.. | numbers] | sort")
        assert result == [1, 2, 3]

    def test_string_split_join_round_trip(self):
        assert jq_eval("a-b-c", 'split("-")') == ["a", "b", "c"]
        assert jq_eval(["a", "b", "c"], 'join("-")') == "a-b-c"

    def test_alternative_operator_default(self):
        # `// "default"` falls back when LHS is null/false.
        assert jq_eval({"a": None}, '.a // "fallback"') == "fallback"
        assert jq_eval({"a": "real"}, '.a // "fallback"') == "real"

    def test_to_entries_from_entries(self):
        result = jq_eval({"a": 1, "b": 2}, "to_entries")
        assert result == [{"key": "a", "value": 1}, {"key": "b", "value": 2}]
        result2 = jq_eval([{"key": "x", "value": 9}], "from_entries")
        assert result2 == {"x": 9}

    def test_string_endswith_startswith(self):
        assert jq_eval("foobar", 'startswith("foo")') is True
        assert jq_eval("foobar", 'endswith("bar")') is True
        assert jq_eval("foobar", 'startswith("xyz")') is False

    def test_test_regex(self):
        assert jq_eval("hello world", 'test("w.rld")') is True
        assert jq_eval("hello world", 'test("xyz")') is False

    def test_walk_transform(self):
        # `walk` is a real jq builtin the homegrown didn't have.
        data = {"a": "FOO", "b": ["BAR", "BAZ"]}
        result = jq_eval(
            data, 'walk(if type == "string" then ascii_downcase else . end)')
        assert result == {"a": "foo", "b": ["bar", "baz"]}

    def test_nested_object_with_paren_value(self):
        data = {"items": [1, 2, 3]}
        result = jq_eval(
            data, "{count: (.items | length), max: (.items | max), "
            "sum: ([.items[]] | add)}")
        assert result == {"count": 3, "max": 3, "sum": 6}

    def test_select_chain_inside_array_construction(self):
        data = {
            "users": [
                {
                    "name": "alice",
                    "active": True
                },
                {
                    "name": "bob",
                    "active": False
                },
                {
                    "name": "carol",
                    "active": True
                },
            ]
        }
        result = jq_eval(
            data, "[.users[] | select(.active) | .name] | join(\", \")")
        assert result == "alice, carol"

    def test_top_level_select_returns_empty_sentinel(self):
        # Real jq: select(false) produces 0 outputs.
        # Our adapter returns JQ_EMPTY so callers serialize as empty bytes.
        assert jq_eval({"x": 5}, "select(.x > 100)") is JQ_EMPTY


class TestJqMemoryBackend:

    def test_single_path(self):
        ws = mem_ws({"/data.json": b'{"key": "value"}'})
        stdout, _ = run_raw(ws, 'jq .key /data/data.json')
        result = json.loads(collect(stdout))
        assert result == "value"

    def test_multiple_paths(self):
        ws = mem_ws({"/a.json": b'{"x": 1}', "/b.json": b'{"x": 2}'})
        stdout, _ = run_raw(ws, "jq .x /data/a.json /data/b.json")
        raw = collect(stdout).decode()
        assert "1" in raw
        assert "2" in raw

    def test_stdin_bytes(self):
        ws = mem_ws()
        stdout, _ = run_raw(ws, "jq .name", stdin=b'{"name": "stdin-test"}')
        result = json.loads(collect(stdout))
        assert result == "stdin-test"

    def test_dot_returns_full(self):
        ws = mem_ws({"/f.json": b'[1, 2, 3]'})
        stdout, _ = run_raw(ws, "jq . /data/f.json")
        result = json.loads(collect(stdout))
        assert result == [1, 2, 3]

    def test_missing_expression_defaults_dot(self):
        ws = mem_ws({"/f.json": b'{"a": 1}'})
        stdout, io = run_raw(ws, "jq")
        assert io.exit_code == 0
        assert collect(stdout) == b""

    def test_pipe_in_command(self):
        ws = mem_ws({"/f.json": b'{"items": [1, 2, 3]}'})
        stdout, _ = run_raw(ws, "jq '.items | length' /data/f.json")
        result = json.loads(collect(stdout))
        assert result == 3

    def test_select_via_command(self):
        ws = mem_ws({"/f.json": b'[{"a": 1}, {"a": 5}]'})
        stdout, _ = run_raw(ws, "jq '.[] | select(.a > 2)' /data/f.json")
        result = json.loads(collect(stdout))
        assert result == {"a": 5}

    def test_keys_via_command(self):
        ws = mem_ws({"/f.json": b'{"b": 1, "a": 2}'})
        stdout, _ = run_raw(ws, "jq keys /data/f.json")
        result = json.loads(collect(stdout))
        assert result == ["a", "b"]

    def test_spread_array_iteration(self):
        ws = mem_ws({"/f.json": b'[10, 20, 30]'})
        stdout, _ = run_raw(ws, "jq '.[]' /data/f.json")
        lines = collect(stdout).strip().splitlines()
        result = [json.loads(line) for line in lines]
        assert result == [10, 20, 30]

    def test_no_spread_dot_on_array(self):
        ws = mem_ws({"/f.json": b'[10, 20, 30]'})
        stdout, _ = run_raw(ws, "jq '.' /data/f.json")
        result = json.loads(collect(stdout))
        assert result == [10, 20, 30]

    def test_spread_nested_iteration(self):
        ws = mem_ws({"/f.json": b'[{"x": 1}, {"x": 2}]'})
        stdout, _ = run_raw(ws, "jq '.[].x' /data/f.json")
        lines = collect(stdout).strip().splitlines()
        result = [json.loads(line) for line in lines]
        assert result == [1, 2]

    def test_spread_via_stdin(self):
        ws = mem_ws()
        stdout, _ = run_raw(ws, "jq '.[]'", stdin=b'[1, 2, 3]')
        lines = collect(stdout).strip().splitlines()
        result = [json.loads(line) for line in lines]
        assert result == [1, 2, 3]

    def test_no_spread_dot_via_stdin(self):
        ws = mem_ws()
        stdout, _ = run_raw(ws, "jq '.'", stdin=b'[1, 2, 3]')
        result = json.loads(collect(stdout))
        assert result == [1, 2, 3]

    def test_spread_with_raw_flag(self):
        ws = mem_ws({"/f.json": b'["hello", "world"]'})
        stdout, _ = run_raw(ws, "jq -r '.[]' /data/f.json")
        output = collect(stdout).decode()
        assert output == "hello\nworld\n"

    def test_spread_select_multiple(self):
        ws = mem_ws({"/f.json": b'[{"a": 1}, {"a": 5}, {"a": 10}]'})
        stdout, _ = run_raw(ws, "jq -c '.[] | select(.a > 4)' /data/f.json")
        lines = collect(stdout).strip().splitlines()
        result = [json.loads(line) for line in lines]
        assert result == [{"a": 5}, {"a": 10}]


class TestJqDiskBackend:

    def _disk_ws(self, tmp_path, files):
        from mirage.resource.disk.disk import DiskResource
        for name, data in files.items():
            fp = tmp_path / name.lstrip("/")
            fp.parent.mkdir(parents=True, exist_ok=True)
            fp.write_bytes(data)
        disk = DiskResource(str(tmp_path))
        from mirage.workspace import Workspace
        return Workspace(
            {"/disk": (disk, MountMode.WRITE)},
            mode=MountMode.WRITE,
        )

    def test_single_path(self, tmp_path):
        ws = self._disk_ws(tmp_path, {"/f.json": b'{"val": 42}'})
        stdout, _ = run_raw(ws, "jq .val /disk/f.json")
        result = json.loads(collect(stdout))
        assert result == 42

    def test_stdin_bytes(self, tmp_path):
        ws = self._disk_ws(tmp_path, {})
        stdout, _ = run_raw(ws, "jq .x", stdin=b'{"x": "disk-stdin"}')
        result = json.loads(collect(stdout))
        assert result == "disk-stdin"

    def test_nested_key(self, tmp_path):
        ws = self._disk_ws(tmp_path, {"/f.json": b'{"a": {"b": 99}}'})
        stdout, _ = run_raw(ws, "jq .a.b /disk/f.json")
        result = json.loads(collect(stdout))
        assert result == 99

    def test_array_iteration(self, tmp_path):
        ws = self._disk_ws(tmp_path, {"/f.json": b'{"items": [10, 20, 30]}'})
        stdout, _ = run_raw(ws, "jq '.items[]' /disk/f.json")
        lines = collect(stdout).strip().splitlines()
        result = [json.loads(line) for line in lines]
        assert result == [10, 20, 30]

    def test_pipe_length(self, tmp_path):
        ws = self._disk_ws(tmp_path, {"/f.json": b'[1, 2, 3, 4]'})
        stdout, _ = run_raw(ws, "jq '. | length' /disk/f.json")
        result = json.loads(collect(stdout))
        assert result == 4

    def test_file_not_found(self, tmp_path):
        ws = self._disk_ws(tmp_path, {})
        _, io = run_raw(ws, "jq . /disk/missing.json")
        assert io.exit_code != 0

    def test_spread_iteration(self, tmp_path):
        ws = self._disk_ws(tmp_path, {"/f.json": b'[1, 2, 3]'})
        stdout, _ = run_raw(ws, "jq '.[]' /disk/f.json")
        lines = collect(stdout).strip().splitlines()
        result = [json.loads(line) for line in lines]
        assert result == [1, 2, 3]

    def test_no_spread_dot_array(self, tmp_path):
        ws = self._disk_ws(tmp_path, {"/f.json": b'[1, 2, 3]'})
        stdout, _ = run_raw(ws, "jq '.' /disk/f.json")
        result = json.loads(collect(stdout))
        assert result == [1, 2, 3]

    def test_spread_raw(self, tmp_path):
        ws = self._disk_ws(tmp_path, {"/f.json": b'["aa", "bb"]'})
        stdout, _ = run_raw(ws, "jq -r '.[]' /disk/f.json")
        output = collect(stdout).decode()
        assert output == "aa\nbb\n"


class TestJqS3Backend:

    def _s3_ws(self):
        from mirage.resource.s3.s3 import S3Config, S3Resource
        from mirage.workspace import Workspace
        config = S3Config(bucket="test-bucket", region="us-east-1")
        s3 = S3Resource(config)
        return Workspace(
            {"/s3": (s3, MountMode.READ)},
            mode=MountMode.READ,
        )

    def test_stdin_bytes(self):
        ws = self._s3_ws()
        stdout, _ = run_raw(ws, "jq .key", stdin=b'{"key": "s3-stdin"}')
        result = json.loads(collect(stdout))
        assert result == "s3-stdin"

    def test_stdin_dot(self):
        ws = self._s3_ws()
        data = {"a": 1, "b": [2, 3]}
        stdout, _ = run_raw(ws, "jq .", stdin=json.dumps(data).encode())
        result = json.loads(collect(stdout))
        assert result == data

    def test_stdin_length(self):
        ws = self._s3_ws()
        stdout, _ = run_raw(ws, "jq length", stdin=b'[1, 2, 3]')
        result = json.loads(collect(stdout))
        assert result == 3

    def _run_jq_path(self, data, expr):
        ops = CommandIO(readdir=None,
                        read_bytes=partial(_const_bytes, data),
                        read_stream=None,
                        stat=None,
                        is_mounted=lambda a: True,
                        local=False)
        path = PathSpec(resource_path="s3/data.json",
                        virtual="/s3/data.json",
                        directory="/s3",
                        resolved=True)
        return asyncio.run(
            _collect_jq(ops, S3Accessor.__new__(S3Accessor), [path], expr))

    def test_path_with_mock(self):
        out = self._run_jq_path(b'{"name": "from-s3"}', ".name")
        assert json.loads(out) == "from-s3"

    def test_path_array_iteration_mock(self):
        out = self._run_jq_path(b'[{"id": 1}, {"id": 2}]', ".[].id")
        result = [json.loads(line) for line in out.strip().splitlines()]
        assert result == [1, 2]

    def test_path_pipe_length_mock(self):
        out = self._run_jq_path(b'{"items": [1, 2, 3]}', ".items | length")
        assert json.loads(out) == 3

    def test_spread_iteration_mock(self):
        out = self._run_jq_path(b'[10, 20, 30]', ".[]")
        result = [json.loads(line) for line in out.strip().splitlines()]
        assert result == [10, 20, 30]

    def test_no_spread_dot_mock(self):
        out = self._run_jq_path(b'[10, 20, 30]', ".")
        assert json.loads(out) == [10, 20, 30]

    def test_spread_stdin(self):
        ws = self._s3_ws()
        stdout, _ = run_raw(ws, "jq '.[]'", stdin=b'[1, 2, 3]')
        lines = collect(stdout).strip().splitlines()
        result = [json.loads(line) for line in lines]
        assert result == [1, 2, 3]

    def test_no_spread_dot_stdin(self):
        ws = self._s3_ws()
        stdout, _ = run_raw(ws, "jq '.'", stdin=b'[1, 2, 3]')
        result = json.loads(collect(stdout))
        assert result == [1, 2, 3]

    def test_disk_multiple_paths(self, tmp_path):
        from mirage.resource.disk.disk import DiskResource
        from mirage.workspace import Workspace
        (tmp_path / "a.json").write_bytes(b'{"x": 1}')
        (tmp_path / "b.json").write_bytes(b'{"x": 2}')
        disk = DiskResource(str(tmp_path))
        ws = Workspace(
            {"/disk": (disk, MountMode.WRITE)},
            mode=MountMode.WRITE,
        )
        stdout, _ = run_raw(ws, "jq .x /disk/a.json /disk/b.json")
        raw = collect(stdout).decode()
        assert "1" in raw
        assert "2" in raw
