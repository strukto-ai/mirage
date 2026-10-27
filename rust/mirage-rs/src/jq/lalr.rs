use std::collections::HashMap;

/// A terminal's associativity, as a Bison precedence declaration gives it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum Assoc {
    Left,
    Right,
    Nonassoc,
    Precedence,
}

/// What a state does on one lookahead token, after Bison's conflict
/// resolution and default reductions: `Default` takes the state's default
/// reduction, or is a syntax error where it has none.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum Action {
    Default,
    Shift(usize),
    Reduce(usize),
    Error,
}

/// One rule: its left side and the length of its right side.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Rule {
    pub(crate) lhs: usize,
    pub(crate) len: usize,
}

/// LALR(1) tables built the way Bison 3.8 builds them for a `yacc.c`
/// parser: shift/reduce conflicts settled by precedence (a `%nonassoc` tie
/// is an explicit error), reduce/reduce by the earlier rule, and every
/// state's most common reduction made its default unless the state shifts
/// `error`. A state whose row is all default never reads a lookahead, and
/// the tokens a syntax error lists as expected are the explicit entries of
/// the state it was found in.
pub(crate) struct Tables {
    pub(crate) tokens: usize,
    pub(crate) rules: Vec<Rule>,
    action: Vec<Action>,
    default: Vec<Option<usize>>,
    goto: Vec<Option<usize>>,
    nonterminals: usize,
    /// The state shifting `$end` leads to, where the parse is accepted.
    pub(crate) accept: usize,
    /// Conflicts precedence did not settle, which Bison settles in favour
    /// of the shift, and of the earlier rule.
    pub(crate) conflicts: usize,
}

type Set = u128;

impl Tables {
    pub(crate) fn action(&self, state: usize, token: usize) -> Action {
        self.action[state * self.tokens + token]
    }

    pub(crate) fn default(&self, state: usize) -> Option<usize> {
        self.default[state]
    }

    /// Whether the state reads a lookahead before it acts.
    pub(crate) fn reads(&self, state: usize) -> bool {
        (0..self.tokens).any(|t| self.action(state, t) != Action::Default)
    }

    pub(crate) fn goto(&self, state: usize, lhs: usize) -> usize {
        self.goto[state * self.nonterminals + lhs - self.tokens]
            .expect("a reduction always has a goto")
    }

    /// The tokens a syntax error found in `state` lists as expected, in
    /// symbol order, `error` aside.
    pub(crate) fn expected(&self, state: usize, error: usize) -> Vec<usize> {
        (0..self.tokens)
            .filter(|&t| {
                t != error && !matches!(self.action(state, t), Action::Default | Action::Error)
            })
            .collect()
    }

    #[cfg(test)]
    pub(crate) fn states(&self) -> usize {
        self.default.len()
    }
}

struct Grammar {
    tokens: usize,
    lhs: Vec<usize>,
    rhs: Vec<Vec<usize>>,
    by_lhs: Vec<Vec<usize>>,
    nullable: Vec<bool>,
    /// For each nonterminal, the rules whose items an LR(0) closure adds
    /// for it: its own, and those of every nonterminal they start with.
    reach: Vec<Vec<usize>>,
}

impl Grammar {
    fn nonterminal(&self, symbol: usize) -> Option<usize> {
        symbol.checked_sub(self.tokens)
    }

    fn closure(&self, kernel: &[(usize, usize)]) -> Vec<(usize, usize)> {
        let mut added = vec![false; self.lhs.len()];
        let mut items = kernel.to_vec();
        for &(rule, dot) in kernel {
            if let Some(n) = self.rhs[rule].get(dot).and_then(|s| self.nonterminal(*s)) {
                for &r in &self.reach[n] {
                    if !added[r] {
                        added[r] = true;
                        items.push((r, 0));
                    }
                }
            }
        }
        items.sort();
        items.dedup();
        items
    }
}

