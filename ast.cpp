#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdbool.h>
#include <vector>
#include <map>
#include <ctype.h>
#include "general.hpp"
#include "ast.hpp"
#include "symbol.hpp"
#include "error.hpp"
#include "debuginfo.hpp"

#include <llvm/IR/IRBuilder.h>
#include <llvm/IR/PassManager.h>
#include <llvm/IR/Module.h>
#include <llvm/IR/Value.h>
#include <llvm/IR/Verifier.h>
#include <llvm/Passes/PassBuilder.h>
#include <llvm/Support/raw_ostream.h>
#include <llvm/Transforms/InstCombine/InstCombine.h>
#include <llvm/Transforms/Scalar/GVN.h>
#include <llvm/Transforms/Scalar/Reassociate.h>
#include <llvm/Transforms/Scalar/SimplifyCFG.h>
#include <llvm/Transforms/Utils/Mem2Reg.h>

using namespace llvm;

extern int lineno;
extern const char* filename;
SymbolEntry  *e;
static ast ast_make (kind k, char *c, int n, ast l, ast r, Type_T t, int line) {
	ast p;
	p = new struct node;
	p->k = k;
	p->id = c;
	p->num = n;
	p->left = l;
	p->right = r;
	p->type = t;
	p->line = line;
	p->decl = NULL;
	return p;
}

const char* kinds[]={
	"WHILE", "IF", "IFELSE", "SEQ", "RET", "PAR", "PARREF", "TYPE", "TYPEARR", "PROC", "VAR", "ASS", "ARREXPR", "FUNCALL", "FUNCDEF",
	"ID", "CONST", "CHAR", "STRING", "BOOL", "PLUS", "MINUS", "TIMES", "DIV", "MOD", "NOT", "EQUALS", "NOTEQUALS", "LESSEQUALS", "GREATEQUALS",
	"GREATER", "LESS", "AND", "OR"
};

SymbolEntry* library[14];

const char* types[]{
	"void", "int", "boolean", "byte", "real", "array", "iarray", "pointer"
};


void ast_tree_print (ast node, int depth){
	if (node != NULL) {
		for (int i = 0; i<depth; i++) {
			printf("\t");
		}
		printf("%s",kinds[node->k]);
		if (node != NULL && node->id != NULL) {
			printf(" %s",node->id);
		}
		printf("\n");
		for (int i = 0; i<depth; i++) {
			printf("\t");
		}
		printf("\tLEFT\n");
		if (node->left != NULL) {
			ast_tree_print(node->left,depth+1);
		}
		else{
			for (int i = 0; i<depth; i++) {
				printf("\t");
			}
			printf("\tNULL\n");
		}
		for (int i = 0; i<depth; i++) {
			printf("\t");
		}
		printf("\tRIGHT\n");
		if (node->right != NULL) {
			ast_tree_print(node->right,depth+1);
		}
		else{
			for (int i = 0; i<depth; i++) {
				printf("\t");
			}
			printf("\tNULL\n");
		}
	}
}

ast ast_id (char *c, int line) {
	return ast_make(ID, c, 0, NULL, NULL, NULL, line);
}

ast ast_funcdef (char *c, ast l, ast r, int line) {
	return ast_make(FUNCDEF, c, 0, l, r, NULL, line);
}

ast ast_const (int n, Type_T t, int line) {
	return ast_make(CONST, NULL, n, NULL, NULL, t, line);
}

ast ast_ch_str_bool (char *c, kind op, Type_T t, int line) {
	if (op == BOOL) return ast_make(op, c, 0, NULL, NULL, t, line);
	// Drop the quotes around a character or string literal. The lexer
	// only gives literals with both quotes, so c has at least 2 bytes.
	size_t len = strlen(c);
	char* inner = (char*)calloc(len - 1, 1);
	memcpy(inner, c + 1, len - 2);
	return ast_make(op, inner, 0, NULL, NULL, t, line);
}

ast ast_param (char *c, kind op, ast l, int line) {
	return ast_make(op, c, 0, l, NULL, NULL, line);
}

ast ast_type (Type_T t,kind op, int n, int line) {
	return ast_make(op, NULL, n, NULL, NULL, t, line);
}

ast ast_proc (int line) {
	return ast_make(PROC, NULL, 0, NULL, NULL, NULL, line);
}

ast ast_var (char *c, ast l, int line) {
	return ast_make(VAR, c, 0, l, NULL, NULL, line);
}

ast ast_ass (ast l, ast r, int line) {
	return ast_make(ASS, NULL, 0, l, r, NULL, line);
}

ast ast_arrExpr (ast l, ast r, int line) {
	return ast_make(ARREXPR, NULL, 0, l, r, NULL, line);
}

ast ast_funcall (char *c, ast l, int line) {
	return ast_make(FUNCALL, c, 0, l, NULL, NULL, line);
}

ast ast_op (ast l, kind op, ast r, Type_T t, int line) {
	return ast_make(op, NULL, 0, l, r, t, line);
}

ast ast_while (ast l, ast r, int line) {
	return ast_make(WHILE, NULL, 0, l, r, NULL, line);
}

ast ast_if (ast l, ast r, int line) {
	return ast_make(IF, NULL, 0, l, r, NULL, line);
}

ast ast_ifelse (ast l, ast r, int line) {
	return ast_make(IFELSE, NULL, 0, l, r, NULL, line);
}

ast ast_ret (ast l, int line) {
	return ast_make(RET, NULL, 0, l, NULL, NULL, line);
}

ast ast_seq (ast l, ast r, int line) {
	if (r == NULL) return l;
	return ast_make(SEQ, NULL, 0, l, r, NULL, line);
}

// Global LLVM variables related to the LLVM suite.
static LLVMContext TheContext;
static IRBuilder<> Builder(TheContext);
static std::unique_ptr<Module> TheModule;
static std::unique_ptr<FunctionPassManager> TheFPM;
static std::unique_ptr<LoopAnalysisManager> TheLAM;
static std::unique_ptr<FunctionAnalysisManager> TheFAM;
static std::unique_ptr<CGSCCAnalysisManager> TheCGAM;
static std::unique_ptr<ModuleAnalysisManager> TheMAM;
static std::map<int, std::map<std::string, Value *> > NamedValues;
// Debug information for -g, null without it.
static DebugInfo *DI = nullptr;

// Global LLVM variables related to the generated code.
static Function *TheWriteInteger;
static Function *TheWriteByte;
static Function *TheWriteChar;
static Function *TheWriteString;
static Function *TheReadInteger;
static Function *TheReadByte;
static Function *TheReadChar;
static Function *TheReadString;
static Function *TheExtend;
static Function *TheShrink;
static Function *TheStrlen;
static Function *TheStrcmp;
static Function *TheStrcpy;
static Function *TheStrcat;

// Useful LLVM types.
static Type * i1 = IntegerType::get(TheContext, 1);
static Type * i8 = IntegerType::get(TheContext, 8);
static Type * i32 = IntegerType::get(TheContext, 32);
static Type * i64 = IntegerType::get(TheContext, 64);

// Useful LLVM helper functions.
inline ConstantInt* c1(int n) {
	return ConstantInt::get(TheContext, APInt(1, n));
}
inline ConstantInt* c8(char c) {
	return ConstantInt::get(TheContext, APInt(8, c, true));
}
inline ConstantInt* c32(int n) {
	return ConstantInt::get(TheContext, APInt(32, n, true));
}

// LLVM pointers are opaque, so remember the type each pointer points to.
static std::map<Value *, Type *> PointeeTypes;
inline Value* trackPtr(Value *p, Type *t) {
	PointeeTypes[p] = t;
	return p;
}
inline Value* loadValue(Value *p) {
	return Builder.CreateLoad(PointeeTypes[p], p);
}

// Local arrays start zeroed, so a string built in one is always terminated
// and programs behave the same on every platform.
inline void zeroArray(Value *p, int bytes) {
	Builder.CreateMemSet(p, Builder.getInt8(0), bytes, MaybeAlign(1));
}

static int hexDigit(char c) {
	if (c >= '0' && c <= '9') return c - '0';
	if (c >= 'a' && c <= 'f') return c - 'a' + 10;
	return c - 'A' + 10;
}

// The bytes a character or string literal stands for, with its escape
// sequences replaced. The lexer only accepts the escapes of the spec.
static std::string unescape(const char *s) {
	std::string out;
	for (size_t i = 0; s[i] != '\0'; i++) {
		if (s[i] != '\\') {
			out.push_back(s[i]);
			continue;
		}
		switch (s[++i]) {
		case 'n': out.push_back('\n'); break;
		case 't': out.push_back('\t'); break;
		case 'r': out.push_back('\r'); break;
		case '0': out.push_back('\0'); break;
		case 'x':
			if (!isxdigit((unsigned char)s[i + 1]) || !isxdigit((unsigned char)s[i + 2]))
				internal("bad escape sequence in literal %s", s);
			out.push_back((char)(hexDigit(s[i + 1]) * 16 + hexDigit(s[i + 2])));
			i += 2;
			break;
		default: out.push_back(s[i]); break; // \\, \' and \"
		}
	}
	return out;
}

// A variable of an Alan function: a local, a parameter, or a variable of an
// enclosing function that it reaches through a hidden parameter. Each
// declaration has one of these, shared by every function that sees it, so
// a call passes the right variable even when a name is shadowed.
struct variableStruct {
	const char* varName;
	Type* varType;
	bool isArray;
};

//struct implementing function's hidden parameters
struct hiddenParameterStruct {
	variableStruct *var;
};

//struct implementing function's parameters
struct parameterStruct {
	const char* parName;
	Type* parType;
	Type* parTypePure;
	bool isRef;
	bool isArray;
};

