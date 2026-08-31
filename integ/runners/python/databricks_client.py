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

import urllib.request
from urllib.parse import quote


# The one PUT the adapter has to send before mirage sees the mount, so the
# volume root exists. It lives with the python runner rather than with the
# fake, because the fake is a TypeScript kit service and this is the one
# piece of the old databricks_server.py that was never a server. The
# TypeScript host sends the same request from its own adapter.
def create_volume_root(base: str, token: str, remote_path: str) -> None:
    """Create a volume's root directory on the kit fake.

    Args:
        base (str): the fake's origin.
        token (str): the run's bearer token, which the fake reads as its
            tenant.
        remote_path (str): absolute /Volumes path to create.
    """
    url = f"{base.rstrip('/')}/api/2.0/fs/directories{quote(remote_path)}"
    request = urllib.request.Request(url, method="PUT")
    request.add_header("Authorization", f"Bearer {token}")
    urllib.request.urlopen(request).close()
