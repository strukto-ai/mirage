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

from mirage.core.jq.eval import has_top_level_spread, jq_eval
from mirage.core.jq.format import JQ_EMPTY, format_jq_output
from mirage.core.jq.stream import (eval_jsonl_stream, is_jsonl_path,
                                   is_streamable_jsonl_expr, parse_json_auto,
                                   parse_json_docs, parse_json_path,
                                   parse_jsonl)

__all__ = [
    "JQ_EMPTY",
    "eval_jsonl_stream",
    "format_jq_output",
    "has_top_level_spread",
    "is_jsonl_path",
    "is_streamable_jsonl_expr",
    "jq_eval",
    "parse_json_auto",
    "parse_json_docs",
    "parse_json_path",
    "parse_jsonl",
]
