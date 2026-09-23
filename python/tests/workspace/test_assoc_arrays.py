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

import asyncio

import pytest

from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace

# Every expectation is pinned against GNU bash 5.2.37 on
# debian:stable-slim, except where a case says otherwise: mirage walks
# an associative array in sorted-key order (GNU iterates its hash
# table, whose order is unpredictable), and a bare `declare -A m`
# prints `declare -A m=()` where GNU omits the value, the same
# spelling the indexed kind already answers with.
CASES = [
    ("elements_and_count", 'declare -A m; m[alpha]=1; m[beta]=2; '
     'echo "${m[alpha]}|${m[beta]}|${#m[@]}"', "1|2|2\n", "", 0),
    ("declare_p_sorted_trailing_space",
     "declare -A m=([b]=2 [a]=1); declare -p m",
     'declare -A m=([a]="1" [b]="2" )\n', "", 0),
    ("empty_literal_renders_parens", "declare -A m=(); declare -p m",
     "declare -A m=()\n", "", 0),
    ("pairs_literal", "declare -A m=(k1 v1 k2 v2); declare -p m",
     'declare -A m=([k1]="v1" [k2]="v2" )\n', "", 0),
    ("pairs_odd_tail_empty", "declare -A m=(k1 v1 k2); declare -p m",
     'declare -A m=([k1]="v1" [k2]="" )\n', "", 0),
    ("keyed_literal_refuses_plain_words",
     "declare -A m=([a]=1 b 2); declare -p m", 'declare -A m=([a]="1" )\n',
     "bash: m: 'b': must use subscript when assigning associative array\n"
     "bash: m: '2': must use subscript when assigning associative array\n", 0),
    ("splat_and_keys_sorted",
     'declare -A m=([c]=3 [a]=1 [b]=2); echo "${m[@]}"; echo "${!m[@]}"',
     "1 2 3\na b c\n", "", 0),
    ("key_is_not_arithmetic",
     'declare -A m=([2]=two); a=(zero one TWO); echo "|${m[1+1]}|${a[1+1]}|"',
     "||TWO|\n", "", 0),
    ("dollar_key_expands",
     'k=alpha; declare -A m; m[$k]=v; echo "${m[alpha]}|${m[$k]}"', "v|v\n",
     "", 0),
    ("quoted_key_unquotes", 'declare -A m; m["qk"]=v; declare -p m',
     'declare -A m=([qk]="v" )\n', "", 0),
    ("key_with_space_kept_verbatim",
     'declare -A m; m[two words]=v; echo "${m[two words]}"; declare -p m',
     'v\ndeclare -A m=(["two words"]="v" )\n', "", 0),
    ("element_append", 'declare -A m; m[k]=ab; m[k]+=cd; echo "${m[k]}"',
     "abcd\n", "", 0),
    ("literal_append_merges_last_wins",
     "declare -A m=([a]=1); m+=([b]=2 [a]=9); declare -p m",
     'declare -A m=([a]="9" [b]="2" )\n', "", 0),
    ("whole_assign_replaces", "declare -A m=([a]=1); m=([b]=2); declare -p m",
     'declare -A m=([b]="2" )\n', "", 0),
    ("scalar_assign_is_key_zero", "declare -A m=([a]=1); m=x; declare -p m",
     'declare -A m=([0]="x" [a]="1" )\n', "", 0),
    ("indexed_scalar_assign_keeps_tail", "a=(1 2); a=x; declare -p a",
     'declare -a a=([0]="x" [1]="2")\n', "", 0),
    ("unset_element", 'declare -A m=([a]=1 [b]=2); unset "m[a]"; declare -p m',
     'declare -A m=([b]="2" )\n', "", 0),
    ("unset_missing_element_quiet",
     'declare -A m=([a]=1); unset "m[zz]"; echo $?; declare -p m',
     '0\ndeclare -A m=([a]="1" )\n', "", 0),
    ("unset_at_is_noop",
     'declare -A m=([a]=1 [b]=2); unset "m[@]"; declare -p m',
     'declare -A m=([a]="1" [b]="2" )\n', "", 0),
    ("emptied_renders_parens",
     'declare -A m=([a]=1); unset "m[a]"; declare -p m', "declare -A m=()\n",
     "", 0),
    ("defaults_by_key_presence",
     'declare -A m=([a]=1); echo "|${m[zz]}|${m[zz]-d}|${m[zz]:-e}|"',
     "||d|e|\n", "", 0),
    ("empty_value_is_set",
     'declare -A m; m[k]=; echo "|${m[k]}|${m[k]-d}|${m[k]:-e}|${#m[@]}|"',
     "|||e|1|\n", "", 0),
    ("element_length_and_counts",
     'declare -A m=([a]=hello); echo "${#m[a]}|${#m[@]}|${#m}"', "5|1|0\n", "",
     0),
    ("per_element_ops",
     'declare -A m=([a]=xx1 [b]=xx2); echo "${m[@]#xx}"; echo "${m[a]%1}"',
     "1 2\nxx\n", "", 0),
    ("case_op_per_element",
     'declare -A m=([a]=hello); echo "${m[a]^^}|${m[@]^^}"', "HELLO|HELLO\n",
     "", 0),
    ("slice_over_sorted_values",
     'declare -A m=([a]=1 [b]=2 [c]=3); echo "${m[@]:0:2}"; '
     'echo "${m[@]: -1}"', "1 2\n3\n", "", 0),
    ("bare_dollar_is_key_zero",
     'declare -A m=([a]=1); echo "|$m|"; m[0]=z; echo "|$m|"', "||\n|z|\n", "",
     0),
    ("for_iterates_sorted_keys",
     'declare -A m=([b]=2 [a]=1); for k in "${!m[@]}"; '
     'do echo "$k=${m[$k]}"; done', "a=1\nb=2\n", "", 0),
    ("arith_literal_key", 'declare -A m=([abc]=7); x=abc; '
     'echo "$((m[x])) $((m[$x])) $((m[abc]))"', "0 7 7\n", "", 0),
    ("arith_nested_key_text", "declare -A m=([k5]=9); i=5; echo $((m[k$i]))",
     "9\n", "", 0),
    ("arith_quoted_key", 'declare -A m=([x]=3); echo $((m["x"]))', "3\n", "",
     0),
    ("arith_incr_and_assign",
     'declare -A m=([k]=5); ((m[k]++)); echo "${m[k]}|$((m[k]=9))|${m[k]}"',
     "6|9|9\n", "", 0),
    ("arith_missing_reads_zero",
     'declare -A m; ((m[k]--)); echo "${m[k]}"; declare -p m',
     '-1\ndeclare -A m=([k]="-1" )\n', "", 0),
    ("arith_readonly_refused_nonfatal",
     'readonly -A r=([k]=1); ((r[k]++)); echo "after=$?"; declare -p r',
     'after=1\ndeclare -Ar r=([k]="1" )\n', "bash: r: readonly variable\n", 0),
    ("test_v_key_membership", 'declare -A m=([k]=v); [[ -v m[k] ]]; echo $?; '
     '[[ -v m[zz] ]]; echo $?; test -v "m[k]"; echo $?', "0\n1\n0\n", "", 0),
    ("test_v_bare_checks_key_zero",
     "declare -A m=([a]=1); [[ -v m ]]; echo $?; m[0]=z; [[ -v m ]]; echo $?",
     "1\n0\n", "", 0),
    ("scalar_converts_to_key_zero", "s=5; declare -A s; declare -p s",
     'declare -A s=([0]="5" )\n', "", 0),
    ("indexed_conversion_refused",
     "a=(1 2); declare -A a; echo rc=$?; declare -p a",
     'rc=1\ndeclare -a a=([0]="1" [1]="2")\n',
     "bash: declare: a: cannot convert indexed to associative array\n", 0),
    ("assoc_to_indexed_refused",
     "declare -A m=([a]=1); declare -a m; echo rc=$?; declare -p m",
     'rc=1\ndeclare -A m=([a]="1" )\n',
     "bash: declare: m: cannot convert associative to indexed array\n", 0),
    ("empty_subscript_fatal", "e=; declare -A m; m[$e]=v; echo unreached", "",
     "bash: m[$e]: bad array subscript\n", 1),
    ("local_A_shadows", 'f(){ local -A m=([k]=inner); echo "${m[k]}"; }; '
     'declare -A m=([k]=outer); f; echo "${m[k]}"', "inner\nouter\n", "", 0),
    ("readonly_A_renders_Ar", "readonly -A r2=([k]=v); declare -p r2",
     'declare -Ar r2=([k]="v" )\n', "", 0),
    ("export_A_renders_Ax_env_excluded",
     "declare -Ax m=([k]=v); declare -p m; env | grep -c '^m=' || true",
     'declare -Ax m=([k]="v" )\n0\n', "", 0),
    ("read_into_element", 'declare -A m; read "m[k]" <<< hello; declare -p m',
     'declare -A m=([k]="hello" )\n', "", 0),
    ("printf_v_element",
     'declare -A m; printf -v "m[k]" "%s" hi; declare -p m',
     'declare -A m=([k]="hi" )\n', "", 0),
    ("special_keys_quoted_in_declare_p",
     'declare -A m; k1=@; k2="*"; m[$k1]=at; m[$k2]=star; declare -p m',
     'declare -A m=(["*"]="star" ["@"]="at" )\n', "", 0),
    ("indexed_literal_subscripts", "a=([3]=x y [1]=z); declare -p a",
     'declare -a a=([1]="z" [3]="x" [4]="y")\n', "", 0),
    ("indexed_arith_lvalues",
     "a=(); ((a[2]=5)); echo $((a[0]=3)); declare -p a",
     '3\ndeclare -a a=([0]="3" [2]="5")\n', "", 0),
    ("indexed_subscript_dollar_read", 'k=1; a=(x y z); echo "${a[$k]}"', "y\n",
     "", 0),
]

