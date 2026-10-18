use super::common::{BinaryOp, Budget, Builtin, MathFunction};
use super::source::Line;

#[derive(Clone, Debug)]
pub(super) enum Place {
    Scale,
    InputBase,
    OutputBase,
    Last,
    Variable(String),
}

impl Place {
    fn from_name(name: &str) -> Option<Self> {
        match name {
            "scale" => Some(Self::Scale),
            "ibase" => Some(Self::InputBase),
            "obase" => Some(Self::OutputBase),
            "last" | "." => Some(Self::Last),
            name if !reserved(name) => Some(Self::Variable(name.to_owned())),
            _ => None,
        }
    }
}

#[derive(Clone, Debug)]
pub(super) enum Call {
    Builtin(Builtin),
    Math(MathFunction),
    Undefined(String),
}

#[derive(Clone, Debug)]
pub(super) enum Instruction {
    Literal(String),
    Load(Place),
    Negate,
    Binary(BinaryOp),
    Store(Place),
    CompoundStore(Place, BinaryOp),
    Step(Place, i64, bool),
    Call(Call),
    Drop,
    Emit,
    Text(String),
    Newline,
    Halt,
}

#[derive(Clone, Debug)]
pub(super) struct LocatedInstruction {
    pub(super) operation: Instruction,
    pub(super) line: u64,
}

pub(super) struct Program {
    pub(super) instructions: Vec<LocatedInstruction>,
    pub(super) quits: bool,
}

pub(super) enum CompileResult {
    Program(Program),
    Refused {
        diagnostics: Vec<String>,
        quits: bool,
    },
}

#[derive(Debug)]
enum TokenKind {
    Name(String),
    Number { text: String, valid: bool },
    Text { raw: String, printed: String },
    Symbol(String),
    Illegal(char),
}

#[derive(Debug)]
struct Token {
    kind: TokenKind,
    line: u64,
}

fn reserved(name: &str) -> bool {
    matches!(
        name,
        "scale"
            | "ibase"
            | "obase"
            | "last"
            | "sqrt"
            | "length"
            | "read"
            | "define"
            | "auto"
            | "return"
            | "if"
            | "else"
            | "while"
            | "for"
            | "break"
            | "continue"
            | "halt"
            | "quit"
            | "print"
            | "limits"
            | "warranty"
    )
}

fn binary(symbol: &str) -> Option<BinaryOp> {
    match symbol {
        "+" => Some(BinaryOp::Add),
        "-" => Some(BinaryOp::Subtract),
        "*" => Some(BinaryOp::Multiply),
        "/" => Some(BinaryOp::Divide),
        "%" => Some(BinaryOp::Remainder),
        "^" => Some(BinaryOp::Pow),
        _ => None,
    }
}

fn is_number(character: char) -> bool {
    character.is_ascii_digit() || character.is_ascii_uppercase() || character == '.'
}

fn is_name(character: char) -> bool {
    character.is_ascii_lowercase() || character.is_ascii_digit() || character == '_'
}

#[derive(Default)]
enum Lexing {
    #[default]
    Start,
    Boundary {
        line: u64,
        final_line: bool,
    },
    Name {
        text: String,
        line: u64,
    },
    Number {
        text: String,
        line: u64,
        dots: u32,
    },
    Text {
        raw: String,
        printed: String,
        escaped: bool,
        line: u64,
    },
}

#[derive(Clone)]
enum Task {
    Expr,
    Add,
    AddTail,
    Term,
    TermTail,
    Unary,
    Power,
    PowerTail,
    Atom,
    Close,
    Apply(Instruction),
    Print,
    PrintTail,
    End,
}

struct Statement {
    start: usize,
    end: usize,
    incomplete_line: u64,
}

pub(super) struct Compiler {
    source: Line,
    offset: usize,
    lexing: Lexing,
    tokens: Vec<Token>,
    statements: Vec<Statement>,
    token_start: usize,
    quote_index: usize,
    lexed: bool,
    quits: bool,
    statement: usize,
    pos: usize,
    tasks: Vec<Task>,
    instructions: Vec<LocatedInstruction>,
    diagnostics: Vec<String>,
}

