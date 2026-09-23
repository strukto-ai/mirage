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

from mirage.core.awk.errors import AwkSyntaxError
from mirage.core.awk.lexer import Token, TokKind, tokenize
# yapf: disable
from mirage.core.awk.nodes import Binary  # yapf: disable
from mirage.core.awk.nodes import (ArrayRef, Assign, Block, Break, BuiltinCall,
                                   Call, Compare, Concat, Continue, Delete,
                                   DoWhile, Exit, Expr, ExprStmt, Field, For,
                                   ForIn, FuncDef, Getline, GetlineKind, If,
                                   InArray, IncDec, Logical, MatchOp, Next,
                                   NextFile, Not, Num, Print, Printf, Program,
                                   Redirect, RedirKind, Regex, Return, Rule,
                                   RuleKind, Stmt, Str, Ternary, Unary, Var,
                                   While)
# yapf: enable
from mirage.core.awk.regex import compile_ere

P_ASSIGN = 1
P_TERNARY = 2
P_OR = 3
P_AND = 4
P_IN = 5
P_GETLINE_PIPE = 6
P_MATCH = 7
P_COMPARE = 8
P_CONCAT = 9
P_ADD = 10
P_MUL = 11
P_UNARY = 12
P_POW = 13

ASSIGN_OPS = frozenset({"=", "+=", "-=", "*=", "/=", "%=", "^="})
COMPARE_OPS = frozenset({"<", "<=", ">", ">=", "==", "!="})
ADD_OPS = frozenset({"+", "-"})
MUL_OPS = frozenset({"*", "/", "%"})

CONCAT_START_KINDS = frozenset({
    TokKind.NUMBER, TokKind.STRING, TokKind.ERE, TokKind.NAME,
    TokKind.FUNC_NAME, TokKind.BUILTIN
})

CONCAT_START_OPS = frozenset({"$", "(", "++", "--", "!"})

LVALUE_TYPES = (Var, Field, ArrayRef)

STMT_KEYWORDS = frozenset({
    "if", "while", "for", "do", "break", "continue", "next", "nextfile",
    "exit", "return", "delete", "print", "printf", "getline"
})


