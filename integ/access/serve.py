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
"""The deployed Python server: ``build_app()`` under uvicorn.

Every setting comes from the environment, as in a deployment: auth from
``MIRAGE_AUTH_MODE`` and its keys, SSH from ``MIRAGE_SSH_*``, and the
snapshot store an operator passes ``build_app`` from
``ACCESS_SNAPSHOT_STORE`` (an ``S3Config`` as JSON). Run as
``python integ/access/serve.py PORT``.
"""

import json
import os
import sys

import uvicorn

from mirage.server.app import build_app
from mirage.vfs.s3.config import S3Config

store = os.environ.get("ACCESS_SNAPSHOT_STORE")
app = build_app(
    snapshot_store=S3Config(**json.loads(store)) if store else None
)
uvicorn.run(app, host="127.0.0.1", port=int(sys.argv[1]), log_level="warning")