impl Compiler {
    pub(super) fn new(source: Line) -> Self {
        Self {
            source,
            offset: 0,
            lexing: Lexing::Start,
            tokens: Vec::new(),
            statements: Vec::new(),
            token_start: 0,
            quote_index: 0,
            lexed: false,
            quits: false,
            statement: 0,
            pos: 0,
            tasks: Vec::new(),
            instructions: Vec::new(),
            diagnostics: Vec::new(),
        }
    }

    fn token(&mut self, kind: TokenKind, line: u64) {
        if matches!(&kind, TokenKind::Name(name) if name == "quit") {
            self.quits = true;
            if self.token_start != self.tokens.len() {
                self.tokens.push(Token { kind, line });
            }
            self.offset = self.source.chars.len();
        } else {
            self.tokens.push(Token { kind, line });
        }
    }

    fn lex_step(&mut self) {
        let current = self.source.chars.get(self.offset).copied();
        match std::mem::take(&mut self.lexing) {
            Lexing::Boundary { line, final_line } => {
                if self.tokens.len() > self.token_start
                    && matches!(
                        self.tokens.last(),
                        Some(Token {
                            kind: TokenKind::Illegal('\r' | '\x0b' | '\x0c'),
                            ..
                        })
                    )
                {
                    self.tokens.pop();
                    self.lexing = Lexing::Boundary { line, final_line };
                } else {
                    if self.token_start < self.tokens.len() {
                        self.statements.push(Statement {
                            start: self.token_start,
                            end: self.tokens.len(),
                            incomplete_line: line,
                        });
                    }
                    self.token_start = self.tokens.len();
                    self.lexed = final_line;
                }
            }
            Lexing::Name { mut text, line } => {
                if current.is_some_and(is_name) {
                    text.push(current.unwrap());
                    self.offset += 1;
                    self.lexing = Lexing::Name { text, line };
                } else {
                    self.token(TokenKind::Name(text), line);
                }
            }
            Lexing::Number {
                mut text,
                line,
                mut dots,
            } => {
                if current.is_some_and(is_number) {
                    let character = current.unwrap();
                    text.push(character);
                    dots = dots.saturating_add(u32::from(character == '.'));
                    self.offset += 1;
                    self.lexing = Lexing::Number { text, line, dots };
                } else {
                    self.token(
                        TokenKind::Number {
                            text,
                            valid: dots <= 1,
                        },
                        line,
                    );
                }
            }
            Lexing::Text {
                mut raw,
                mut printed,
                mut escaped,
                line,
            } => {
                if let Some(character) = current {
                    self.offset += 1;
                    if character == '"' {
                        self.token(TokenKind::Text { raw, printed }, line);
                    } else {
                        raw.push(character);
                        if escaped {
                            if let Some(character) = escape(character) {
                                printed.push(character);
                            }
                            escaped = false;
                        } else if character == '\\' {
                            escaped = true;
                        } else {
                            printed.push(character);
                        }
                        self.lexing = Lexing::Text {
                            raw,
                            printed,
                            escaped,
                            line,
                        };
                    }
                } else {
                    self.token(TokenKind::Illegal('"'), line);
                }
            }
            Lexing::Start => {
                let Some(character) = current else {
                    self.lexing = Lexing::Boundary {
                        line: self.source.end_line.saturating_add(1),
                        final_line: true,
                    };
                    return;
                };
                let line = self.source.lines[self.offset];
                self.offset += 1;
                if matches!(character, ' ' | '\t')
                    || (matches!(character, '\r' | '\x0b' | '\x0c')
                        && self.tokens.len() == self.token_start)
                {
                    return;
                }
                if character == ';' {
                    self.lexing = Lexing::Boundary {
                        line,
                        final_line: false,
                    };
                } else if character.is_ascii_lowercase() {
                    self.lexing = Lexing::Name {
                        text: character.to_string(),
                        line,
                    };
                } else if character.is_ascii_digit()
                    || character.is_ascii_uppercase()
                    || (character == '.'
                        && self
                            .source
                            .chars
                            .get(self.offset)
                            .is_some_and(|c| c.is_ascii_digit() || c.is_ascii_uppercase()))
                {
                    self.lexing = Lexing::Number {
                        text: character.to_string(),
                        line,
                        dots: u32::from(character == '.'),
                    };
                } else if character == '"' {
                    if self.source.quotes.get(self.quote_index) == Some(&(self.offset - 1)) {
                        self.quote_index += 1;
                        self.lexing = Lexing::Text {
                            raw: String::new(),
                            printed: String::new(),
                            escaped: false,
                            line,
                        };
                    } else {
                        self.token(TokenKind::Illegal(character), line);
                    }
                } else {
                    let mut symbol = character.to_string();
                    if self.source.chars.get(self.offset).is_some_and(|next| {
                        (*next == character && matches!(character, '+' | '-' | '='))
                            || (*next == '='
                                && matches!(character, '+' | '-' | '*' | '/' | '%' | '^'))
                    }) {
                        symbol.push(self.source.chars[self.offset]);
                        self.offset += 1;
                    }
                    if ".+-*/%^=<>!()[]{},\\#".contains(character) {
                        self.token(TokenKind::Symbol(symbol), line);
                    } else {
                        self.token(TokenKind::Illegal(character), line);
                    }
                }
            }
        }
    }

