//! The lines bash numbers a `$( )` body by. bash reads the body again as
//! it prints the command back, so `$LINENO` counts the lines of that
//! printing, not the ones typed: a statement after a `;` stays on its
//! line and one after a newline takes the next, a blank line or a comment
//! adds none, `if`, `while`, `for`, `case` and a function lay their parts
//! out a line each, a `{ }` or `( )` stays inline outside a function, and
//! a heredoc's body follows the command that reads it.

use super::Tree;
use super::tree::to_u32;

/// Where the printing stands and what each node it reached starts on.
struct Layout<'a> {
    tree: &'a Tree,
    line: u32,
    /// The line holds nothing yet: a heredoc's delimiter ended the last.
    fresh: bool,
    /// Inside a function's body, which bash prints a statement to a line.
    function: u32,
    /// The heredoc lines owed once the command reading them is printed.
    owed: u32,
    starts: Vec<Option<u32>>,
    ends: Vec<u32>,
}

/// For each node under `root`, a program read again as bash prints it,
/// its index, the line `$LINENO` numbers it by and the line it ends on,
/// both from 0: a simple command's is where the token after its first
/// element ends, as the host numbers a command typed, any other node's
/// the line it starts on.
pub fn reread_lines(tree: &Tree, root: usize) -> Vec<(u32, u32, u32)> {
    let mut layout = Layout {
        tree,
        line: 0,
        fresh: false,
        function: 0,
        owed: 0,
        starts: vec![None; tree.nodes.len()],
        ends: vec![0; tree.nodes.len()],
    };
    layout.starts[root] = Some(0);
    let items = layout.children(root);
    layout.sequence(&items);
    layout.ends[root] = layout.line;
    let mut under = Vec::new();
    let mut stack = vec![root];
    while let Some(index) = stack.pop() {
        under.push(index);
        stack.extend(layout.children(index));
    }
    under.sort_unstable();
    for &index in &under {
        if layout.starts[index].is_none() {
            let parent = layout.starts[tree.nodes[index].parent as usize];
            layout.starts[index] = parent;
            layout.ends[index] = parent.unwrap_or(0);
        }
    }
    under
        .into_iter()
        .map(|index| {
            let start = layout.starts[index].unwrap_or(0);
            (
                to_u32(index),
                layout.numbered(index, start),
                layout.ends[index],
            )
        })
        .collect()
}

