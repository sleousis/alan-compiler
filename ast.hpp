#ifndef __AST_H__
#define __AST_H__
#include "symbol.hpp"
#include <llvm/IR/IRBuilder.h>
#include <llvm/IR/Module.h>
#include <llvm/IR/Value.h>
using namespace llvm;
typedef enum {
	WHILE=0, IF=1, IFELSE=2, SEQ=3, RET=4, PAR=5, PARREF=6, TYPE=7, TYPEARR=8, PROC=9, VAR=10, ASS=11, ARREXPR=12, FUNCALL=13, FUNCDEF=14,
	ID=15, CONST=16, CHAR=17, STRING=18, BOOL=19, PLUS=20, MINUS=21, TIMES=22, DIV=23, MOD=24, NOT=25, EQUALS=26, NOTEQUALS=27, LESSEQUALS=28, GREATEQUALS=29,
	GREATER=30, LESS=31, AND=32, OR=33
} kind;

extern bool opt;

typedef struct node {
	kind k;
	char *id;
	int num;
	struct node *left, *right;
	Type_T type;
	int line;
} *ast;

Type_T          createInt          ();
Type_T          createIntArr       ();
Type_T          createChar         ();
Type_T          createCharArr      ();
Type_T          createString       (char* theString);

void          createLibrary      ();
SymbolEntry*  lookupLibrary      (char * name);

void ast_tree_print (ast node, int depth);

ast ast_id (char *c, int line);
ast ast_param (char *c, kind op, ast l, int line);
ast ast_type (Type_T t, kind op, int n, int line);
ast ast_proc (int line);
ast ast_func (ast l, int line);
ast ast_var (char *c, ast l, int line);
ast ast_ass (ast l, ast r, int line);
ast ast_arrExpr (ast l, ast r, int line);
ast ast_funcall (char *c, ast l, int line);
ast ast_funcdef (char *c, ast l, ast r, int line);
ast ast_const (int n, Type_T t, int line);
ast ast_ch_str_bool (char *c, kind op, Type_T t, int line);
ast ast_op (ast l, kind op, ast r, Type_T t, int line);
ast ast_print (ast l, int line);
ast ast_let (char *c, ast l, int line);
ast ast_while (ast l, ast r, int line);
ast ast_if (ast l, ast r, int line);
ast ast_ifelse (ast l, ast r, int line);
ast ast_ret (ast l, int line);
ast ast_seq (ast l, ast r, int line);

int ast_run (ast tree);
Type_T ast_sem(ast tree, SymbolEntry * f);
Value * ast_compile (ast t);
void llvm_compile_and_dump (ast t);

#endif