//struct implementing variable table and nesting levels
struct functionTable {
	const char* funName;
	struct functionTable *father;
	std::map<std::string, Value *> NamedValues;
	// The address of each variable the function sees, by declaration.
	std::map<variableStruct *, Value *> addresses;
	std::vector<struct parameterStruct*> funParameters;
	std::vector<struct variableStruct*> funVariables;
	std::vector<struct hiddenParameterStruct*> funHiddenParameters;
	Function *func;
	std::vector<ast> funcDefsDismissed;
};
struct functionTable *currentFunction = new struct functionTable ();

// The function table of each FUNCDEF node.
static std::map<ast, functionTable *> functionOf;

//array of Library functions
// new[]() runs the constructors of the vector and map members. The old
// malloc left them uninitialised, which is undefined behaviour.
struct functionTable *funLibrary = new struct functionTable[14]();

functionTable *findFunctionInLibrary (char* funName) {
	for (int i = 0; i < 14; i++) {
		if (strcmp(funName, funLibrary[i].funName) == 0) return &funLibrary[i];
	}
	return NULL;
}

//create function
Constant *createFunction(char* name, Type* retType) {
	std::vector<Type *> Args;
	for (size_t i = 0; i < currentFunction->funHiddenParameters.size(); i++) {
		Args.push_back(llvm::PointerType::getUnqual(TheContext));
	}
	for (size_t i = 0; i < currentFunction->funParameters.size(); i++) {
		Args.push_back(currentFunction->funParameters[i]->parType);
	}
	FunctionType *type = FunctionType::get(retType, Args, false);
	// The prefix keeps an Alan function from taking the name of a C
	// function, such as memset or strlen, that the runtime or LLVM calls.
	// Alan names have no dots. The debug information keeps the Alan name.
	Function *TheFunction = Function::Create(type, Function::InternalLinkage,
	                                         std::string("alan.") + name, TheModule.get());
	return TheFunction;
}

// Makes a variable of the current function visible under its name at the
// address p, which points to an object of type pointee.
static void addVariable(variableStruct *v, Value *p, Type *pointee) {
	currentFunction->NamedValues[v->varName] = trackPtr(p, pointee);
	currentFunction->addresses[v] = p;
	currentFunction->funVariables.push_back(v);
}

static variableStruct *newVariableStruct(const char *name, Type *type, bool isArray) {
	variableStruct *v = new variableStruct();
	v->varName = name;
	v->varType = type;
	v->isArray = isArray;
	return v;
}

bool FuncDefLockEnabled = true;
// Set when a generated function fails verification.
static bool codegenFailed = false;

// The source line a statement starts on, or 0 for other nodes. The parser
// gives if and while the line where their body ends, so use the condition's.
static int statementLine (ast t) {
	switch (t->k) {
	case WHILE: case IF: return t->left->line;
	case IFELSE: return t->left->left->line;
	case RET: case ASS: case FUNCALL: return t->line;
	default: return 0;
	}
}

// The result type node of a function definition: TYPE or PROC. The parser
// gives a SEQ of it and the rest, or the node alone when the function has
// no local definitions and an empty body.
static ast resultTypeNode (ast t) {
	return t->right->k == SEQ ? t->right->left : t->right;
}

// The line a function is declared on: the line of its result type.
static int functionLine (ast t) {
	return resultTypeNode(t)->line;
}

// True while the current block has no terminator, so code can still go
// into it. After a return the rest of a block is dead.
static bool blockOpen () {
	// getTerminator() cannot be used: it expects a block that is not empty.
	BasicBlock *BB = Builder.GetInsertBlock();
	return BB->empty() || !BB->back().isTerminator();
}

// Compiles an expression and gives its value. Names and array elements
// compile to the address of their object, so load from it.
static Value *rvalue (ast t) {
	Value *v = ast_compile(t);
	if (t->k == ID || t->k == ARREXPR) return loadValue(v);
	return v;
}

static bool isArithmetic (kind k) {
	return k == PLUS || k == MINUS || k == TIMES || k == DIV || k == MOD;
}

// Compiles a chain of arithmetic operators such as a + b - c * d. The
// parser nests left-associative operators on the left, so walk that side
// in a loop. Recursion there overflows the stack on long expressions.
static LLVM_ATTRIBUTE_NOINLINE Value *compileArithmetic (ast t) {
	std::vector<ast> chain;
	ast first = t;
	while (isArithmetic(first->k)) {
		chain.push_back(first);
		first = first->left;
	}
	Value *acc = rvalue(first);
	// byte holds 0 to 255, so its division and remainder are unsigned.
	bool isByte = acc->getType()->isIntegerTy(8);
	for (auto it = chain.rbegin(); it != chain.rend(); ++it) {
		Value *r = rvalue((*it)->right);
		switch ((*it)->k) {
		case PLUS: acc = Builder.CreateAdd(acc, r, "addtmp"); break;
		case MINUS: acc = Builder.CreateSub(acc, r, "subtmp"); break;
		case TIMES: acc = Builder.CreateMul(acc, r, "multmp"); break;
		case DIV: acc = isByte ? Builder.CreateUDiv(acc, r, "divtmp") : Builder.CreateSDiv(acc, r, "divtmp"); break;
		default: acc = isByte ? Builder.CreateURem(acc, r, "modtmp") : Builder.CreateSRem(acc, r, "modtmp"); break;
		}
	}
	return acc;
}

static bool isLogical (kind k) {
	return k == AND || k == OR;
}

// Compiles a chain of & and | with short-circuit evaluation: the right
// operand is evaluated only when the left one does not decide the result.
// Chains nest on the left like arithmetic ones, so walk them in a loop.
static LLVM_ATTRIBUTE_NOINLINE Value *compileLogical (ast t) {
	std::vector<ast> chain;
	ast first = t;
	while (isLogical(first->k)) {
		chain.push_back(first);
		first = first->left;
	}
	Value *acc = ast_compile(first);
	Function *TheFunction = Builder.GetInsertBlock()->getParent();
	for (auto it = chain.rbegin(); it != chain.rend(); ++it) {
		bool isAnd = (*it)->k == AND;
		BasicBlock *LeftBB = Builder.GetInsertBlock();
		BasicBlock *RightBB = BasicBlock::Create(TheContext, isAnd ? "and_right" : "or_right", TheFunction);
		BasicBlock *EndBB = BasicBlock::Create(TheContext, isAnd ? "and_end" : "or_end", TheFunction);
		if (isAnd) Builder.CreateCondBr(acc, RightBB, EndBB);
		else Builder.CreateCondBr(acc, EndBB, RightBB);
		Builder.SetInsertPoint(RightBB);
		Value *r = ast_compile((*it)->right);
		// The right operand can end in another block when it has & or | inside.
		BasicBlock *RightEndBB = Builder.GetInsertBlock();
		Builder.CreateBr(EndBB);
		Builder.SetInsertPoint(EndBB);
		PHINode *phi = Builder.CreatePHI(i1, 2, isAnd ? "andtmp" : "ortmp");
		phi->addIncoming(c1(isAnd ? 0 : 1), LeftBB);
		phi->addIncoming(r, RightEndBB);
		acc = phi;
	}
	return acc;
}

static LLVM_ATTRIBUTE_NOINLINE Value *compileWhile (ast t) {
	Function *TheFunction = Builder.GetInsertBlock()->getParent();
	BasicBlock *LoopBB = BasicBlock::Create(TheContext, "loop", TheFunction);
	BasicBlock *InsideBB = BasicBlock::Create(TheContext, "inside", TheFunction);
	BasicBlock *AfterBB = BasicBlock::Create(TheContext, "after", TheFunction);
	Builder.CreateBr(LoopBB);
	// The condition is evaluated before every iteration.
	Builder.SetInsertPoint(LoopBB);
	Value *cond = ast_compile(t->left);
	Builder.CreateCondBr(cond, InsideBB, AfterBB);
	Builder.SetInsertPoint(InsideBB);
	ast_compile(t->right);
	if (blockOpen()) {
		if (DI) di_location(DI, Builder, statementLine(t));
		Builder.CreateBr(LoopBB);
	}
	Builder.SetInsertPoint(AfterBB);
	return nullptr;
}

static LLVM_ATTRIBUTE_NOINLINE Value *compileIf (ast t) {
	Value *cond = ast_compile(t->left);
	Function *TheFunction = Builder.GetInsertBlock()->getParent();
	BasicBlock *InsideBB =
		BasicBlock::Create(TheContext, "then", TheFunction);
	BasicBlock *AfterBB =
		BasicBlock::Create(TheContext, "endif", TheFunction);
	Builder.CreateCondBr(cond, InsideBB, AfterBB);
	Builder.SetInsertPoint(InsideBB);
	ast_compile(t->right);
	if (blockOpen()) Builder.CreateBr(AfterBB);
	Builder.SetInsertPoint(AfterBB);
	return nullptr;
}

static LLVM_ATTRIBUTE_NOINLINE Value *compileIfElse (ast t) {
	Value *cond = ast_compile(t->left->left);
	Function *TheFunction = Builder.GetInsertBlock()->getParent();
	BasicBlock *InsideBB =
		BasicBlock::Create(TheContext, "then", TheFunction);
	BasicBlock *ElseInsideBB =
		BasicBlock::Create(TheContext, "else", TheFunction);
	BasicBlock *AfterBB =
		BasicBlock::Create(TheContext, "endifelse", TheFunction);
	Builder.CreateCondBr(cond, InsideBB, ElseInsideBB);
	Builder.SetInsertPoint(InsideBB);
	ast_compile(t->left->right);
	if (blockOpen()) Builder.CreateBr(AfterBB);
	Builder.SetInsertPoint(ElseInsideBB);
	ast_compile(t->right);
	if (blockOpen()) Builder.CreateBr(AfterBB);
	Builder.SetInsertPoint(AfterBB);
	return nullptr;
}

static LLVM_ATTRIBUTE_NOINLINE Value *compileReturn (ast t) {
	// "return;" in a proc has the proc's TYPE node as its operand.
	if (t->left->k == TYPE) Builder.CreateRetVoid();
	else Builder.CreateRet(rvalue(t->left));
	return nullptr;
}