impl Layout<'_> {
    fn kind(&self, index: usize) -> &'static str {
        self.tree.kind(index)
    }

    fn children(&self, index: usize) -> Vec<usize> {
        let node = &self.tree.nodes[index];
        (node.first_child as usize..(node.first_child + node.child_count) as usize).collect()
    }

    fn named(&self, index: usize) -> bool {
        self.tree.nodes[index].named
    }

    /// Move to a new line unless the one it stands on holds nothing yet.
    fn break_line(&mut self) {
        if !self.fresh {
            self.line += 1;
        }
        self.fresh = false;
    }

    /// The statements of a list in order, each where its separator puts
    /// it: on the same line after `;` or `&` (a line of its own inside a
    /// function), on the next after a newline (two on inside a function).
    fn sequence(&mut self, items: &[usize]) {
        let mut first = true;
        let mut inline = false;
        for &item in items {
            if !self.named(item) {
                inline |= matches!(self.kind(item), ";" | "&" | ";;" | ";&" | ";;&");
                continue;
            }
            if self.kind(item) == "comment" {
                continue;
            }
            if !first {
                if inline {
                    if self.function > 0 {
                        self.break_line();
                    }
                } else {
                    self.line += if self.function > 0 && !self.fresh {
                        2
                    } else {
                        1
                    };
                    self.fresh = false;
                }
            }
            self.statement(item);
            first = false;
            inline = false;
        }
    }

    fn statement(&mut self, index: usize) {
        self.fresh = false;
        self.starts[index] = Some(self.line);
        match self.kind(index) {
            "if_statement" => self.if_statement(index),
            "while_statement" | "for_statement" | "c_style_for_statement" => self.looped(index),
            "case_statement" => self.case_statement(index),
            "compound_statement"
                if self
                    .children(index)
                    .first()
                    .is_some_and(|&c| self.kind(c) != "((") =>
            {
                self.group(index)
            }
            "subshell" => {
                let inner: Vec<usize> = self.children(index);
                self.sequence(&inner);
            }
            "function_definition" => self.function_definition(index),
            "redirected_statement"
            | "pipeline"
            | "list"
            | "negated_command"
            | "timed_statement" => {
                for child in self.children(index) {
                    if self.kind(child).ends_with("redirect") {
                        self.inline(child);
                    } else if self.named(child) {
                        self.statement(child);
                    }
                }
            }
            _ => self.inline(index),
        }
        if !matches!(self.kind(index), "pipeline" | "list") {
            self.pay();
        }
        self.ends[index] = self.line;
    }

    /// The heredoc bodies the command just printed reads: a line on, its
    /// lines and its delimiter's, the next text on a line of its own.
    fn pay(&mut self) {
        if self.owed > 0 {
            self.line += 1 + self.owed;
            self.owed = 0;
            self.fresh = true;
        }
    }

    /// A node printed within its line: the newlines its text holds, a
    /// `$( )` in it as its body prints, a heredoc owed to after it.
    fn inline(&mut self, index: usize) {
        self.starts[index] = Some(self.line);
        if let Some(heredoc) = self.tree.heredoc(index) {
            let typed = self
                .tree
                .original
                .get(heredoc.body_start..heredoc.end)
                .unwrap_or_default();
            self.owed += newlines(typed, 0, typed.len());
            self.ends[index] = self.line;
            return;
        }
        if matches!(
            self.kind(index),
            "command_substitution" | "process_substitution"
        ) && !self.tree.source[self.tree.nodes[index].start as usize..].starts_with(b"`")
        {
            let (function, owed) = (self.function, self.owed);
            self.function = 0;
            self.owed = 0;
            let start = self.line;
            let body = self.children(index);
            self.sequence(&body);
            self.pay();
            self.fresh = false;
            self.function = function;
            self.owed = owed;
            self.ends[index] = self.line.max(start);
            return;
        }
        let node = self.tree.nodes[index];
        let mut at = node.start as usize;
        for child in self.children(index) {
            let child_start = self.tree.nodes[child].start as usize;
            self.line += newlines(&self.tree.source, at, child_start);
            self.inline(child);
            at = at.max(self.tree.nodes[child].end as usize);
        }
        self.line += newlines(&self.tree.source, at, node.end as usize);
        self.ends[index] = self.line;
    }

    /// `if C; then` on a line, each body on the lines after its keyword,
    /// an `elif` printed as an `else` holding the next `if`, whose `fi`
    /// closes after the outer one's body.
    fn if_statement(&mut self, index: usize) {
        let mut part: Vec<usize> = Vec::new();
        let mut nested = 0;
        for child in self.children(index) {
            match self.kind(child) {
                "if" => {}
                "then" => {
                    self.sequence(&part);
                    part.clear();
                    self.break_line();
                }
                "elif_clause" | "else_clause" | "fi" => {
                    self.sequence(&part);
                    part.clear();
                    self.break_line();
                    self.starts[child] = Some(self.line);
                    if self.kind(child) == "elif_clause" {
                        self.break_line();
                        nested += 1;
                        self.clause(child, true);
                    } else if self.kind(child) == "else_clause" {
                        self.break_line();
                        self.clause(child, false);
                    }
                    self.ends[child] = self.line;
                }
                _ => part.push(child),
            }
        }
        for _ in 0..nested {
            self.break_line();
        }
    }

    /// An `elif` clause's condition and body, or an `else` clause's body.
    fn clause(&mut self, index: usize, condition: bool) {
        let mut part: Vec<usize> = Vec::new();
        for child in self.children(index) {
            match self.kind(child) {
                "elif" | "else" => {}
                "then" if condition => {
                    self.sequence(&part);
                    part.clear();
                    self.break_line();
                }
                _ => part.push(child),
            }
        }
        self.sequence(&part);
    }

    /// `while C; do`, or `for x in W;` with `do` on a line of its own,
    /// the body on the lines after and `done` after it.
    fn looped(&mut self, index: usize) {
        let mut head: Vec<usize> = Vec::new();
        for child in self.children(index) {
            if matches!(self.kind(child), "do_group" | "compound_statement") {
                if self.kind(index) == "while_statement" {
                    self.sequence(&head);
                } else {
                    self.words(&head);
                    self.break_line();
                }
                self.starts[child] = Some(self.line);
                self.break_line();
                let body: Vec<usize> = self.children(child);
                self.sequence(&body);
                self.break_line();
                self.ends[child] = self.line;
            } else {
                head.push(child);
            }
        }
    }

    /// A loop header's words, printed within its line.
    fn words(&mut self, items: &[usize]) {
        for &item in items {
            self.inline(item);
        }
    }

    /// `case W in`, then each pattern, body and terminator on a line of
    /// its own, an empty body taking its line too, and `esac`: a `$( )`
    /// in a pattern spans its own printing before the body.
    fn case_statement(&mut self, index: usize) {
        for child in self.children(index) {
            if self.kind(child) == "case_item" {
                self.break_line();
                self.starts[child] = Some(self.line);
                let mut parts = self.children(child).into_iter();
                for part in parts.by_ref() {
                    if self.kind(part) == ")" {
                        break;
                    }
                    if self.named(part) {
                        self.inline(part);
                    }
                }
                let body: Vec<usize> = parts.collect();
                self.break_line();
                self.sequence(&body);
                self.break_line();
                self.ends[child] = self.line;
            } else if self.kind(child) == "esac" {
                self.break_line();
            } else if self.named(child) {
                self.inline(child);
            }
        }
    }

    /// `{ list; }` within its line, or, inside a function, `{` and `}`
    /// on lines of their own around it.
    fn group(&mut self, index: usize) {
        let body: Vec<usize> = self.children(index);
        if self.function == 0 {
            self.sequence(&body);
            return;
        }
        self.break_line();
        self.sequence(&body);
        self.break_line();
    }

    /// `f () ` on its line, `{` on the next, the body a statement to a
    /// line, and `}`: a body that is no `{ }` printed inside one.
    fn function_definition(&mut self, index: usize) {
        for child in self.children(index) {
            let field = self.tree.nodes[child].field as usize;
            if field == 0 || super::FIELDS[field - 1] != "body" {
                continue;
            }
            self.break_line();
            self.starts[child] = Some(self.line);
            self.break_line();
            self.function += 1;
            if self.kind(child) == "compound_statement" {
                let body: Vec<usize> = self.children(child);
                self.sequence(&body);
            } else {
                self.statement(child);
            }
            self.function -= 1;
            self.break_line();
            self.ends[child] = self.line;
        }
    }

    /// The line bash numbers a node by: a simple command's where the
    /// token after its first element ends, or where that element ends
    /// when it is an assignment; any other node's where it starts.
    fn numbered(&self, index: usize, start: u32) -> u32 {
        let parent = self.tree.nodes[index].parent;
        let kind = self.kind(index);
        if kind == "variable_assignment" {
            let grouped =
                parent != u32::MAX && self.kind(parent as usize) == "variable_assignments";
            if !grouped {
                return self.ends[index];
            }
            return self.numbered(parent as usize, start);
        }
        let children = self.children(index);
        if kind == "variable_assignments" && !children.is_empty() {
            return self.ends[children[0]];
        }
        if !matches!(kind, "command" | "declaration_command") || children.is_empty() {
            return start;
        }
        if self.kind(children[0]) == "variable_assignment" {
            return self.ends[children[0]];
        }
        let mut after = *children.get(1).unwrap_or(&children[0]);
        if matches!(
            self.kind(after),
            "file_redirect" | "heredoc_redirect" | "herestring_redirect"
        ) {
            if let Some(&operator) = self.children(after).first() {
                after = operator;
            }
        }
        self.ends[after]
    }
}

