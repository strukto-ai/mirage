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

from mirage.policy.match.allow import head_allowed, line_tokens
from mirage.policy.match.decide import decide
from mirage.policy.match.pattern import pattern_matches, split_pattern
from mirage.policy.match.reads import has_rules, reads_args, scopes_paths
from mirage.policy.match.rule import (
    io_reach,
    io_refusal,
    op_ruling,
    operand_paths,
    posix_level,
    skipped_at_dispatch,
    target_directory,
)
from mirage.policy.types import Outcome, Ruling

__all__ = [
    "Outcome",
    "Ruling",
    "decide",
    "has_rules",
    "head_allowed",
    "io_reach",
    "io_refusal",
    "line_tokens",
    "op_ruling",
    "operand_paths",
    "pattern_matches",
    "posix_level",
    "reads_args",
    "scopes_paths",
    "skipped_at_dispatch",
    "split_pattern",
    "target_directory",
]
