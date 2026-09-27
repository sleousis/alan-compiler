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
	if (op != BOOL) {
		char* substr = (char*)calloc(strlen(c)-1, 1);
		strncpy(substr, c+1, strlen(c)-2);
		return ast_make(op, substr, 0, NULL, NULL, t, line);
	}  if (op != BOOL) {
		char* substr = (char*)calloc(strlen(c)-1, 1);
		strncpy(substr, c+1, strlen(c)-2);
		return ast_make(op, substr, 0, NULL, NULL, t, line);
	}
	else{
		return ast_make(op, c, 0, NULL, NULL, t, line);
	}
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

//string helper functions
int hexToInt(char c)
{
	int first = c / 16 - 3;
	int second = c % 16;
	int result = first*10 + second;
	if (result > 9) result--;
	return result;
}

int hexToLetter(char c, char d)
{
	int high = hexToInt(c) * 16;
	int low = hexToInt(d);
	return high+low;
}

//struct implementing function's variables (names and types)
struct variableStruct {
	const char* varName;
	Type* varType;
	bool isArray;
};

//struct implementing function's hidden parameters
struct hiddenParameterStruct {
	const char* parName;
	Type* parType;
	bool isArray;
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
	std::vector<struct functionTable*> children;
	std::map<std::string, Value *> NamedValues;
	std::vector<struct parameterStruct*> funParameters;
	std::vector<struct variableStruct*> funVariables;
	std::vector<struct hiddenParameterStruct*> funHiddenParameters;
	Function *func;
	std::vector<ast> funcDefsDismissed;
};
struct functionTable *currentFunction = new struct functionTable ();

struct functionTable* findFunction (char* funName) {
	struct functionTable *tmp = currentFunction;
	for (size_t i = 0; i < tmp->children.size(); i++) {
		if (strcmp(tmp->children[i]->funName, funName) == 0) {
			tmp = tmp->children[i];
			return tmp;
		}
	}
	tmp = tmp->father;
	for (size_t i = 0; i < tmp->children.size(); i++) {
		if (strcmp(tmp->children[i]->funName, funName) == 0) {
			tmp = tmp->children[i];
			return tmp;
		}
	}
	return NULL;
}

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
	Function *TheFunction = Function::Create(type, Function::ExternalLinkage, name, TheModule.get());
	return TheFunction;
}

bool FuncDefLockEnabled = true;
bool isVariable = true;
bool retEnabled = false;
BasicBlock *globalBB;

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

// The line a function is declared on: the line of its result type.
static int functionLine (ast t) {
	return t->right->k == SEQ ? t->right->left->line : t->right->line;
}