class Parser:

    def __init__(self, tokens: list[Token]) -> None:
        self.toks = tokens
        self.pos = 0
        self.funcs: dict[str, FuncDef] = {}
        self.loop_depth = 0
        self.in_function = False

    def peek(self, ahead: int = 0) -> Token:
        idx = self.pos + ahead
        return self.toks[idx] if idx < len(self.toks) else self.toks[-1]

    def next_token(self) -> Token:
        tok = self.peek()
        if tok.kind is not TokKind.EOF:
            self.pos += 1
        return tok

    def error(self, message: str) -> AwkSyntaxError:
        """Build a syntax error naming the current token.

        Args:
            message (str): human readable reason.
        """
        tok = self.peek()
        near = tok.text if tok.kind is not TokKind.EOF else "end of program"
        return AwkSyntaxError(f"awk: syntax error at '{near}': {message}")

    def at_op(self, *texts: str) -> bool:
        tok = self.peek()
        return tok.kind is TokKind.OP and tok.text in texts

    def at_keyword(self, *words: str) -> bool:
        tok = self.peek()
        return tok.kind is TokKind.KEYWORD and tok.text in words

    def eat_op(self, text: str) -> None:
        if not self.at_op(text):
            raise self.error(f"expected '{text}'")
        self.pos += 1

    def eat_keyword(self, word: str) -> None:
        if not self.at_keyword(word):
            raise self.error(f"expected '{word}'")
        self.pos += 1

    def skip_newlines(self) -> None:
        while self.peek().kind is TokKind.NEWLINE:
            self.pos += 1

    def skip_terminators(self) -> None:
        while self.peek().kind is TokKind.NEWLINE or self.at_op(";"):
            self.pos += 1

    def at_stmt_end(self) -> bool:
        tok = self.peek()
        return (tok.kind in (TokKind.NEWLINE, TokKind.EOF)
                or (tok.kind is TokKind.OP and tok.text in ("}", ";")))

    def parse_program(self) -> Program:
        """Parse a whole awk program into rules and function definitions.

        Returns:
            Program: the parsed rules in source order plus functions.
        """
        rules: list[Rule] = []
        self.skip_terminators()
        while self.peek().kind is not TokKind.EOF:
            if self.at_keyword("function", "func"):
                self.parse_function()
            else:
                rules.append(self.parse_rule())
            self.skip_terminators()
        return Program(tuple(rules), self.funcs)

    def parse_function(self) -> None:
        self.next_token()
        name_tok = self.next_token()
        if name_tok.kind not in (TokKind.NAME, TokKind.FUNC_NAME):
            raise self.error("expected function name")
        self.eat_op("(")
        params: list[str] = []
        self.skip_newlines()
        while not self.at_op(")"):
            tok = self.next_token()
            if tok.kind is not TokKind.NAME:
                raise self.error("expected parameter name")
            params.append(tok.text)
            self.skip_newlines()
            if self.at_op(","):
                self.pos += 1
                self.skip_newlines()
        self.eat_op(")")
        self.skip_newlines()
        self.in_function = True
        body = self.parse_block()
        self.in_function = False
        self.funcs[name_tok.text] = FuncDef(name_tok.text, tuple(params), body)

    def parse_rule(self) -> Rule:
        if self.at_keyword("BEGIN"):
            self.pos += 1
            self.skip_newlines()
            return Rule(RuleKind.BEGIN, None, None, self.parse_block())
        if self.at_keyword("END"):
            self.pos += 1
            self.skip_newlines()
            return Rule(RuleKind.END, None, None, self.parse_block())
        if self.at_op("{"):
            return Rule(RuleKind.ALWAYS, None, None, self.parse_block())
        pattern = self.parse_expr(P_ASSIGN)
        if self.at_op(","):
            self.pos += 1
            self.skip_newlines()
            end_pattern = self.parse_expr(P_ASSIGN)
            action = self.parse_block() if self.at_op("{") else None
            return Rule(RuleKind.RANGE, pattern, end_pattern, action)
        action = self.parse_block() if self.at_op("{") else None
        return Rule(RuleKind.PATTERN, pattern, None, action)

    def parse_block(self) -> Block:
        self.eat_op("{")
        body: list[Stmt] = []
        self.skip_terminators()
        while not self.at_op("}"):
            if self.peek().kind is TokKind.EOF:
                raise self.error("unexpected end of program, expected '}'")
            body.append(self.parse_statement())
            self.skip_terminators()
        self.eat_op("}")
        return Block(tuple(body))

    def parse_simple_or_block(self) -> Stmt:
        self.skip_newlines()
        if self.at_op("{"):
            return self.parse_block()
        return self.parse_statement()

    def parse_loop_body(self) -> Stmt:
        self.loop_depth += 1
        body = self.parse_simple_or_block()
        self.loop_depth -= 1
        return body

    def parse_statement(self) -> Stmt:
        if self.at_op("{"):
            return self.parse_block()
        if self.at_op(";"):
            self.pos += 1
            return Block(())
        tok = self.peek()
        if tok.kind is TokKind.KEYWORD:
            if tok.text == "if":
                return self.parse_if()
            if tok.text == "while":
                return self.parse_while()
            if tok.text == "do":
                return self.parse_do_while()
            if tok.text == "for":
                return self.parse_for()
            if tok.text in ("print", "printf"):
                return self.parse_print()
            if tok.text == "delete":
                return self.parse_delete()
            if tok.text in ("break", "continue", "next", "nextfile"):
                if tok.text in ("break", "continue") and not self.loop_depth:
                    raise self.error(f"{tok.text} outside a loop")
                self.pos += 1
                return self.simple_jump(tok.text)
            if tok.text in ("exit", "return"):
                if tok.text == "return" and not self.in_function:
                    raise self.error("return outside a function")
                self.pos += 1
                value = None if self.at_stmt_end() else self.parse_expr(
                    P_ASSIGN)
                return Exit(value) if tok.text == "exit" else Return(value)
        return ExprStmt(self.parse_expr(P_ASSIGN))

    def simple_jump(self, word: str) -> Stmt:
        """Build the argument-free control-flow statement for a keyword.

        Args:
            word (str): one of break, continue, next, nextfile.
        """
        if word == "break":
            return Break()
        if word == "continue":
            return Continue()
        if word == "next":
            return Next()
        return NextFile()

    def parse_if(self) -> Stmt:
        self.eat_keyword("if")
        self.eat_op("(")
        cond = self.parse_expr(P_ASSIGN)
        self.eat_op(")")
        then = self.parse_simple_or_block()
        save = self.pos
        self.skip_terminators()
        if self.at_keyword("else"):
            self.pos += 1
            return If(cond, then, self.parse_simple_or_block())
        self.pos = save
        return If(cond, then, None)

    def parse_while(self) -> Stmt:
        self.eat_keyword("while")
        self.eat_op("(")
        cond = self.parse_expr(P_ASSIGN)
        self.eat_op(")")
        return While(cond, self.parse_loop_body())

    def parse_do_while(self) -> Stmt:
        self.eat_keyword("do")
        body = self.parse_loop_body()
        self.skip_terminators()
        self.eat_keyword("while")
        self.eat_op("(")
        cond = self.parse_expr(P_ASSIGN)
        self.eat_op(")")
        return DoWhile(body, cond)

    def parse_for(self) -> Stmt:
        self.eat_keyword("for")
        self.eat_op("(")
        if (self.peek().kind is TokKind.NAME
                and self.peek(1).kind is TokKind.KEYWORD
                and self.peek(1).text == "in"):
            var = self.next_token().text
            self.pos += 1
            array = self.next_token()
            if array.kind is not TokKind.NAME:
                raise self.error("expected array name")
            self.eat_op(")")
            return ForIn(var, array.text, self.parse_loop_body())
        init = None if self.at_op(";") else self.parse_statement()
        self.eat_op(";")
        self.skip_newlines()
        cond = None if self.at_op(";") else self.parse_expr(P_ASSIGN)
        self.eat_op(";")
        self.skip_newlines()
        post = None if self.at_op(")") else self.parse_statement()
        self.eat_op(")")
        return For(init, cond, post, self.parse_loop_body())

    def parse_delete(self) -> Stmt:
        self.eat_keyword("delete")
        name = self.next_token()
        if name.kind not in (TokKind.NAME, TokKind.FUNC_NAME):
            raise self.error("expected array name")
        if self.at_op("["):
            self.pos += 1
            subs = self.parse_expr_list("]")
            self.eat_op("]")
            return Delete(name.text, subs)
        if self.at_op("("):
            self.pos += 1
            subs = self.parse_expr_list(")")
            self.eat_op(")")
            return Delete(name.text, subs)
        return Delete(name.text, None)

    def parse_expr_list(self, closer: str) -> tuple[Expr, ...]:
        """Parse a comma separated expression list up to a closing token.

        Args:
            closer (str): the operator text that ends the list.
        """
        items: list[Expr] = []
        self.skip_newlines()
        if self.at_op(closer):
            return ()
        items.append(self.parse_expr(P_ASSIGN))
        while self.at_op(","):
            self.pos += 1
            self.skip_newlines()
            items.append(self.parse_expr(P_ASSIGN))
        return tuple(items)

    def parse_print(self) -> Stmt:
        word = self.next_token().text
        args: tuple[Expr, ...] = ()
        if not self.at_stmt_end() and not self.at_op(">", ">>", "|"):
            args = self.parse_print_args()
        redirect = self.parse_redirect()
        return Print(args, redirect) if word == "print" else Printf(
            args, redirect)

    def parse_print_args(self) -> tuple[Expr, ...]:
        """Parse a print/printf argument list.

        Handles the parenthesised form ``print (a, b)`` by trying it first
        and backtracking when the parentheses turn out to be a grouped
        expression instead of the whole list.
        """
        if self.at_op("("):
            save = self.pos
            self.pos += 1
            try:
                grouped = self.parse_expr_list(")")
            except AwkSyntaxError:
                self.pos = save
            else:
                if len(grouped) > 1 and self.at_op(")"):
                    self.pos += 1
                    if self.at_stmt_end() or self.at_op(">", ">>", "|"):
                        return grouped
                self.pos = save
        items: list[Expr] = [self.parse_expr(P_ASSIGN, no_gt=True)]
        while self.at_op(","):
            self.pos += 1
            self.skip_newlines()
            items.append(self.parse_expr(P_ASSIGN, no_gt=True))
        return tuple(items)

    def parse_redirect(self) -> Redirect | None:
        if self.at_op(">"):
            self.pos += 1
            return Redirect(RedirKind.FILE, self.parse_expr(P_CONCAT))
        if self.at_op(">>"):
            self.pos += 1
            return Redirect(RedirKind.APPEND, self.parse_expr(P_CONCAT))
        if self.at_op("|"):
            self.pos += 1
            return Redirect(RedirKind.PIPE, self.parse_expr(P_CONCAT))
        return None

    def parse_expr(self, min_bp: int, no_gt: bool = False) -> Expr:
        """Parse an expression using precedence climbing.

        Args:
            min_bp (int): the minimum binding power to keep consuming.
            no_gt (bool): when true, ``>``/``>>``/``|`` end the expression
                so print redirection is not read as comparison.
        """
        left = self.parse_unary(no_gt)
        return self.parse_infix(left, min_bp, no_gt)

    def parse_unary(self, no_gt: bool) -> Expr:
        if self.at_op("!"):
            self.pos += 1
            return Not(self.parse_expr(P_UNARY, no_gt))
        if self.at_op("-"):
            self.pos += 1
            return Unary("-", self.parse_expr(P_UNARY, no_gt))
        if self.at_op("+"):
            self.pos += 1
            return Unary("+", self.parse_expr(P_UNARY, no_gt))
        if self.at_op("++", "--"):
            op = self.next_token().text
            target = self.parse_unary(no_gt)
            if not isinstance(target, LVALUE_TYPES):
                raise self.error(f"{op} needs an lvalue")
            return IncDec(True, op, target)
        return self.parse_postfix(self.parse_primary(no_gt), no_gt)

    def parse_postfix(self, node: Expr, no_gt: bool) -> Expr:
        while self.at_op("++", "--") and isinstance(node, LVALUE_TYPES):
            op = self.next_token().text
            node = IncDec(False, op, node)
        return node

    def parse_primary(self, no_gt: bool) -> Expr:
        tok = self.peek()
        if tok.kind is TokKind.NUMBER:
            self.pos += 1
            return Num(float(tok.value))
        if tok.kind is TokKind.STRING:
            self.pos += 1
            return Str(tok.value)
        if tok.kind is TokKind.ERE:
            self.pos += 1
            compile_ere(tok.value)
            return Regex(tok.value)
        if tok.kind is TokKind.OP and tok.text == "$":
            self.pos += 1
            return Field(self.parse_field_index(no_gt))
        if tok.kind is TokKind.OP and tok.text == "(":
            return self.parse_grouping()
        if tok.kind is TokKind.KEYWORD and tok.text == "getline":
            return self.parse_getline(None)
        if tok.kind is TokKind.BUILTIN:
            self.pos += 1
            if self.at_op("("):
                self.pos += 1
                args = self.parse_expr_list(")")
                self.eat_op(")")
                return BuiltinCall(tok.text, args)
            return BuiltinCall(tok.text, ())
        if tok.kind is TokKind.FUNC_NAME:
            self.pos += 1
            self.eat_op("(")
            args = self.parse_expr_list(")")
            self.eat_op(")")
            return Call(tok.text, args)
        if tok.kind is TokKind.NAME:
            self.pos += 1
            if self.at_op("["):
                self.pos += 1
                subs = self.parse_expr_list("]")
                self.eat_op("]")
                return ArrayRef(tok.text, subs)
            return Var(tok.text)
        raise self.error("expected an expression")

    def parse_field_index(self, no_gt: bool) -> Expr:
        # `$` binds tighter than every binary operator, so `$NF-1` is
        # ($NF)-1 and only a parenthesised index can be compound.
        if self.at_op("("):
            return self.parse_grouping()
        if self.at_op("$"):
            self.pos += 1
            return Field(self.parse_field_index(no_gt))
        if self.at_op("++", "--"):
            op = self.next_token().text
            target = self.parse_field_index(no_gt)
            if not isinstance(target, LVALUE_TYPES):
                raise self.error(f"{op} needs an lvalue")
            return IncDec(True, op, target)
        if self.at_op("-"):
            self.pos += 1
            return Unary("-", self.parse_field_index(no_gt))
        return self.parse_postfix(self.parse_primary(no_gt), no_gt)

    def parse_grouping(self) -> Expr:
        self.eat_op("(")
        items = self.parse_expr_list(")")
        self.eat_op(")")
        if len(items) == 1:
            return items[0]
        if self.at_keyword("in"):
            self.pos += 1
            name = self.next_token()
            if name.kind is not TokKind.NAME:
                raise self.error("expected array name after 'in'")
            return InArray(items, name.text)
        raise self.error("unexpected expression list")

    def parse_getline(self, source: Expr | None) -> Expr:
        self.eat_keyword("getline")
        target: Expr | None = None
        tok = self.peek()
        if tok.kind is TokKind.NAME or (tok.kind is TokKind.OP
                                        and tok.text == "$"):
            candidate = self.parse_primary(True)
            if not isinstance(candidate, LVALUE_TYPES):
                raise self.error("getline needs an lvalue")
            target = candidate
        if source is not None:
            return Getline(GetlineKind.CMD, target, source)
        if self.at_op("<"):
            self.pos += 1
            return Getline(GetlineKind.FILE, target, self.parse_expr(P_CONCAT))
        return Getline(GetlineKind.PLAIN, target, None)

    def starts_concat(self) -> bool:
        tok = self.peek()
        if tok.kind in CONCAT_START_KINDS:
            return True
        if tok.kind is TokKind.OP:
            return tok.text in CONCAT_START_OPS
        if tok.kind is TokKind.KEYWORD:
            return tok.text == "getline"
        return False

    def parse_infix(self, left: Expr, min_bp: int, no_gt: bool) -> Expr:
        while True:
            tok = self.peek()
            if tok.kind is TokKind.KEYWORD and tok.text == "in":
                if P_IN < min_bp:
                    return left
                self.pos += 1
                name = self.next_token()
                if name.kind is not TokKind.NAME:
                    raise self.error("expected array name after 'in'")
                left = InArray((left, ), name.text)
                continue
            if tok.kind is not TokKind.OP:
                if self.starts_concat() and P_CONCAT >= min_bp:
                    left = Concat(left, self.parse_expr(P_CONCAT + 1, no_gt))
                    continue
                return left
            op = tok.text
            if op in ASSIGN_OPS:
                if P_ASSIGN < min_bp or not isinstance(left, LVALUE_TYPES):
                    return left
                self.pos += 1
                self.skip_newlines()
                return Assign(left, op, self.parse_expr(P_ASSIGN, no_gt))
            if op == "?":
                if P_TERNARY < min_bp:
                    return left
                self.pos += 1
                self.skip_newlines()
                then = self.parse_expr(P_ASSIGN, no_gt)
                self.eat_op(":")
                self.skip_newlines()
                left = Ternary(left, then, self.parse_expr(P_TERNARY, no_gt))
                continue
            if op in ("||", "&&"):
                bp = P_OR if op == "||" else P_AND
                if bp < min_bp:
                    return left
                self.pos += 1
                self.skip_newlines()
                left = Logical(op, left, self.parse_expr(bp + 1, no_gt))
                continue
            if op in ("~", "!~"):
                if P_MATCH < min_bp:
                    return left
                self.pos += 1
                left = MatchOp(op == "!~", left,
                               self.parse_expr(P_MATCH + 1, no_gt))
                continue
            if op == "|":
                if no_gt or P_GETLINE_PIPE < min_bp:
                    return left
                if not (self.peek(1).kind is TokKind.KEYWORD
                        and self.peek(1).text == "getline"):
                    return left
                self.pos += 1
                left = self.parse_getline(left)
                continue
            if op in COMPARE_OPS:
                if (no_gt and op in (">", ">>")) or P_COMPARE < min_bp:
                    return left
                self.pos += 1
                left = Compare(op, left, self.parse_expr(P_COMPARE + 1, no_gt))
                continue
            if op in ADD_OPS:
                if P_ADD < min_bp:
                    return left
                self.pos += 1
                left = Binary(op, left, self.parse_expr(P_ADD + 1, no_gt))
                continue
            if op in MUL_OPS:
                if P_MUL < min_bp:
                    return left
                self.pos += 1
                left = Binary(op, left, self.parse_expr(P_MUL + 1, no_gt))
                continue
            if op == "^":
                if P_POW < min_bp:
                    return left
                self.pos += 1
                left = Binary("^", left, self.parse_expr(P_POW, no_gt))
                continue
            if op in ("(", "$", "++", "--", "!"):
                if P_CONCAT < min_bp:
                    return left
                left = Concat(left, self.parse_expr(P_CONCAT + 1, no_gt))
                continue
            return left


def parse(src: str) -> Program:
    """Parse awk program source into a Program.

    Args:
        src (str): the awk program text.

    Returns:
        Program: rules in source order plus function definitions.
    """
    return Parser(tokenize(src)).parse_program()


__all__ = ["Parser", "parse"]
