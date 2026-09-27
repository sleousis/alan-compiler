%{
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "llvm/Support/Path.h"
#include "ast.hpp"
#include "symbol.hpp"
#include "error.hpp"
#include "cli.hpp"

const char* filename;
extern int yylex();
extern FILE *yyin;
void yyerror (const char msg[]);

extern int lineno;
extern SymbolEntry* library[14];
ast tree;
bool opt;
%}

%union{
  ast a;
  char *c;
  int n;
  unsigned char b;
  Type_T t;
}

%token T_while "while"
%token T_if "if"
%token T_else "else"
%token T_ret "return"
%token T_int "int"
%token T_byte "byte"
%token T_ref "reference"
%token T_proc "proc"
%token<c> T_true "true"
%token<c> T_false "false"
%token T_equal "=="
%token T_grequal ">="
%token T_lequal "<="
%token T_notequal "!="
%token T_assign "="
%token<c> T_char
%token<c> T_string
%token<c> T_id
%token<n> T_const

%left<c> '|'
%left<c> '&'
%nonassoc<c> "==" "!=" '>' '<' "<=" ">="
%left '+' '-'
%left '*' '/' '%'
%nonassoc UMINUS UPLUS '!'

%expect 1

%type<a> program
%type<a> func_def
%type<a> fpar_list
%type<a> fpar_def_list
%type<a> fpar_def
%type<a> type
%type<a> r_type
%type<a> local_def_list
%type<a> local_def
%type<a> var_def
%type<a> compound_stmt
%type<a> stmt_list
%type<a> stmt
%type<a> l_value
%type<a> expr
%type<a> func_call
%type<a> expr_list
%type<a> cond
%type<t> data_type

%%

program:
  func_def { tree = $$ = $1; }
;

func_def:
  T_id '(' fpar_list ')' ':' r_type local_def_list compound_stmt { $$ = ast_funcdef($1, $3, ast_seq($6, ast_seq($7, $8, lineno),lineno),lineno); }
;

fpar_list:
 /* nothing */ { $$ = NULL; }
| fpar_def fpar_def_list { $$ = ast_seq($1, $2,lineno); }
;

fpar_def_list:
 /*nothing*/ { $$ = NULL; }
| ',' fpar_def fpar_def_list { $$ = ast_seq($2, $3,lineno); }
;

fpar_def:
  T_id ':' type { $$ = ast_param($1, PAR, $3,lineno); }
| T_id ':' "reference" type { $$ = ast_param($1, PARREF, $4,lineno); }
;

type:
  data_type { $$ = ast_type($1, TYPE, 0,lineno); }
| data_type '[' ']' { $$ = ast_type($1, TYPEARR, 0, lineno); }
;

data_type:
  T_int { $$ = createInt(); }
| T_byte { $$ = createChar(); }
;

r_type:
  data_type { $$ = ast_type($1, TYPE, 0,lineno); }
| "proc" { $$ = ast_proc(lineno);}
;

local_def_list:
  /*nothing*/ { $$ = NULL; }
| local_def local_def_list { $$ = ast_seq($1, $2,lineno); }
;

local_def:
  func_def { $$ = $1; }
| var_def { $$ = $1; }
;

var_def:
  T_id ':' data_type ';' { $$ = ast_var($1, ast_type($3, TYPE, 0,lineno),lineno); }
| T_id ':' data_type '[' T_const ']' ';' { $$ = ast_var($1, ast_type($3, TYPEARR, $5,lineno),lineno); }
;

compound_stmt:
  '{' stmt_list '}' { $$ = $2; }
;

stmt_list:
  /*nothing*/ { $$ = NULL; }
| stmt stmt_list { $$ = ast_seq($1, $2,lineno); }
;

stmt:
  ';' { $$ = NULL; }
| l_value "=" expr ';' { $$ = ast_ass($1, $3,lineno); }
| compound_stmt { $$ = $1; }
| func_call ';' { $$ = $1; }
| "if" '(' cond ')' stmt { $$ = ast_if($3, $5,lineno); }
| "if" '(' cond ')' stmt "else" stmt { $$ = ast_ifelse(ast_if($3, $5,lineno), $7,lineno); }
| "while" '(' cond ')' stmt { $$ = ast_while($3, $5,lineno); }
| "return" ';' { $$ = ast_ret(ast_type(typeVoid, TYPE, 0, lineno), lineno); }
| "return" expr ';' { $$ = ast_ret ($2,lineno); }
;