static LLVM_ATTRIBUTE_NOINLINE Value *compileParameter (ast t) {
	struct parameterStruct *tmpFunParameter = new struct parameterStruct ();
	tmpFunParameter->parName = t->id;
	if (t->left->type->kind == Type_tag::TYPE_INTEGER) {
		tmpFunParameter->parType = i32;
		tmpFunParameter->parTypePure = i32;
	}
	else if (t->left->type->kind == Type_tag::TYPE_CHAR) {
		tmpFunParameter->parType = i8;
		tmpFunParameter->parTypePure = i8;
	}
	tmpFunParameter->isRef = false;
	tmpFunParameter->isArray = false;
	currentFunction->funParameters.push_back(tmpFunParameter);
	return nullptr;
}

static LLVM_ATTRIBUTE_NOINLINE Value *compileReferenceParameter (ast t) {
	struct parameterStruct *tmpFunParameter = new struct parameterStruct ();
	tmpFunParameter->parName = t->id;
	//NEEDS FIX
	if (t->left->type->kind == Type_tag::TYPE_INTEGER) {
		tmpFunParameter->parType = llvm::PointerType::getUnqual(TheContext);
		tmpFunParameter->parTypePure = i32;
	}
	else if (t->left->type->kind == Type_tag::TYPE_CHAR) {
		tmpFunParameter->parType = llvm::PointerType::getUnqual(TheContext);
		tmpFunParameter->parTypePure = i8;
	}
	if (t->left->k == TYPE) tmpFunParameter->isArray = false;
	else if (t->left->k == TYPEARR) tmpFunParameter->isArray = true;
	tmpFunParameter->isRef = true;
	currentFunction->funParameters.push_back(tmpFunParameter);
	return nullptr;
}

static LLVM_ATTRIBUTE_NOINLINE Value *compileVariable (ast t) {
	Type *elemType = t->left->type->kind == Type_tag::TYPE_CHAR ? i8 : i32;
	bool isArray = t->left->k == TYPEARR;
	Type *objType = isArray ? (Type *)ArrayType::get(elemType, t->left->num) : elemType;
	AllocaInst *slot = Builder.CreateAlloca(objType, 0, t->id);
	if (isArray) zeroArray(slot, (elemType == i8 ? 1 : 4) * t->left->num);
	addVariable(newVariableStruct(t->id, elemType, isArray), slot, objType);
	if (DI) {
		di_variable(DI, slot, t->id, t->line, elemType == i8, isArray,
		            isArray ? t->left->num : 0);
	}
	return nullptr;
}

static LLVM_ATTRIBUTE_NOINLINE Value *compileElement (ast t) {
	Value *index = rvalue(t->right);
	Value *l = ast_compile(t->left);
	Type *elemType = PointeeTypes[l]->getArrayElementType();
	return trackPtr(Builder.CreateGEP(elemType, l, index, "tmpArr"), elemType);
}

static LLVM_ATTRIBUTE_NOINLINE Value *compileCall (ast t) {
	// ast_sem found the function the call names, by the scope rules.
	bool isInLibrary = t->decl == NULL;
	struct functionTable *tmp = isInLibrary ? findFunctionInLibrary(t->id) : functionOf[t->decl];
	if (tmp == NULL) internal("no code for function %s", t->id);
	std::vector<Value*> Args;
	// Pass the variables of the enclosing functions that the callee can
	// see. The caller sees each of them too, maybe under a shadowed name.
	if (!isInLibrary) {
		for (hiddenParameterStruct *h : tmp->funHiddenParameters) {
			auto found = currentFunction->addresses.find(h->var);
			if (found == currentFunction->addresses.end())
				internal("%s cannot pass variable %s to %s", currentFunction->funName, h->var->varName, tmp->funName);
			Args.push_back(found->second);
		}
	}
	// The arguments nest on the right: SEQ(a, SEQ(b, c)).
	ast iter = t->left;
	for (size_t i = 0; iter != NULL; i++) {
		ast arg = iter->k == SEQ ? iter->left : iter;
		iter = iter->k == SEQ ? iter->right : NULL;
		// A reference parameter gets the address of the l-value.
		if (tmp->funParameters[i]->isRef) Args.push_back(ast_compile(arg));
		else Args.push_back(rvalue(arg));
	}
	CallInst *call = Builder.CreateCall(tmp->func, Args);
	// The zeroext of byte arguments and results must be on the call too.
	call->setAttributes(tmp->func->getAttributes());
	return call;
}

static LLVM_ATTRIBUTE_NOINLINE Value *compileFunction (ast t) {
	if (!FuncDefLockEnabled) {
		//Enable funcDef lock
		FuncDefLockEnabled = true;
		currentFunction = functionOf[t];
		BasicBlock *BB = BasicBlock::Create(TheContext, "entry", currentFunction->func);
		Builder.SetInsertPoint(BB);
		if (DI) {
			std::vector<std::pair<std::string, Type *>> params;
			for (parameterStruct *p : currentFunction->funParameters)
				params.emplace_back(p->parName, p->parType);
			di_function(DI, currentFunction->func, t->id, functionLine(t), params);
			di_location(DI, Builder, functionLine(t));
		}
		//set args names and initialization
		Function::arg_iterator argss = currentFunction->func->arg_begin();
		for (hiddenParameterStruct *h : currentFunction->funHiddenParameters) {
			Value *tmpArg = argss++;
			tmpArg->setName(h->var->varName);
			// An array arrives as a pointer to its first element.
			addVariable(h->var, tmpArg, h->var->isArray ? (Type *)ArrayType::get(h->var->varType, 1) : h->var->varType);
		}
		for (parameterStruct *par : currentFunction->funParameters) {
			Value *tmpArg = argss++;
			variableStruct *v = newVariableStruct(par->parName, par->parTypePure, par->isArray);
			if (!par->isRef) {
				AllocaInst *slot = Builder.CreateAlloca(par->parType, 0, par->parName);
				Builder.CreateStore(tmpArg, slot);
				addVariable(v, slot, par->parType);
				if (DI) di_variable(DI, slot, par->parName, functionLine(t), par->parType == i8, false, 0);
			}
			else {
				tmpArg->setName(par->parName);
				addVariable(v, tmpArg, par->isArray ? (Type *)ArrayType::get(par->parTypePure, 1) : par->parTypePure);
				if (DI) {
					// A reference has no slot of its own, so give the
					// debugger one that holds the address.
					AllocaInst *slot = Builder.CreateAlloca(tmpArg->getType(), nullptr,
					                                        std::string(par->parName) + ".addr");
					Builder.CreateStore(tmpArg, slot);
					di_variable(DI, slot, par->parName, functionLine(t),
					            par->parTypePure == i8, par->isArray, 0, true);
				}
			}
		}
		//Emit the program code.
		ast_compile(t->right);
		// Falling off the end returns 0 from a function with a result.
		if (blockOpen()) {
			ast result = resultTypeNode(t);
			if (result->k == PROC) Builder.CreateRetVoid();
			else if (result->type->kind == Type_tag::TYPE_CHAR) Builder.CreateRet(c8(0));
			else Builder.CreateRet(c32(0));
		}
		// The passes assume valid IR and can crash on anything else, so
		// they run only on a function that verifies. Invalid IR fails
		// the module's verification in llvm_compile.
		if (verifyFunction(*currentFunction->func, &errs())) codegenFailed = true;
		else if (opt) TheFPM->run(*currentFunction->func, *TheFAM);
		//Disable funcDef lock
		FuncDefLockEnabled = false;
		//define dismissed funcDefs
		ast poppedTmp;
		while (currentFunction->funcDefsDismissed.size() > 0) {
			poppedTmp = currentFunction->funcDefsDismissed.back();
			currentFunction->funcDefsDismissed.pop_back();
			ast_compile(poppedTmp);
		}
		// Nested functions are generated above, inside this one's scope.
		di_end_function(DI);
		currentFunction = currentFunction->father;
	}
	else {
		currentFunction->funcDefsDismissed.push_back(t);
		struct functionTable *newFunction = new struct functionTable ();
		newFunction->funName = t->id;
		newFunction->father = currentFunction;
		functionOf[t] = newFunction;
		currentFunction = newFunction;
		//get parent's variables as hidden parameters
		for (variableStruct *v : currentFunction->father->funVariables) {
			hiddenParameterStruct *h = new hiddenParameterStruct ();
			h->var = v;
			currentFunction->funHiddenParameters.push_back(h);
		}
		//Create new Function Definition
		Constant *c = nullptr;
		//get function's parameters
		ast_compile(t->left);
		//define function type
		ast result = resultTypeNode(t);
		if (result->k == PROC) c = createFunction(t->id, Type::getVoidTy(TheContext));
		else if (result->type->kind == Type_tag::TYPE_CHAR) c = createFunction(t->id, i8);
		else c = createFunction(t->id, i32);
		currentFunction->func = cast<Function>(c);
		functionTable *firstFunction = currentFunction;
		currentFunction = currentFunction->father;
		//if this is the first function just run all the code
		if (currentFunction->father == NULL) {
			//close main function
			std::vector<Value*> Args;
			Builder.CreateCall(firstFunction->func, Args);
			Builder.CreateRet(c32(0));
			//run all the code
			FuncDefLockEnabled = false;
			ast_compile(t);
		}
	}
	return nullptr;
}

