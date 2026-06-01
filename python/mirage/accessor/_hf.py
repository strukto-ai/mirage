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

import opendal

from mirage.accessor.base import Accessor
from mirage.resource.secrets import reveal_secret

HF_RESOURCES = ["hf_buckets", "hf_datasets", "hf_models", "hf_spaces"]


class _HfAccessor(Accessor):
    REPO_TYPE: str = ""

    def __init__(self, config) -> None:
        self.config = config

    def operator(self):
        kwargs = {
            "repo_type": self.REPO_TYPE,
            "repo_id": self._repo_id(),
        }
        token = reveal_secret(self.config.token)
        if token:
            kwargs["token"] = token
        endpoint = getattr(self.config, "endpoint", None)
        if endpoint:
            kwargs["endpoint"] = endpoint
        root = self._root()
        if root:
            kwargs["root"] = root
        revision = getattr(self.config, "revision", None)
        if revision:
            kwargs["revision"] = revision
        return opendal.AsyncOperator("hf", **kwargs)

    def _repo_id(self) -> str:
        return getattr(self.config, "repo_id", None) or self.config.bucket

    def _root(self) -> str | None:
        kp = getattr(self.config, "key_prefix", None)
        if not kp:
            return None
        return "/" + kp.strip("/") + "/"
