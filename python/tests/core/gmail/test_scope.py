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

from mirage.core.gmail.scope import detect_scope
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
    assert scope.label_name is None


def test_root_with_prefix():
    scope = detect_scope(_gs("/gmail/", prefix="/gmail"))
    assert scope.use_native is True


def test_label_dir():
    scope = detect_scope(_gs("/gmail/INBOX", prefix="/gmail"))
    assert scope.use_native is True
    assert scope.label_name == "INBOX"
    assert scope.date_str is None


def test_label_date_dir():
    scope = detect_scope(_gs("/gmail/INBOX/2026-04-10", prefix="/gmail"))
    assert scope.use_native is True
    assert scope.label_name == "INBOX"
    assert scope.date_str == "2026-04-10"


def test_specific_message_file():
    scope = detect_scope(
        _gs("/gmail/INBOX/2026-04-10/Hello__abc123.gmail.json",
            prefix="/gmail"))
    assert scope.use_native is False
    assert scope.label_name == "INBOX"


def test_attachment_path():
    scope = detect_scope(
        _gs("/gmail/INBOX/2026-04-10/Hello__abc123/file.pdf", prefix="/gmail"))
    assert scope.use_native is False


def test_glob_in_date_dir():
    spec = PathSpec(
        resource_path=mount_key("/gmail/INBOX/2026-04-10/*.gmail.json",
                                "/gmail"),
        virtual="/gmail/INBOX/2026-04-10/*.gmail.json",
        directory="/gmail/INBOX/2026-04-10/",
        pattern="*.gmail.json",
        resolved=False,
    )
    scope = detect_scope(spec)
    assert scope.use_native is True
    assert scope.label_name == "INBOX"
    assert scope.date_str == "2026-04-10"