# The declaration attributes, pinned the same way. `-i -l -u` shape a
# value at write time; `-t` and `-n` are stored and printed (nameref
# aliasing is not wired, see execute_node); `+attr` clears, with the
# two GNU refusals for the letters that cannot come off.
ATTR_CASES = [
    ("i_declared_value_coerces", 'declare -i n=3+4; echo "$n"; declare -p n',
     '7\ndeclare -i n="7"\n', "", 0),
    ("i_later_write_and_bad_word",
     'declare -i n; n=2*5; echo "$n"; n=hello; echo "|$n|"; declare -p n',
     '10\n|0|\ndeclare -i n="0"\n', "", 0),
    ("i_var_reference", 'x=6; declare -i n; n=x+1; echo "$n"; n="x * 2"; '
     'echo "$n"', "7\n12\n", "", 0),
    ("i_bad_expr_fatal", 'declare -i n; n=1+; echo unreached', "",
     "bash: 1+: syntax error: operand expected\n", 1),
    ("i_div_zero_fatal", 'declare -i n; n=1/0; echo unreached', "",
     "bash: 1/0: division by 0\n", 1),
    ("i_append_adds", 'declare -i n=5; n+=3; echo "$n"; declare -p n',
     '8\ndeclare -i n="8"\n', "", 0),
    ("i_plus_turns_off",
     'declare -i n=5; declare +i n; n=1+1; echo "$n"; declare -p n',
     '1+1\ndeclare -- n="1+1"\n', "", 0),
    ("i_existing_keeps_text", "v=2+2; declare -i v; echo \"$v\"; declare -p v",
     '2+2\ndeclare -i v="2+2"\n', "", 0),
    ("i_bare_stays_unset", 'declare -i n; declare -p n; echo "|${n-unset}|"',
     "declare -i n\n|unset|\n", "", 0),
    ("i_array_per_element",
     "declare -ai a=(1+1 2*3); declare -p a; a[2]=3+3; declare -p a",
     'declare -ai a=([0]="2" [1]="6")\n'
     'declare -ai a=([0]="2" [1]="6" [2]="6")\n', "", 0),
    ("i_local", 'f(){ local -i x=1+1; echo "$x"; }; f', "2\n", "", 0),
    ("i_export_cluster", 'declare -ix n=2+2; declare -p n; env | grep "^n="',
     'declare -ix n="4"\nn=4\n', "", 0),
    ("i_readonly_cluster", "declare -ir n=2+2; declare -p n; n=5; echo x",
     'declare -ir n="4"\n', "bash: n: readonly variable\n", 1),
    ("i_hex_octal_negative",
     'declare -i n; n=-3-4; echo "$n"; n=0x10; echo "$n"; n=010; echo "$n"',
     "-7\n16\n8\n", "", 0),
    ("i_prefix_assign_uncoerced", "declare -i n; n=1+1 printenv n", "1+1\n",
     "", 0),
    ("i_read_coerces", 'declare -i n; read n <<< "5+5"; echo "$n"', "10\n", "",
     0),
    ("i_printf_v_coerces", 'declare -i n; printf -v n "%s" "2*8"; echo "$n"',
     "16\n", "", 0),
    ("i_default_op_coerces", 'declare -i n; : "${n:=3+3}"; echo "$n"', "6\n",
     "", 0),
    ("i_read_bad_refuses", 'declare -i n; read n <<< "1+"; echo "rc=$? |$n|"',
     "rc=1 ||\n", "bash: read: 1+: syntax error: operand expected\n", 0),
    ("i_printf_bad_refuses",
     'declare -i n; printf -v n "%s" "1+"; echo "rc=$? |$n|"', "rc=1 ||\n",
     "bash: printf: 1+: syntax error: operand expected\n", 0),
    ("i_declare_bad_continues", 'declare -i n=1+; echo "rc=$? |$n|"',
     "rc=1 ||\n", "bash: declare: 1+: syntax error: operand expected\n", 0),
    ("i_via_export_and_readonly_kw",
     'declare -i n; export n=1+1; echo "$n"; declare -i m; readonly m=2+2; '
     'echo "$m"; declare -p n m',
     '2\n4\ndeclare -ix n="2"\ndeclare -ir m="4"\n', "", 0),
    ("i_typeset_alias", 'typeset -i n=9-2; echo "$n"', "7\n", "", 0),
    ("l_folds_on_write",
     'declare -l s=HeLLo; echo "$s"; s=WORLD; echo "$s"; declare -p s',
     'hello\nworld\ndeclare -l s="world"\n', "", 0),
    ("u_folds_and_appends",
     'declare -u s=hello; echo "$s"; s+=xyz; echo "$s"; declare -p s',
     'HELLO\nHELLOXYZ\ndeclare -u s="HELLOXYZ"\n', "", 0),
    ("l_existing_keeps_text", 'v=MiXeD; declare -l v; echo "$v"; declare -p v',
     'MiXeD\ndeclare -l v="MiXeD"\n', "", 0),
    ("lu_conflict_sets_neither",
     'declare -lu s=aBc; echo "$s"; declare -p s; declare -ul t=aBc; '
     'declare -p t', 'aBc\ndeclare -- s="aBc"\ndeclare -- t="aBc"\n', "", 0),
    ("l_then_u_displaces",
     'declare -l s=aBc; declare -u s; s=XyZ; echo "$s"; declare -p s',
     'XYZ\ndeclare -u s="XYZ"\n', "", 0),
    ("l_plus_turns_off",
     'declare -l s=abc; declare +l s; s=XyZ; echo "$s"; declare -p s',
     'XyZ\ndeclare -- s="XyZ"\n', "", 0),
    ("l_array_per_element",
     'declare -la a=(AB cD); declare -p a; a[2]=EF; echo "${a[2]}"',
     'declare -al a=([0]="ab" [1]="cd")\nef\n', "", 0),
    ("l_read_printf_default",
     'declare -l s; read s <<< "HeLLo"; echo "$s"; printf -v s "%s" "AbC"; '
     'echo "$s"; declare -l t; : "${t:=XYZ}"; echo "$t"', "hello\nabc\nxyz\n",
     "", 0),
    ("li_combo_order", 'declare -li n=1+1; echo "$n"; declare -p n',
     '2\ndeclare -il n="2"\n', "", 0),
    ("l_export_kw", 'declare -l s; export s=ABC; echo "$s"; declare -p s',
     'abc\ndeclare -xl s="abc"\n', "", 0),
    ("l_prefix_uncoerced", "declare -l s; s=ABC printenv s", "ABC\n", "", 0),
    ("u_local", 'f(){ local -u x=abc; echo "$x"; }; f', "ABC\n", "", 0),
    ("u_readonly_cluster", 'declare -ur s=abc; echo "$s"; declare -p s',
     'ABC\ndeclare -ru s="ABC"\n', "", 0),
    ("t_stored_and_printed", "declare -t v=1; declare -p v; declare +t v; "
     "declare -p v", 'declare -t v="1"\ndeclare -- v="1"\n', "", 0),
    ("n_stored_and_printed",
     "x=1; declare -n r=x; declare -p r; declare +n r; declare -p r",
     'declare -n r="x"\ndeclare -- r="x"\n', "", 0),
    ("plus_x_unexports",
     "export V=1; declare +x V; printenv V; echo rc=$?; declare -p V",
     'rc=1\ndeclare -- V="1"\n', "", 0),
    ("plus_r_refused", "readonly R=1; declare +r R; echo rc=$?; declare -p R",
     'rc=1\ndeclare -r R="1"\n', "bash: declare: R: readonly variable\n", 0),
    ("plus_a_refused", "a=(1); declare +a a; echo rc=$?; declare -p a",
     'rc=1\ndeclare -a a=([0]="1")\n',
     "bash: declare: a: cannot destroy array variables in this way\n", 0),
    ("plus_A_refused", "declare -A m=([k]=v); declare +A m; echo rc=$?",
     "rc=1\n",
     "bash: declare: m: cannot destroy array variables in this way\n", 0),
    ("plus_unknown_letter", "declare +q v; echo rc=$?", "rc=2\n",
     "bash: declare: +q: invalid option\n"
     "declare: usage: declare [-aAfFgiIlnrtux] [name[=value] ...] "
     "or declare -p [-aAfFilnrtux] [name ...]\n", 0),
    ("minus_unknown_letter", "declare -q v; echo rc=$?", "rc=2\n",
     "bash: declare: -q: invalid option\n"
     "declare: usage: declare [-aAfFgiIlnrtux] [name[=value] ...] "
     "or declare -p [-aAfFilnrtux] [name ...]\n", 0),
    ("plus_multi_letters", "declare -xi n=1; declare +xi n; declare -p n",
     'declare -- n="1"\n', "", 0),
    ("plus_creates_unset", "declare +x NEVER; echo rc=$?; declare -p NEVER",
     "rc=0\ndeclare -- NEVER\n", "", 0),
    ("plus_with_value_assigns",
     "export V=1; declare +x V=2; declare -p V; printenv V; echo rc=$?",
     'declare -- V="2"\nrc=1\n', "", 0),
    ("minus_plus_mix", "declare -i +x n=1+1; declare -p n",
     'declare -i n="2"\n', "", 0),
    ("plus_export_kw_refused", "export V=1; export +x V; echo rc=$?", "rc=1\n",
     "bash: export: `+x': not a valid identifier\n", 0),
    ("plus_readonly_kw_refused", "readonly +r R; echo rc=$?", "rc=1\n",
     "bash: readonly: `+r': not a valid identifier\n", 0),
    ("plus_p_is_print", "v=1; declare +p v; echo rc=$?",
     'declare -- v="1"\nrc=0\n', "", 0),
]