static LLVM_ATTRIBUTE_NOINLINE Value *compileString (ast t) {
	// A string literal is an l-value of type byte[n+1] that the program
	// may change (a callee can write through its reference), so each
	// evaluation gets fresh contents. The storage is allocated once in
	// the entry block, so a loop does not grow the stack.
	std::string bytes = unescape(t->id);
	bytes.push_back('\0');
	ArrayType *type = ArrayType::get(i8, bytes.size());
	GlobalVariable *contents = new GlobalVariable(*TheModule, type, true, GlobalValue::PrivateLinkage,
	                                              ConstantDataArray::getString(TheContext, bytes, false), ".str");
	contents->setUnnamedAddr(GlobalValue::UnnamedAddr::Global);
	contents->setAlignment(Align(1));
	BasicBlock &entry = Builder.GetInsertBlock()->getParent()->getEntryBlock();
	IRBuilder<> entryBuilder(&entry, entry.begin());
	AllocaInst *slot = entryBuilder.CreateAlloca(type, nullptr, "newString");
	Builder.CreateMemCpy(slot, MaybeAlign(1), contents, MaybeAlign(1), bytes.size());
	return trackPtr(slot, type);
}

static LLVM_ATTRIBUTE_NOINLINE Value *compileComparison (ast t) {
	Value *v1 = rvalue(t->left);
	Value *v2 = rvalue(t->right);
	// byte holds 0 to 255, so it compares unsigned.
	bool isByte = v1->getType()->isIntegerTy(8);
	switch (t->k) {
	case EQUALS: return Builder.CreateICmpEQ(v1, v2, "equalstmp");
	case NOTEQUALS: return Builder.CreateICmpNE(v1, v2, "notequalstmp");
	case LESSEQUALS: return isByte ? Builder.CreateICmpULE(v1, v2, "lessequalstmp") : Builder.CreateICmpSLE(v1, v2, "lessequalstmp");
	case GREATEQUALS: return isByte ? Builder.CreateICmpUGE(v1, v2, "greatequalstmp") : Builder.CreateICmpSGE(v1, v2, "greatequalstmp");
	case GREATER: return isByte ? Builder.CreateICmpUGT(v1, v2, "greatertmp") : Builder.CreateICmpSGT(v1, v2, "greatertmp");
	default: return isByte ? Builder.CreateICmpULT(v1, v2, "lesstmp") : Builder.CreateICmpSLT(v1, v2, "lesstmp");
	}
}

static LLVM_ATTRIBUTE_NOINLINE Value *compileName (ast t) {
	auto found = currentFunction->NamedValues.find(t->id);
	if (found == currentFunction->NamedValues.end()) {
		error_prefix(t->line);
		error("Variable \033[1;36m%s\033[0m not in scope.", t->id);
	}
	return found->second;
}

static LLVM_ATTRIBUTE_NOINLINE Value *compileChar (ast t) {
	return c8(unescape(t->id)[0]);
}

// Nested statements recurse through ast_compile and ast_sem, so these two
// keep small stack frames: each case with locals of its own is a function
// that is not inlined.
Value * ast_compile (ast t) {
	if (t == nullptr) return nullptr;
	if (DI && statementLine(t) > 0) di_location(DI, Builder, statementLine(t));
	switch (t->k) {
	case WHILE: return compileWhile(t);
	case IF: return compileIf(t);
	case IFELSE: return compileIfElse(t);
	case SEQ: {
		// A statement list nests on the right. Walk it in a loop, so long
		// lists do not use up the stack. Statements after a return are
		// dead: emitting them would put code after the ret terminator.
		for (; t != nullptr && t->k == SEQ && blockOpen(); t = t->right)
			ast_compile(t->left);
		if (t != nullptr && blockOpen()) ast_compile(t);
		return nullptr;
	}
	case RET: return compileReturn(t);
	case PAR: return compileParameter(t);
	case PARREF: return compileReferenceParameter(t);
	case PROC: {
		return nullptr;
	}
	case VAR: return compileVariable(t);
	case ASS: {
		Value *r_value = rvalue(t->right);
		Value *l = ast_compile(t->left);
		Builder.CreateStore(r_value,l);
		return nullptr;
	}
	case ARREXPR: return compileElement(t);
	case FUNCALL: return compileCall(t);
	case FUNCDEF: return compileFunction(t);
	case ID: return compileName(t);
	case CONST: {
		return c32(t->num);
	}
	case CHAR: return compileChar(t);
	case STRING: return compileString(t);
	case BOOL: {
		return c1(strcmp(t->id, "true") == 0);
	}
	case PLUS: case MINUS: case TIMES: case DIV: case MOD:
		return compileArithmetic(t);
	case EQUALS: case NOTEQUALS: case LESSEQUALS: case GREATEQUALS: case GREATER: case LESS: return compileComparison(t);
	case NOT:
		return Builder.CreateNot(ast_compile(t->left), "nottmp");
	case AND: case OR:
		return compileLogical(t);
	default: {}
	}
	return nullptr;
}

Module *alan_module () {
	return TheModule.get();
}

