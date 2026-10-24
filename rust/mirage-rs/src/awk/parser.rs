use super::lexer::{BUILTINS, Kind, Token, tokenize};
use super::text::compile_ere;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(super) enum Cmp {
    Lt,
    Le,
    Gt,
    Ge,
    Eq,
    Ne,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(super) enum GetlineKind {
    Plain,
    File,
    Command,
}

#[derive(Clone, Debug, PartialEq)]
pub(super) enum Expr {
    Num(f64),
    Str(Vec<u8>),
    Regex(Vec<u8>),
    Var(Vec<u8>),
    Field(Box<Expr>),
    Index(Vec<u8>, Vec<Expr>),
    /// The operator of `op=`, None for a plain `=`.
    Assign(Box<Expr>, Option<u8>, Box<Expr>),
    Binary(u8, Box<Expr>, Box<Expr>),
    /// Unary `-` or `+`.
    Unary(u8, Box<Expr>),
    Concat(Box<Expr>, Box<Expr>),
    Compare(Cmp, Box<Expr>, Box<Expr>),
    /// `~`, or `!~` when negated.
    Match(bool, Box<Expr>, Box<Expr>),
    /// `&&`, or `||` when false.
    Logical(bool, Box<Expr>, Box<Expr>),
    Not(Box<Expr>),
    Cond(Box<Expr>, Box<Expr>, Box<Expr>),
    /// `++`/`--`: before the operand or after it, and by how much.
    IncDec(bool, f64, Box<Expr>),
    Call(Vec<u8>, Vec<Expr>),
    Builtin(&'static [u8], Vec<Expr>),
    In(Vec<Expr>, Vec<u8>),
    Getline(GetlineKind, Option<Box<Expr>>, Option<Box<Expr>>),
}

impl Expr {
    pub(super) fn is_lvalue(&self) -> bool {
        matches!(self, Expr::Var(_) | Expr::Field(_) | Expr::Index(..))
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(super) enum RedirKind {
    File,
    Append,
    Pipe,
}

#[derive(Clone, Debug, PartialEq)]
pub(super) enum Stmt {
    Block(Vec<Stmt>),
    Expr(Expr),
    /// `print` or, when true, `printf`.
    Print(bool, Vec<Expr>, Option<(RedirKind, Expr)>),
    If(Expr, Box<Stmt>, Option<Box<Stmt>>),
    While(Expr, Box<Stmt>),
    Do(Box<Stmt>, Expr),
    For(
        Option<Box<Stmt>>,
        Option<Expr>,
        Option<Box<Stmt>>,
        Box<Stmt>,
    ),
    ForIn(Vec<u8>, Vec<u8>, Box<Stmt>),
    Next,
    NextFile,
    Break,
    Continue,
    Exit(Option<Expr>),
    Return(Option<Expr>),
    Delete(Vec<u8>, Option<Vec<Expr>>),
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(super) enum RuleKind {
    Begin,
    End,
    Always,
    Pattern,
    Range,
}

#[derive(Debug)]
pub(super) struct Rule {
    pub(super) kind: RuleKind,
    pub(super) pattern: Option<Expr>,
    pub(super) end: Option<Expr>,
    pub(super) action: Option<Vec<Stmt>>,
}

#[derive(Debug)]
pub(super) struct Function {
    pub(super) name: Vec<u8>,
    pub(super) params: Vec<Vec<u8>>,
    pub(super) body: Vec<Stmt>,
}

#[derive(Debug, Default)]
pub(super) struct Program {
    pub(super) rules: Vec<Rule>,
    pub(super) functions: Vec<Function>,
}

const P_ASSIGN: u8 = 1;
const P_TERNARY: u8 = 2;
const P_OR: u8 = 3;
const P_AND: u8 = 4;
const P_IN: u8 = 5;
const P_MATCH: u8 = 6;
const P_COMPARE: u8 = 7;
const P_CONCAT: u8 = 8;
const P_ADD: u8 = 9;
const P_MUL: u8 = 10;
const P_UNARY: u8 = 11;
const P_POW: u8 = 12;

/// The builtins whose arguments mawk 1.3.4's grammar counts as it reads
/// them: a surplus or missing one is refused where the call goes wrong.
const GRAMMAR_BUILTINS: [&[u8]; 5] = [b"gsub", b"length", b"match", b"split", b"sub"];

type Parsed<T> = Result<T, Vec<u8>>;

struct Parser {
    toks: Vec<Token>,
    pos: usize,
    functions: Vec<Function>,
    loop_depth: usize,
    in_function: bool,
}

impl Parser {
    fn peek(&self, ahead: usize) -> &Token {
        let last = self.toks.len() - 1;
        &self.toks[(self.pos + ahead).min(last)]
    }

    fn next_token(&mut self) -> Token {
        let tok = self.peek(0).clone();
        if tok.kind != Kind::Eof {
            self.pos += 1;
        }
        tok
    }

    fn error(&self, message: &[u8]) -> Vec<u8> {
        let tok = self.peek(0);
        let near: &[u8] = if tok.kind == Kind::Eof {
            b"end of program"
        } else {
            &tok.text
        };
        [b"awk: syntax error at '", near, b"': ", message].concat()
    }

    fn at_op(&self, texts: &[&[u8]]) -> bool {
        let tok = self.peek(0);
        tok.kind == Kind::Op && texts.contains(&tok.text.as_slice())
    }

    fn at_keyword(&self, word: &[u8]) -> bool {
        let tok = self.peek(0);
        tok.kind == Kind::Keyword && tok.text == word
    }

    fn eat_op(&mut self, text: &[u8]) -> Parsed<()> {
        if !self.at_op(&[text]) {
            return Err(self.error(&[b"expected '", text, b"'"].concat()));
        }
        self.pos += 1;
        Ok(())
    }

    fn eat_keyword(&mut self, word: &[u8]) -> Parsed<()> {
        if !self.at_keyword(word) {
            return Err(self.error(&[b"expected '", word, b"'"].concat()));
        }
        self.pos += 1;
        Ok(())
    }

    fn skip_newlines(&mut self) {
        while self.peek(0).kind == Kind::Newline {
            self.pos += 1;
        }
    }

    fn skip_terminators(&mut self) {
        while self.peek(0).kind == Kind::Newline || self.at_op(&[b";"]) {
            self.pos += 1;
        }
    }

    fn at_stmt_end(&self) -> bool {
        matches!(self.peek(0).kind, Kind::Newline | Kind::Eof) || self.at_op(&[b"}", b";"])
    }

    fn at_redirect(&self) -> bool {
        self.at_op(&[b">", b">>", b"|"])
    }

    fn program(mut self) -> Parsed<Program> {
        let mut rules = Vec::new();
        self.skip_terminators();
        while self.peek(0).kind != Kind::Eof {
            if self.at_keyword(b"function") || self.at_keyword(b"func") {
                self.function()?;
            } else {
                rules.push(self.rule()?);
            }
            self.skip_terminators();
        }
        Ok(Program {
            rules,
            functions: self.functions,
        })
    }

    fn function(&mut self) -> Parsed<()> {
        self.next_token();
        let name = self.next_token();
        if !matches!(name.kind, Kind::Name | Kind::FuncName) {
            return Err(self.error(b"expected function name"));
        }
        self.eat_op(b"(")?;
        let mut params = Vec::new();
        self.skip_newlines();
        while !self.at_op(&[b")"]) {
            let tok = self.next_token();
            if tok.kind != Kind::Name {
                return Err(self.error(b"expected parameter name"));
            }
            params.push(tok.text);
            self.skip_newlines();
            if self.at_op(&[b","]) {
                self.pos += 1;
                self.skip_newlines();
            }
        }
        self.eat_op(b")")?;
        self.skip_newlines();
        self.in_function = true;
        let body = self.block()?;
        self.in_function = false;
        let function = Function {
            name: name.text,
            params,
            body,
        };
        match self.functions.iter_mut().find(|f| f.name == function.name) {
            Some(slot) => *slot = function,
            None => self.functions.push(function),
        }
        Ok(())
    }

    fn rule(&mut self) -> Parsed<Rule> {
        let edge = |kind, action| Rule {
            kind,
            pattern: None,
            end: None,
            action: Some(action),
        };
        if self.at_keyword(b"BEGIN") || self.at_keyword(b"END") {
            let kind = if self.at_keyword(b"BEGIN") {
                RuleKind::Begin
            } else {
                RuleKind::End
            };
            self.pos += 1;
            self.skip_newlines();
            return Ok(edge(kind, self.block()?));
        }
        if self.at_op(&[b"{"]) {
            return Ok(edge(RuleKind::Always, self.block()?));
        }
        let pattern = self.expr(P_ASSIGN, false)?;
        let mut end = None;
        if self.at_op(&[b","]) {
            self.pos += 1;
            self.skip_newlines();
            end = Some(self.expr(P_ASSIGN, false)?);
        }
        let action = if self.at_op(&[b"{"]) {
            Some(self.block()?)
        } else {
            None
        };
        Ok(Rule {
            kind: if end.is_some() {
                RuleKind::Range
            } else {
                RuleKind::Pattern
            },
            pattern: Some(pattern),
            end,
            action,
        })
    }

    fn block(&mut self) -> Parsed<Vec<Stmt>> {
        self.eat_op(b"{")?;
        let mut body = Vec::new();
        self.skip_terminators();
        while !self.at_op(&[b"}"]) {
            if self.peek(0).kind == Kind::Eof {
                return Err(self.error(b"unexpected end of program, expected '}'"));
            }
            body.push(self.statement()?);
            self.skip_terminators();
        }
        self.eat_op(b"}")?;
        Ok(body)
    }

    fn simple_or_block(&mut self) -> Parsed<Stmt> {
        self.skip_newlines();
        if self.at_op(&[b"{"]) {
            return Ok(Stmt::Block(self.block()?));
        }
        self.statement()
    }

    fn loop_body(&mut self) -> Parsed<Stmt> {
        self.loop_depth += 1;
        let body = self.simple_or_block();
        self.loop_depth -= 1;
        body
    }

    fn statement(&mut self) -> Parsed<Stmt> {
        if self.at_op(&[b"{"]) {
            return Ok(Stmt::Block(self.block()?));
        }
        if self.at_op(&[b";"]) {
            self.pos += 1;
            return Ok(Stmt::Block(Vec::new()));
        }
        let tok = self.peek(0).clone();
        if tok.kind == Kind::Keyword {
            match tok.text.as_slice() {
                b"if" => return self.if_stmt(),
                b"while" => {
                    self.pos += 1;
                    let cond = self.condition()?;
                    return Ok(Stmt::While(cond, Box::new(self.loop_body()?)));
                }
                b"do" => return self.do_stmt(),
                b"for" => return self.for_stmt(),
                b"print" | b"printf" => return self.print(),
                b"delete" => return self.delete(),
                word @ (b"break" | b"continue" | b"next" | b"nextfile") => {
                    if matches!(word, b"break" | b"continue") && self.loop_depth == 0 {
                        return Err(self.error(&[word, b" outside a loop"].concat()));
                    }
                    self.pos += 1;
                    return Ok(match word {
                        b"break" => Stmt::Break,
                        b"continue" => Stmt::Continue,
                        b"next" => Stmt::Next,
                        _ => Stmt::NextFile,
                    });
                }
                word @ (b"exit" | b"return") => {
                    if word == b"return" && !self.in_function {
                        return Err(self.error(b"return outside a function"));
                    }
                    self.pos += 1;
                    let value = if self.at_stmt_end() {
                        None
                    } else {
                        Some(self.expr(P_ASSIGN, false)?)
                    };
                    return Ok(if word == b"exit" {
                        Stmt::Exit(value)
                    } else {
                        Stmt::Return(value)
                    });
                }
                _ => {}
            }
        }
        Ok(Stmt::Expr(self.expr(P_ASSIGN, false)?))
    }

    fn condition(&mut self) -> Parsed<Expr> {
        self.eat_op(b"(")?;
        let cond = self.expr(P_ASSIGN, false)?;
        self.eat_op(b")")?;
        Ok(cond)
    }

    fn if_stmt(&mut self) -> Parsed<Stmt> {
        self.eat_keyword(b"if")?;
        let cond = self.condition()?;
        let then = Box::new(self.simple_or_block()?);
        let save = self.pos;
        self.skip_terminators();
        if self.at_keyword(b"else") {
            self.pos += 1;
            let other = self.simple_or_block()?;
            return Ok(Stmt::If(cond, then, Some(Box::new(other))));
        }
        self.pos = save;
        Ok(Stmt::If(cond, then, None))
    }

    fn do_stmt(&mut self) -> Parsed<Stmt> {
        self.eat_keyword(b"do")?;
        let body = self.loop_body()?;
        self.skip_terminators();
        self.eat_keyword(b"while")?;
        let cond = self.condition()?;
        Ok(Stmt::Do(Box::new(body), cond))
    }

    fn for_stmt(&mut self) -> Parsed<Stmt> {
        self.eat_keyword(b"for")?;
        self.eat_op(b"(")?;
        if self.peek(0).kind == Kind::Name
            && self.peek(1).kind == Kind::Keyword
            && self.peek(1).text == b"in"
        {
            let var = self.next_token().text;
            self.pos += 1;
            let array = self.next_token();
            if array.kind != Kind::Name {
                return Err(self.error(b"expected array name"));
            }
            self.eat_op(b")")?;
            return Ok(Stmt::ForIn(var, array.text, Box::new(self.loop_body()?)));
        }
        let init = if self.at_op(&[b";"]) {
            None
        } else {
            Some(Box::new(self.statement()?))
        };
        self.eat_op(b";")?;
        self.skip_newlines();
        let cond = if self.at_op(&[b";"]) {
            None
        } else {
            Some(self.expr(P_ASSIGN, false)?)
        };
        self.eat_op(b";")?;
        self.skip_newlines();
        let post = if self.at_op(&[b")"]) {
            None
        } else {
            Some(Box::new(self.statement()?))
        };
        self.eat_op(b")")?;
        Ok(Stmt::For(init, cond, post, Box::new(self.loop_body()?)))
    }

    fn delete(&mut self) -> Parsed<Stmt> {
        self.eat_keyword(b"delete")?;
        let name = self.next_token();
        if !matches!(name.kind, Kind::Name | Kind::FuncName) {
            return Err(self.error(b"expected array name"));
        }
        for (open, close) in [(b"[", b"]"), (b"(", b")")] {
            if self.at_op(&[open]) {
                self.pos += 1;
                let subs = self.expr_list(close)?;
                self.eat_op(close)?;
                return Ok(Stmt::Delete(name.text, Some(subs)));
            }
        }
        Ok(Stmt::Delete(name.text, None))
    }

    fn expr_list(&mut self, closer: &[u8]) -> Parsed<Vec<Expr>> {
        let mut items = Vec::new();
        self.skip_newlines();
        if self.at_op(&[closer]) {
            return Ok(items);
        }
        items.push(self.expr(P_ASSIGN, false)?);
        while self.at_op(&[b","]) {
            self.pos += 1;
            self.skip_newlines();
            items.push(self.expr(P_ASSIGN, false)?);
        }
        Ok(items)
    }

    fn print(&mut self) -> Parsed<Stmt> {
        let formatted = self.next_token().text == b"printf";
        let args = if !self.at_stmt_end() && !self.at_redirect() {
            self.print_args()?
        } else {
            Vec::new()
        };
        let redirect = if self.at_redirect() {
            let kind = match self.next_token().text.as_slice() {
                b">" => RedirKind::File,
                b">>" => RedirKind::Append,
                _ => RedirKind::Pipe,
            };
            Some((kind, self.expr(P_CONCAT, false)?))
        } else {
            None
        };
        Ok(Stmt::Print(formatted, args, redirect))
    }

    /// A print statement's arguments: `print (a, b)` is tried first, and
    /// read again as a grouped expression when the parentheses turn out
    /// not to hold the whole list.
    fn print_args(&mut self) -> Parsed<Vec<Expr>> {
        if self.at_op(&[b"("]) {
            let save = self.pos;
            self.pos += 1;
            if let Ok(grouped) = self.expr_list(b")") {
                if grouped.len() > 1 && self.at_op(&[b")"]) {
                    self.pos += 1;
                    if self.at_stmt_end() || self.at_redirect() {
                        return Ok(grouped);
                    }
                }
            }
            self.pos = save;
        }
        let mut items = vec![self.expr(P_ASSIGN, true)?];
        while self.at_op(&[b","]) {
            self.pos += 1;
            self.skip_newlines();
            items.push(self.expr(P_ASSIGN, true)?);
        }
        Ok(items)
    }

    /// An expression by precedence climbing; under `no_gt` a `>`, `>>` or
    /// `|` ends it, as in a print statement.
    fn expr(&mut self, min_bp: u8, no_gt: bool) -> Parsed<Expr> {
        let left = self.unary(no_gt)?;
        self.infix(left, min_bp, no_gt)
    }

    fn unary(&mut self, no_gt: bool) -> Parsed<Expr> {
        if self.at_op(&[b"!"]) {
            self.pos += 1;
            return Ok(Expr::Not(Box::new(self.expr(P_UNARY, no_gt)?)));
        }
        if self.at_op(&[b"-", b"+"]) {
            let op = self.next_token().text[0];
            return Ok(Expr::Unary(op, Box::new(self.expr(P_UNARY, no_gt)?)));
        }
        if self.at_op(&[b"++", b"--"]) {
            return self.pre_increment(|parser| parser.unary(no_gt));
        }
        let node = self.primary(no_gt)?;
        let mut node = self.postfix(node);
        // `cmd | getline` takes the primary alone as its command (mawk
        // 1.3.4); in a print statement `|` is the output pipe instead.
        while !no_gt
            && self.at_op(&[b"|"])
            && self.peek(1).kind == Kind::Keyword
            && self.peek(1).text == b"getline"
        {
            self.pos += 1;
            node = self.getline(Some(node))?;
        }
        Ok(node)
    }

    fn pre_increment(&mut self, operand: impl FnOnce(&mut Self) -> Parsed<Expr>) -> Parsed<Expr> {
        let op = self.next_token().text;
        let target = operand(self)?;
        if !target.is_lvalue() {
            return Err(self.error(&[op.as_slice(), b" needs an lvalue"].concat()));
        }
        let delta = if op == b"++" { 1.0 } else { -1.0 };
        Ok(Expr::IncDec(true, delta, Box::new(target)))
    }

    fn postfix(&mut self, mut node: Expr) -> Expr {
        while self.at_op(&[b"++", b"--"]) && node.is_lvalue() {
            let delta = if self.next_token().text == b"++" {
                1.0
            } else {
                -1.0
            };
            node = Expr::IncDec(false, delta, Box::new(node));
        }
        node
    }

    fn primary(&mut self, no_gt: bool) -> Parsed<Expr> {
        let tok = self.peek(0).clone();
        match tok.kind {
            Kind::Number => {
                self.pos += 1;
                let value = std::str::from_utf8(&tok.text)
                    .ok()
                    .and_then(|text| text.parse::<f64>().ok())
                    .unwrap_or(0.0);
                Ok(Expr::Num(value))
            }
            Kind::String => {
                self.pos += 1;
                Ok(Expr::Str(tok.text))
            }
            Kind::Ere => {
                self.pos += 1;
                compile_ere(&tok.text)?;
                Ok(Expr::Regex(tok.text))
            }
            Kind::Op if tok.text == b"$" => {
                self.pos += 1;
                Ok(Expr::Field(Box::new(self.field_index(no_gt)?)))
            }
            Kind::Op if tok.text == b"(" => self.grouping(),
            Kind::Keyword if tok.text == b"getline" => self.getline(None),
            Kind::Builtin => {
                self.pos += 1;
                let name = BUILTINS
                    .iter()
                    .find(|(name, _, _)| *name == tok.text)
                    .map_or(&b""[..], |(name, _, _)| *name);
                Ok(Expr::Builtin(name, self.builtin_args(name)?))
            }
            Kind::FuncName => {
                self.pos += 1;
                self.eat_op(b"(")?;
                let args = self.expr_list(b")")?;
                self.eat_op(b")")?;
                Ok(Expr::Call(tok.text, args))
            }
            Kind::Name => {
                self.pos += 1;
                if self.at_op(&[b"["]) {
                    self.pos += 1;
                    let subs = self.expr_list(b"]")?;
                    self.eat_op(b"]")?;
                    return Ok(Expr::Index(tok.text, subs));
                }
                Ok(Expr::Var(tok.text))
            }
            _ => Err(self.error(b"expected an expression")),
        }
    }

    /// A builtin's arguments, counted as mawk 1.3.4 counts them: only
    /// `length` may go without parentheses, and the grammar builtins are
    /// refused at the token where the call goes wrong.
    fn builtin_args(&mut self, name: &[u8]) -> Parsed<Vec<Expr>> {
        if !self.at_op(&[b"("]) {
            if name == b"length" {
                return Ok(Vec::new());
            }
            return Err(self.error(b"expected '('"));
        }
        self.pos += 1;
        let (least, most) = BUILTINS
            .iter()
            .find(|(known, _, _)| *known == name)
            .map_or((0, 0), |&(_, least, most)| (least, most));
        if !GRAMMAR_BUILTINS.contains(&name) {
            let args = self.expr_list(b")")?;
            self.eat_op(b")")?;
            let count = args.len();
            let name = String::from_utf8_lossy(name);
            if count < least {
                return Err(format!(
                    "awk: not enough arguments in call to {name}: {count} (need {least})"
                )
                .into_bytes());
            }
            if count > most {
                return Err(format!(
                    "awk: too many arguments in call to {name}: {count} (maximum {most})"
                )
                .into_bytes());
            }
            return Ok(args);
        }
        let mut items = Vec::new();
        self.skip_newlines();
        while items.len() < most {
            if items.len() >= least && self.at_op(&[b")"]) {
                break;
            }
            if !items.is_empty() {
                self.eat_op(b",")?;
                self.skip_newlines();
            }
            items.push(self.expr(P_ASSIGN, false)?);
        }
        self.eat_op(b")")?;
        Ok(items)
    }

    /// `$` binds tighter than every binary operator, so `$NF-1` is
    /// `($NF)-1` and only a parenthesised index can be compound.
    fn field_index(&mut self, no_gt: bool) -> Parsed<Expr> {
        if self.at_op(&[b"("]) {
            return self.grouping();
        }
        if self.at_op(&[b"$"]) {
            self.pos += 1;
            return Ok(Expr::Field(Box::new(self.field_index(no_gt)?)));
        }
        if self.at_op(&[b"++", b"--"]) {
            return self.pre_increment(|parser| parser.field_index(no_gt));
        }
        if self.at_op(&[b"-"]) {
            self.pos += 1;
            return Ok(Expr::Unary(b'-', Box::new(self.field_index(no_gt)?)));
        }
        let node = self.primary(no_gt)?;
        Ok(self.postfix(node))
    }

    fn grouping(&mut self) -> Parsed<Expr> {
        self.eat_op(b"(")?;
        let mut items = self.expr_list(b")")?;
        self.eat_op(b")")?;
        if items.len() == 1 {
            return Ok(items.remove(0));
        }
        if self.at_keyword(b"in") {
            self.pos += 1;
            let name = self.next_token();
            if name.kind != Kind::Name {
                return Err(self.error(b"expected array name after 'in'"));
            }
            return Ok(Expr::In(items, name.text));
        }
        Err(self.error(b"unexpected expression list"))
    }

    fn getline(&mut self, command: Option<Expr>) -> Parsed<Expr> {
        self.eat_keyword(b"getline")?;
        let tok = self.peek(0);
        let target = if tok.kind == Kind::Name || (tok.kind == Kind::Op && tok.text == b"$") {
            let candidate = self.primary(true)?;
            if !candidate.is_lvalue() {
                return Err(self.error(b"getline needs an lvalue"));
            }
            Some(Box::new(candidate))
        } else {
            None
        };
        if let Some(command) = command {
            return Ok(Expr::Getline(
                GetlineKind::Command,
                target,
                Some(Box::new(command)),
            ));
        }
        if self.at_op(&[b"<"]) {
            // The file is a primary: `getline < "a" "b"` reads "a", and
            // `getline line < f > 0` compares the result (mawk 1.3.4).
            self.pos += 1;
            let name = self.primary(true)?;
            let name = self.postfix(name);
            return Ok(Expr::Getline(
                GetlineKind::File,
                target,
                Some(Box::new(name)),
            ));
        }
        Ok(Expr::Getline(GetlineKind::Plain, target, None))
    }

    fn starts_concat(&self) -> bool {
        let tok = self.peek(0);
        match tok.kind {
            Kind::Number
            | Kind::String
            | Kind::Ere
            | Kind::Name
            | Kind::FuncName
            | Kind::Builtin => true,
            Kind::Op => matches!(tok.text.as_slice(), b"$" | b"(" | b"++" | b"--" | b"!"),
            Kind::Keyword => tok.text == b"getline",
            _ => false,
        }
    }

    fn infix(&mut self, mut left: Expr, min_bp: u8, no_gt: bool) -> Parsed<Expr> {
        loop {
            let tok = self.peek(0);
            if tok.kind == Kind::Keyword && tok.text == b"in" {
                if P_IN < min_bp {
                    return Ok(left);
                }
                self.pos += 1;
                let name = self.next_token();
                if name.kind != Kind::Name {
                    return Err(self.error(b"expected array name after 'in'"));
                }
                left = Expr::In(vec![left], name.text);
                continue;
            }
            if tok.kind != Kind::Op {
                if self.starts_concat() && P_CONCAT >= min_bp {
                    let right = self.expr(P_CONCAT + 1, no_gt)?;
                    left = Expr::Concat(Box::new(left), Box::new(right));
                    continue;
                }
                return Ok(left);
            }
            let op = tok.text.clone();
            match op.as_slice() {
                b"=" | b"+=" | b"-=" | b"*=" | b"/=" | b"%=" | b"^=" => {
                    if P_ASSIGN < min_bp || !left.is_lvalue() {
                        return Ok(left);
                    }
                    self.pos += 1;
                    self.skip_newlines();
                    let value = self.expr(P_ASSIGN, no_gt)?;
                    let op = (op.len() == 2).then_some(op[0]);
                    return Ok(Expr::Assign(Box::new(left), op, Box::new(value)));
                }
                b"?" => {
                    if P_TERNARY < min_bp {
                        return Ok(left);
                    }
                    self.pos += 1;
                    self.skip_newlines();
                    let then = self.expr(P_ASSIGN, no_gt)?;
                    self.eat_op(b":")?;
                    self.skip_newlines();
                    let other = self.expr(P_TERNARY, no_gt)?;
                    left = Expr::Cond(Box::new(left), Box::new(then), Box::new(other));
                }
                b"||" | b"&&" => {
                    let and = op == b"&&";
                    let bp = if and { P_AND } else { P_OR };
                    if bp < min_bp {
                        return Ok(left);
                    }
                    self.pos += 1;
                    self.skip_newlines();
                    let right = self.expr(bp + 1, no_gt)?;
                    left = Expr::Logical(and, Box::new(left), Box::new(right));
                }
                b"~" | b"!~" => {
                    if P_MATCH < min_bp {
                        return Ok(left);
                    }
                    self.pos += 1;
                    let right = self.expr(P_MATCH + 1, no_gt)?;
                    left = Expr::Match(op == b"!~", Box::new(left), Box::new(right));
                }
                b"<" | b"<=" | b">" | b">=" | b"==" | b"!=" => {
                    if (no_gt && op == b">") || P_COMPARE < min_bp {
                        return Ok(left);
                    }
                    self.pos += 1;
                    let cmp = match op.as_slice() {
                        b"<" => Cmp::Lt,
                        b"<=" => Cmp::Le,
                        b">" => Cmp::Gt,
                        b">=" => Cmp::Ge,
                        b"==" => Cmp::Eq,
                        _ => Cmp::Ne,
                    };
                    let right = self.expr(P_COMPARE + 1, no_gt)?;
                    left = Expr::Compare(cmp, Box::new(left), Box::new(right));
                }
                b"+" | b"-" | b"*" | b"/" | b"%" | b"^" => {
                    let bp = match op[0] {
                        b'+' | b'-' => P_ADD,
                        b'^' => P_POW,
                        _ => P_MUL,
                    };
                    if bp < min_bp {
                        return Ok(left);
                    }
                    self.pos += 1;
                    // `^` is right-associative.
                    let next = if bp == P_POW { bp } else { bp + 1 };
                    let right = self.expr(next, no_gt)?;
                    left = Expr::Binary(op[0], Box::new(left), Box::new(right));
                }
                b"(" | b"$" | b"++" | b"--" | b"!" => {
                    if P_CONCAT < min_bp {
                        return Ok(left);
                    }
                    let right = self.expr(P_CONCAT + 1, no_gt)?;
                    left = Expr::Concat(Box::new(left), Box::new(right));
                }
                _ => return Ok(left),
            }
        }
    }
}

/// Parse a program; a refusal is the message awk prints.
pub(super) fn parse(src: &[u8]) -> Parsed<Program> {
    Parser {
        toks: tokenize(src)?,
        pos: 0,
        functions: Vec::new(),
        loop_depth: 0,
        in_function: false,
    }
    .program()
}
