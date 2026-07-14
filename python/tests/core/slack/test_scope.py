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

from mirage.core.slack.scope import coalesce_scopes, detect_scope
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key


def _gs(path: str,
        prefix: str = "",
        pattern: str | None = None,
        directory: str | None = None) -> PathSpec:
    return PathSpec(
        resource_path=mount_key(path, prefix),
        virtual=path,
        directory=directory
        or (path.rsplit("/", 1)[0] + "/" if "/" in path else "/"),
        pattern=pattern,
    )


def test_root_empty():
    scope = detect_scope(PathSpec.from_str_path("/"))
    assert scope.use_native is True
    assert scope.channel_name is None


def test_root_with_prefix():
    scope = detect_scope(_gs("/slack/", prefix="/slack"))
    assert scope.use_native is True


def test_channels_root():
    scope = detect_scope(_gs("/slack/channels", prefix="/slack"))
    assert scope.use_native is True
    assert scope.container == "channels"
    assert scope.channel_name is None


def test_channel_dir():
    scope = detect_scope(_gs("/slack/channels/general__C1", prefix="/slack"))
    assert scope.use_native is True
    assert scope.container == "channels"
    assert scope.channel_name == "general"
    assert scope.channel_id == "C1"


def test_channel_dm_dir():
    scope = detect_scope(_gs("/slack/dms/alice__D1", prefix="/slack"))
    assert scope.use_native is True
    assert scope.container == "dms"
    assert scope.channel_name == "alice"
    assert scope.channel_id == "D1"


def test_channel_glob_jsonl():
    spec = PathSpec(
        resource_path=mount_key("/slack/channels/general__C1/*/chat.jsonl",
                                "/slack"),
        virtual="/slack/channels/general__C1/*/chat.jsonl",
        directory="/slack/channels/general__C1/",
        pattern="*/chat.jsonl",
        resolved=False,
    )
    scope = detect_scope(spec)
    assert scope.use_native is True
    assert scope.channel_name == "general"
    assert scope.channel_id == "C1"


def test_specific_chat_jsonl():
    scope = detect_scope(
        _gs("/slack/channels/general__C1/2026-04-10/chat.jsonl",
            prefix="/slack"))
    assert scope.use_native is False
    assert scope.date_str == "2026-04-10"
    assert scope.channel_name == "general"
    assert scope.channel_id == "C1"


def test_users_dir_not_native():
    scope = detect_scope(_gs("/slack/users", prefix="/slack"))
    assert scope.use_native is False


def test_users_file_not_native():
    scope = detect_scope(_gs("/slack/users/alice__U1.json", prefix="/slack"))
    assert scope.use_native is False


def test_unknown_root_not_native():
    scope = detect_scope(_gs("/slack/whatever", prefix="/slack"))
    assert scope.use_native is False


def test_dirname_without_id():
    scope = detect_scope(_gs("/slack/channels/general", prefix="/slack"))
    assert scope.use_native is True
    assert scope.channel_name == "general"
    assert scope.channel_id is None


def _spec(path: str, prefix: str = "/slack") -> PathSpec:
    return PathSpec(resource_path=mount_key(path, prefix),
                    virtual=path,
                    directory=path)


def test_coalesce_concrete_jsonl_paths_same_channel():
    paths = [
        _spec(f"/slack/channels/general__C1/2026-01-{day:02d}/chat.jsonl")
        for day in range(1, 8)
    ]
    scope = coalesce_scopes(paths)
    assert scope is not None
    assert scope.use_native is True
    assert scope.channel_name == "general"
    assert scope.channel_id == "C1"
    assert scope.container == "channels"


def test_coalesce_returns_none_for_mixed_channels():
    paths = [
        _spec("/slack/channels/general__C1/2026-01-01/chat.jsonl"),
        _spec("/slack/channels/random__C2/2026-01-01/chat.jsonl"),
    ]
    assert coalesce_scopes(paths) is None


def test_coalesce_returns_none_for_mixed_containers():
    paths = [
        _spec("/slack/channels/general__C1/2026-01-01/chat.jsonl"),
        _spec("/slack/dms/alice__D1/2026-01-01/chat.jsonl"),
    ]
    assert coalesce_scopes(paths) is None


def test_coalesce_single_path_delegates_to_detect_scope():
    p = _spec("/slack/channels/general__C1/2026-01-01/chat.jsonl")
    scope = coalesce_scopes([p])
    assert scope is not None
    assert scope.use_native is True
    assert scope.channel_name == "general"


def test_coalesce_empty_list_returns_none():
    assert coalesce_scopes([]) is None


def test_date_dir():
    scope = detect_scope(
        _gs("/slack/channels/general__C1/2026-04-10", prefix="/slack"))
    assert scope.use_native is True
    assert scope.date_str == "2026-04-10"
    assert scope.channel_name == "general"
    assert scope.channel_id == "C1"
    assert scope.target == "date"


def test_files_dir():
    scope = detect_scope(
        _gs("/slack/channels/general__C1/2026-04-10/files", prefix="/slack"))
    assert scope.use_native is True
    assert scope.date_str == "2026-04-10"
    assert scope.target == "files"


def test_specific_file_blob():
    scope = detect_scope(
        _gs("/slack/channels/general__C1/2026-04-10/files/report__F1.pdf",
            prefix="/slack"))
    assert scope.use_native is False
    assert scope.date_str == "2026-04-10"
    assert scope.target == "files"
    assert scope.channel_name == "general"
    assert scope.channel_id == "C1"


def test_glob_files_in_day():
    spec = PathSpec(
        resource_path=mount_key(
            "/slack/channels/general__C1/2026-04-10/files/*.pdf", "/slack"),
        virtual="/slack/channels/general__C1/2026-04-10/files/*.pdf",
        directory="/slack/channels/general__C1/2026-04-10/files/",
        pattern="*.pdf",
        resolved=False,
    )
    scope = detect_scope(spec)
    assert scope.use_native is True
    assert scope.target == "files"


def test_chat_jsonl_target():
    scope = detect_scope(
        _gs("/slack/channels/general__C1/2026-04-10/chat.jsonl",
            prefix="/slack"))
    assert scope.target == "messages"


def test_depth3_non_date_falls_through():
    scope = detect_scope(
        _gs("/slack/channels/general__C1/notadate", prefix="/slack"))
    assert scope.use_native is False
    assert scope.target is None


def test_depth4_unknown_leaf_under_date_not_native():
    scope = detect_scope(
        _gs("/slack/channels/general__C1/2026-04-10/random.txt",
            prefix="/slack"))
    assert scope.use_native is False
    assert scope.target is None
