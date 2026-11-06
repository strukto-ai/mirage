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
    """Resolve exponent numbers, and leave a timestamp a string, as
    TypeScript's YAML 1.2 loader does.

    The remaining PyYAML resolvers stay unchanged, and this subclass
    leaves ``yaml.safe_load`` untouched for other consumers.
    """


# YAML 1.2 has no timestamp type: `system_time: 2026-03-02T09:00:00Z`
# stays the text it was written as.
_YamlLoader.yaml_implicit_resolvers = {
    first: [
        (tag, regexp)
        for tag, regexp in resolvers
        if tag != "tag:yaml.org,2002:timestamp"
    ]
    for first, resolvers in yaml.SafeLoader.yaml_implicit_resolvers.items()
}


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


OCTAL = re.compile(r"^0o[0-7]+$")


class _YamlDumper(yaml.SafeDumper):
    """Quote every string that either host's loader would read as
    something else, so YAML written by one reads back the same on both.

    The loader's resolvers, plus YAML 1.2's ``0o`` octal, which
    TypeScript reads as a number.
    """


_YamlDumper.yaml_implicit_resolvers = {
    first: list(resolvers)
    for first, resolvers in _YamlLoader.yaml_implicit_resolvers.items()
}
_YamlDumper.add_implicit_resolver("tag:yaml.org,2002:int", OCTAL, ["0"])


def dump_yaml(obj: Any) -> str:
    """Write YAML that ``parse_yaml`` and TypeScript's loader both read
    back as ``obj``.

    Args:
        obj (Any): plain data.

    Returns:
        str: the YAML document.
    """
    text: str = yaml.dump(
        obj, Dumper=_YamlDumper, sort_keys=False, allow_unicode=True
    )
    return text
