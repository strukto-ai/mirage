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

from mirage.core.hierarchy.codec import INT_JSON, JSON_NAME, JSONL_NAME
from mirage.core.hierarchy.scope import Scope, Slot, make_detect_scope
from mirage.types import ContentType

TOP_LEVEL_DIRS = ["traces", "sessions", "prompts", "datasets"]

# One description of the tree: readdir, stat and read all classify
# through it, so they cannot disagree about what a path means.
SCOPES = (
    Scope(kind="traces", segments=("traces",), probed=False),
    Scope(
        kind="trace",
        segments=("traces", Slot("trace_id", JSON_NAME)),
        leaf=True,
        filetype=ContentType.JSON,
    ),
    Scope(kind="sessions", segments=("sessions",), probed=False),
    Scope(kind="session", segments=("sessions", Slot("session_id"))),
    Scope(
        kind="session_trace",
        segments=("sessions", Slot("session_id"), Slot("trace_id", JSON_NAME)),
        leaf=True,
        filetype=ContentType.JSON,
    ),
    Scope(kind="prompts", segments=("prompts",), probed=False),
    Scope(kind="prompt", segments=("prompts", Slot("prompt_name"))),
    # A version that is not a plain ASCII integer cannot name a prompt
    # version, so it fails the scope match and reads as ENOENT instead
    # of an int() crash (python) or a digit-prefix guess (typescript).
    Scope(
        kind="prompt_version",
        segments=("prompts", Slot("prompt_name"), Slot("version", INT_JSON)),
        leaf=True,
        filetype=ContentType.JSON,
    ),
    Scope(kind="datasets", segments=("datasets",), probed=False),
    Scope(kind="dataset", segments=("datasets", Slot("dataset_name"))),
    Scope(
        kind="dataset_items",
        segments=("datasets", Slot("dataset_name"), "items.jsonl"),
        leaf=True,
        filetype=ContentType.TEXT,
    ),
    Scope(kind="runs", segments=("datasets", Slot("dataset_name"), "runs")),
    Scope(
        kind="dataset_run",
        segments=(
            "datasets",
            Slot("dataset_name"),
            "runs",
            Slot("run_name", JSONL_NAME),
        ),
        leaf=True,
        filetype=ContentType.TEXT,
    ),
)

detect_scope = make_detect_scope(SCOPES)
