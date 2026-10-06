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

from mirage.policy.match.allow import (
    head_visible,
    line_allowed,
    line_tokens,
    node_visible,
)
from mirage.policy.match.decide import decide, outranks, rule_at, source_of
from mirage.policy.match.pattern import (
    pattern_matches,
    pattern_names,
    pattern_reaches,
    split_pattern,
)
from mirage.policy.match.reads import has_rules, reads_args, scopes_paths
from mirage.policy.match.rule import (
    RuleMatch,
    Subject,
    better_match,
    covers_depth,
    hidden_depth,
    io_reach,
    io_refusal,
    match_io,
    match_op,
    match_rule,
    matched_operand,
    op_reach,
    op_refusal,
    op_ruling,
    posix_level,
    rule_applies,
    rule_reach,
    rule_scope,
    skipped_at_op_doors,
    subjects,
)
from mirage.policy.types import Outcome, Ruling
from mirage.utils.hidden import anchor_depth

__all__ = [
    "Outcome",
    "RuleMatch",
    "Ruling",
    "Subject",
    "anchor_depth",
    "better_match",
    "covers_depth",
    "decide",
    "has_rules",
    "hidden_depth",
    "head_visible",
    "io_reach",
    "io_refusal",
    "line_allowed",
    "line_tokens",
    "match_io",
    "match_op",
    "match_rule",
    "matched_operand",
    "node_visible",
    "op_reach",
    "posix_level",
    "skipped_at_op_doors",
    "op_refusal",
    "op_ruling",
    "outranks",
    "pattern_matches",
    "pattern_names",
    "pattern_reaches",
    "reads_args",
    "rule_applies",
    "rule_at",
    "rule_reach",
    "rule_scope",
    "scopes_paths",
    "source_of",
    "split_pattern",
    "subjects",
]