Value * ast_compile (ast t) {
	if (t == nullptr) return nullptr;
	if (DI && statementLine(t) > 0) di_location(DI, Builder, statementLine(t));
	switch (t->k) {
	case WHILE: {
		// Emit the number of iterations.
		Value *n = ast_compile(t->left);
		// Make the new basic block for the loop.
		Function *TheFunction = Builder.GetInsertBlock()->getParent();
		BasicBlock *PreheaderBB = Builder.GetInsertBlock();
		BasicBlock *LoopBB = BasicBlock::Create(TheContext, "loop", TheFunction);
		// Insert an explicit fall-through from the current block.
		if (!retEnabled) Builder.CreateBr(LoopBB);
		else retEnabled = false;
		// Start insertion in the loop.
		Builder.SetInsertPoint(LoopBB);
		// Create the phi node and start it with the number of iterations.
		PHINode *phi_iter = Builder.CreatePHI(i1, 0, "iter");
		phi_iter->addIncoming(n, PreheaderBB);
		// Create the end loop condition.
		Value *cond = Builder.CreateICmpEQ(phi_iter, c1(1), "loop_cond");
		// Create the "after loop" block.
		BasicBlock *InsideBB =
			BasicBlock::Create(TheContext, "inside", TheFunction);
		BasicBlock *AfterBB =
			BasicBlock::Create(TheContext, "after", TheFunction);
		Builder.CreateCondBr(cond, InsideBB, AfterBB);
		Builder.SetInsertPoint(InsideBB);
		globalBB = InsideBB;
		// Emit the body of the loop.
		ast_compile(t->right);
		// Decrease the number of iterations.
		if (DI) di_location(DI, Builder, statementLine(t));
		Value *newCond = ast_compile(t->left);
		// Loop back.
		phi_iter->addIncoming(newCond, Builder.GetInsertBlock());
		if (!retEnabled) Builder.CreateBr(LoopBB);
		else retEnabled = false;
		// End of loop.
		Builder.SetInsertPoint(AfterBB);
		globalBB = AfterBB;
		return nullptr;
	}
	case IF: {
		Value *v = ast_compile(t->left);
		Value *cond = Builder.CreateICmpNE(v, c1(0), "if_cond");
		Function *TheFunction = Builder.GetInsertBlock()->getParent();
		BasicBlock *InsideBB =
			BasicBlock::Create(TheContext, "then", TheFunction);
		BasicBlock *AfterBB =
			BasicBlock::Create(TheContext, "endif", TheFunction);
		Builder.CreateCondBr(cond, InsideBB, AfterBB);
		Builder.SetInsertPoint(InsideBB);
		globalBB = InsideBB;
		ast_compile(t->right);
		if (!retEnabled) Builder.CreateBr(AfterBB);
		else retEnabled = false;
		Builder.SetInsertPoint(AfterBB);
		globalBB = AfterBB;
		return nullptr;
	}
	case IFELSE: {
		Value *v = ast_compile(t->left->left);
		Value *cond = Builder.CreateICmpNE(v, c1(0), "if_cond");
		Function *TheFunction = Builder.GetInsertBlock()->getParent();
		BasicBlock *InsideBB =
			BasicBlock::Create(TheContext, "then", TheFunction);
		BasicBlock *ElseInsideBB =
			BasicBlock::Create(TheContext, "else", TheFunction);
		BasicBlock *AfterBB =
			BasicBlock::Create(TheContext, "endifelse", TheFunction);
		Builder.CreateCondBr(cond, InsideBB, ElseInsideBB);
		Builder.SetInsertPoint(InsideBB);
		globalBB = InsideBB;
		ast_compile(t->left->right);
		if (!retEnabled) Builder.CreateBr(AfterBB);
		else retEnabled = false;
		Builder.SetInsertPoint(ElseInsideBB);
		globalBB = ElseInsideBB;
		ast_compile(t->right);
		if (!retEnabled) Builder.CreateBr(AfterBB);
		else retEnabled = false;
		Builder.SetInsertPoint(AfterBB);
		globalBB = AfterBB;
		return nullptr;
	}
	case SEQ: {
		ast_compile(t->left);
		// Statements after a return are dead. Emitting them would put
		// instructions after the ret terminator and fail verification.
		if (!retEnabled) ast_compile(t->right);
		return nullptr;
	}
	case RET: {
		Value *l_value;
		Value *l = ast_compile(t->left);
		if (isVariable) l_value = loadValue(l);
		else l_value = l;
		retEnabled = true;
		return Builder.CreateRet(l_value);
	}
	case PAR: {
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
		if (t->left->k == TYPEARR) {
			error_prefix(t->line);
			error("In function \033[1;36m%s\033[0m, array must be a reference parameter.", currentFunction->funName);
		}
		tmpFunParameter->isRef = false;
		tmpFunParameter->isArray = false;
		currentFunction->funParameters.push_back(tmpFunParameter);
		return nullptr;
	}
	case PARREF: {
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
	case PROC: {
		return nullptr;
	}
	case VAR: {
		struct variableStruct *tmp = new struct variableStruct ();
		if (t->left->type->kind == Type_tag::TYPE_INTEGER) {
			if (t->left->k == TYPE) {
				currentFunction->NamedValues[t->id] = trackPtr(Builder.CreateAlloca(i32,0,t->id), i32);
				tmp->varName = t->id; tmp->varType = i32; tmp->isArray = false;
				currentFunction->funVariables.push_back(tmp);
			}
			else if (t->left->k == TYPEARR) {
				currentFunction->NamedValues[t->id] = trackPtr(Builder.CreateAlloca(ArrayType::get(i32,t->left->num),0,t->id), ArrayType::get(i32,t->left->num));
				zeroArray(currentFunction->NamedValues[t->id], 4 * t->left->num);
				tmp->varName = t->id; tmp->varType = i32; tmp->isArray = true;
				currentFunction->funVariables.push_back(tmp);
			}
		}
		else if (t->left->type->kind == Type_tag::TYPE_CHAR) {
			if (t->left->k == TYPE) {
				currentFunction->NamedValues[t->id] = trackPtr(Builder.CreateAlloca(i8,0,t->id), i8);
				tmp->varName = t->id; tmp->varType = i8; tmp->isArray = false;
				currentFunction->funVariables.push_back(tmp);
			}
			else if (t->left->k == TYPEARR) {
				currentFunction->NamedValues[t->id] = trackPtr(Builder.CreateAlloca(ArrayType::get(i8,t->left->num),0,t->id), ArrayType::get(i8,t->left->num));
				zeroArray(currentFunction->NamedValues[t->id], t->left->num);
				tmp->varName = t->id; tmp->varType = i8; tmp->isArray = true;
				currentFunction->funVariables.push_back(tmp);
			}
		}
		if (DI) {
			di_variable(DI, cast<AllocaInst>(currentFunction->NamedValues[t->id]), t->id, t->line,
			            t->left->type->kind == Type_tag::TYPE_CHAR, t->left->k == TYPEARR,
			            t->left->k == TYPEARR ? t->left->num : 0);
		}
		return nullptr;
	}
	case ASS: {
		Value *r_value;
		Value *r = ast_compile(t->right);
		if (isVariable) r_value = loadValue(r);
		else r_value = r;
		Value *l = ast_compile(t->left);
		Builder.CreateStore(r_value,l);
		return nullptr;
	}
	case ARREXPR: {
		Value *r_value;
		Value *r = ast_compile(t->right);
		if (isVariable) r_value = loadValue(r);
		else r_value = r;
		Value *l = ast_compile(t->left);
		Type *arrType = PointeeTypes[l];
		Value *tmpArr = trackPtr(Builder.CreateGEP(arrType, l, std::vector<Value *>{ c32(0), r_value }, "tmpArr"),
		                         arrType->getArrayElementType());
		isVariable = true;
		return tmpArr;
	}
	case FUNCALL: {
		bool isInLibrary = false;
		struct functionTable *tmp = findFunction(t->id);
		if (tmp == NULL) {
			tmp = findFunctionInLibrary(t->id);
			if (tmp == NULL) {
				error_prefix(t->line);
				error("Function \033[1;36m%s\033[0m not in scope.", t->id);
			}
			isInLibrary = true;
		}
		//get args
		std::vector<Value*> Args;
		//pass in-scope variables
		if (!isInLibrary) {
			for (size_t i = 0; i < tmp->funHiddenParameters.size(); i++) {
				if (tmp->funHiddenParameters[i]->isArray) {
					Instruction *result = new BitCastInst(currentFunction->NamedValues[tmp->funHiddenParameters[i]->parName],
					                                      llvm::PointerType::getUnqual(TheContext),
					                                      "castedArr", globalBB);
					Args.push_back(result);
				}
				else Args.push_back(currentFunction->NamedValues[tmp->funHiddenParameters[i]->parName]);
			}
		}
		//1 or more parameters
		if (t->left != NULL) {
			Value *l, *v;
			//1 parameter
			if (t->left->k != SEQ) {
				l = ast_compile(t->left);
				if (!tmp->funParameters[0]->isRef) {
					if (isVariable) v = loadValue(l);
					else v = l;
				}
				else {
					if (tmp->funParameters[0]->isArray) {
						Instruction *result = new BitCastInst(l, llvm::PointerType::getUnqual(TheContext),
						                                      "castedArr", globalBB);
						v = result;
					}
					else v = l;
				}
				Args.push_back(v);
			}
			//2 or more parameters
			else {
				ast iter = t->left;
				int i = 0;
				while (iter->right->k == SEQ) {
					l = ast_compile(iter->left);
					if (!tmp->funParameters[i]->isRef) {
						if (isVariable) v = loadValue(l);
						else v = l;
					}
					else {
						if (tmp->funParameters[i]->isArray) {
							Instruction *result = new BitCastInst(l, llvm::PointerType::getUnqual(TheContext),
							                                      "castedArr", globalBB);
							v = result;
						}
						else v = l;
					}
					Args.push_back(v);
					i++;
					iter = iter->right;
				}
				l = ast_compile(iter->left);
				if (!tmp->funParameters[i]->isRef) {
					if (isVariable) v = loadValue(l);
					else v = l;
				}
				else {
					if (tmp->funParameters[i]->isArray) {
						Instruction *result = new BitCastInst(l, llvm::PointerType::getUnqual(TheContext),
						                                      "castedArr", globalBB);
						v = result;
					}
					else v = l;
				}
				Args.push_back(v);
				i++;
				l = ast_compile(iter->right);
				if (!tmp->funParameters[i]->isRef) {
					if (isVariable) v = loadValue(l);
					else v = l;
				}
				else {
					if (tmp->funParameters[i]->isArray) {
						Instruction *result = new BitCastInst(l, llvm::PointerType::getUnqual(TheContext),
						                                      "castedArr", globalBB);
						v = result;
					}
					else v = l;
				}
				Args.push_back(v);
				i++;
			}
		}
		//make call
		Value *retVal = Builder.CreateCall(tmp->func, Args);
		isVariable = false;
		return retVal;
	}
	case FUNCDEF: {
		if (!FuncDefLockEnabled) {
			//Enable funcDef lock
			FuncDefLockEnabled = true;
			currentFunction = findFunction(t->id);
			BasicBlock *BB = BasicBlock::Create(TheContext, "entry", currentFunction->func);
			Builder.SetInsertPoint(BB);
			globalBB = BB;
			if (DI) {
				std::vector<std::pair<std::string, Type *>> params;
				for (parameterStruct *p : currentFunction->funParameters)
					params.emplace_back(p->parName, p->parType);
				di_function(DI, currentFunction->func, t->id, functionLine(t), params);
				di_location(DI, Builder, functionLine(t));
			}
			//set args names and initialization
			Function::arg_iterator argss = currentFunction->func->arg_begin();
			for (size_t i = 0; i < currentFunction->funHiddenParameters.size(); i++) {
				Value *tmpArg = argss++;
				if (currentFunction->funHiddenParameters[i]->isArray) {
					Instruction *result = new BitCastInst(tmpArg,
					                                      llvm::PointerType::getUnqual(TheContext),
					                                      "backCastedArr", globalBB);
					currentFunction->NamedValues[currentFunction->funHiddenParameters[i]->parName] =
						trackPtr(result, ArrayType::get(currentFunction->funHiddenParameters[i]->parType,1));
				}
				else currentFunction->NamedValues[currentFunction->funHiddenParameters[i]->parName] =
					trackPtr(tmpArg, currentFunction->funHiddenParameters[i]->parType);
				struct variableStruct *vartmp = new struct variableStruct ();
				vartmp->varName = currentFunction->funHiddenParameters[i]->parName;
				vartmp->varType = currentFunction->funHiddenParameters[i]->parType;
				vartmp->isArray = currentFunction->funHiddenParameters[i]->isArray;
				currentFunction->funVariables.push_back(vartmp);
			}
			for (size_t i = 0; i < currentFunction->funParameters.size(); i++) {
				Value *tmpArg = argss++;
				if (!currentFunction->funParameters[i]->isRef) {
					currentFunction->NamedValues[currentFunction->funParameters[i]->parName] =
						trackPtr(Builder.CreateAlloca(currentFunction->funParameters[i]->parType,0,currentFunction->funParameters[i]->parName),
						         currentFunction->funParameters[i]->parType);
					struct variableStruct *vartmp = new struct variableStruct ();
					vartmp->varName = currentFunction->funParameters[i]->parName;
					vartmp->varType = currentFunction->funParameters[i]->parType;
					vartmp->isArray = false;
					currentFunction->funVariables.push_back(vartmp);
					Builder.CreateStore(tmpArg, currentFunction->NamedValues[currentFunction->funParameters[i]->parName]);
					if (DI) {
						di_variable(DI, cast<AllocaInst>(currentFunction->NamedValues[currentFunction->funParameters[i]->parName]),
						            currentFunction->funParameters[i]->parName, functionLine(t),
						            currentFunction->funParameters[i]->parType == i8, false, 0);
					}
				}
				else {
					if (currentFunction->funParameters[i]->isArray) {
						Instruction *result = new BitCastInst(tmpArg,
						                                      llvm::PointerType::getUnqual(TheContext),
						                                      "backCastedArr", globalBB);
						currentFunction->NamedValues[currentFunction->funParameters[i]->parName] =
							trackPtr(result, ArrayType::get(currentFunction->funParameters[i]->parTypePure,1));
					}
					else currentFunction->NamedValues[currentFunction->funParameters[i]->parName] =
						trackPtr(tmpArg, currentFunction->funParameters[i]->parTypePure);
					struct variableStruct *vartmp = new struct variableStruct ();
					vartmp->varName = currentFunction->funParameters[i]->parName;
					vartmp->varType = currentFunction->funParameters[i]->parTypePure;
					vartmp->isArray = currentFunction->funParameters[i]->isArray;
					currentFunction->funVariables.push_back(vartmp);
					if (DI) {
						// A reference has no slot of its own, so give the
						// debugger one that holds the address.
						AllocaInst *slot = Builder.CreateAlloca(tmpArg->getType(), nullptr,
						                                        std::string(currentFunction->funParameters[i]->parName) + ".addr");
						Builder.CreateStore(tmpArg, slot);
						di_variable(DI, slot, currentFunction->funParameters[i]->parName, functionLine(t),
						            currentFunction->funParameters[i]->parTypePure == i8,
						            currentFunction->funParameters[i]->isArray, 0, true);
					}
				}
			}
			//Emit the program code.
			ast_compile(t->right);
			if (!retEnabled && (t->right->k == PROC || t->right->left->k == PROC)) Builder.CreateRetVoid();
			else if (!retEnabled && t->right->left->type->kind == Type_tag::TYPE_INTEGER) Builder.CreateRet(c32(0));
			else if (!retEnabled && t->right->left->type->kind == Type_tag::TYPE_CHAR) Builder.CreateRet(c8(0));
			retEnabled = false;
			if (opt) {
				TheFPM->run(*currentFunction->func, *TheFAM);
			}
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
			currentFunction->children.push_back(newFunction);
			currentFunction = newFunction;
			//get parent's variables as hidden parameters
			struct hiddenParameterStruct *parTmp;
			for (size_t i = 0; i < currentFunction->father->funVariables.size(); i++) {
				parTmp = new struct hiddenParameterStruct ();
				parTmp->parName = currentFunction->father->funVariables[i]->varName;
				parTmp->parType = currentFunction->father->funVariables[i]->varType;
				parTmp->isArray = currentFunction->father->funVariables[i]->isArray;
				currentFunction->funHiddenParameters.push_back(parTmp);
			}
			//Create new Function Definition
			Constant *c = nullptr;
			//get function's parameters
			ast_compile(t->left);
			//define function type
			if (t->right->k == SEQ) {
				if (t->right->left->k == PROC) c = createFunction(t->id, Type::getVoidTy(TheContext));
				else {
					if (t->right->left->type->kind == Type_tag::TYPE_INTEGER) c = createFunction(t->id, i32);
					else if (t->right->left->type->kind == Type_tag::TYPE_CHAR) c = createFunction(t->id, i8);
				}
			}
			else {
				if (t->right->k == PROC) c = createFunction(t->id, Type::getVoidTy(TheContext));
				else {
					if (t->right->type->kind == Type_tag::TYPE_INTEGER) c = createFunction(t->id, i32);
					else if (t->right->type->kind == Type_tag::TYPE_CHAR) c = createFunction(t->id, i8);
				}
			}
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
	case ID: {
		if (currentFunction->NamedValues.find(t->id) == currentFunction->NamedValues.end()) {
			error_prefix(t->line);
			error("Variable \033[1;36m%s\033[0m not in scope.", t->id);
		}
		Value *v = currentFunction->NamedValues[t->id];
		isVariable = true;
		return v;
	}
	case CONST: {
		isVariable = false;
		return c32(t->num);
	}
	case CHAR: {
		isVariable = false;
		char* s = t->id;
		char c;
		if (s[0] == '\\' && strlen(s) > 1) {
			if (s[1] == 'n') c = '\n';
			else if (s[1] == 't') c = '\t';
			else if (s[1] == 't') c = '\t';
			else if (s[1] == 'r') c = '\r';
			else if (s[1] == '0') c = '\0';
			else if (s[1] == '\\') c = '\\';
			else if (s[1] == '\'') c = '\'';
			else if (s[1] == '\"') c = '\"';
			else if (s[1] == 'x' && 3 < strlen(s)) c = hexToLetter(s[2],s[3]);
			else c = s[0];
		}
		else c = s[0];
		return c8(c);
	}
	case STRING: {
		isVariable = false;
		const char* s = t->id;
		size_t len = strlen(s);
		char* sNew = (char*) malloc(sizeof(char)*(len+1));
		size_t sPos = 0;
		size_t sNewPos = 0;
		while (sPos < len) {
			if (s[sPos] == '\\' && sPos+1 < len) {
				if (s[sPos+1] == 'n')       {sNew[sNewPos] = '\n'; sPos += 2;}
				else if (s[sPos+1] == 't')  {sNew[sNewPos] = '\t'; sPos += 2;}
				else if (s[sPos+1] == 'r')  {sNew[sNewPos] = '\r'; sPos += 2;}
				else if (s[sPos+1] == '0')  {sNew[sNewPos] = '\0'; sPos += 2;}
				else if (s[sPos+1] == '\\') {sNew[sNewPos] = '\\'; sPos += 2;}
				else if (s[sPos+1] == '\'') {sNew[sNewPos] = '\''; sPos += 2;}
				else if (s[sPos+1] == '\"') {sNew[sNewPos] = '\"'; sPos += 2;}
				else if (s[sPos+1] == 'x' && sPos+3 < len) {
					sNew[sNewPos] = hexToLetter(s[sPos+2],s[sPos+3]);
					sPos += 4;
				}
				else {sNew[sNewPos] = s[sPos]; sPos++;}
			}
			else {
				sNew[sNewPos] = s[sPos];
				sPos++;
			}
			sNewPos++;
		}
		sNew[sNewPos] = '\0';
		Value *string = ConstantDataArray::getString(TheContext,StringRef(sNew));
		Value *newString = trackPtr(Builder.CreateAlloca(ArrayType::get(i8,strlen(sNew)+1),0,"newString"),
		                             ArrayType::get(i8,strlen(sNew)+1));
		Builder.CreateStore(string, newString);
		return newString;
	}
	case BOOL: {
		printf("%s\n", t->id);
		if (strcmp(t->id,"true") == 0) return c1(1);
		if (strcmp(t->id,"false") == 0) return c1(0);
		return nullptr;
	}
	case PLUS: {
		Value *v1, *v2;
		Value *l = ast_compile(t->left);
		if (isVariable) v1 = loadValue(l);
		else v1 = l;
		Value *r = ast_compile(t->right);
		if (isVariable) v2 = loadValue(r);
		else v2 = r;
		isVariable = false;
		return Builder.CreateAdd(v1, v2, "addtmp");
	}
	case MINUS: {
		Value *v1, *v2;
		Value *l = ast_compile(t->left);
		if (isVariable) v1 = loadValue(l);
		else v1 = l;
		Value *r = ast_compile(t->right);
		if (isVariable) v2 = loadValue(r);
		else v2 = r;
		isVariable = false;
		return Builder.CreateSub(v1, v2, "subtmp");
	}
	case TIMES: {
		Value *v1, *v2;
		Value *l = ast_compile(t->left);
		if (isVariable) v1 = loadValue(l);
		else v1 = l;
		Value *r = ast_compile(t->right);
		if (isVariable) v2 = loadValue(r);
		else v2 = r;
		isVariable = false;
		return Builder.CreateMul(v1, v2, "multmp");
	}
	case DIV: {
		Value *v1, *v2;
		Value *l = ast_compile(t->left);
		if (isVariable) v1 = loadValue(l);
		else v1 = l;
		Value *r = ast_compile(t->right);
		if (isVariable) v2 = loadValue(r);
		else v2 = r;
		isVariable = false;
		return Builder.CreateSDiv(v1, v2, "divtmp");
	}
	case MOD: {
		Value *v1, *v2;
		Value *l = ast_compile(t->left);
		if (isVariable) v1 = loadValue(l);
		else v1 = l;
		Value *r = ast_compile(t->right);
		if (isVariable) v2 = loadValue(r);
		else v2 = r;
		isVariable = false;
		return Builder.CreateSRem(v1, v2, "modtmp");
	}
	case EQUALS: {
		Value *v1, *v2;
		Value *l = ast_compile(t->left);
		if (isVariable) v1 = loadValue(l);
		else v1 = l;
		Value *r = ast_compile(t->right);
		if (isVariable) v2 = loadValue(r);
		else v2 = r;
		isVariable = false;
		return Builder.CreateICmpEQ(v1, v2, "equalstmp");
	}
	case NOTEQUALS: {
		Value *v1, *v2;
		Value *l = ast_compile(t->left);
		if (isVariable) v1 = loadValue(l);
		else v1 = l;
		Value *r = ast_compile(t->right);
		if (isVariable) v2 = loadValue(r);
		else v2 = r;
		isVariable = false;
		return Builder.CreateICmpNE(v1, v2, "notequalstmp");
	}
	case LESSEQUALS: {
		Value *v1, *v2;
		Value *l = ast_compile(t->left);
		if (isVariable) v1 = loadValue(l);
		else v1 = l;
		Value *r = ast_compile(t->right);
		if (isVariable) v2 = loadValue(r);
		else v2 = r;
		isVariable = false;
		return Builder.CreateICmpSLE(v1, v2, "lessequalstmp");
	}
	case GREATEQUALS: {
		Value *v1, *v2;
		Value *l = ast_compile(t->left);
		if (isVariable) v1 = loadValue(l);
		else v1 = l;
		Value *r = ast_compile(t->right);
		if (isVariable) v2 = loadValue(r);
		else v2 = r;
		isVariable = false;
		return Builder.CreateICmpSGE(v1, v2, "greatequalstmp");
	}
	case GREATER: {
		Value *v1, *v2;
		Value *l = ast_compile(t->left);
		if (isVariable) v1 = loadValue(l);
		else v1 = l;
		Value *r = ast_compile(t->right);
		if (isVariable) v2 = loadValue(r);
		else v2 = r;
		isVariable = false;
		return Builder.CreateICmpSGT(v1, v2, "greatertmp");
	}
	case LESS: {
		Value *v1, *v2;
		Value *l = ast_compile(t->left);
		if (isVariable) v1 = loadValue(l);
		else v1 = l;
		Value *r = ast_compile(t->right);
		if (isVariable) v2 = loadValue(r);
		else v2 = r;
		isVariable = false;
		return Builder.CreateICmpSLT(v1, v2, "lesstmp");
	}
	case NOT: {
		Value *v;
		Value *l = ast_compile(t->left);
		if (isVariable) v = loadValue(l);
		else v = l;
		isVariable = false;
		return Builder.CreateNot(v, "nottmp");
	}
	case AND: {
		Value *v1, *v2;
		Value *l = ast_compile(t->left);
		if (isVariable) v1 = loadValue(l);
		else v1 = l;
		Value *r = ast_compile(t->right);
		if (isVariable) v2 = loadValue(r);
		else v2 = r;
		isVariable = false;
		return Builder.CreateAnd(v1, v2, "andtmp");
	}
	case OR: {
		Value *v1, *v2;
		Value *l = ast_compile(t->left);
		if (isVariable) v1 = loadValue(l);
		else v1 = l;
		Value *r = ast_compile(t->right);
		if (isVariable) v2 = loadValue(r);
		else v2 = r;
		isVariable = false;
		return Builder.CreateOr(v1, v2, "ortmp");
	}
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
	bool bad = verifyModule(*TheModule, &errs());
	if (bad) {
		fprintf(stderr, "The faulty IR is:\n");
		fprintf(stderr, "------------------------------------------------\n\n");
		TheModule->print(errs(), nullptr);
		return false;
	}
	TheFPM->run(*main, *TheFAM);
	return true;
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
		//printf("%s\n",kinds[t->k]);
		Type_T *retType = new(Type_T);
		if (f!= NULL && f->entryType == ENTRY_PARAMETER) {
			Type_T checkType = ast_sem(t->left, f);
			if (checkType->isArray != f->u.eParameter.type->isArray) {
				error_prefix(t->line);
				error("\033[1;36m%s\033[0m Parameter Type Mismatch (no arrays allowed).", f->id);
			}
			if (!equalType(checkType, f->u.eParameter.type)) {
				error_prefix(t->line);
				error("\033[1;36m%s\033[0m Parameter Type Mismatch (type \033[1;36m%s\033[0m with type \033[1;36m%s\033[0m).", f->id, types[checkType->kind],types[f->u.eParameter.type->kind]);
			}
			if (f->u.eParameter.mode == PASS_BY_VALUE && checkType->isArray == 1) {
				error_prefix(t->line);
				error("Can't pass Array \033[1;36m%s\033[0m as Parameter by value.", f->id);
			}
			if (f->u.eParameter.mode == PASS_BY_REFERENCE && t->left->k != ID && t->left->k != ARREXPR && t->left->k != STRING  && t->left->k != FUNCALL && checkType->isArray) {
				error_prefix(t->line);
				error("Only L-values can be passed by reference.");
			}
			SymbolEntry *nextParameter = (SymbolEntry*)malloc(sizeof(SymbolEntry));
			nextParameter = f->u.eParameter.next;
			if (nextParameter == NULL && t->right != NULL) { error_prefix(t->line); error("Error at Parameter \033[1;36m%s\033[0m, there are too many Parameters.", f->id);}
			if (nextParameter != NULL && t->right == NULL) { error_prefix(t->line); error("Error at Parameter \033[1;36m%s\033[0m, there must exist more Parameters.", f->id);}
			if (*retType == NULL) *retType = checkType;
			if (t->right->k != SEQ) {
				checkType = ast_sem(t->right, f);
				if (checkType->isArray != nextParameter->u.eParameter.type->isArray) {
					error_prefix(t->line);
					error("\033[1;36m%s\033[0m Parameter Type Mismatch (no arrays allowed).", nextParameter->id);
				}
				if (!equalType(checkType, nextParameter->u.eParameter.type)) {
					error_prefix(t->line);
					error("\033[1;36m%s\033[0m Parameter Type Mismatch (type \033[1;36m%s\033[0m with type \033[1;36m%s\033[0m).", nextParameter->id, types[checkType->kind],types[nextParameter->u.eParameter.type->kind]);
				}
				if (nextParameter->u.eParameter.mode == PASS_BY_VALUE && checkType->isArray == 1) {
					error_prefix(t->line);
					error("Can't pass Array \033[1;36m%s\033[0m as Parameter by value.", nextParameter->id);
				}
				if (nextParameter->u.eParameter.mode == PASS_BY_REFERENCE && t->left->k != ID && t->left->k != ARREXPR && t->left->k != STRING  && t->left->k != FUNCALL && checkType->isArray != 1) {
					error_prefix(t->line);
					error("Only L-values can be passed by reference.");
				}
				nextParameter = nextParameter->u.eParameter.next;
				if (nextParameter != NULL) { error_prefix(t->line); error("Error at Parameter \033[1;36m%s\033[0m, there must exist more Parameters.", nextParameter->id);}
				if (*retType == NULL) *retType = checkType;
				return *retType;
			}
			else {
				ast_sem(t->right, nextParameter);
				return *retType;
			}
		}
		else {
			*retType = ast_sem(t->left, f);
			ast_sem(t->right, f);
			return *retType;
		}
	}
	case RET: {
		//printf("%s\n",kinds[t->k]);
		if (f->entryType != ENTRY_FUNCTION) { error_prefix(t->line); error("case RET error!");}
		Type_T functionType = f->u.eFunction.resultType;
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
	case PAR: {
		//printf("%s: %s\n",kinds[t->k] ,t->id);
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
		if (t->num < 0) { error_prefix(t->line); error ("Array size must be a positive int.");}
		t->type->size = t->num;
		return t->type;
	}
	case PROC: {
		//printf("%s: %s\n",kinds[t->k] ,"VOID");
		return typeVoid;
	}
	case VAR: {
		//printf("%s: %s\n",kinds[t->k] ,t->id);
		newVariable(t->id, ast_sem(t->left,f));
		return NULL;
	}
	case ASS: {
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
	case ARREXPR: {
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
		if (tempType2->kind != Type_tag::TYPE_INTEGER) {
			error_prefix(t->line);
			error ("Index of array must be an int.");
		}
		return retType;
	}
	case FUNCALL: {
		//printf("%s: %s\n",kinds[t->k] ,t->id);
		SymbolEntry *theFunction = (SymbolEntry*)malloc(sizeof(SymbolEntry));
		theFunction = lookupEntry(t->id,LOOKUP_ALL_SCOPES,false);
		if (theFunction == NULL) {
			theFunction = lookupLibrary(t->id);
			if (theFunction == NULL) {
				error_prefix(t->line);
				error("Function \033[1;36m%s\033[0m is not declared in this Scope.", t->id);
			}
		}
		if (theFunction->entryType != ENTRY_FUNCTION) { error_prefix(t->line); error("\033[1;36m%s\033[0m is not a function.", t->id);}
		t->type = theFunction->u.eFunction.resultType;
		SymbolEntry *firstParameter = (SymbolEntry*)malloc(sizeof(SymbolEntry));
		firstParameter = theFunction->u.eFunction.firstArgument;
		SymbolEntry *nextParameter = (SymbolEntry*)malloc(sizeof(SymbolEntry));
		if (firstParameter != NULL) nextParameter = firstParameter->u.eParameter.next;
		if (firstParameter == NULL && t->left != NULL) { error_prefix(t->line); error("Function \033[1;36m%s\033[0m cannot have any Parameters.", t->id);}
		if (firstParameter != NULL && t->left == NULL) { error_prefix(t->line); error("Function \033[1;36m%s\033[0m must have Parameters.", t->id);}
		if (firstParameter != NULL && nextParameter != NULL && t->left->k != SEQ) { error_prefix(t->line); error("Error at Parameter \033[1;36m%s\033[0m, there must exist more Parameters.", t->id);}
		if (firstParameter != NULL && nextParameter == NULL && t->left->k == SEQ) { error_prefix(t->line); error("Error at Parameter \033[1;36m%s\033[0m, there are too many Parameters.", t->id);}
		if (firstParameter != NULL && firstParameter->u.eParameter.next == NULL) {
			Type_T checkType = ast_sem(t->left, f);
			if (checkType->isArray != firstParameter->u.eParameter.type->isArray) {
				error_prefix(t->line);
				error("\033[1;36m%s\033[0m Parameter Type Mismatch (no arrays allowed).");
			}
			if (!equalType(checkType, firstParameter->u.eParameter.type)) {
				error_prefix(t->line);
				error("\033[1;36m%s\033[0m Parameter Type Mismatch (type \033[1;36m%s\033[0m with type \033[1;36m%s\033[0m).", firstParameter->id, types[checkType->kind], types[firstParameter->u.eParameter.type->kind]);
			}
			if (firstParameter->u.eParameter.mode == PASS_BY_VALUE && checkType->isArray == 1) {
				error_prefix(t->line);
				error("Can't pass L-value \033[1;36m%s\033[0m Parameter by value.", firstParameter->id);
			}
			if (firstParameter->u.eParameter.mode == PASS_BY_REFERENCE && t->left->k != ID && t->left->k != ARREXPR && t->left->k != STRING && t->left->k != FUNCALL) {
				error_prefix(t->line);
				error("Only L-values can pass by reference.");
			}
		}
		else{
			ast_sem(t->left, firstParameter);
		}
		return t->type;
	}
	case FUNCDEF: {
		//printf("%s: %s\n",kinds[t->k] ,t->id);
		openScope();
		SymbolEntry *theFunction = newFunction(t->id);
		ast_sem(t->left, theFunction);
		theFunction->u.eFunction.resultType = ast_sem(t->right->left,NULL);
		endFunctionHeader(theFunction, ast_sem(t->right, theFunction));
		closeScope();
		if (currentScope != NULL) {
			insertEntry(theFunction);
		}
		return NULL;
	}
	case ID: {
		//printf("%s: %s\n",kinds[t->k] ,t->id);
		SymbolEntry *entry = (SymbolEntry*)malloc(sizeof(SymbolEntry));
		entry = lookupEntry(t->id,LOOKUP_CURRENT_SCOPE,false);
		if (entry == NULL) {
			error_prefix(t->line);
			error("Identifier not found.");
			return NULL;
		}
		if (entry->entryType == ENTRY_VARIABLE) {
			t->type = entry->u.eVariable.type;
			return entry->u.eVariable.type;
		}
		if (entry->entryType == ENTRY_CONSTANT) {
			t->type = entry->u.eConstant.type;
			return entry->u.eConstant.type;
		}
		if (entry->entryType == ENTRY_FUNCTION) {
			t->type = entry->u.eFunction.resultType;
			return entry->u.eFunction.resultType;
		}
		if (entry->entryType == ENTRY_PARAMETER) {
			t->type = entry->u.eParameter.type;
			return entry->u.eParameter.type;
		}
		if (entry->entryType == ENTRY_TEMPORARY) {
			t->type = entry->u.eTemporary.type;
			return entry->u.eTemporary.type;
		}
		return t->type;
	}
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
		t->type = typeBoolean;
		newConstant(t->id,t->type);
		return t->type;
	}
	case PLUS: {
		//printf("%s: +\n",kinds[t->k]);
		ast_sem(t->left,f);
		ast_sem(t->right,f);
		if (t->left->type->isArray == 1 || t->right->type->isArray == 1)
		{ error_prefix(t->line);
		  error("type mismatch in + operator (can't use array in expression).");}
		if (!equalType(t->left->type, t->right->type)) {
			error_prefix(t->line);
			error("type mismatch in + operator (type \033[1;36m%s\033[0m with type \033[1;36m%s\033[0m).",types[t->left->type->kind],types[t->right->type->kind]);
		}
		else t->type = t->left->type;
		return t->type;
	}
	case MINUS: {
		//printf("%s: -\n",kinds[t->k]);
		ast_sem(t->left,f);
		ast_sem(t->right,f);
		if (t->left->type->isArray == 1 || t->right->type->isArray == 1)
		{ error_prefix(t->line);
		  error("type mismatch in - operator (can't use array in expression).");}
		if (!equalType(t->left->type, t->right->type)) {
			error_prefix(t->line);
			error("type mismatch in - operator (type \033[1;36m%s\033[0m with type \033[1;36m%s\033[0m).",types[t->left->type->kind],types[t->right->type->kind]);
		}
		else t->type = t->left->type;
		return t->type;
	}
	case TIMES: {
		//printf("%s: *\n",kinds[t->k]);
		ast_sem(t->left,f);
		ast_sem(t->right,f);
		if (t->left->type->isArray == 1 || t->right->type->isArray == 1)
		{ error_prefix(t->line);
		  error("type mismatch in * operator (can't use array in expression).");}
		if (!equalType(t->left->type, t->right->type)) {
			error_prefix(t->line);
			error("type mismatch in * operator (type \033[1;36m%s\033[0m with type \033[1;36m%s\033[0m).",types[t->left->type->kind],types[t->right->type->kind]);
		}
		else t->type = t->left->type;
		return t->type;
	}
	case DIV: {
		//printf("%s: /\n",kinds[t->k]);
		ast_sem(t->left,f);
		ast_sem(t->right,f);
		if (t->left->type->isArray == 1 || t->right->type->isArray == 1)
		{ error_prefix(t->line);
		  error("type mismatch in / operator (can't use array in expression).");}
		if (!equalType(t->left->type, t->right->type)) {
			error_prefix(t->line);
			error("type mismatch in / operator (type \033[1;36m%s\033[0m with type \033[1;36m%s\033[0m).",types[t->left->type->kind],types[t->right->type->kind]);
		}
		else t->type = t->left->type;
		return t->type;
	}
	case MOD: {
		//printf("%s: %%\n",kinds[t->k]);
		ast_sem(t->left,f);
		ast_sem(t->right,f);
		if (t->left->type->isArray == 1 || t->right->type->isArray == 1)
		{ error_prefix(t->line);
		  error("type mismatch in % operator (can't use array in expression).");}
		if (!equalType(t->left->type, t->right->type)) {
			error_prefix(t->line);
			error("type mismatch in % operator (type \033[1;36m%s\033[0m with type \033[1;36m%s\033[0m).",types[t->left->type->kind],types[t->right->type->kind]);
		}
		else t->type = t->left->type;
		return t->type;
	}
	case EQUALS: {
		//printf("%s: ==\n",kinds[t->k]);
		ast_sem(t->left,f);
		ast_sem(t->right,f);
		if (t->left->type->isArray == 1 || t->right->type->isArray == 1)
		{ error_prefix(t->line);
		  error("type mismatch in == operator (can't use array in expression).");}
		if (!equalType(t->left->type, t->right->type)) {
			error_prefix(t->line);
			error("type mismatch in == operator (type \033[1;36m%s\033[0m with type \033[1;36m%s\033[0m).",types[t->left->type->kind],types[t->right->type->kind]);
		}
		return t->type;
	}
	case NOTEQUALS: {
		//printf("%s: !=\n",kinds[t->k]);
		ast_sem(t->left,f);
		ast_sem(t->right,f);
		if (t->left->type->isArray == 1 || t->right->type->isArray == 1)
		{ error_prefix(t->line);
		  error("type mismatch in != operator (can't use array in expression).");}
		if (!equalType(t->left->type, t->right->type)) {
			error_prefix(t->line);
			error("type mismatch in != operator (type \033[1;36m%s\033[0m with type \033[1;36m%s\033[0m).",types[t->left->type->kind],types[t->right->type->kind]);
		}
		return t->type;
	}
	case LESSEQUALS: {
		//printf("%s: <=\n",kinds[t->k]);
		ast_sem(t->left,f);
		ast_sem(t->right,f);
		if (t->left->type->isArray == 1 || t->right->type->isArray == 1)
		{ error_prefix(t->line);
		  error("type mismatch in <= operator (can't use array in expression).");}
		if (!equalType(t->left->type, t->right->type)) {
			error_prefix(t->line);
			error("type mismatch in <= operator (type \033[1;36m%s\033[0m with type \033[1;36m%s\033[0m).",types[t->left->type->kind],types[t->right->type->kind]);
		}
		return t->type;
	}
	case GREATEQUALS: {
		//printf("%s: >=\n",kinds[t->k]);
		ast_sem(t->left,f);
		ast_sem(t->right,f);
		if (t->left->type->isArray == 1 || t->right->type->isArray == 1)
		{ error_prefix(t->line);
		  error("type mismatch in >= operator (can't use array in expression).");}
		if (!equalType(t->left->type, t->right->type)) {
			error_prefix(t->line);
			error("type mismatch in >= operator (type \033[1;36m%s\033[0m with type \033[1;36m%s\033[0m).",types[t->left->type->kind],types[t->right->type->kind]);
		}
		return t->type;
	}
	case GREATER: {
		//printf("%s: >\n",kinds[t->k]);
		ast_sem(t->left,f);
		ast_sem(t->right,f);
		if (t->left->type->isArray == 1 || t->right->type->isArray == 1)
		{ error_prefix(t->line);
		  error("type mismatch in > operator (can't use array in expression).");}
		if (!equalType(t->left->type, t->right->type)) {
			error_prefix(t->line);
			error("type mismatch in > operator (type \033[1;36m%s\033[0m with type \033[1;36m%s\033[0m).",types[t->left->type->kind],types[t->right->type->kind]);
		}
		return t->type;
	}
	case LESS: {
		//printf("%s: <\n",kinds[t->k]);
		ast_sem(t->left,f);
		ast_sem(t->right,f);
		if (t->left->type->isArray == 1 || t->right->type->isArray == 1)
		{ error_prefix(t->line);
		  error("type mismatch in < operator (can't use array in expression).");}
		if (!equalType(t->left->type, t->right->type)) {
			error_prefix(t->line);
			error("type mismatch in < operator (type \033[1;36m%s\033[0m with type \033[1;36m%s\033[0m).",types[t->left->type->kind],types[t->right->type->kind]);
		}
		return t->type;
	}
	case NOT: {
		//printf("%s: !\n",kinds[t->k]);
		ast_sem(t->left,f);
		ast_sem(t->right,f);
		if (!equalType(t->right->type, typeBoolean))
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
	library[0]->id = (char *) new char* [strlen("writeInteger") + 1];
	strcpy((library[0]->id), "writeInteger");
	library[0]->entryType = ENTRY_FUNCTION;
	library[0]->u.eFunction.resultType = typeVoid;
	library[0]->u.eFunction.firstArgument = (SymbolEntry *)new(SymbolEntry);
	library[0]->u.eFunction.firstArgument->id = (char *) new char* [strlen("n") + 1];
	strcpy((library[0]->u.eFunction.firstArgument->id), "n");
	library[0]->u.eFunction.firstArgument->entryType = ENTRY_PARAMETER;
	library[0]->u.eFunction.firstArgument->u.eParameter.type = createInt();
	library[0]->u.eFunction.firstArgument->u.eParameter.type->refCount++;
	library[0]->u.eFunction.firstArgument->u.eParameter.mode = PASS_BY_VALUE;
	library[0]->u.eFunction.firstArgument->u.eParameter.next = NULL;
	library[0]->u.eFunction.lastArgument = library[0]->u.eFunction.firstArgument;

	library[1] = (SymbolEntry *)new(SymbolEntry);
	library[1]->id = (char *) new char* [strlen("writeByte") + 1];
	strcpy((library[1]->id), "writeByte");
	library[1]->entryType = ENTRY_FUNCTION;
	library[1]->u.eFunction.resultType = typeVoid;
	library[1]->u.eFunction.firstArgument = (SymbolEntry *)new(SymbolEntry);
	library[1]->u.eFunction.firstArgument->id = (char *) new char* [strlen("b") + 1];
	strcpy((library[1]->u.eFunction.firstArgument->id), "b");
	library[1]->u.eFunction.firstArgument->entryType = ENTRY_PARAMETER;
	library[1]->u.eFunction.firstArgument->u.eParameter.type = createChar();
	library[1]->u.eFunction.firstArgument->u.eParameter.type->refCount++;
	library[1]->u.eFunction.firstArgument->u.eParameter.mode = PASS_BY_VALUE;
	library[1]->u.eFunction.firstArgument->u.eParameter.next = NULL;
	library[1]->u.eFunction.lastArgument = library[1]->u.eFunction.firstArgument;

	library[2] = (SymbolEntry *)new(SymbolEntry);
	library[2]->id = (char *) new char* [strlen("writeChar") + 1];
	strcpy((library[2]->id), "writeChar");
	library[2]->entryType = ENTRY_FUNCTION;
	library[2]->u.eFunction.resultType = typeVoid;
	library[2]->u.eFunction.firstArgument = (SymbolEntry *)new(SymbolEntry);
	library[2]->u.eFunction.firstArgument->id = (char *) new char* [strlen("b") + 1];
	strcpy((library[2]->u.eFunction.firstArgument->id), "b");
	library[2]->u.eFunction.firstArgument->entryType = ENTRY_PARAMETER;
	library[2]->u.eFunction.firstArgument->u.eParameter.type = createChar();
	library[2]->u.eFunction.firstArgument->u.eParameter.type->refCount++;
	library[2]->u.eFunction.firstArgument->u.eParameter.mode = PASS_BY_VALUE;
	library[2]->u.eFunction.firstArgument->u.eParameter.next = NULL;
	library[2]->u.eFunction.lastArgument = library[2]->u.eFunction.firstArgument;

	library[3] = (SymbolEntry *)new(SymbolEntry);
	library[3]->id = (char *) new char* [strlen("writeString") + 1];
	strcpy((library[3]->id), "writeString");
	library[3]->entryType = ENTRY_FUNCTION;
	library[3]->u.eFunction.resultType = typeVoid;
	library[3]->u.eFunction.firstArgument = (SymbolEntry *)new(SymbolEntry);
	library[3]->u.eFunction.firstArgument->id = (char *) new char* [strlen("s") + 1];
	strcpy((library[3]->u.eFunction.firstArgument->id), "s");
	library[3]->u.eFunction.firstArgument->entryType = ENTRY_PARAMETER;
	library[3]->u.eFunction.firstArgument->u.eParameter.type = createCharArr();
	library[3]->u.eFunction.firstArgument->u.eParameter.type->refCount++;
	library[3]->u.eFunction.firstArgument->u.eParameter.mode = PASS_BY_REFERENCE;
	library[3]->u.eFunction.firstArgument->u.eParameter.next = NULL;
	library[3]->u.eFunction.lastArgument = library[3]->u.eFunction.firstArgument;

	library[4] = (SymbolEntry *)new(SymbolEntry);
	library[4]->id = (char *) new char* [strlen("readInteger") + 1];
	strcpy((library[4]->id), "readInteger");
	library[4]->entryType = ENTRY_FUNCTION;
	library[4]->u.eFunction.resultType = createInt();
	library[4]->u.eFunction.firstArgument = library[4]->u.eFunction.lastArgument = NULL;

	library[5] = (SymbolEntry *)new(SymbolEntry);
	library[5]->id = (char *) new char* [strlen("readByte") + 1];
	strcpy((library[5]->id), "readByte");
	library[5]->entryType = ENTRY_FUNCTION;
	library[5]->u.eFunction.resultType = createChar();
	library[5]->u.eFunction.firstArgument = library[5]->u.eFunction.lastArgument = NULL;

	library[6] = (SymbolEntry *)new(SymbolEntry);
	library[6]->id = (char *) new char* [strlen("readChar") + 1];
	strcpy((library[6]->id), "readChar");
	library[6]->entryType = ENTRY_FUNCTION;
	library[6]->u.eFunction.resultType = createChar();
	library[6]->u.eFunction.firstArgument = library[6]->u.eFunction.lastArgument = NULL;

	library[7] = (SymbolEntry *)new(SymbolEntry);
	library[7]->id = (char *) new char* [strlen("readString") + 1];
	strcpy((library[7]->id), "readString");
	library[7]->entryType = ENTRY_FUNCTION;
	library[7]->u.eFunction.resultType = typeVoid;
	library[7]->u.eFunction.firstArgument = (SymbolEntry *)new(SymbolEntry);
	library[7]->u.eFunction.firstArgument->id = (char *) new char* [strlen("n") + 1];
	strcpy((library[7]->u.eFunction.firstArgument->id), "n");
	library[7]->u.eFunction.firstArgument->entryType = ENTRY_PARAMETER;
	library[7]->u.eFunction.firstArgument->u.eParameter.type = createInt();
	library[7]->u.eFunction.firstArgument->u.eParameter.type->refCount++;
	library[7]->u.eFunction.firstArgument->u.eParameter.mode = PASS_BY_VALUE;
	library[7]->u.eFunction.lastArgument = (SymbolEntry *)new(SymbolEntry);
	library[7]->u.eFunction.lastArgument->id = (char *) new char* [strlen("s") + 1];
	strcpy((library[7]->u.eFunction.lastArgument->id), "s");
	library[7]->u.eFunction.lastArgument->entryType = ENTRY_PARAMETER;
	library[7]->u.eFunction.lastArgument->u.eParameter.type = createCharArr();
	library[7]->u.eFunction.lastArgument->u.eParameter.type->refCount++;
	library[7]->u.eFunction.lastArgument->u.eParameter.mode = PASS_BY_REFERENCE;
	library[7]->u.eFunction.lastArgument->u.eParameter.next = NULL;
	library[7]->u.eFunction.firstArgument->u.eParameter.next = library[7]->u.eFunction.lastArgument;

	library[8] = (SymbolEntry *)new(SymbolEntry);
	library[8]->id = (char *) new char* [strlen("extend") + 1];
	strcpy((library[8]->id), "extend");
	library[8]->entryType = ENTRY_FUNCTION;
	library[8]->u.eFunction.resultType = createInt();
	library[8]->u.eFunction.firstArgument = (SymbolEntry *)new(SymbolEntry);
	library[8]->u.eFunction.firstArgument->id = (char *) new char* [strlen("b") + 1];
	strcpy((library[8]->u.eFunction.firstArgument->id), "b");
	library[8]->u.eFunction.firstArgument->entryType = ENTRY_PARAMETER;
	library[8]->u.eFunction.firstArgument->u.eParameter.type = createChar();
	library[8]->u.eFunction.firstArgument->u.eParameter.type->refCount++;
	library[8]->u.eFunction.firstArgument->u.eParameter.mode = PASS_BY_VALUE;
	library[8]->u.eFunction.firstArgument->u.eParameter.next = NULL;
	library[8]->u.eFunction.lastArgument = library[8]->u.eFunction.firstArgument;

	library[9] = (SymbolEntry *)new(SymbolEntry);
	library[9]->id = (char *) new char* [strlen("shrink") + 1];
	strcpy((library[9]->id), "shrink");
	library[9]->entryType = ENTRY_FUNCTION;
	library[9]->u.eFunction.resultType = createChar();
	library[9]->u.eFunction.firstArgument = (SymbolEntry *)new(SymbolEntry);
	library[9]->u.eFunction.firstArgument->id = (char *) new char* [strlen("i") + 1];
	strcpy((library[9]->u.eFunction.firstArgument->id), "i");
	library[9]->u.eFunction.firstArgument->entryType = ENTRY_PARAMETER;
	library[9]->u.eFunction.firstArgument->u.eParameter.type = createInt();
	library[9]->u.eFunction.firstArgument->u.eParameter.type->refCount++;
	library[9]->u.eFunction.firstArgument->u.eParameter.mode = PASS_BY_VALUE;
	library[9]->u.eFunction.firstArgument->u.eParameter.next = NULL;
	library[9]->u.eFunction.lastArgument = library[9]->u.eFunction.firstArgument;

	library[10] = (SymbolEntry *)new(SymbolEntry);
	library[10]->id = (char *) new char* [strlen("strlen") + 1];
	strcpy((library[10]->id), "strlen");
	library[10]->entryType = ENTRY_FUNCTION;
	library[10]->u.eFunction.resultType = createInt();
	library[10]->u.eFunction.firstArgument = (SymbolEntry *)new(SymbolEntry);
	library[10]->u.eFunction.firstArgument->id = (char *) new char* [strlen("s") + 1];
	strcpy((library[10]->u.eFunction.firstArgument->id), "s");
	library[10]->u.eFunction.firstArgument->entryType = ENTRY_PARAMETER;
	library[10]->u.eFunction.firstArgument->u.eParameter.type = createCharArr();
	library[10]->u.eFunction.firstArgument->u.eParameter.type->refCount++;
	library[10]->u.eFunction.firstArgument->u.eParameter.mode = PASS_BY_REFERENCE;
	library[10]->u.eFunction.firstArgument->u.eParameter.next = NULL;
	library[10]->u.eFunction.lastArgument = library[10]->u.eFunction.firstArgument;

	library[11] = (SymbolEntry *)new(SymbolEntry);
	library[11]->id = (char *) new char* [strlen("strcmp") + 1];
	strcpy((library[11]->id), "strcmp");
	library[11]->entryType = ENTRY_FUNCTION;
	library[11]->u.eFunction.resultType = createInt();
	library[11]->u.eFunction.firstArgument = (SymbolEntry *)new(SymbolEntry);
	library[11]->u.eFunction.firstArgument->id = (char *) new char* [strlen("s1") + 1];
	strcpy((library[11]->u.eFunction.firstArgument->id), "s1");
	library[11]->u.eFunction.firstArgument->entryType = ENTRY_PARAMETER;
	library[11]->u.eFunction.firstArgument->u.eParameter.type = createCharArr();
	library[11]->u.eFunction.firstArgument->u.eParameter.type->refCount++;
	library[11]->u.eFunction.firstArgument->u.eParameter.mode = PASS_BY_REFERENCE;
	library[11]->u.eFunction.lastArgument = (SymbolEntry *)new(SymbolEntry);
	library[11]->u.eFunction.lastArgument->id = (char *) new char* [strlen("s2") + 1];
	strcpy((library[11]->u.eFunction.lastArgument->id), "s2");
	library[11]->u.eFunction.lastArgument->entryType = ENTRY_PARAMETER;
	library[11]->u.eFunction.lastArgument->u.eParameter.type = createCharArr();
	library[11]->u.eFunction.lastArgument->u.eParameter.type->refCount++;
	library[11]->u.eFunction.lastArgument->u.eParameter.mode = PASS_BY_REFERENCE;
	library[11]->u.eFunction.lastArgument->u.eParameter.next = NULL;
	library[11]->u.eFunction.firstArgument->u.eParameter.next = library[11]->u.eFunction.lastArgument;

	library[12] = (SymbolEntry *)new(SymbolEntry);
	library[12]->id = (char *) new char* [strlen("strcpy") + 1];
	strcpy((library[12]->id), "strcpy");
	library[12]->entryType = ENTRY_FUNCTION;
	library[12]->u.eFunction.resultType = typeVoid;
	library[12]->u.eFunction.firstArgument = (SymbolEntry *)new(SymbolEntry);
	library[12]->u.eFunction.firstArgument->id = (char *) new char* [strlen("trg") + 1];
	strcpy((library[12]->u.eFunction.firstArgument->id), "trg");
	library[12]->u.eFunction.firstArgument->entryType = ENTRY_PARAMETER;
	library[12]->u.eFunction.firstArgument->u.eParameter.type = createCharArr();
	library[12]->u.eFunction.firstArgument->u.eParameter.type->refCount++;
	library[12]->u.eFunction.firstArgument->u.eParameter.mode = PASS_BY_REFERENCE;
	library[12]->u.eFunction.lastArgument = (SymbolEntry *)new(SymbolEntry);
	library[12]->u.eFunction.lastArgument->id = (char *) new char* [strlen("src") + 1];
	strcpy((library[12]->u.eFunction.lastArgument->id), "src");
	library[12]->u.eFunction.lastArgument->entryType = ENTRY_PARAMETER;
	library[12]->u.eFunction.lastArgument->u.eParameter.type = createCharArr();
	library[12]->u.eFunction.lastArgument->u.eParameter.type->refCount++;
	library[12]->u.eFunction.lastArgument->u.eParameter.mode = PASS_BY_REFERENCE;
	library[12]->u.eFunction.lastArgument->u.eParameter.next = NULL;
	library[12]->u.eFunction.firstArgument->u.eParameter.next = library[12]->u.eFunction.lastArgument;

	library[13] = (SymbolEntry *)new(SymbolEntry);
	library[13]->id = (char *) new char* [strlen("strcat") + 1];
	strcpy((library[13]->id), "strcat");
	library[13]->entryType = ENTRY_FUNCTION;
	library[13]->u.eFunction.resultType = typeVoid;
	library[13]->u.eFunction.firstArgument = (SymbolEntry *)new(SymbolEntry);
	library[13]->u.eFunction.firstArgument->id = (char *) new char* [strlen("trg") + 1];
	strcpy((library[13]->u.eFunction.firstArgument->id), "trg");
	library[13]->u.eFunction.firstArgument->entryType = ENTRY_PARAMETER;
	library[13]->u.eFunction.firstArgument->u.eParameter.type = createCharArr();
	library[13]->u.eFunction.firstArgument->u.eParameter.type->refCount++;
	library[13]->u.eFunction.firstArgument->u.eParameter.mode = PASS_BY_REFERENCE;
	library[13]->u.eFunction.lastArgument = (SymbolEntry *)new(SymbolEntry);
	library[13]->u.eFunction.lastArgument->id = (char *) new char* [strlen("src") + 1];
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