fn bit(token: usize) -> Set {
    1 << token
}

/// Raise every set to the union of the sets it reaches along `edges`.
fn propagate(sets: &mut [Set], edges: &[Vec<usize>]) {
    loop {
        let mut changed = false;
        for from in 0..sets.len() {
            for &to in &edges[from] {
                let more = sets[from] | sets[to];
                if more != sets[from] {
                    sets[from] = more;
                    changed = true;
                }
            }
        }
        if !changed {
            return;
        }
    }
}

/// Build the tables. `tokens` are the terminals in symbol order (`$end`,
/// `error` first), `precedence` the precedence declarations from the
/// lowest, and each rule `"Lhs: sym sym %prec tok"` with symbols spelled
/// as `tokens` spells them; the first rule's left side is the start
/// symbol. Lookaheads are LALR(1)'s, computed as DeRemer and Pennello
/// do, which is how Bison computes them.
pub(crate) fn build(tokens: &[&str], precedence: &[(Assoc, &[&str])], rules: &[&str]) -> Tables {
    let ntok = tokens.len();
    assert!(ntok <= 128, "too many tokens for a lookahead set");
    let mut names: HashMap<&str, usize> = tokens.iter().enumerate().map(|(i, t)| (*t, i)).collect();
    let mut nonterminals = vec!["$accept"];
    names.insert("$accept", ntok);
    for rule in rules {
        let lhs = rule.split(':').next().expect("a rule names its left side");
        if !names.contains_key(lhs) {
            names.insert(lhs, ntok + nonterminals.len());
            nonterminals.push(lhs);
        }
    }
    let nnt = nonterminals.len();
    let mut token_prec: Vec<Option<(usize, Assoc)>> = vec![None; ntok];
    for (level, (assoc, list)) in precedence.iter().enumerate() {
        for name in *list {
            token_prec[names[name]] = Some((level + 1, *assoc));
        }
    }
    let mut lhs = vec![ntok];
    let mut rhs = vec![vec![ntok + 1, 0]];
    let mut prec = vec![None];
    for rule in rules {
        let (left, right) = rule.split_once(':').expect("a rule has a colon");
        let mut words = right.split_whitespace();
        let mut symbols = Vec::new();
        let mut over = None;
        while let Some(word) = words.next() {
            if word == "%prec" {
                let tok = words.next().expect("%prec names a token");
                over = Some(token_prec[names[tok]].expect("%prec token has a precedence"));
                continue;
            }
            symbols.push(
                *names
                    .get(word)
                    .unwrap_or_else(|| panic!("unknown symbol {word}")),
            );
        }
        let last = symbols.iter().rev().find(|s| **s < ntok).copied();
        prec.push(over.or_else(|| last.and_then(|t| token_prec[t])));
        lhs.push(names[left]);
        rhs.push(symbols);
    }
    let mut by_lhs: Vec<Vec<usize>> = vec![Vec::new(); nnt];
    for (r, l) in lhs.iter().enumerate() {
        by_lhs[l - ntok].push(r);
    }
    let mut nullable = vec![false; ntok + nnt];
    loop {
        let mut changed = false;
        for r in 0..rhs.len() {
            if !nullable[lhs[r]] && rhs[r].iter().all(|s| nullable[*s]) {
                nullable[lhs[r]] = true;
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }
    let mut reach: Vec<Vec<usize>> = Vec::with_capacity(nnt);
    for n in 0..nnt {
        let mut seen = vec![false; nnt];
        let mut stack = vec![n];
        seen[n] = true;
        let mut rules_of = Vec::new();
        while let Some(m) = stack.pop() {
            for &r in &by_lhs[m] {
                rules_of.push(r);
                if let Some(&first) = rhs[r].first() {
                    if first >= ntok && !seen[first - ntok] {
                        seen[first - ntok] = true;
                        stack.push(first - ntok);
                    }
                }
            }
        }
        rules_of.sort();
        reach.push(rules_of);
    }
    let grammar = Grammar {
        tokens: ntok,
        lhs,
        rhs,
        by_lhs,
        nullable,
        reach,
    };

    let mut kernels: Vec<Vec<(usize, usize)>> = vec![vec![(0, 0)]];
    let mut known: HashMap<Vec<(usize, usize)>, usize> = HashMap::new();
    known.insert(kernels[0].clone(), 0);
    let mut closures: Vec<Vec<(usize, usize)>> = Vec::new();
    let mut transitions: Vec<Vec<(usize, usize)>> = Vec::new();
    let mut s = 0;
    while s < kernels.len() {
        let items = grammar.closure(&kernels[s]);
        let mut by_symbol: Vec<(usize, Vec<(usize, usize)>)> = Vec::new();
        for &(rule, dot) in &items {
            if let Some(&x) = grammar.rhs[rule].get(dot) {
                match by_symbol.iter_mut().find(|(y, _)| *y == x) {
                    Some((_, k)) => k.push((rule, dot + 1)),
                    None => by_symbol.push((x, vec![(rule, dot + 1)])),
                }
            }
        }
        by_symbol.sort_by_key(|(x, _)| *x);
        let mut out = Vec::new();
        for (x, kernel) in by_symbol {
            let target = *known.entry(kernel.clone()).or_insert_with(|| {
                kernels.push(kernel);
                kernels.len() - 1
            });
            out.push((x, target));
        }
        closures.push(items);
        transitions.push(out);
        s += 1;
    }
    let nstates = kernels.len();
    let target = |s: usize, x: usize| {
        transitions[s]
            .iter()
            .find(|(y, _)| *y == x)
            .map(|(_, t)| *t)
            .expect("a goto on every symbol after a dot")
    };

    let mut edges_of: HashMap<(usize, usize), usize> = HashMap::new();
    let mut gotos: Vec<(usize, usize)> = Vec::new();
    for (s, out) in transitions.iter().enumerate() {
        for &(x, _) in out {
            if x >= ntok {
                edges_of.insert((s, x), gotos.len());
                gotos.push((s, x));
            }
        }
    }
    let mut read: Vec<Set> = Vec::with_capacity(gotos.len());
    let mut reads: Vec<Vec<usize>> = vec![Vec::new(); gotos.len()];
    for (i, &(s, x)) in gotos.iter().enumerate() {
        let r = target(s, x);
        let mut direct = 0;
        for &(y, _) in &transitions[r] {
            if y < ntok {
                direct |= bit(y);
            } else if grammar.nullable[y] {
                reads[i].push(edges_of[&(r, y)]);
            }
        }
        read.push(direct);
    }
    propagate(&mut read, &reads);
    let mut includes: Vec<Vec<usize>> = vec![Vec::new(); gotos.len()];
    let mut lookback: HashMap<(usize, usize), Vec<usize>> = HashMap::new();
    for (j, &(p, b)) in gotos.iter().enumerate() {
        for &rule in &grammar.by_lhs[b - ntok] {
            let body = &grammar.rhs[rule];
            let mut state = p;
            for (i, &x) in body.iter().enumerate() {
                if x >= ntok && body[i + 1..].iter().all(|y| grammar.nullable[*y]) {
                    includes[edges_of[&(state, x)]].push(j);
                }
                state = target(state, x);
            }
            lookback.entry((state, rule)).or_default().push(j);
        }
    }
    let mut follow = read;
    propagate(&mut follow, &includes);

    let mut action = vec![Action::Default; nstates * ntok];
    let mut default = vec![None; nstates];
    let mut goto = vec![None; nstates * nnt];
    let mut conflicts = 0;
    for s in 0..nstates {
        let mut reds: Vec<(usize, Set)> = closures[s]
            .iter()
            .filter(|(rule, dot)| *rule != 0 && *dot == grammar.rhs[*rule].len())
            .map(|(rule, _)| {
                let set = lookback
                    .get(&(s, *rule))
                    .map_or(0, |js| js.iter().fold(0, |acc, j| acc | follow[*j]));
                (*rule, set)
            })
            .collect();
        reds.sort_by_key(|(rule, _)| *rule);
        let mut shifts: Vec<(usize, usize)> = Vec::new();
        for &(x, t) in &transitions[s] {
            if x < ntok {
                shifts.push((x, t));
            } else {
                goto[s * nnt + x - ntok] = Some(t);
            }
        }
        let row = &mut action[s * ntok..(s + 1) * ntok];
        let consistent = reds.len() <= 1 && (reds.is_empty() || shifts.is_empty());
        if consistent {
            for &(x, t) in &shifts {
                row[x] = Action::Shift(t);
            }
            default[s] = reds.first().map(|(r, _)| *r);
            continue;
        }
        let mut shift_set: Set = shifts.iter().fold(0, |acc, (x, _)| acc | bit(*x));
        let mut errors: Set = 0;
        for (rule, set) in reds.iter_mut() {
            let Some((level, _)) = prec[*rule] else {
                continue;
            };
            if *set & shift_set == 0 {
                continue;
            }
            for (t, tprec) in token_prec.iter().enumerate() {
                if *set & bit(t) == 0 || shift_set & bit(t) == 0 {
                    continue;
                }
                let Some((tlevel, assoc)) = *tprec else {
                    continue;
                };
                if tlevel < level {
                    shift_set &= !bit(t);
                } else if tlevel > level {
                    *set &= !bit(t);
                } else {
                    match assoc {
                        Assoc::Precedence => {}
                        Assoc::Right => *set &= !bit(t),
                        Assoc::Left => shift_set &= !bit(t),
                        Assoc::Nonassoc => {
                            shift_set &= !bit(t);
                            *set &= !bit(t);
                            errors |= bit(t);
                        }
                    }
                }
            }
        }
        let mut seen = shift_set;
        for (_, set) in &reds {
            if set & seen != 0 {
                conflicts += 1;
            }
            seen |= set;
        }
        for (rule, set) in reds.iter().rev() {
            for (t, slot) in row.iter_mut().enumerate() {
                if set & bit(t) != 0 {
                    *slot = Action::Reduce(*rule);
                }
            }
        }
        let mut nodefault = false;
        for &(x, t) in &shifts {
            if shift_set & bit(x) != 0 {
                row[x] = Action::Shift(t);
                nodefault |= x == 1;
            }
        }
        for (t, slot) in row.iter_mut().enumerate() {
            if errors & bit(t) != 0 {
                *slot = Action::Error;
            }
        }
        if !nodefault {
            let mut best: Option<(usize, usize)> = None;
            for (rule, _) in &reds {
                let count = row.iter().filter(|a| **a == Action::Reduce(*rule)).count();
                if count > best.map_or(0, |(_, c)| c) {
                    best = Some((*rule, count));
                }
            }
            if let Some((rule, _)) = best {
                for slot in row.iter_mut() {
                    if *slot == Action::Reduce(rule) {
                        *slot = Action::Default;
                    }
                }
                default[s] = Some(rule);
            }
        }
        if default[s].is_none() {
            for slot in row.iter_mut() {
                if *slot == Action::Error {
                    *slot = Action::Default;
                }
            }
        }
    }
    Tables {
        tokens: ntok,
        rules: grammar
            .lhs
            .iter()
            .zip(&grammar.rhs)
            .map(|(l, r)| Rule {
                lhs: *l,
                len: r.len(),
            })
            .collect(),
        action,
        default,
        goto,
        nonterminals: nnt,
        accept: kernels
            .iter()
            .position(|k| k.contains(&(0, 2)))
            .expect("the start rule completes"),
        conflicts,
    }
}