bool llvm_compile (ast t, const char *debugFile) {
	// Initialize the module and the optimization passes.
	TheModule = std::make_unique<Module>("alan program", TheContext);
	DI = di_begin(*TheModule, debugFile);
	TheFPM = std::make_unique<FunctionPassManager>();
	TheLAM = std::make_unique<LoopAnalysisManager>();
	TheFAM = std::make_unique<FunctionAnalysisManager>();
	TheCGAM = std::make_unique<CGSCCAnalysisManager>();
	TheMAM = std::make_unique<ModuleAnalysisManager>();
	TheFPM->addPass(PromotePass());
	TheFPM->addPass(InstCombinePass());
	TheFPM->addPass(ReassociatePass());
	TheFPM->addPass(GVNPass());
	TheFPM->addPass(SimplifyCFGPass());
	PassBuilder PB;
	PB.registerModuleAnalyses(*TheMAM);
	PB.registerCGSCCAnalyses(*TheCGAM);
	PB.registerFunctionAnalyses(*TheFAM);
	PB.registerLoopAnalyses(*TheLAM);
	PB.crossRegisterProxies(*TheLAM, *TheFAM, *TheCGAM, *TheMAM);
	// declare void @writeInteger(i32)
	FunctionType *writeInteger_type =
		FunctionType::get(Type::getVoidTy(TheContext),
		                  std::vector<Type *>{ i32 }, false);
	TheWriteInteger =
		Function::Create(writeInteger_type, Function::ExternalLinkage,
		                 "alan_writeInteger", TheModule.get());
	funLibrary[0].funName = "writeInteger"; funLibrary[0].func = TheWriteInteger;
	struct parameterStruct *tmpFunParameter = new struct parameterStruct ();
	tmpFunParameter->isRef = false; tmpFunParameter->isArray = false;
	tmpFunParameter->parType = i32; tmpFunParameter->parTypePure = i32;
	funLibrary[0].funParameters.push_back(tmpFunParameter);
	// declare void @writeByte(i8)
	FunctionType *writeByte_type =
		FunctionType::get(Type::getVoidTy(TheContext),
		                  std::vector<Type *>{ i8 }, false);
	TheWriteByte =
		Function::Create(writeByte_type, Function::ExternalLinkage,
		                 "alan_writeByte", TheModule.get());
	funLibrary[1].funName = "writeByte"; funLibrary[1].func = TheWriteByte;
	tmpFunParameter = new struct parameterStruct ();
	tmpFunParameter->isRef = false; tmpFunParameter->isArray = false;
	tmpFunParameter->parType = i8; tmpFunParameter->parTypePure = i8;
	funLibrary[1].funParameters.push_back(tmpFunParameter);
	// declare void @writeChar(i8)
	FunctionType *writeChar_type =
		FunctionType::get(Type::getVoidTy(TheContext),
		                  std::vector<Type *>{ i8 }, false);
	TheWriteChar =
		Function::Create(writeChar_type, Function::ExternalLinkage,
		                 "alan_writeChar", TheModule.get());
	funLibrary[2].funName = "writeChar"; funLibrary[2].func = TheWriteChar;
	tmpFunParameter = new struct parameterStruct ();
	tmpFunParameter->isRef = false; tmpFunParameter->isArray = false;
	tmpFunParameter->parType = i8; tmpFunParameter->parTypePure = i8;
	funLibrary[2].funParameters.push_back(tmpFunParameter);
	// declare void @writeString(i8*)
	FunctionType *writeString_type =
		FunctionType::get(Type::getVoidTy(TheContext),
		                  std::vector<Type *>{ PointerType::get(TheContext, 0) }, false);
	TheWriteString =
		Function::Create(writeString_type, Function::ExternalLinkage,
		                 "alan_writeString", TheModule.get());
	funLibrary[3].funName = "writeString"; funLibrary[3].func = TheWriteString;
	tmpFunParameter = new struct parameterStruct ();
	tmpFunParameter->isRef = true; tmpFunParameter->isArray = true;
	tmpFunParameter->parType = i8; tmpFunParameter->parTypePure = i8;
	funLibrary[3].funParameters.push_back(tmpFunParameter);
	// declare i32 @readInteger()
	FunctionType *readInteger_type =
		FunctionType::get(i32, false);
	TheReadInteger =
		Function::Create(readInteger_type, Function::ExternalLinkage,
		                 "alan_readInteger", TheModule.get());
	funLibrary[4].funName = "readInteger"; funLibrary[4].func = TheReadInteger;
	// declare i8 @readByte()
	FunctionType *readByte_type =
		FunctionType::get(i8, false);
	TheReadByte =
		Function::Create(readByte_type, Function::ExternalLinkage,
		                 "alan_readByte", TheModule.get());
	funLibrary[5].funName = "readByte"; funLibrary[5].func = TheReadByte;
	// declare i8 @readChar()
	FunctionType *readChar_type =
		FunctionType::get(i8, false);
	TheReadChar =
		Function::Create(readChar_type, Function::ExternalLinkage,
		                 "alan_readChar", TheModule.get());
	funLibrary[6].funName = "readChar"; funLibrary[6].func = TheReadChar;
	// declare void @readString(i32, i8*)
	FunctionType *readString_type =
		FunctionType::get(Type::getVoidTy(TheContext),
		                  std::vector<Type *>{ i32, PointerType::get(TheContext, 0) }, false);
	TheReadString =
		Function::Create(readString_type, Function::ExternalLinkage,
		                 "alan_readString", TheModule.get());
	funLibrary[7].funName = "readString"; funLibrary[7].func = TheReadString;
	tmpFunParameter = new struct parameterStruct ();
	tmpFunParameter->isRef = false; tmpFunParameter->isArray = false;
	tmpFunParameter->parType = i8; tmpFunParameter->parTypePure = i8;
	funLibrary[7].funParameters.push_back(tmpFunParameter);
	tmpFunParameter = new struct parameterStruct ();
	tmpFunParameter->isRef = true; tmpFunParameter->isArray = true;
	tmpFunParameter->parType = i8; tmpFunParameter->parTypePure = i8;
	funLibrary[7].funParameters.push_back(tmpFunParameter);
	// declare i32 @extend(i8)
	FunctionType *extend_type =
		FunctionType::get(i32, std::vector<Type *>{ i8 }, false);
	TheExtend =
		Function::Create(extend_type, Function::ExternalLinkage,
		                 "alan_extend", TheModule.get());
	funLibrary[8].funName = "extend"; funLibrary[8].func = TheExtend;
	tmpFunParameter = new struct parameterStruct ();
	tmpFunParameter->isRef = false; tmpFunParameter->isArray = false;
	tmpFunParameter->parType = i8; tmpFunParameter->parTypePure = i8;
	funLibrary[8].funParameters.push_back(tmpFunParameter);
	// declare i8 @shrink(i32)
	FunctionType *shrink_type =
		FunctionType::get(i8, std::vector<Type *>{ i32 }, false);
	TheShrink =
		Function::Create(shrink_type, Function::ExternalLinkage,
		                 "alan_shrink", TheModule.get());
	funLibrary[9].funName = "shrink"; funLibrary[9].func = TheShrink;
	tmpFunParameter = new struct parameterStruct ();
	tmpFunParameter->isRef = false; tmpFunParameter->isArray = false;
	tmpFunParameter->parType = i32; tmpFunParameter->parTypePure = i32;
	funLibrary[9].funParameters.push_back(tmpFunParameter);
	// declare i32 @strlen(i8*)
	FunctionType *strlen_type =
		FunctionType::get(i32, std::vector<Type *>{ PointerType::get(TheContext, 0) }, false);
	TheStrlen =
		Function::Create(strlen_type, Function::ExternalLinkage,
		                 "alan_strlen", TheModule.get());
	funLibrary[10].funName = "strlen"; funLibrary[10].func = TheStrlen;
	tmpFunParameter = new struct parameterStruct ();
	tmpFunParameter->isRef = true; tmpFunParameter->isArray = true;
	tmpFunParameter->parType = i8; tmpFunParameter->parTypePure = i8;
	funLibrary[10].funParameters.push_back(tmpFunParameter);
	// declare i32 @strcmp(i8*, i8*)
	FunctionType *strcmp_type =
		FunctionType::get(i32, std::vector<Type *>{ PointerType::get(TheContext, 0), PointerType::get(TheContext, 0) }, false);
	TheStrcmp =
		Function::Create(strcmp_type, Function::ExternalLinkage,
		                 "alan_strcmp", TheModule.get());
	funLibrary[11].funName = "strcmp"; funLibrary[11].func = TheStrcmp;
	tmpFunParameter = new struct parameterStruct ();
	tmpFunParameter->isRef = true; tmpFunParameter->isArray = true;
	tmpFunParameter->parType = i8; tmpFunParameter->parTypePure = i8;
	funLibrary[11].funParameters.push_back(tmpFunParameter);
	tmpFunParameter = new struct parameterStruct ();
	tmpFunParameter->isRef = true; tmpFunParameter->isArray = true;
	tmpFunParameter->parType = i8; tmpFunParameter->parTypePure = i8;
	funLibrary[11].funParameters.push_back(tmpFunParameter);
	// declare void @strcpy(i8*, i8*)
	FunctionType *strcpy_type =
		FunctionType::get(Type::getVoidTy(TheContext),
		                  std::vector<Type *>{ PointerType::get(TheContext, 0), PointerType::get(TheContext, 0) }, false);
	TheStrcpy =
		Function::Create(strcpy_type, Function::ExternalLinkage,
		                 "alan_strcpy", TheModule.get());
	funLibrary[12].funName = "strcpy"; funLibrary[12].func = TheStrcpy;
	tmpFunParameter = new struct parameterStruct ();
	tmpFunParameter->isRef = true; tmpFunParameter->isArray = true;
	tmpFunParameter->parType = i8; tmpFunParameter->parTypePure = i8;
	funLibrary[12].funParameters.push_back(tmpFunParameter);
	tmpFunParameter = new struct parameterStruct ();
	tmpFunParameter->isRef = true; tmpFunParameter->isArray = true;
	tmpFunParameter->parType = i8; tmpFunParameter->parTypePure = i8;
	funLibrary[12].funParameters.push_back(tmpFunParameter);
	// declare void @strcat(i8*, i8*)
	FunctionType *strcat_type =
		FunctionType::get(Type::getVoidTy(TheContext),
		                  std::vector<Type *>{ PointerType::get(TheContext, 0), PointerType::get(TheContext, 0) }, false);
	TheStrcat =
		Function::Create(strcat_type, Function::ExternalLinkage,
		                 "alan_strcat", TheModule.get());
	funLibrary[13].funName = "strcat"; funLibrary[13].func = TheStrcat;
	tmpFunParameter = new struct parameterStruct ();
	tmpFunParameter->isRef = true; tmpFunParameter->isArray = true;
	tmpFunParameter->parType = i8; tmpFunParameter->parTypePure = i8;
	funLibrary[13].funParameters.push_back(tmpFunParameter);
	tmpFunParameter = new struct parameterStruct ();
	tmpFunParameter->isRef = true; tmpFunParameter->isArray = true;
	tmpFunParameter->parType = i8; tmpFunParameter->parTypePure = i8;
	funLibrary[13].funParameters.push_back(tmpFunParameter);
	// The runtime is C, and its byte arguments and results are unsigned
	// char. Some ABIs leave the upper bits of a register undefined unless
	// the IR says zeroext, and AArch64 macOS extends in the caller only.
	for (int i = 0; i < 14; i++) {
		Function *F = funLibrary[i].func;
		for (Argument &arg : F->args())
			if (arg.getType()->isIntegerTy(8)) arg.addAttr(Attribute::ZExt);
		if (F->getReturnType()->isIntegerTy(8)) F->addRetAttr(Attribute::ZExt);
	}
	// Define and start the main function.
	Value *c = TheModule->getOrInsertFunction("main", i32).getCallee();
	Function* main = cast<Function>(c);
	BasicBlock *BB = BasicBlock::Create(TheContext, "entry", main);
	Builder.SetInsertPoint(BB);
	currentFunction->funName = "__Main__";
	currentFunction->father = NULL;
	ast_compile(t);
	di_finish(DI);
	DI = nullptr;
	// Verify and optimize the main function.
	bool bad = verifyModule(*TheModule, &errs()) || codegenFailed;
	if (bad) {
		fprintf(stderr, "The faulty IR is:\n");
		fprintf(stderr, "------------------------------------------------\n\n");
		TheModule->print(errs(), nullptr);
		return false;
	}
	TheFPM->run(*main, *TheFAM);
	return true;
}

// The FUNCDEF node of each Alan function's symbol table entry.
static std::map<SymbolEntry *, ast> funcDecls;

// The name of a type in messages. A proc call has no value.
static const char *typeName (Type_T type) {
	return type->kind == Type_tag::TYPE_VOID ? "proc" : types[type->kind];
}

static const char *operatorName (kind k) {
	switch (k) {
	case PLUS: return "+";
	case MINUS: return "-";
	case TIMES: return "*";
	case DIV: return "/";
	case MOD: return "%";
	case EQUALS: return "==";
	case NOTEQUALS: return "!=";
	case LESSEQUALS: return "<=";
	case GREATEQUALS: return ">=";
	case GREATER: return ">";
	default: return "<";
	}
}

// Checks the operands of an arithmetic or relational operator. Spec 1.4.3:
// both are int or both are byte.
static void checkOperands (ast op) {
	const char *name = operatorName(op->k);
	Type_T l = op->left->type, r = op->right->type;
	if (l->isArray == 1 || r->isArray == 1) {
		error_prefix(op->line);
		error("type mismatch in %s operator (can't use array in expression).", name);
	}
	if (!equalType(l, r)) {
		error_prefix(op->line);
		error("type mismatch in %s operator (type \033[1;36m%s\033[0m with type \033[1;36m%s\033[0m).", name, typeName(l), typeName(r));
	}
	if (l->kind != Type_tag::TYPE_INTEGER && l->kind != Type_tag::TYPE_CHAR) {
		error_prefix(op->line);
		error("type mismatch in %s operator (operands must be int or byte, not %s).", name, typeName(l));
	}
}

static LLVM_ATTRIBUTE_NOINLINE Type_T checkReturn (ast t, SymbolEntry *f) {
	//printf("%s\n",kinds[t->k]);
	if (f->entryType != ENTRY_FUNCTION) { error_prefix(t->line); error("case RET error!");}
	Type_T functionType = f->u.eFunction.resultType;
	if (functionType->kind == Type_tag::TYPE_VOID && t->left->k != TYPE) {
		error_prefix(t->line);
		error("Function \033[1;36m%s\033[0m is a proc, so its return cannot have a value.", f->id);
	}
	Type_T tempType = ast_sem(t->left,f);
	if (tempType->isArray != 0) {
		error_prefix(t->line);
		error("Can't return whole array.");
	}
	if (!equalType(functionType, tempType)) {
		error_prefix(t->line);
		error("Function %s must return %s.", f->id, types[functionType->kind]);
	}
	return NULL;
}