    fn end(&self) -> usize {
        self.statements[self.statement].end
    }

    fn symbol(&self, symbol: &str) -> bool {
        self.pos < self.end()
            && matches!(&self.tokens[self.pos].kind, TokenKind::Symbol(value) if value == symbol)
    }

    fn name(&self) -> Option<&str> {
        if self.pos >= self.end() {
            return None;
        }
        match &self.tokens[self.pos].kind {
            TokenKind::Name(name) => Some(name),
            TokenKind::Symbol(name) if name == "." => Some(name),
            _ => None,
        }
    }

    fn line(&self) -> u64 {
        self.tokens
            .get(self.pos)
            .map_or(self.statements[self.statement].incomplete_line, |token| {
                token.line
            })
    }

    fn emit(&mut self, operation: Instruction) {
        self.instructions.push(LocatedInstruction {
            operation,
            line: self.line(),
        });
    }

    fn fail(&mut self, at: Option<(u64, bool)>) {
        let incomplete = self.pos >= self.end();
        let mut line = if incomplete {
            self.statements[self.statement].incomplete_line
        } else {
            self.line()
        };
        let mut reason = "syntax error".to_owned();
        if let Some((at_line, use_incomplete)) = at {
            if !use_incomplete || !incomplete {
                line = at_line;
            }
        } else if let Some(Token {
            kind: TokenKind::Illegal(character),
            ..
        }) = self.tokens.get(self.pos).filter(|_| !incomplete)
        {
            reason = format!("illegal character: {character}");
        }
        self.diagnostics
            .push(format!("(standard_in) {line}: {reason}\n"));
        self.tasks.clear();
        self.statement += 1;
    }

    fn assignment(&mut self) -> Option<Instruction> {
        let place = Place::from_name(self.name()?)?;
        if self.pos + 1 >= self.end() {
            return None;
        }
        let TokenKind::Symbol(symbol) = &self.tokens[self.pos + 1].kind else {
            return None;
        };
        let instruction = if symbol == "=" {
            Instruction::Store(place)
        } else if symbol.ends_with('=') && symbol.len() == 2 {
            Instruction::CompoundStore(place, binary(&symbol[..1])?)
        } else {
            return None;
        };
        self.pos += 2;
        Some(instruction)
    }

    fn start_statement(&mut self) {
        self.pos = self.statements[self.statement].start;
        self.tasks.push(Task::End);
        if self.name() == Some("halt") && self.pos + 1 == self.end() {
            self.pos += 1;
            self.emit(Instruction::Halt);
        } else if matches!(&self.tokens[self.pos].kind, TokenKind::Text { .. }) {
            let TokenKind::Text { raw, .. } = std::mem::replace(
                &mut self.tokens[self.pos].kind,
                TokenKind::Symbol(String::new()),
            ) else {
                unreachable!()
            };
            self.emit(Instruction::Text(raw));
            self.pos += 1;
        } else if self.name() == Some("print") {
            self.pos += 1;
            self.tasks.push(Task::Print);
        } else if let Some(store) = self.assignment() {
            self.tasks.push(Task::Apply(Instruction::Drop));
            self.tasks.push(Task::Apply(store));
            self.tasks.push(Task::Expr);
        } else {
            self.tasks.push(Task::Apply(Instruction::Newline));
            self.tasks.push(Task::Apply(Instruction::Emit));
            self.tasks.push(Task::Expr);
        }
    }

