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

from .conftest import EXAMPLE_JSON, EXAMPLE_JSONL, jq, jq_all, write_to_backend


class TestJqExampleJson:

    def _load(self, backend):
        write_to_backend(backend, "/tmp/example.json",
                         EXAMPLE_JSON.read_bytes())

    def test_top_level_keys(self, backend):
        self._load(backend)
        result = jq(backend, "/tmp/example.json", "keys")
        assert "company" in result
        assert "departments" in result
        assert "valuation" in result

    def test_company_name(self, backend):
        self._load(backend)
        result = jq(backend, "/tmp/example.json", ".company")
        assert result == "Strukto"

    def test_valuation(self, backend):
        self._load(backend)
        result = jq(backend, "/tmp/example.json", ".valuation")
        assert result == 45000000

    def test_department_count(self, backend):
        self._load(backend)
        result = jq(backend, "/tmp/example.json", ".departments | length")
        assert result == 3

    def test_department_names(self, backend):
        self._load(backend)
        result = jq_all(backend, "/tmp/example.json", ".departments[] | .name")
        assert "Engineering" in result
        assert "Product" in result

    def test_nested_team_names(self, backend):
        self._load(backend)
        result = jq_all(backend, "/tmp/example.json",
                        ".departments[0].teams[] | .name")
        assert "Platform" in result

    def test_deep_member_access(self, backend):
        self._load(backend)
        result = jq(backend, "/tmp/example.json",
                    ".departments[0].teams[0].lead")
        assert result == "Alice Chen"

    def test_select_high_budget(self, backend):
        self._load(backend)
        result = jq(backend, "/tmp/example.json",
                    ".departments[] | select(.budget > 2000000) | .name")
        assert "Engineering" in result

    def test_map_department_budgets(self, backend):
        self._load(backend)
        result = jq(backend, "/tmp/example.json",
                    ".departments | map(.budget)")
        assert isinstance(result, list)
        assert len(result) == 3
        assert all(isinstance(b, int) for b in result)

    def test_nested_array_slice(self, backend):
        self._load(backend)
        result = jq(backend, "/tmp/example.json",
                    ".departments[0].quarterly_spend | .[0:2]")
        assert len(result) == 2

    def test_keys_of_nested_object(self, backend):
        self._load(backend)
        result = jq(backend, "/tmp/example.json", ".metadata | keys")
        assert isinstance(result, list)

    def test_sort_by_budget(self, backend):
        self._load(backend)
        result = jq(backend, "/tmp/example.json",
                    ".departments | sort_by(.budget)")
        assert result[0]["budget"] <= result[-1]["budget"]

    def test_has_key(self, backend):
        self._load(backend)
        result = jq(backend, "/tmp/example.json", 'has("company")')
        assert result is True

    def test_type_of_departments(self, backend):
        self._load(backend)
        result = jq(backend, "/tmp/example.json", ".departments | type")
        assert result == "array"

    def test_contains_department(self, backend):
        self._load(backend)
        result = jq(backend, "/tmp/example.json",
                    'contains({"company": "Strukto"})')
        assert result is True


class TestJqExampleJsonl:

    def _load(self, backend):
        write_to_backend(backend, "/tmp/example.jsonl",
                         EXAMPLE_JSONL.read_bytes())

    def test_total_lines(self, backend):
        self._load(backend)
        result = jq(backend, "/tmp/example.jsonl", "length")
        assert result == 5766

    def test_all_have_type(self, backend):
        self._load(backend)
        result = jq(backend, "/tmp/example.jsonl", 'map(has("type"))')
        assert all(result)

    def test_unique_types(self, backend):
        self._load(backend)
        result = jq(backend, "/tmp/example.jsonl", "map(.type) | unique")
        assert "user" in result
        assert "assistant" in result
        assert "queue-operation" in result

    def test_select_queue_operations(self, backend):
        self._load(backend)
        result = jq_all(
            backend, "/tmp/example.jsonl",
            '.[] | select(.type == "queue-operation") | .operation')
        assert "enqueue" in result
        assert "dequeue" in result

    def test_first_entry_type(self, backend):
        self._load(backend)
        result = jq(backend, "/tmp/example.jsonl", "first | .type")
        assert result == "queue-operation"

    def test_last_entry_type(self, backend):
        self._load(backend)
        result = jq(backend, "/tmp/example.jsonl", "last | .type")
        assert isinstance(result, str)

    def test_count_user_messages(self, backend):
        self._load(backend)
        result = jq(backend, "/tmp/example.jsonl",
                    'map(select(.type == "user")) | length')
        assert result > 0

    def test_slice_first_five(self, backend):
        self._load(backend)
        result = jq(backend, "/tmp/example.jsonl", ".[0:5] | length")
        assert result == 5

    def test_map_type_length(self, backend):
        self._load(backend)
        result = jq(backend, "/tmp/example.jsonl", ".[0:3] | map(.type)")
        assert len(result) == 3
        assert all(isinstance(t, str) for t in result)

    def test_group_by_type_first_ten(self, backend):
        self._load(backend)
        result = jq(backend, "/tmp/example.jsonl", ".[0:10] | group_by(.type)")
        assert isinstance(result, list)
        assert all(isinstance(g, list) for g in result)