static LLVM_ATTRIBUTE_NOINLINE Type_T checkVariable (ast t, SymbolEntry *f) {
	// A parameter's array type has no size, a variable's must be positive.
	if (t->left->k == TYPEARR && t->left->num <= 0) {
		error_prefix(t->line);
		error("Array size must be a positive int.");
	}
	newVariable(t->id, ast_sem(t->left,f));
	return NULL;
}

static LLVM_ATTRIBUTE_NOINLINE Type_T checkAssignment (ast t, SymbolEntry *f) {
	//printf("%s: =\n",kinds[t->k]);
	Type_T type1 = ast_sem(t->left,f);
	Type_T type2 = ast_sem(t->right,f);
	if (type1->isArray != 0 || type2->isArray != 0) {
		error_prefix(t->line);
		error("Can't assign whole arrays or strings by = operator.");
	}
	if (!equalType(type1, type2)) {
		error_prefix(t->line);
		error("Can't assign different types (type \033[1;36m%s\033[0m with type \033[1;36m%s\033[0m).",types[type1->kind],types[type2->kind]);
	}
	return NULL;
}

static LLVM_ATTRIBUTE_NOINLINE Type_T checkElement (ast t, SymbolEntry *f) {
	//printf("%s\n",kinds[t->k]);
	Type_T retType = new Type_tag();
	Type_T tempType = ast_sem(t->left,f);
	retType->isArray = tempType->isArray;
	retType->kind = tempType->kind;
	retType->size = tempType->size;
	if (retType->isArray == 0) {
		error_prefix(t->line);
		error ("Expected array.");
	}
	t->id = t->left->id;
	retType->isArray = 0;
	t->type = retType;
	Type_T tempType2 = ast_sem(t->right,f);
	if (tempType2->kind != Type_tag::TYPE_INTEGER || tempType2->isArray) {
		error_prefix(t->line);
		error ("Index of array must be an int.");
	}
	return retType;
}

static LLVM_ATTRIBUTE_NOINLINE Type_T checkCall (ast t, SymbolEntry *f) {
	SymbolEntry *theFunction = lookupEntry(t->id,LOOKUP_ALL_SCOPES,false);
	if (theFunction == NULL) {
		theFunction = lookupLibrary(t->id);
		if (theFunction == NULL) {
			error_prefix(t->line);
			error("Function \033[1;36m%s\033[0m is not declared in this Scope.", t->id);
		}
	}
	if (theFunction->entryType != ENTRY_FUNCTION) { error_prefix(t->line); error("\033[1;36m%s\033[0m is not a function.", t->id);}
	// NULL for a library function, which has no FUNCDEF.
	auto decl = funcDecls.find(theFunction);
	t->decl = decl == funcDecls.end() ? NULL : decl->second;
	t->type = theFunction->u.eFunction.resultType;
	SymbolEntry *param = theFunction->u.eFunction.firstArgument;
	if (param == NULL && t->left != NULL) { error_prefix(t->line); error("Function \033[1;36m%s\033[0m cannot have any Parameters.", t->id);}
	if (param != NULL && t->left == NULL) { error_prefix(t->line); error("Function \033[1;36m%s\033[0m must have Parameters.", t->id);}
	// The arguments nest on the right: SEQ(a, SEQ(b, c)).
	for (ast iter = t->left; iter != NULL; param = param->u.eParameter.next) {
		ast arg = iter->k == SEQ ? iter->left : iter;
		iter = iter->k == SEQ ? iter->right : NULL;
		if (param == NULL) { error_prefix(t->line); error("Error at Parameter \033[1;36m%s\033[0m, there are too many Parameters.", t->id);}
		Type_T argType = ast_sem(arg, f);
		Type_T parType = param->u.eParameter.type;
		if (argType->isArray != parType->isArray) {
			error_prefix(t->line);
			if (parType->isArray) error("\033[1;36m%s\033[0m Parameter Type Mismatch (an array is expected).", param->id);
			else error("\033[1;36m%s\033[0m Parameter Type Mismatch (no arrays allowed).", param->id);
		}
		if (!equalType(argType, parType)) {
			error_prefix(t->line);
			error("\033[1;36m%s\033[0m Parameter Type Mismatch (type \033[1;36m%s\033[0m with type \033[1;36m%s\033[0m).", param->id, typeName(argType), typeName(parType));
		}
		// Spec 1.4.4: a reference parameter needs an l-value: a variable,
		// a parameter, an array element or a string literal.
		if (param->u.eParameter.mode == PASS_BY_REFERENCE && arg->k != ID && arg->k != ARREXPR && arg->k != STRING) {
			error_prefix(t->line);
			error("Only L-values can be passed by reference (parameter \033[1;36m%s\033[0m).", param->id);
		}
	}
	if (param != NULL) { error_prefix(t->line); error("Error at Parameter \033[1;36m%s\033[0m, there must exist more Parameters.", param->id);}
	return t->type;
}

static LLVM_ATTRIBUTE_NOINLINE Type_T checkFunction (ast t, SymbolEntry *f) {
	// As in Pascal, the name of a function belongs to the enclosing
	// scope, and its parameters and locals to a scope of its own. The
	// program's function gets an outer scope for its name.
	bool outermost = currentScope == NULL;
	if (outermost) openScope();
	// A duplicate name is reported on the line of the header.
	linecount = functionLine(t);
	// The program starts by calling this function with no arguments.
	if (outermost && t->left != NULL) {
		error_prefix(functionLine(t));
		error("The main function \033[1;36m%s\033[0m cannot have parameters.", t->id);
	}
	SymbolEntry *theFunction = newFunction(t->id);
	funcDecls[theFunction] = t;
	openScope();
	ast_sem(t->left, theFunction);
	Type_T resultType = ast_sem(resultTypeNode(t),NULL);
	theFunction->u.eFunction.resultType = resultType;
	ast_sem(t->right, theFunction);
	endFunctionHeader(theFunction, resultType);
	closeScope();
	if (outermost) closeScope();
	return NULL;
}

static LLVM_ATTRIBUTE_NOINLINE Type_T checkName (ast t, SymbolEntry *f) {
	SymbolEntry *entry = lookupEntry(t->id,LOOKUP_CURRENT_SCOPE,false);
	if (entry == NULL) {
		error_prefix(t->line);
		error("Identifier \033[1;36m%s\033[0m not found.", t->id);
	}
	switch (entry->entryType) {
	case ENTRY_VARIABLE: t->type = entry->u.eVariable.type; break;
	case ENTRY_PARAMETER: t->type = entry->u.eParameter.type; break;
	case ENTRY_CONSTANT: t->type = entry->u.eConstant.type; break;
	case ENTRY_TEMPORARY: t->type = entry->u.eTemporary.type; break;
	case ENTRY_FUNCTION:
		// Spec 1.4.1: only variables and parameters are l-values, and a
		// function is used only by calling it.
		error_prefix(t->line);
		error("\033[1;36m%s\033[0m is a function, so it needs arguments in parentheses.", t->id);
	}
	return t->type;
}

static LLVM_ATTRIBUTE_NOINLINE Type_T checkArithmetic (ast t, SymbolEntry *f) {
	// Walk the left side of a chain such as a + b - c in a loop, as
	// ast_compile does, so long expressions do not use up the stack.
	std::vector<ast> chain;
	ast first = t;
	while (isArithmetic(first->k)) {
		chain.push_back(first);
		first = first->left;
	}
	ast_sem(first,f);
	for (auto it = chain.rbegin(); it != chain.rend(); ++it) {
		ast op = *it;
		linecount = op->line;
		ast_sem(op->right,f);
		checkOperands(op);
		op->type = op->left->type;
	}
	return t->type;
}