    fn parse_step(&mut self, task: Task) {
        match task {
            Task::Expr => {
                if let Some(store) = self.assignment() {
                    self.tasks.push(Task::Apply(store));
                    self.tasks.push(Task::Expr);
                } else {
                    self.tasks.push(Task::Add);
                }
            }
            Task::Add => self.tasks.extend([Task::AddTail, Task::Term]),
            Task::AddTail => {
                if self.symbol("+") || self.symbol("-") {
                    let op = if self.symbol("+") {
                        BinaryOp::Add
                    } else {
                        BinaryOp::Subtract
                    };
                    self.pos += 1;
                    self.tasks.extend([
                        Task::AddTail,
                        Task::Apply(Instruction::Binary(op)),
                        Task::Term,
                    ]);
                }
            }
            Task::Term => self.tasks.extend([Task::TermTail, Task::Unary]),
            Task::TermTail => {
                if self.symbol("*") || self.symbol("/") || self.symbol("%") {
                    let TokenKind::Symbol(symbol) = &self.tokens[self.pos].kind else {
                        unreachable!()
                    };
                    let op = binary(symbol).unwrap();
                    self.pos += 1;
                    self.tasks.extend([
                        Task::TermTail,
                        Task::Apply(Instruction::Binary(op)),
                        Task::Unary,
                    ]);
                }
            }
            Task::Unary => {
                if self.symbol("++") || self.symbol("--") {
                    let delta = if self.symbol("++") { 1 } else { -1 };
                    self.pos += 1;
                    let target = self.name().map(str::to_owned);
                    if target.is_some() {
                        self.pos += 1;
                    }
                    if let Some(place) = target.as_deref().and_then(Place::from_name) {
                        self.emit(Instruction::Step(place, delta, false));
                    } else {
                        self.fail(None);
                    }
                } else if self.symbol("-") {
                    self.pos += 1;
                    self.tasks
                        .extend([Task::Apply(Instruction::Negate), Task::Unary]);
                } else {
                    self.tasks.push(Task::Power);
                }
            }
            Task::Power => self.tasks.extend([Task::PowerTail, Task::Atom]),
            Task::PowerTail => {
                if self.symbol("^") {
                    self.pos += 1;
                    self.tasks
                        .extend([Task::Apply(Instruction::Binary(BinaryOp::Pow)), Task::Unary]);
                }
            }
            Task::Atom => {
                if self.symbol("(") {
                    self.pos += 1;
                    self.tasks.extend([Task::Close, Task::Expr]);
                } else if self.pos < self.end()
                    && matches!(&self.tokens[self.pos].kind, TokenKind::Number { .. })
                {
                    let TokenKind::Number { text: raw, valid } = std::mem::replace(
                        &mut self.tokens[self.pos].kind,
                        TokenKind::Symbol(String::new()),
                    ) else {
                        unreachable!()
                    };
                    if !valid {
                        self.fail(Some((self.line(), false)));
                    } else {
                        self.emit(Instruction::Literal(raw));
                        self.pos += 1;
                    }
                } else if let Some(name) = self.name().map(str::to_owned) {
                    let start_line = self.line();
                    self.pos += 1;
                    let builtin = match name.as_str() {
                        "sqrt" => Some(Builtin::Sqrt),
                        "length" => Some(Builtin::Length),
                        "scale" => Some(Builtin::Scale),
                        _ => None,
                    };
                    if self.symbol("(") && (builtin.is_some() || (!reserved(&name) && name != "."))
                    {
                        self.pos += 1;
                        let call = if let Some(function) = builtin {
                            Call::Builtin(function)
                        } else {
                            match name.as_str() {
                                "s" => Call::Math(MathFunction::Sin),
                                "c" => Call::Math(MathFunction::Cos),
                                "a" => Call::Math(MathFunction::Atan),
                                "l" => Call::Math(MathFunction::Log),
                                "e" => Call::Math(MathFunction::Exp),
                                _ => Call::Undefined(name),
                            }
                        };
                        self.tasks.extend([
                            Task::Apply(Instruction::Call(call)),
                            Task::Close,
                            Task::Expr,
                        ]);
                    } else if builtin.is_some() && name != "scale" {
                        self.fail(Some((start_line, true)));
                    } else if let Some(place) = Place::from_name(&name) {
                        if self.symbol("++") || self.symbol("--") {
                            let delta = if self.symbol("++") { 1 } else { -1 };
                            self.emit(Instruction::Step(place, delta, true));
                            self.pos += 1;
                        } else {
                            self.emit(Instruction::Load(place));
                        }
                    } else {
                        self.fail(Some((start_line, false)));
                    }
                } else {
                    self.fail(None);
                }
            }
            Task::Close => {
                if self.symbol(")") {
                    self.pos += 1;
                } else {
                    self.fail(None);
                }
            }
            Task::Apply(instruction) => self.emit(instruction),
            Task::Print => {
                self.tasks.push(Task::PrintTail);
                if self.pos < self.end()
                    && matches!(&self.tokens[self.pos].kind, TokenKind::Text { .. })
                {
                    let TokenKind::Text { printed, .. } = std::mem::replace(
                        &mut self.tokens[self.pos].kind,
                        TokenKind::Symbol(String::new()),
                    ) else {
                        unreachable!()
                    };
                    self.emit(Instruction::Text(printed));
                    self.pos += 1;
                } else {
                    self.tasks
                        .extend([Task::Apply(Instruction::Emit), Task::Expr]);
                }
            }
            Task::PrintTail => {
                if self.symbol(",") {
                    self.pos += 1;
                    self.tasks.push(Task::Print);
                }
            }
            Task::End => {
                if self.pos < self.end() {
                    self.fail(None);
                } else {
                    self.statement += 1;
                }
            }
        }
    }