l_value:
  T_id { $$ = ast_id($1,lineno); }
| T_id '[' expr ']' { $$ = ast_arrExpr(ast_id($1,lineno), $3,lineno);}
| T_string { $$ = ast_ch_str_bool($1, STRING, createString($1) ,lineno); }
;

expr:
  T_const { $$ = ast_const($1, createInt(),lineno); }
| T_char { $$ = ast_ch_str_bool($1, CHAR, createChar(),lineno); }
| l_value { $$ = $1; }
| '(' expr ')' { $$ = $2; }
| func_call { $$ = $1; }
| '+' expr { $$ = ast_op(ast_const(0, createInt(),lineno), PLUS, $2, createInt(),lineno); } %prec UPLUS
| '-' expr { $$ = ast_op(ast_const(0, createInt(),lineno), MINUS, $2, createInt(),lineno); } %prec UMINUS
| expr '+' expr { $$ = ast_op($1, PLUS, $3, NULL,lineno); }
| expr '-' expr { $$ = ast_op($1, MINUS, $3, NULL,lineno); }
| expr '*' expr { $$ = ast_op($1, TIMES, $3, NULL,lineno); }
| expr '/' expr { $$ = ast_op($1, DIV, $3, NULL,lineno); }
| expr '%' expr { $$ = ast_op($1, MOD, $3, NULL,lineno); }
;

func_call:
  T_id '(' ')' { $$ = ast_funcall($1, NULL,lineno); }
| T_id '(' expr expr_list ')' { $$ = ast_funcall($1, ast_seq($3, $4, lineno),lineno); }
;

expr_list:
  /*nothing*/ { $$ = NULL; }
| ',' expr expr_list { $$ = ast_seq($2, $3,lineno); }
;

cond:
  "true" { $$ = ast_ch_str_bool($1, BOOL, typeBoolean,lineno); }
| "false" { $$ = ast_ch_str_bool($1, BOOL, typeBoolean,lineno); }
| '(' cond ')' { $$ = $2; }
| '!' cond { $$ = ast_op($2, NOT, NULL, typeBoolean,lineno); }
| expr "==" expr { $$ = ast_op($1, EQUALS, $3, typeBoolean,lineno); }
| expr "!=" expr { $$ = ast_op($1, NOTEQUALS, $3, typeBoolean,lineno); }
| expr '<' expr { $$ = ast_op($1, LESS, $3, typeBoolean,lineno); }
| expr '>' expr { $$ = ast_op($1, GREATER, $3, typeBoolean,lineno); }
| expr "<=" expr { $$ = ast_op($1, LESSEQUALS, $3, typeBoolean,lineno); }
| expr ">=" expr { $$ = ast_op($1, GREATEQUALS, $3, typeBoolean,lineno); }
| cond '&' cond { $$ = ast_op($1, AND, $3, typeBoolean,lineno); }
| cond '|' cond { $$ = ast_op($1, OR, $3, typeBoolean,lineno); }
;

%%

void yyerror (const char msg[]) {
  bool tty = stderr_is_tty();
  fprintf(stderr, "%s:%d: %serror:%s %s\n", filename, lineno,
          tty ? "\033[1;31m" : "", tty ? "\033[0m" : "", msg);
  exit(1);
}

/* Parse the file at path and check it. When codegen is true, also generate
   the LLVM module that alan_module() returns. Returns 0 on success. Errors
   in the program are reported on stderr and end the process with exit
   code 1. When debug is true, the module carries DWARF debug information. */
int compile_to_module(const char *path, bool optimize, bool codegen, bool debug) {
  opt = optimize;
  yyin = fopen(path, "r");
  if (yyin == NULL) {
    fprintf(stderr, "alanc: %serror:%s cannot open %s\n",
            stderr_is_tty() ? "\033[1;31m" : "",
            stderr_is_tty() ? "\033[0m" : "", path);
    return 1;
  }
  filename = strdup(llvm::sys::path::filename(path).str().c_str());
  if (yyparse()) return 1;
  fclose(yyin);
  initSymbolTable(997);
  createLibrary();
  ast_sem(tree,NULL);
  destroySymbolTable();
  if (codegen && !llvm_compile(tree, debug ? path : nullptr)) return 1;
  return 0;
}

int main(int argc, char *argv[]) {
  return alan_cli_main(argc, argv);
}