Type_T ast_sem (ast t, SymbolEntry * f) {
	if (t == NULL) return NULL;
	// Symbol table errors have no line of their own, so they use this one.
	linecount = t->line;
	switch (t->k) {
	case WHILE: {
		//printf("%s\n",kinds[t->k]);
		ast_sem(t->left,f);
		if (!equalType(t->left->type, typeBoolean))
		{
			error_prefix(t->line);
			error("While loop expects a boolean expression.");
		}
		ast_sem(t->right,f);
		return NULL;
	}
	case IF: {
		//printf("%s\n",kinds[t->k]);
		ast_sem(t->left,f);
		if (!equalType(t->left->type, typeBoolean))
		{ error_prefix(t->line);
		  error("If expects a boolean condition.");}
		ast_sem(t->right,f);
		return NULL;
	}
	case IFELSE: {
		//printf("%s\n",kinds[t->k]);
		ast_sem(t->left,f);
		ast_sem(t->right,f);
		return NULL;
	}
	case SEQ: {
		// A statement list nests on the right, so walk it in a loop.
		for (; t != NULL && t->k == SEQ; t = t->right)
			ast_sem(t->left, f);
		ast_sem(t, f);
		return NULL;
	}
	case RET: return checkReturn(t, f);
	case PAR: {
		if (t->left->k == TYPEARR) {
			error_prefix(t->line);
			error("In function \033[1;36m%s\033[0m, array must be a reference parameter.", f->id);
		}
		newParameter(t->id, ast_sem(t->left, f), PASS_BY_VALUE, f);
		return NULL;
	}
	case PARREF: {
		//printf("%s: %s\n",kinds[t->k] ,t->id);
		newParameter(t->id, ast_sem(t->left, f), PASS_BY_REFERENCE, f);
		return NULL;
	}
	case TYPE: {
		//printf("%s: %s\n",kinds[t->k] ,types[t->type->kind]);
		t->type->isArray = 0;
		return t->type;
	}
	case TYPEARR: {
		//printf("%s: %s ARRAY\n",kinds[t->k] ,types[t->type->kind]);
		t->type->isArray = 1;
		t->type->size = t->num;
		return t->type;
	}
	case PROC: {
		//printf("%s: %s\n",kinds[t->k] ,"VOID");
		return typeVoid;
	}
	case VAR: return checkVariable(t, f);
	case ASS: return checkAssignment(t, f);
	case ARREXPR: return checkElement(t, f);
	case FUNCALL: return checkCall(t, f);
	case FUNCDEF: return checkFunction(t, f);
	case ID: return checkName(t, f);
	case CONST: {
		//printf("%s: %d\n",kinds[t->k] ,t->num);
		return t->type;
	}
	case CHAR: {
		//printf("%s: %s\n",kinds[t->k] ,t->id);
		return t->type;
	}
	case STRING: {
		//printf("%s: %s\n",kinds[t->k] ,t->id);
		return t->type;
	}
	case BOOL: {
		//printf("%s: %s\n",kinds[t->k] ,t->id);
		// true and false are literals, not names, so they get no symbol
		// table entry. One entry per use gave "Duplicate identifier".
		t->type = typeBoolean;
		return t->type;
	}
	case PLUS: case MINUS: case TIMES: case DIV: case MOD: return checkArithmetic(t, f);
	case EQUALS: case NOTEQUALS: case LESSEQUALS: case GREATEQUALS: case GREATER: case LESS: {
		ast_sem(t->left,f);
		ast_sem(t->right,f);
		checkOperands(t);
		return t->type;
	}
	case NOT: {
		//printf("%s: !\n",kinds[t->k]);
		ast_sem(t->left,f);
		if (!equalType(t->left->type, typeBoolean))
		{ error_prefix(t->line);
		  error("type mismatch in ! operator.");}
		return t->type;
	}
	case AND: {
		//printf("%s: &\n",kinds[t->k]);
		ast_sem(t->left,f);
		ast_sem(t->right,f);
		if (!equalType(t->left->type, typeBoolean) ||
		    !equalType(t->right->type, typeBoolean))
		{ error_prefix(t->line);
		  error("type mismatch in AND operator.");}
		return t->type;
	}
	case OR: {
		//printf("%s: |\n",kinds[t->k]);
		ast_sem(t->left,f);
		ast_sem(t->right,f);
		if (!equalType(t->left->type, typeBoolean) ||
		    !equalType(t->right->type, typeBoolean))
		{ error_prefix(t->line);
		  error("type mismatch in OR operator.");}
		return t->type;
	}
	}
	return NULL;
}

