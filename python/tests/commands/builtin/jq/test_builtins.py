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

import pytest

from mirage.core.jq import jq_eval

from .conftest import eval_one


class TestJqType:

    def test_type_object(self):
        assert eval_one({"a": 1}, "type") == "object"

    def test_type_array(self):
        assert eval_one([1, 2], "type") == "array"

    def test_type_string(self):
        assert eval_one("hello", "type") == "string"

    def test_type_number_int(self):
        assert eval_one(42, "type") == "number"

    def test_type_number_float(self):
        assert eval_one(3.14, "type") == "number"

    def test_type_boolean(self):
        assert eval_one(True, "type") == "boolean"

    def test_type_null(self):
        assert eval_one(None, "type") == "null"


class TestJqFlatten:

    def test_flatten_nested(self):
        assert eval_one([[1, 2], [3, 4]], "flatten") == [1, 2, 3, 4]

    def test_flatten_mixed(self):
        assert eval_one([[1], 2, [3, 4]], "flatten") == [1, 2, 3, 4]

    def test_flatten_already_flat(self):
        assert eval_one([1, 2, 3], "flatten") == [1, 2, 3]

    def test_flatten_empty(self):
        assert eval_one([], "flatten") == []

    def test_flatten_non_list_raises(self):
        with pytest.raises(ValueError):
            eval_one("hello", "flatten")


class TestJqUnique:

    def test_unique_with_duplicates(self):
        assert eval_one([1, 2, 2, 3, 1], "unique") == [1, 2, 3]

    def test_unique_already_unique(self):
        assert eval_one([1, 2, 3], "unique") == [1, 2, 3]

    def test_unique_empty(self):
        assert eval_one([], "unique") == []

    def test_unique_strings(self):
        assert eval_one(["a", "b", "a"], "unique") == ["a", "b"]

    def test_unique_non_list_raises(self):
        with pytest.raises(ValueError):
            eval_one("hello", "unique")


class TestJqSort:

    def test_sort_numbers(self):
        assert eval_one([3, 1, 2], "sort") == [1, 2, 3]

    def test_sort_strings(self):
        assert eval_one(["c", "a", "b"], "sort") == ["a", "b", "c"]

    def test_sort_already_sorted(self):
        assert eval_one([1, 2, 3], "sort") == [1, 2, 3]

    def test_sort_empty(self):
        assert eval_one([], "sort") == []

    def test_sort_non_list_raises(self):
        with pytest.raises(ValueError):
            eval_one("hello", "sort")


class TestJqReverse:

    def test_reverse_list(self):
        assert eval_one([1, 2, 3], "reverse") == [3, 2, 1]

    def test_reverse_string_raises(self):
        with pytest.raises(ValueError):
            eval_one("hello", "reverse")

    def test_reverse_empty_list(self):
        assert eval_one([], "reverse") == []

    def test_reverse_single_element(self):
        assert eval_one([42], "reverse") == [42]


class TestJqNot:

    def test_not_true(self):
        assert eval_one(True, "not") is False

    def test_not_false(self):
        assert eval_one(False, "not") is True

    def test_not_none(self):
        assert eval_one(None, "not") is True

    def test_not_zero_is_false_in_jq(self):
        assert eval_one(0, "not") is False

    def test_not_nonempty_list(self):
        assert eval_one([1], "not") is False

    def test_not_empty_list_is_false_in_jq(self):
        assert eval_one([], "not") is False


class TestJqLiterals:

    def test_null(self):
        assert eval_one({"a": 1}, "null") is None

    def test_true(self):
        assert eval_one({}, "true") is True

    def test_false(self):
        assert eval_one({}, "false") is False

    def test_empty_produces_no_output(self):
        assert jq_eval({}, "empty") == []


class TestJqAddMinMax:

    def test_add_sum_array(self):
        assert eval_one([1, 2, 3], "add") == 6

    def test_add_concat_strings(self):
        assert eval_one(["a", "b", "c"], "add") == "abc"

    def test_add_empty_array(self):
        assert eval_one([], "add") is None

    def test_add_concat_arrays(self):
        assert eval_one([[1, 2], [3, 4]], "add") == [1, 2, 3, 4]

    def test_min(self):
        assert eval_one([3, 1, 2], "min") == 1

    def test_max(self):
        assert eval_one([3, 1, 2], "max") == 3

    def test_min_strings(self):
        assert eval_one(["b", "a", "c"], "min") == "a"

    def test_max_strings(self):
        assert eval_one(["b", "a", "c"], "max") == "c"

    def test_min_empty(self):
        assert eval_one([], "min") is None

    def test_max_empty(self):
        assert eval_one([], "max") is None


class TestJqFirstLastAnyAll:

    def test_first(self):
        assert eval_one([10, 20, 30], "first") == 10

    def test_last(self):
        assert eval_one([10, 20, 30], "last") == 30

    def test_any_true(self):
        assert eval_one([False, True, False], "any") is True

    def test_any_false(self):
        assert eval_one([False, False], "any") is False

    def test_all_true(self):
        assert eval_one([True, True], "all") is True

    def test_all_false(self):
        assert eval_one([True, False], "all") is False

    def test_any_empty(self):
        assert eval_one([], "any") is False

    def test_all_empty(self):
        assert eval_one([], "all") is True


class TestJqConversions:

    def test_to_number(self):
        assert eval_one("42", "tonumber") == 42

    def test_to_number_float(self):
        assert eval_one("3.14", "tonumber") == 3.14

    def test_tostring(self):
        assert eval_one(42, "tostring") == "42"

    def test_tostring_on_string(self):
        assert eval_one("hello", "tostring") == "hello"


class TestJqCsvTsv:

    def test_csv(self):
        result = eval_one(["a", "b", "c"], "@csv")
        assert result == '"a","b","c"'

    def test_tsv(self):
        result = eval_one(["a", "b", "c"], "@tsv")
        assert result == "a\tb\tc"

    def test_csv_with_numbers(self):
        result = eval_one([1, 2, 3], "@csv")
        assert result == "1,2,3"

    def test_tsv_with_numbers(self):
        result = eval_one([1, 2, 3], "@tsv")
        assert result == "1\t2\t3"

    def test_csv_non_list_raises(self):
        with pytest.raises(ValueError):
            eval_one("hello", "@csv")

    def test_tsv_non_list_raises(self):
        with pytest.raises(ValueError):
            eval_one("hello", "@tsv")


class TestJqFlattenRecursive:

    def test_flatten_recursive(self):
        assert eval_one([[[1, [2]], [3]], [4]], "flatten") == [1, 2, 3, 4]
