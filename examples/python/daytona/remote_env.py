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

import os

from daytona import Image

MIRAGE_GIT_SPEC = (
    "mirage-ai[s3] @ "
    "git+https://github.com/strukto-ai/mirage.git#subdirectory=python")


def remote_env() -> dict[str, str]:
    return {
        "AWS_S3_BUCKET": os.environ["AWS_S3_BUCKET"],
        "AWS_DEFAULT_REGION": os.environ.get("AWS_DEFAULT_REGION",
                                             "us-east-1"),
        "AWS_ACCESS_KEY_ID": os.environ["AWS_ACCESS_KEY_ID"],
        "AWS_SECRET_ACCESS_KEY": os.environ["AWS_SECRET_ACCESS_KEY"],
    }


def base_image() -> Image:
    return (Image.debian_slim("3.12").run_commands(
        "apt-get update "
        "&& apt-get install -y --no-install-recommends git "
        "&& rm -rf /var/lib/apt/lists/*").pip_install(MIRAGE_GIT_SPEC))


def fuse_image() -> Image:
    return (Image.debian_slim("3.12").run_commands(
        "apt-get update "
        "&& apt-get install -y --no-install-recommends "
        "    git fuse3 libfuse3-dev "
        "&& sed -i 's/^#user_allow_other/user_allow_other/' /etc/fuse.conf "
        "&& rm -rf /var/lib/apt/lists/*").pip_install(MIRAGE_GIT_SPEC))
