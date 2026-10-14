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

from mirage.vfs.ssh.config import SSHConfig
from mirage.vfs.ssh.ssh import SSHVFS


def test_two_logins_to_one_root_are_one_store():
    def location(username: str, root: str) -> str | None:
        config = SSHConfig(host="box", username=username, root=root)
        return SSHVFS(config).storage_location()

    assert location("ada", "/srv/data") == location("bob", "/srv/data/")
    assert location("ada", "/srv/data") != location("ada", "/srv")
