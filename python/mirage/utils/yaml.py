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

import re
from typing import Any

import yaml


class _YamlLoader(yaml.SafeLoader):
    """Resolve exponent numbers as TypeScript's YAML 1.2 loader does.

    The remaining PyYAML resolvers stay unchanged, and this subclass
    leaves ``yaml.safe_load`` untouched for other consumers.
    """


_YamlLoader.add_implicit_resolver(
    "tag:yaml.org,2002:float",
    re.compile(r"^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)[eE][+-]?[0-9]+$"),
    list("+-0123456789."),
)


def parse_yaml(text: str) -> Any:
    """Parse config scalars identically for validation and CLI transport.

    Args:
        text (str): Workspace YAML or JSON document.
    """
    return yaml.load(text, Loader=_YamlLoader)
