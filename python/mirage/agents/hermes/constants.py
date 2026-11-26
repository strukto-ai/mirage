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

BACKEND = "mirage"
SESSION_PREFIX = "hermes-"
SETTING = "config"
SOURCE = "hermes"
ROUTED_SOURCES = frozenset({"env", SOURCE})

AMBIENT_VFS = {
    "ssh": "asyncssh reads ~/.ssh/config and the ssh-agent",
}
AMBIENT_MACHINES = {
    "ssh": "asyncssh reads ~/.ssh/config, the ssh-agent and default keys",
    "kubernetes": "kubectl reads ~/.kube/config",
}
KEYED_MACHINES = frozenset({"e2b", "daytona", "boxd"})
OAUTH_VFS = frozenset(
    {
        "gdrive",
        "gmail",
        "gcal",
        "gdocs",
        "gsheets",
        "gslides",
        "box",
        "dropbox",
    }
)
OAUTH_CLIS = frozenset({"gws"})
REFRESH_FIELDS = ("refresh_token", "client_secret")
OUTSIDE = (
    "code outside Mirage's own list, whose keys the plugin cannot vouch for"
)
LOCAL_SCHEMES = frozenset({"", "file", "db"})
LANCE_S3_KEYS = ("aws_access_key_id", "aws_secret_access_key")
MONGO_VFS = frozenset({"mongodb", "gridfs"})
AWS_MECHANISM = "MONGODB-AWS"