# `readonly -f`, `declare -f/-F/-rf`, and the `jobs` flags, pinned the
# same way. A frozen function refuses redefinition and unset in its own
# voice and keeps the old body. The `jobs` rows are mirage's own shape
# (`[N] status cmd`, table id where GNU prints a pid); the flags apply
# to that shape, and `-s` lists nothing because mirage jobs never stop.
FUNC_JOB_CASES = [
    ("rof_refuses_redefinition",
     'f(){ echo one; }; readonly -f f; f(){ echo two; }; echo rc=$?; f',
     "rc=1\none\n", "bash: f: readonly function\n", 0),
    ("rof_refuses_keyword_form",
     'f(){ echo one; }; readonly -f f; function f { echo two; }; '
     'echo rc=$?; f', "rc=1\none\n", "bash: f: readonly function\n", 0),
    ("rof_refuses_unset_f",
     'f(){ echo one; }; readonly -f f; unset -f f; echo rc=$?; f',
     "rc=1\none\n", "bash: unset: f: cannot unset: readonly function\n", 0),
    ("rof_refuses_unset_auto",
     'f(){ echo one; }; readonly -f f; unset f; echo rc=$?; f', "rc=1\none\n",
     "bash: unset: f: cannot unset: readonly function\n", 0),
    ("rof_not_a_function", "readonly -f nothere; echo rc=$?", "rc=1\n",
     "bash: readonly: nothere: not a function\n", 0),
    ("rof_lists_frozen", "f(){ :; }; g(){ :; }; readonly -f f; readonly -f",
     "declare -fr f\n", "", 0),
    ("rof_variable_untouched",
     'f(){ echo one; }; f=var; readonly -f f; f=other; echo "$f"', "other\n",
     "", 0),
    ("rof_two_names_both_freeze",
     "f(){ :; }; g(){ :; }; readonly -f f g; f(){ :; }; echo rc=$?; "
     "g(){ :; }; echo rc=$?", "rc=1\nrc=1\n",
     "bash: f: readonly function\nbash: g: readonly function\n", 0),
    ("rof_inherited_by_subshell",
     'f(){ echo one; }; readonly -f f; ( f(){ echo in; }; echo rc=$? ); f',
     "rc=1\none\n", "bash: f: readonly function\n", 0),
    ("declare_rf_freezes",
     'f(){ echo one; }; declare -rf f; f(){ echo two; }; echo rc=$?; f',
     "rc=1\none\n", "bash: f: readonly function\n", 0),
    ("declare_F_lists_and_names",
     "f(){ :; }; g(){ :; }; declare -F; declare -F f; echo rc=$?; "
     "declare -F nothere; echo rc=$?",
     "declare -f f\ndeclare -f g\nf\nrc=0\nrc=1\n", "", 0),
    ("declare_f_names_row",
     "h(){ :; }; declare -f h; echo rc=$?; declare -f nothere; echo rc=$?",
     "declare -f h\nrc=0\nrc=1\n", "", 0),
    ("jobs_r_running_only", "sleep 5 & echo hi & sleep 0.3; jobs -r",
     "[1] running sleep 5\n", "", 0),
    ("jobs_p_ids_only", "sleep 5 & sleep 5 & jobs -p", "1\n2\n", "", 0),
    ("jobs_l_id_column", "sleep 5 & jobs -l", "[1] 1 running sleep 5\n", "",
     0),
    ("jobs_s_lists_nothing", "sleep 5 & jobs -s; echo rc=$?", "rc=0\n", "", 0),
    ("jobs_n_changed_then_none",
     "sleep 5 & echo hi & sleep 0.3; jobs -n; echo ---; jobs -n",
     "[2] completed echo hi\n---\n", "", 0),
    ("jobs_spec_filters", "sleep 5 & sleep 5 & jobs %2; jobs 1",
     "[2] running sleep 5\n[1] running sleep 5\n", "", 0),
    ("jobs_no_such_job", "sleep 5 & jobs %9; echo rc=$?", "rc=1\n",
     "bash: jobs: %9: no such job\n", 0),
    ("jobs_bad_flag_usage", "jobs -q; echo rc=$?", "rc=2\n",
     "bash: jobs: -q: invalid option\n"
     "jobs: usage: jobs [-lnprs] [jobspec ...] or jobs -x command [args]\n",
     0),
    ("jobs_lp_combined", "sleep 5 & sleep 5 & jobs -lp", "1\n2\n", "", 0),
]