    pub(super) fn advance(&mut self, budget: &mut Budget) -> bool {
        while budget.take() {
            if !self.lexed {
                self.lex_step();
            } else if let Some(task) = self.tasks.pop() {
                self.parse_step(task);
            } else if self.statement < self.statements.len() {
                self.start_statement();
            } else {
                return true;
            }
        }
        false
    }

    pub(super) fn finish(self) -> CompileResult {
        if self.diagnostics.is_empty() {
            CompileResult::Program(Program {
                instructions: self.instructions,
                quits: self.quits,
            })
        } else {
            CompileResult::Refused {
                diagnostics: self.diagnostics,
                quits: self.quits,
            }
        }
    }
}

fn escape(character: char) -> Option<char> {
    match character {
        'a' => Some('\x07'),
        'b' => Some('\x08'),
        'f' => Some('\x0c'),
        'n' => Some('\n'),
        'q' => Some('"'),
        'r' => Some('\r'),
        't' => Some('\t'),
        '\\' => Some('\\'),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bc::source::{FrontEvent, FrontStep, Source};

    fn compile(input: &str) -> CompileResult {
        let mut source = Source::new();
        source.feed(input.as_bytes());
        source.finish();
        let line = loop {
            match source.advance(&mut Budget::new(3)) {
                FrontStep::Event(FrontEvent::Program(line)) => break line,
                FrontStep::Pending => {}
                _ => panic!("expected logical line"),
            }
        };
        let mut compiler = Compiler::new(line);
        while !compiler.advance(&mut Budget::new(3)) {}
        compiler.finish()
    }

    #[test]
    fn syntax_refuses_each_bad_statement_before_execution() {
        let CompileResult::Refused { diagnostics, quits } = compile("x=5;1/0;1 2;1+\n") else {
            panic!("expected refusal")
        };
        assert!(!quits);
        assert_eq!(
            diagnostics,
            [
                "(standard_in) 1: syntax error\n",
                "(standard_in) 2: syntax error\n"
            ]
        );
    }

    #[test]
    fn input_depth_uses_parser_tasks() {
        let input = format!("{}7{}\n", "(".repeat(32_000), ")".repeat(32_000));
        let CompileResult::Program(program) = compile(&input) else {
            panic!("expected program")
        };
        assert_eq!(program.instructions.len(), 3);
    }

    #[test]
    fn quit_cuts_lexically_but_halt_is_an_instruction() {
        let CompileResult::Program(program) = compile("print \"quit\";1+1;quit;@\n") else {
            panic!("expected program")
        };
        assert!(program.quits);
        let CompileResult::Refused { diagnostics, .. } = compile("1+1;halt;1 2\n") else {
            panic!("expected refusal")
        };
        assert_eq!(diagnostics, ["(standard_in) 1: syntax error\n"]);
    }
}
