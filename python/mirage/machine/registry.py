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

import importlib
from collections.abc import Mapping
from typing import Any

from mirage.machine.handle import MachineHandle

# Providers resolve on first use. Some provider SDKs are heavy (the
# daytona client alone pulls in opentelemetry), and importing them
# eagerly would put that cost on every `import mirage`, so the table
# holds module paths and imports the class only when a machine is built.
MACHINE_MODULES: dict[str, str] = {
    "apple_container": "mirage.machine.apple_container:AppleContainerMachine",
    "boxd": "mirage.machine.boxd:BoxdMachine",
    "cloudflare_container": "mirage.machine.cloudflare_container:ContainerMachine",
    "daytona": "mirage.machine.daytona:DaytonaMachine",
    "docker": "mirage.machine.docker:DockerMachine",
    "e2b": "mirage.machine.e2b:E2BMachine",
    "kubernetes": "mirage.machine.kubernetes:KubernetesMachine",
    "microsandbox": "mirage.machine.microsandbox:MicrosandboxMachine",
    "smolvm": "mirage.machine.smolvm:SmolvmMachine",
    "ssh": "mirage.machine.ssh:SSHMachine",
}


def known_providers() -> list[str]:
    """Every provider a ``machines:`` entry may name."""
    return sorted(MACHINE_MODULES)


def machine_class(provider: str) -> type[MachineHandle]:
    """The handle class a provider names, importing its module on first
    use.

    Args:
        provider (str): a provider from MACHINE_MODULES.

    Raises:
        ValueError: an unknown provider.
    """
    if provider not in MACHINE_MODULES:
        known = ", ".join(repr(p) for p in known_providers())
        raise ValueError(
            f"unknown machine provider: {provider!r} (expected one of {known})"
        )
    module_path, attr = MACHINE_MODULES[provider].split(":")
    cls: type[MachineHandle] = getattr(
        importlib.import_module(module_path), attr
    )
    return cls


def build_machine(
    name: str, spec: MachineHandle | Mapping[str, Any]
) -> MachineHandle:
    """The machine one ``machines:`` entry describes: a handle as given,
    or its ``provider`` built with the entry's other keys as its config.
    Mirrors TypeScript's ``buildMachine``.

    Args:
        name (str): the entry's name.
        spec (MachineHandle | Mapping[str, Any]): a handle, or the
            entry as YAML spells it.

    Raises:
        ValueError: a handle under another name, an entry without a
            provider, or an unknown provider.
    """
    if isinstance(spec, MachineHandle):
        if spec.name != name:
            raise ValueError(
                f"machine {name!r} is a handle named {spec.name!r}"
            )
        return spec
    fields = dict(spec)
    provider = fields.pop("provider", None)
    if not isinstance(provider, str) or not provider:
        raise ValueError(f"machine {name!r} needs a provider")
    return machine_class(provider)(name, fields)
