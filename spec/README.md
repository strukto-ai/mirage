# Command Spec Exports

One JSON file per builtin command per implementation, dumped from the live
registries. `python/general` is the Python surface; `typescript/node` and
`typescript/browser` are the two TypeScript package pairings (`core` + `node`,
`core` + `browser`).

Each file carries the parsed spec (description, epilog, options, positional
operands, rest operand, ignored tokens) plus a `_meta` block recording which
resources register the command and whether any registration carries a
provision, an aggregate, or the write flag.

`_meta.by_resource` keys those same facts by the registering resource. The
union flags cannot say *which* backend carries a provision, so dropping one
backend's provision while another keeps it leaves every union unchanged. The
parity check compares per resource for that reason, and falls back to the
unions only once the per-resource entries agree. Registrations with no
resource (the general commands) are keyed under the empty string.

```bash
# Regenerate
./python/.venv/bin/python scripts/gen_specs.py
node --experimental-strip-types typescript/scripts/gen-specs.ts

# Compare the two implementations
./python/.venv/bin/python scripts/check_spec_parity.py
```

## The two CI gates

`Spec drift` regenerates both trees and fails if the committed JSON moved,
so the checked-in surface always matches the code.

`Spec parity` runs `scripts/check_spec_parity.py`, which diffs Python against
TypeScript command by command: every option (including its help text, value
kind, repeatability and shorthand form), every operand, the resource set each
command registers under, and the per-resource metadata. Resources are compared
against the union of the `node` and `browser` variants, since Python has no
runtime split.

Divergences that are structural rather than bugs live in
`parity_exceptions.json`:

- `resource_expansions` — one implementation registers a command once for a
  name that stands for several resource kinds. Python's HF commands declare
  `hf_buckets` and the datasets/models/spaces resources rebind them at
  construction, where TypeScript names all four up front.
- `language_only_resources` — a backend that exists in only one runtime, such
  as the browser's OPFS.
- `commands` — per-command exemptions. `fields` mutes a whole top-level field;
  `by_resource` names one resource and one metadata key, so an exemption
  cannot quietly hide a second divergence on the same command.

The checker fails on a *stale* exception, so an entry cannot outlive the
divergence it documents. An exemption counts as used only when it actually
suppresses a live divergence, not merely by being listed.

## Keeping the dump complete

`gen-specs.ts` can only see command groups the package index re-exports, so it
asserts that every `*_COMMANDS` declared by a builtin command module is
reachable. A backend that defines commands but forgets the re-export used to
drop out of the dump silently; now generation fails.
