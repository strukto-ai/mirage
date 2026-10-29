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

from mirage.policy.composition import Composition
from mirage.policy.types import CommandRule


def test_composition_rule_ids_use_hash_lookup_and_keep_first_instances(
    monkeypatch,
):
    comparisons = 0
    original_eq = CommandRule.__eq__

    def counted_eq(self, other):
        nonlocal comparisons
        comparisons += 1
        return original_eq(self, other)

    monkeypatch.setattr(CommandRule, "__eq__", counted_eq)
    rules = [CommandRule(reason=f"rule {index}") for index in range(256)]
    composition = Composition()
    try:
        assert [composition.rule_id(rule) for rule in rules] == list(
            range(256)
        )
        assert [
            composition.rule_id(CommandRule(reason=rule.reason))
            for rule in rules
        ] == list(range(256))
        assert all(
            first is rule for first, rule in zip(composition.rules, rules)
        )
        assert comparisons <= len(rules)
    finally:
        composition.close()
