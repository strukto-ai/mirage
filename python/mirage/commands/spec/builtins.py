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

from dataclasses import replace

from mirage.commands.spec.builtin_specs import SPECS
from mirage.commands.spec.compile import compile_spec
from mirage.commands.spec.constants import HELP_OPTION, VERSION_OPTION
from mirage.commands.spec.types import CommandSpec


def help_spec(spec: CommandSpec) -> CommandSpec:
    """The spec plus whichever of --help / --version it does not declare.

    Mirrors GNU coreutils: every command accepts both, so both have to
    parse before a handler can short-circuit them. A command declaring
    either keeps its own.

    Args:
        spec (CommandSpec): the command's declared grammar.
    """
    extras = [
        option
        for option, spelling in (
            (HELP_OPTION, "--help"),
            (VERSION_OPTION, "--version"),
        )
        if not any(spelling in o.names for o in compile_spec(spec).options)
    ]
    if not extras:
        return spec
    return replace(spec, arguments=spec.arguments + tuple(extras))


# The builtin specs in the form the registry actually parses. Built once
# so there is ONE enriched object per builtin rather than one per
# backend that registers the command, which is what makes the identity
# test below a pointer compare instead of a field-by-field probe.
BUILTIN_HELP_SPECS: dict[str, CommandSpec] = {
    _spec_name: help_spec(_spec) for _spec_name, _spec in SPECS.items()
}


def registered_spec(name: str, spec: CommandSpec) -> CommandSpec:
    """The spec the registry parses for this command.

    ``help_spec``, except that a builtin gets the one shared copy rather
    than a fresh one per registration, so ``is_builtin_grammar`` can
    answer with a pointer compare. Every backend that registers `cat`
    therefore parses the same object.

    Args:
        name (str): command name as registered.
        spec (CommandSpec): the command's declared grammar.
    """
    if spec is SPECS.get(name):
        return BUILTIN_HELP_SPECS[name]
    return help_spec(spec)


def is_builtin_grammar(name: str, spec: CommandSpec | None) -> bool:
    """Whether ``spec`` is the builtin ``name``'s own grammar.

    The measured per-program rules (NO_LONG_OPTIONS,
    SOLE_ARGUMENT_LONG_OPTIONS, DIGIT_OPTIONS, LONG_SYNONYMS,
    IN_ORDER_OPERANDS, LETTER_OPTIONS) describe one real program, so a mount
    that registers its own command under a builtin's name must not
    inherit them: nothing refuses that registration, and `expr` is the
    sharp case, where the rule turns a declared `--mode=x` into an
    operand and the handler never sees the flag.

    A name is not an identity, and neither is the declared spec on its
    own: the registry parses an enriched COPY (config.py appends the two
    standard options), so both forms count and both are compared by
    object. A registered command passing the builtin's own spec is the
    builtin's grammar and does inherit the rule, which is the answer the
    name-keyed version got right by accident.

    Args:
        name (str): command name as invoked.
        spec (CommandSpec | None): the spec being parsed, or None when
            the caller has no registration to offer.
    """
    if spec is None:
        return False
    return spec is SPECS.get(name) or spec is BUILTIN_HELP_SPECS.get(name)
