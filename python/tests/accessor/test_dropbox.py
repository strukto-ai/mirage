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

import pytest

from mirage.accessor.dropbox import (DropboxAccessor,
                                     normalize_dropbox_root_path)
from mirage.core.dropbox._client import DropboxTokenManager
from mirage.resource.dropbox.config import DropboxConfig


def test_root_spellings_map_to_empty_api_path():
    assert normalize_dropbox_root_path(None) == ""
    assert normalize_dropbox_root_path("") == ""
    assert normalize_dropbox_root_path("/") == ""
    assert normalize_dropbox_root_path("//") == ""
    assert normalize_dropbox_root_path(".") == ""


def test_subfolder_paths_normalize_without_trailing_slash():
    assert normalize_dropbox_root_path("Team/data") == "/Team/data"
    assert normalize_dropbox_root_path("/Team/data") == "/Team/data"
    assert normalize_dropbox_root_path("/Team/data/") == "/Team/data"
    assert normalize_dropbox_root_path("Team//./data") == "/Team/data"


def test_dotdot_segments_rejected():
    with pytest.raises(ValueError, match="'\\.\\.'"):
        normalize_dropbox_root_path("/Team/../other")
    with pytest.raises(ValueError, match="'\\.\\.'"):
        normalize_dropbox_root_path("..")


def test_accessor_defaults_to_account_root():
    config = DropboxConfig(client_id="c", client_secret="s", refresh_token="r")
    accessor = DropboxAccessor(config, DropboxTokenManager(config))
    assert accessor.root_path == ""


def test_accessor_stores_normalized_root_path():
    config = DropboxConfig(client_id="c",
                           client_secret="s",
                           refresh_token="r",
                           root_path="Team/data/")
    accessor = DropboxAccessor(config, DropboxTokenManager(config))
    assert accessor.root_path == "/Team/data"