/// The newlines in `source` between two offsets.
fn newlines(source: &[u8], from: usize, to: usize) -> u32 {
    to_u32(
        source
            .get(from..to.max(from))
            .map_or(0, |gap| memchr::memchr_iter(b'\n', gap).count()),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shell::parse;

    /// `$LINENO` for each `echo $LINENO` in `body`, from 1.
    fn echoed(body: &str) -> Vec<u32> {
        let tree = parse(body.as_bytes());
        let lines = reread_lines(&tree, 0);
        let mut out: Vec<(u32, u32)> = lines
            .into_iter()
            .filter(|&(index, _, _)| {
                let index = index as usize;
                tree.kind(index) == "command"
                    && tree.source[tree.nodes[index].start as usize..].starts_with(b"echo $LINENO")
            })
            .map(|(index, line, _)| (tree.nodes[index as usize].start, line + 1))
            .collect();
        out.sort_unstable();
        out.into_iter().map(|(_, line)| line).collect()
    }

    #[test]
    fn a_body_numbers_as_bash_prints_it() {
        assert_eq!(
            echoed("if true; then echo $LINENO; fi; echo $LINENO"),
            [2, 3]
        );
        assert_eq!(
            echoed("if true; then echo $LINENO; echo $LINENO; fi"),
            [2, 2]
        );
        assert_eq!(
            echoed("if true; then :; elif true; then :; else :; fi; echo $LINENO"),
            [9]
        );
        assert_eq!(
            echoed("for i in 1; do echo $LINENO; done; echo $LINENO"),
            [3, 4]
        );
        assert_eq!(echoed("while false; do :; done; echo $LINENO"), [3]);
        assert_eq!(
            echoed("case x in a) :;; b|x) echo $LINENO;; esac; echo $LINENO"),
            [6, 8]
        );
        assert_eq!(
            echoed("case x in $(if true; then echo x; fi)) echo $LINENO;; esac; echo $LINENO"),
            [5, 7]
        );
        assert_eq!(
            echoed("case x in a) :;; \"$(if true; then echo x; fi)\") echo $LINENO;; esac"),
            [8]
        );
        assert_eq!(
            echoed("{\necho $LINENO\necho $LINENO\n}\necho $LINENO"),
            [1, 2, 3]
        );
        assert_eq!(echoed("{ echo $LINENO; }\ntrue\necho $LINENO"), [1, 3]);
        assert_eq!(echoed("true;\necho $LINENO"), [1]);
        assert_eq!(echoed("true\n\n# c\necho $LINENO"), [2]);
        assert_eq!(echoed("echo 'a\nb'\necho $LINENO"), [3]);
        assert_eq!(
            echoed("f(){ echo $LINENO; echo $LINENO; }; f; echo $LINENO"),
            [3, 4, 5]
        );
        assert_eq!(
            echoed("f(){ echo $LINENO\necho $LINENO; }; f; echo $LINENO"),
            [3, 5, 6]
        );
        assert_eq!(echoed("f() ( : ); echo $LINENO"), [4]);
        assert_eq!(echoed("cat <<E\nx\nE\necho $LINENO"), [5]);
        assert_eq!(echoed("cat <<E; echo $LINENO\nx\nE\necho $LINENO"), [4, 5]);
        assert_eq!(
            echoed("cat <<A <<B; echo $LINENO\na\nA\nb\nB\necho $LINENO"),
            [6, 7]
        );
        assert_eq!(
            echoed("f(){ cat <<E\nx\nE\necho $LINENO; }; f; echo $LINENO"),
            [7, 8]
        );
    }

    #[test]
    fn a_substitution_in_the_body_spans_its_own_printing() {
        let tree = parse(b"if true; then echo $(if true; then :; fi); fi");
        let echo = (0..tree.nodes.len())
            .find(|&index| {
                tree.kind(index) == "command"
                    && tree.source[tree.nodes[index].start as usize..].starts_with(b"echo")
            })
            .unwrap();
        let lines = reread_lines(&tree, 0);
        let &(_, line, _) = lines
            .iter()
            .find(|&&(index, _, _)| index as usize == echo)
            .unwrap();
        assert_eq!(line, 3);
    }
}
