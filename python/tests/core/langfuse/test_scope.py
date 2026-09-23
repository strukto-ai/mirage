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

from mirage.core.langfuse.scope import SEARCH_KINDS, detect_scope
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key


def _spec(path: str) -> PathSpec:
    """A mount-relative operand, the way a command hands one to a scope.

    detect_scope declares PathSpec and reads only mount_path; passing the
    bare string relied on its isinstance fallback, which is the raw-string
    path CLAUDE.md forbids.
    """
    key = path.strip("/")
    return PathSpec(
        vfs_path=key,
        virtual="/langfuse/" + key,
        directory="/langfuse",
        pattern=None,
        resolved=True,
    )


def test_root_path():
    assert detect_scope(_spec("/")).kind == "root"


def test_traces_dir():
    assert detect_scope(_spec("/traces")).kind == "traces"


def test_traces_file():
    match = detect_scope(_spec("/traces/abc.json"))
    assert match.kind == "trace"
    assert match.slots == {"trace_id": "abc"}


def test_sessions_dir():
    assert detect_scope(_spec("/sessions")).kind == "sessions"


def test_sessions_id():
    match = detect_scope(_spec("/sessions/sid1"))
    assert match.kind == "session"
    assert match.slots == {"session_id": "sid1"}


def test_sessions_trace_file():
    match = detect_scope(_spec("/sessions/sid1/tid1.json"))
    assert match.kind == "session_trace"
    assert match.slots == {"session_id": "sid1", "trace_id": "tid1"}


def test_prompts_dir():
    assert detect_scope(_spec("/prompts")).kind == "prompts"


def test_prompts_name():
    match = detect_scope(_spec("/prompts/summarize"))
    assert match.kind == "prompt"
    assert match.slots == {"prompt_name": "summarize"}


def test_prompts_version_file():
    match = detect_scope(_spec("/prompts/summarize/1.json"))
    assert match.kind == "prompt_version"
    assert match.slots == {"prompt_name": "summarize", "version": "1"}


def test_prompts_version_must_be_an_integer():
    # int("abc") used to crash the read path; a non-numeric version now
    # fails the scope match and reads as ENOENT, matching typescript.
    assert detect_scope(
        _spec("/prompts/summarize/abc.json")).kind == ("invalid")


def test_datasets_dir():
    assert detect_scope(_spec("/datasets")).kind == "datasets"


def test_datasets_name():
    match = detect_scope(_spec("/datasets/qa-eval"))
    assert match.kind == "dataset"
    assert match.slots == {"dataset_name": "qa-eval"}


def test_glob_scope_root():
    gs = PathSpec(
        vfs_path=mount_key("/langfuse/", "/langfuse"),
        virtual="/langfuse/",
        directory="/langfuse/",
        pattern=None,
        resolved=False,
    )
    assert detect_scope(gs).kind == "root"


def test_glob_scope_traces():
    gs = PathSpec(
        vfs_path=mount_key("/langfuse/traces", "/langfuse"),
        virtual="/langfuse/traces",
        directory="/langfuse/",
        pattern=None,
        resolved=False,
    )
    assert detect_scope(gs).kind == "traces"


def test_glob_scope_file():
    gs = PathSpec(
        vfs_path=mount_key("/langfuse/traces/abc.json", "/langfuse"),
        virtual="/langfuse/traces/abc.json",
        directory="/langfuse/traces/",
        pattern="*.json",
        resolved=True,
    )
    match = detect_scope(gs)
    assert match.kind == "trace"
    assert match.slots == {"trace_id": "abc"}


def test_unrecognized_path_is_not_root():
    # Falling back to "root" made the grep/rg push-down treat any bogus path
    # as "search every trace", answering a missing file with the whole mount.
    assert detect_scope(_spec("__nf_missing__")).kind == "invalid"
    assert detect_scope(_spec("traces/a/b/c/d")).kind == "invalid"
    assert "invalid" not in SEARCH_KINDS


def test_leaves_fall_through_the_search_pushdown():
    # A leaf path must reach the generic per-file scan, never a
    # whole-container search.
    for path in ("/traces/abc.json", "/datasets/qa/items.jsonl",
                 "/datasets/qa/runs", "/datasets/qa/runs/r1.jsonl"):
        assert detect_scope(_spec(path)).kind not in SEARCH_KINDS