void createLibrary(){

	library[0] = (SymbolEntry *)new(SymbolEntry);
	library[0]->id = new char [strlen("writeInteger") + 1];
	strcpy((library[0]->id), "writeInteger");
	library[0]->entryType = ENTRY_FUNCTION;
	library[0]->u.eFunction.resultType = typeVoid;
	library[0]->u.eFunction.firstArgument = (SymbolEntry *)new(SymbolEntry);
	library[0]->u.eFunction.firstArgument->id = new char [strlen("n") + 1];
	strcpy((library[0]->u.eFunction.firstArgument->id), "n");
	library[0]->u.eFunction.firstArgument->entryType = ENTRY_PARAMETER;
	library[0]->u.eFunction.firstArgument->u.eParameter.type = createInt();
	library[0]->u.eFunction.firstArgument->u.eParameter.type->refCount++;
	library[0]->u.eFunction.firstArgument->u.eParameter.mode = PASS_BY_VALUE;
	library[0]->u.eFunction.firstArgument->u.eParameter.next = NULL;
	library[0]->u.eFunction.lastArgument = library[0]->u.eFunction.firstArgument;

	library[1] = (SymbolEntry *)new(SymbolEntry);
	library[1]->id = new char [strlen("writeByte") + 1];
	strcpy((library[1]->id), "writeByte");
	library[1]->entryType = ENTRY_FUNCTION;
	library[1]->u.eFunction.resultType = typeVoid;
	library[1]->u.eFunction.firstArgument = (SymbolEntry *)new(SymbolEntry);
	library[1]->u.eFunction.firstArgument->id = new char [strlen("b") + 1];
	strcpy((library[1]->u.eFunction.firstArgument->id), "b");
	library[1]->u.eFunction.firstArgument->entryType = ENTRY_PARAMETER;
	library[1]->u.eFunction.firstArgument->u.eParameter.type = createChar();
	library[1]->u.eFunction.firstArgument->u.eParameter.type->refCount++;
	library[1]->u.eFunction.firstArgument->u.eParameter.mode = PASS_BY_VALUE;
	library[1]->u.eFunction.firstArgument->u.eParameter.next = NULL;
	library[1]->u.eFunction.lastArgument = library[1]->u.eFunction.firstArgument;

	library[2] = (SymbolEntry *)new(SymbolEntry);
	library[2]->id = new char [strlen("writeChar") + 1];
	strcpy((library[2]->id), "writeChar");
	library[2]->entryType = ENTRY_FUNCTION;
	library[2]->u.eFunction.resultType = typeVoid;
	library[2]->u.eFunction.firstArgument = (SymbolEntry *)new(SymbolEntry);
	library[2]->u.eFunction.firstArgument->id = new char [strlen("b") + 1];
	strcpy((library[2]->u.eFunction.firstArgument->id), "b");
	library[2]->u.eFunction.firstArgument->entryType = ENTRY_PARAMETER;
	library[2]->u.eFunction.firstArgument->u.eParameter.type = createChar();
	library[2]->u.eFunction.firstArgument->u.eParameter.type->refCount++;
	library[2]->u.eFunction.firstArgument->u.eParameter.mode = PASS_BY_VALUE;
	library[2]->u.eFunction.firstArgument->u.eParameter.next = NULL;
	library[2]->u.eFunction.lastArgument = library[2]->u.eFunction.firstArgument;

	library[3] = (SymbolEntry *)new(SymbolEntry);
	library[3]->id = new char [strlen("writeString") + 1];
	strcpy((library[3]->id), "writeString");
	library[3]->entryType = ENTRY_FUNCTION;
	library[3]->u.eFunction.resultType = typeVoid;
	library[3]->u.eFunction.firstArgument = (SymbolEntry *)new(SymbolEntry);
	library[3]->u.eFunction.firstArgument->id = new char [strlen("s") + 1];
	strcpy((library[3]->u.eFunction.firstArgument->id), "s");
	library[3]->u.eFunction.firstArgument->entryType = ENTRY_PARAMETER;
	library[3]->u.eFunction.firstArgument->u.eParameter.type = createCharArr();
	library[3]->u.eFunction.firstArgument->u.eParameter.type->refCount++;
	library[3]->u.eFunction.firstArgument->u.eParameter.mode = PASS_BY_REFERENCE;
	library[3]->u.eFunction.firstArgument->u.eParameter.next = NULL;
	library[3]->u.eFunction.lastArgument = library[3]->u.eFunction.firstArgument;

	library[4] = (SymbolEntry *)new(SymbolEntry);
	library[4]->id = new char [strlen("readInteger") + 1];
	strcpy((library[4]->id), "readInteger");
	library[4]->entryType = ENTRY_FUNCTION;
	library[4]->u.eFunction.resultType = createInt();
	library[4]->u.eFunction.firstArgument = library[4]->u.eFunction.lastArgument = NULL;

	library[5] = (SymbolEntry *)new(SymbolEntry);
	library[5]->id = new char [strlen("readByte") + 1];
	strcpy((library[5]->id), "readByte");
	library[5]->entryType = ENTRY_FUNCTION;
	library[5]->u.eFunction.resultType = createChar();
	library[5]->u.eFunction.firstArgument = library[5]->u.eFunction.lastArgument = NULL;

	library[6] = (SymbolEntry *)new(SymbolEntry);
	library[6]->id = new char [strlen("readChar") + 1];
	strcpy((library[6]->id), "readChar");
	library[6]->entryType = ENTRY_FUNCTION;
	library[6]->u.eFunction.resultType = createChar();
	library[6]->u.eFunction.firstArgument = library[6]->u.eFunction.lastArgument = NULL;

	library[7] = (SymbolEntry *)new(SymbolEntry);
	library[7]->id = new char [strlen("readString") + 1];
	strcpy((library[7]->id), "readString");
	library[7]->entryType = ENTRY_FUNCTION;
	library[7]->u.eFunction.resultType = typeVoid;
	library[7]->u.eFunction.firstArgument = (SymbolEntry *)new(SymbolEntry);
	library[7]->u.eFunction.firstArgument->id = new char [strlen("n") + 1];
	strcpy((library[7]->u.eFunction.firstArgument->id), "n");
	library[7]->u.eFunction.firstArgument->entryType = ENTRY_PARAMETER;
	library[7]->u.eFunction.firstArgument->u.eParameter.type = createInt();
	library[7]->u.eFunction.firstArgument->u.eParameter.type->refCount++;
	library[7]->u.eFunction.firstArgument->u.eParameter.mode = PASS_BY_VALUE;
	library[7]->u.eFunction.lastArgument = (SymbolEntry *)new(SymbolEntry);
	library[7]->u.eFunction.lastArgument->id = new char [strlen("s") + 1];
	strcpy((library[7]->u.eFunction.lastArgument->id), "s");
	library[7]->u.eFunction.lastArgument->entryType = ENTRY_PARAMETER;
	library[7]->u.eFunction.lastArgument->u.eParameter.type = createCharArr();
	library[7]->u.eFunction.lastArgument->u.eParameter.type->refCount++;
	library[7]->u.eFunction.lastArgument->u.eParameter.mode = PASS_BY_REFERENCE;
	library[7]->u.eFunction.lastArgument->u.eParameter.next = NULL;
	library[7]->u.eFunction.firstArgument->u.eParameter.next = library[7]->u.eFunction.lastArgument;

	library[8] = (SymbolEntry *)new(SymbolEntry);
	library[8]->id = new char [strlen("extend") + 1];
	strcpy((library[8]->id), "extend");
	library[8]->entryType = ENTRY_FUNCTION;
	library[8]->u.eFunction.resultType = createInt();
	library[8]->u.eFunction.firstArgument = (SymbolEntry *)new(SymbolEntry);
	library[8]->u.eFunction.firstArgument->id = new char [strlen("b") + 1];
	strcpy((library[8]->u.eFunction.firstArgument->id), "b");
	library[8]->u.eFunction.firstArgument->entryType = ENTRY_PARAMETER;
	library[8]->u.eFunction.firstArgument->u.eParameter.type = createChar();
	library[8]->u.eFunction.firstArgument->u.eParameter.type->refCount++;
	library[8]->u.eFunction.firstArgument->u.eParameter.mode = PASS_BY_VALUE;
	library[8]->u.eFunction.firstArgument->u.eParameter.next = NULL;
	library[8]->u.eFunction.lastArgument = library[8]->u.eFunction.firstArgument;

	library[9] = (SymbolEntry *)new(SymbolEntry);
	library[9]->id = new char [strlen("shrink") + 1];
	strcpy((library[9]->id), "shrink");
	library[9]->entryType = ENTRY_FUNCTION;
	library[9]->u.eFunction.resultType = createChar();
	library[9]->u.eFunction.firstArgument = (SymbolEntry *)new(SymbolEntry);
	library[9]->u.eFunction.firstArgument->id = new char [strlen("i") + 1];
	strcpy((library[9]->u.eFunction.firstArgument->id), "i");
	library[9]->u.eFunction.firstArgument->entryType = ENTRY_PARAMETER;
	library[9]->u.eFunction.firstArgument->u.eParameter.type = createInt();
	library[9]->u.eFunction.firstArgument->u.eParameter.type->refCount++;
	library[9]->u.eFunction.firstArgument->u.eParameter.mode = PASS_BY_VALUE;
	library[9]->u.eFunction.firstArgument->u.eParameter.next = NULL;
	library[9]->u.eFunction.lastArgument = library[9]->u.eFunction.firstArgument;

	library[10] = (SymbolEntry *)new(SymbolEntry);
	library[10]->id = new char [strlen("strlen") + 1];
	strcpy((library[10]->id), "strlen");
	library[10]->entryType = ENTRY_FUNCTION;
	library[10]->u.eFunction.resultType = createInt();
	library[10]->u.eFunction.firstArgument = (SymbolEntry *)new(SymbolEntry);
	library[10]->u.eFunction.firstArgument->id = new char [strlen("s") + 1];
	strcpy((library[10]->u.eFunction.firstArgument->id), "s");
	library[10]->u.eFunction.firstArgument->entryType = ENTRY_PARAMETER;
	library[10]->u.eFunction.firstArgument->u.eParameter.type = createCharArr();
	library[10]->u.eFunction.firstArgument->u.eParameter.type->refCount++;
	library[10]->u.eFunction.firstArgument->u.eParameter.mode = PASS_BY_REFERENCE;
	library[10]->u.eFunction.firstArgument->u.eParameter.next = NULL;
	library[10]->u.eFunction.lastArgument = library[10]->u.eFunction.firstArgument;

	library[11] = (SymbolEntry *)new(SymbolEntry);
	library[11]->id = new char [strlen("strcmp") + 1];
	strcpy((library[11]->id), "strcmp");
	library[11]->entryType = ENTRY_FUNCTION;
	library[11]->u.eFunction.resultType = createInt();
	library[11]->u.eFunction.firstArgument = (SymbolEntry *)new(SymbolEntry);
	library[11]->u.eFunction.firstArgument->id = new char [strlen("s1") + 1];
	strcpy((library[11]->u.eFunction.firstArgument->id), "s1");
	library[11]->u.eFunction.firstArgument->entryType = ENTRY_PARAMETER;
	library[11]->u.eFunction.firstArgument->u.eParameter.type = createCharArr();
	library[11]->u.eFunction.firstArgument->u.eParameter.type->refCount++;
	library[11]->u.eFunction.firstArgument->u.eParameter.mode = PASS_BY_REFERENCE;
	library[11]->u.eFunction.lastArgument = (SymbolEntry *)new(SymbolEntry);
	library[11]->u.eFunction.lastArgument->id = new char [strlen("s2") + 1];
	strcpy((library[11]->u.eFunction.lastArgument->id), "s2");
	library[11]->u.eFunction.lastArgument->entryType = ENTRY_PARAMETER;
	library[11]->u.eFunction.lastArgument->u.eParameter.type = createCharArr();
	library[11]->u.eFunction.lastArgument->u.eParameter.type->refCount++;
	library[11]->u.eFunction.lastArgument->u.eParameter.mode = PASS_BY_REFERENCE;
	library[11]->u.eFunction.lastArgument->u.eParameter.next = NULL;
	library[11]->u.eFunction.firstArgument->u.eParameter.next = library[11]->u.eFunction.lastArgument;

	library[12] = (SymbolEntry *)new(SymbolEntry);
	library[12]->id = new char [strlen("strcpy") + 1];
	strcpy((library[12]->id), "strcpy");
	library[12]->entryType = ENTRY_FUNCTION;
	library[12]->u.eFunction.resultType = typeVoid;
	library[12]->u.eFunction.firstArgument = (SymbolEntry *)new(SymbolEntry);
	library[12]->u.eFunction.firstArgument->id = new char [strlen("trg") + 1];
	strcpy((library[12]->u.eFunction.firstArgument->id), "trg");
	library[12]->u.eFunction.firstArgument->entryType = ENTRY_PARAMETER;
	library[12]->u.eFunction.firstArgument->u.eParameter.type = createCharArr();
	library[12]->u.eFunction.firstArgument->u.eParameter.type->refCount++;
	library[12]->u.eFunction.firstArgument->u.eParameter.mode = PASS_BY_REFERENCE;
	library[12]->u.eFunction.lastArgument = (SymbolEntry *)new(SymbolEntry);
	library[12]->u.eFunction.lastArgument->id = new char [strlen("src") + 1];
	strcpy((library[12]->u.eFunction.lastArgument->id), "src");
	library[12]->u.eFunction.lastArgument->entryType = ENTRY_PARAMETER;
	library[12]->u.eFunction.lastArgument->u.eParameter.type = createCharArr();
	library[12]->u.eFunction.lastArgument->u.eParameter.type->refCount++;
	library[12]->u.eFunction.lastArgument->u.eParameter.mode = PASS_BY_REFERENCE;
	library[12]->u.eFunction.lastArgument->u.eParameter.next = NULL;
	library[12]->u.eFunction.firstArgument->u.eParameter.next = library[12]->u.eFunction.lastArgument;

	library[13] = (SymbolEntry *)new(SymbolEntry);
	library[13]->id = new char [strlen("strcat") + 1];
	strcpy((library[13]->id), "strcat");
	library[13]->entryType = ENTRY_FUNCTION;
	library[13]->u.eFunction.resultType = typeVoid;
	library[13]->u.eFunction.firstArgument = (SymbolEntry *)new(SymbolEntry);
	library[13]->u.eFunction.firstArgument->id = new char [strlen("trg") + 1];
	strcpy((library[13]->u.eFunction.firstArgument->id), "trg");
	library[13]->u.eFunction.firstArgument->entryType = ENTRY_PARAMETER;
	library[13]->u.eFunction.firstArgument->u.eParameter.type = createCharArr();
	library[13]->u.eFunction.firstArgument->u.eParameter.type->refCount++;
	library[13]->u.eFunction.firstArgument->u.eParameter.mode = PASS_BY_REFERENCE;
	library[13]->u.eFunction.lastArgument = (SymbolEntry *)new(SymbolEntry);
	library[13]->u.eFunction.lastArgument->id = new char [strlen("src") + 1];
	strcpy((library[13]->u.eFunction.lastArgument->id), "src");
	library[13]->u.eFunction.lastArgument->entryType = ENTRY_PARAMETER;
	library[13]->u.eFunction.lastArgument->u.eParameter.type = createCharArr();
	library[13]->u.eFunction.lastArgument->u.eParameter.type->refCount++;
	library[13]->u.eFunction.lastArgument->u.eParameter.mode = PASS_BY_REFERENCE;
	library[13]->u.eFunction.lastArgument->u.eParameter.next = NULL;
	library[13]->u.eFunction.firstArgument->u.eParameter.next = library[13]->u.eFunction.lastArgument;
}

SymbolEntry* lookupLibrary(char * name){
	for (int i = 0; i<14; i++) {
		if (strcmp(library[i]->id, name) == 0) return library[i];
	}
	return NULL;
}

Type_T createChar(){
	Type_T theType = new Type_tag();
	theType->kind = Type_tag::TYPE_CHAR;
	theType->isArray = 0;
	theType->refType = NULL;
	theType->size = 0;
	theType->refCount = 0;
	return theType;
}

Type_T createCharArr(){
	Type_T theType = new Type_tag();
	theType->kind = Type_tag::TYPE_CHAR;
	theType->isArray = 1;
	theType->refType = NULL;
	theType->size = 0;
	theType->refCount = 0;
	return theType;
}

Type_T createInt(){
	Type_T theType = new Type_tag();
	theType->kind = Type_tag::TYPE_INTEGER;
	theType->isArray = 0;
	theType->refType = NULL;
	theType->size = 0;
	theType->refCount = 0;
	return theType;
}

Type_T createIntArr(){
	Type_T theType = new Type_tag();
	theType->kind = Type_tag::TYPE_INTEGER;
	theType->isArray = 1;
	theType->refType = NULL;
	theType->size = 0;
	theType->refCount = 0;
	return theType;
}

Type_T createString(char* theString){
	Type_T theType = new Type_tag();
	theType->kind = Type_tag::TYPE_CHAR;
	theType->isArray = 1;
	theType->refType = NULL;
	theType->size = static_cast<RepInteger>(strlen(theString));
	theType->refCount = 0;
	return theType;
}
