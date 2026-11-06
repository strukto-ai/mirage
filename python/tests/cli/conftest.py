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


@pytest.fixture
def home(tmp_path, monkeypatch):
    """A fresh mirage home with no context, workspace, URL, port or token
    from the environment."""
    monkeypatch.setenv("MIRAGE_HOME", str(tmp_path))
    for name in (
        "MIRAGE_CONTEXT",
        "MIRAGE_WORKSPACE",
        "MIRAGE_DAEMON_URL",
        "MIRAGE_DAEMON_PORT",
        "MIRAGE_TOKEN",
    ):
        monkeypatch.setenv(name, "")
    return tmp_path
