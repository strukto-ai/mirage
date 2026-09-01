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

from pydantic import BaseModel

from mirage.secrets.config import (AWSSMConfig, DotenvConfig, EnvConfig,
                                   OnePasswordConfig)

# Builtin fetchers are import paths, not imports, so a source's SDK
# loads only when a workspace actually uses it (`build_resource`'s
# trick: aws.py imports aioboto3, which is an extra). The config models
# are imported eagerly because config.py costs only pydantic.
BUILTINS: dict[str, tuple[type[BaseModel], str]] = {
    "env": (EnvConfig, "mirage.secrets.env:fetch_env"),
    "dotenv": (DotenvConfig, "mirage.secrets.dotenv:fetch_dotenv"),
    "aws-sm": (AWSSMConfig, "mirage.secrets.aws:fetch_aws_sm"),
    "1password":
    (OnePasswordConfig, "mirage.secrets.onepassword:fetch_onepassword"),
}
