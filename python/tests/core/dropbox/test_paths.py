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

from mirage.accessor.dropbox import DropboxAccessor
from mirage.core.dropbox._client import DropboxTokenManager
from mirage.core.dropbox.paths import dropbox_path_of
from mirage.resource.dropbox.config import DropboxConfig
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key


def make_accessor(root_path: str = "/") -> DropboxAccessor:
    config = DropboxConfig(client_id="c",
                           client_secret="s",
                           refresh_token="r",
                           root_path=root_path)
    return DropboxAccessor(config, DropboxTokenManager(config))


def test_account_root_maps_to_empty_path():
    assert dropbox_path_of(make_accessor(), PathSpec.from_str_path("/")) == ""


def test_subfolder_root_prefixes_api_path():
    assert dropbox_path_of(make_accessor("/Team/data"),
                           PathSpec.from_str_path("/a.txt")) == \
        "/Team/data/a.txt"


def test_mount_prefix_is_stripped():
    spec = PathSpec(virtual="/dropbox/docs/a.txt",
                    directory="/dropbox/docs",
                    resource_path=mount_key("/dropbox/docs/a.txt", "/dropbox"))
    assert dropbox_path_of(make_accessor(), spec) == "/docs/a.txt"