# The review round, pinned the same way: a parameter default lands on
# the element the reference named, arithmetic writes land in
# evaluation order across bare and subscripted targets (a bare name
# aliases element 0), a bare array name reads as element 0 in
# arithmetic, `-i` resolves element references at the write, and
# `test -v` unquotes an associative subscript. `${a[-5]:=v}` diverges
# by one line: GNU also warns `a: bad array subscript` for the read,
# and expansion has no warning channel here.
REVIEW_CASES = [
    ('assoc_default_colon',
     'declare -A m; echo "${m[k]:=v}"; declare -p m; echo "${m[k]:=w}"',
     'v\ndeclare -A m=([k]="v" )\nv\n', '', 0),
    ('assoc_default_eq', 'declare -A m; echo "${m[k]=v}"; declare -p m',
     'v\ndeclare -A m=([k]="v" )\n', '', 0),
    ('indexed_default_new_index', 'a=(1 2); echo "${a[3]:=v}"; declare -p a',
     'v\ndeclare -a a=([0]="1" [1]="2" [3]="v")\n', '', 0),
    ('indexed_default_neg_set', 'a=(1 2); echo "${a[-1]:=v}"; declare -p a',
     '2\ndeclare -a a=([0]="1" [1]="2")\n', '', 0),
    ('indexed_default_neg_out', 'a=(1 2); echo "${a[-5]:=v}"; echo after', '',
     'bash: a[-5]: bad array subscript\n', 1),
    ('indexed_default_splat',
     'a=(); echo "${a[@]:=v}"; declare -p a; echo after', '',
     'bash: a[@]: bad array subscript\n', 1),
    ('indexed_default_unset', 'unset a; echo "${a[2]:=v}"; declare -p a',
     'v\ndeclare -a a=([2]="v")\n', '', 0),
    ('indexed_default_scalar', 'x=s; echo "${x[1]:=v}"; declare -p x',
     'v\ndeclare -a x=([0]="s" [1]="v")\n', '', 0),
    ('assoc_default_dollar_key',
     'declare -A m; k=q; echo "${m[$k]:=v}"; declare -p m',
     'v\ndeclare -A m=([q]="v" )\n', '', 0),
    ('arith_order_elem_then_bare', 'a=(0); ((a[0]=1, a=2)); declare -p a',
     'declare -a a=([0]="2")\n', '', 0),
    ('arith_order_bare_then_elem', 'a=(0); ((a=2, a[0]=1)); declare -p a',
     'declare -a a=([0]="1")\n', '', 0),
    ('arith_bare_keeps_tail', 'a=(1 2 3); ((a=5)); declare -p a',
     'declare -a a=([0]="5" [1]="2" [2]="3")\n', '', 0),
    ('arith_expansion_bare_keeps_tail',
     'a=(1 2 3); echo $((a=7)); declare -p a',
     '7\ndeclare -a a=([0]="7" [1]="2" [2]="3")\n', '', 0),
    ('arith_cfor_bare_keeps_tail',
     'a=(1 2 3); for ((a=9; a<10; a++)); do :; done; declare -p a',
     'declare -a a=([0]="10" [1]="2" [2]="3")\n', '', 0),
    ('int_reads_indexed_element', 'a=(1 2); declare -i n; n="a[1]+1"; echo $n',
     '3\n', '', 0),
    ('int_reads_assoc_element',
     'declare -A m=([x]=4); declare -i n; n="m[x]+1"; echo $n', '5\n', '', 0),
    ('int_reads_quoted_assoc_element',
     'declare -A m=([x]=4); declare -i n; n=\'m["x"]+1\'; echo $n', '5\n', '',
     0),
    ('int_missing_element_is_zero',
     'a=(1 2); declare -i n; n="a[5]+1"; echo $n', '1\n', '', 0),
    ('test_v_quoted_assoc_key',
     'declare -A m=([x]=1); test -v \'m["x"]\' && echo yes || echo no',
     'yes\n', '', 0),
    ('cond_v_single_quoted_assoc_key',
     'declare -A m=([x]=1); [[ -v "m[\'x\']" ]] && echo yes || echo no',
     'yes\n', '', 0),
    ('test_v_literal_quote_key',
     'declare -A m=([\'"x"\']=1); test -v \'m["x"]\' && echo yes || echo no; '
     'declare -p m', 'no\ndeclare -A m=(["\\"x\\""]="1" )\n', '', 0),
    ('arith_bare_array_read',
     'a=(4 5); echo $((a)); a=(11 2); ((a<10)) && echo lt || echo ge',
     '4\nge\n', '', 0),
    ('arith_bare_assoc_read', 'declare -A m=([0]=7 [x]=1); echo $((m+1))',
     '8\n', '', 0),
    ('int_from_array_name', 'abc=(3 4); declare -i n; n=abc; echo $n', '3\n',
     '', 0),
]

ALL_CASES = CASES + ATTR_CASES + FUNC_JOB_CASES + REVIEW_CASES


@pytest.mark.parametrize("case_id,cmd,out,err,code",
                         ALL_CASES,
                         ids=[c[0] for c in ALL_CASES])
def test_assoc_case(case_id, cmd, out, err, code):

    async def run():
        ws = Workspace({"data": RAMVFS()})
        try:
            io = await ws.shell(cmd)
            stdout = await io.stdout_str()
            stderr = io.stderr or b""
            if isinstance(stderr, bytes):
                stderr = stderr.decode()
            return io.exit_code, stdout, stderr
        finally:
            await ws.close()

    got_code, got_out, got_err = asyncio.run(run())
    assert (got_out, got_err, got_code) == (out, err, code)
