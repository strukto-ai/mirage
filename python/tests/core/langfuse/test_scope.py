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

from mirage.core.langfuse.scope import detect_scope
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key


def test_root_path():
    scope = detect_scope("/")
    assert scope.level == "root"


def test_traces_dir():
    scope = detect_scope("/traces")
    assert scope.level == "traces"
    assert scope.resource_type == "traces"


def test_traces_file():
    scope = detect_scope("/traces/abc.json")
    assert scope.level == "file"
    assert scope.resource_type == "traces"
    assert scope.resource_id == "abc"


def test_sessions_dir():
    scope = detect_scope("/sessions")
    assert scope.level == "sessions"
    assert scope.resource_type == "sessions"


def test_sessions_id():
    scope = detect_scope("/sessions/sid1")
    assert scope.level == "sessions"
    assert scope.resource_type == "sessions"
    assert scope.resource_id == "sid1"


def test_sessions_trace_file():
    scope = detect_scope("/sessions/sid1/tid1.json")
    assert scope.level == "file"
    assert scope.resource_type == "sessions"
    assert scope.resource_id == "sid1"


def test_prompts_dir():
    scope = detect_scope("/prompts")
    assert scope.level == "prompts"
    assert scope.resource_type == "prompts"


def test_prompts_name():
    scope = detect_scope("/prompts/summarize")
    assert scope.level == "prompts"
    assert scope.resource_type == "prompts"
    assert scope.resource_id == "summarize"


def test_prompts_version_file():
    scope = detect_scope("/prompts/summarize/1.json")
    assert scope.level == "file"
    assert scope.resource_type == "prompts"
    assert scope.resource_id == "summarize"


def test_datasets_dir():
    scope = detect_scope("/datasets")
    assert scope.level == "datasets"
    assert scope.resource_type == "datasets"


def test_datasets_name():
    scope = detect_scope("/datasets/qa-eval")
    assert scope.level == "datasets"
    assert scope.resource_type == "datasets"
    assert scope.resource_id == "qa-eval"


def test_glob_scope_root():
    gs = PathSpec(
        resource_path=mount_key("/langfuse/", "/langfuse"),
        virtual="/langfuse/",
        directory="/langfuse/",
        pattern=None,
        resolved=False,
    )
    scope = detect_scope(gs)
    assert scope.level == "root"


def test_glob_scope_traces():
    gs = PathSpec(
        resource_path=mount_key("/langfuse/traces", "/langfuse"),
        virtual="/langfuse/traces",
        directory="/langfuse/",
        pattern=None,
        resolved=False,
    )
    scope = detect_scope(gs)
    assert scope.level == "traces"
    assert scope.resource_type == "traces"


def test_glob_scope_file():
    gs = PathSpec(
        resource_path=mount_key("/langfuse/traces/abc.json", "/langfuse"),
        virtual="/langfuse/traces/abc.json",
        directory="/langfuse/traces/",
        pattern="*.json",
        resolved=True,
    )
    scope = detect_scope(gs)
    assert scope.level == "file"
    assert scope.resource_type == "traces"
    assert scope.resource_id == "abc"
