/******************************************************************************
 *  CVS version:
 *     $Id: symbol.c,v 1.3 2004/05/05 22:00:08 nickie Exp $
 ******************************************************************************
 *
 *  C code file : symbol.c
 *  Project     : PCL Compiler
 *  Version     : 1.0 alpha
 *  Written by  : Nikolaos S. Papaspyrou (nickie@softlab.ntua.gr)
 *  Date        : May 14, 2003
 *  Description : Generic symbol table in C
 *
 *  Comments: (in Greek iso-8859-7)
 *  ---------
 *  Εθνικό Μετσόβιο Πολυτεχνείο.
 *  Σχολή Ηλεκτρολόγων Μηχανικών και Μηχανικών Υπολογιστών.
 *  Τομέας Τεχνολογίας Πληροφορικής και Υπολογιστών.
 *  Εργαστήριο Τεχνολογίας Λογισμικού
 */


/* ---------------------------------------------------------------------
   ---------------------------- Header files ---------------------------
   --------------------------------------------------------------------- */

#include <stdio.h>
#include <string.h>
#include <stdarg.h>

#include "general.hpp"
#include "error.hpp"
#include "symbol.hpp"

typedef struct Type_tag * Type_T;

/* ---------------------------------------------------------------------
   ------------- Καθολικές μεταβλητές του πίνακα συμβόλων --------------
   --------------------------------------------------------------------- */

Scope        * currentScope;           /* Τρέχουσα εμβέλεια              */
unsigned int quadNext;                 /* Αριθμός επόμενης τετράδας      */
unsigned int tempNumber;               /* Αρίθμηση των temporaries       */

static unsigned int hashTableSize;     /* Μέγεθος πίνακα κατακερματισμού */
static SymbolEntry ** hashTable;       /* Πίνακας κατακερματισμού        */

static struct Type_tag typeConst [] = {
	{ Type_tag::TYPE_VOID,    0, 0, 0, 0 },
	{ Type_tag::TYPE_INTEGER, 0, 0, 0, 0 },
	{ Type_tag::TYPE_BOOLEAN, 0, 0, 0, 0 },
	{ Type_tag::TYPE_CHAR,    0, 0, 0, 0 },
	{ Type_tag::TYPE_REAL,    0, 0, 0, 0 }
};

const Type_T typeVoid    = &(typeConst[0]);
const Type_T typeInteger = &(typeConst[1]);
const Type_T typeBoolean = &(typeConst[2]);
const Type_T typeChar    = &(typeConst[3]);
const Type_T typeReal    = &(typeConst[4]);


/* ---------------------------------------------------------------------
   ------- Υλοποίηση βοηθητικών συναρτήσεων του πίνακα συμβόλων --------
   --------------------------------------------------------------------- */

typedef unsigned long int HashType;

static HashType PJW_hash (char * key)
{
	/*
	 *  P.J. Weinberger's hashing function. See also:
	 *  Aho A.V., Sethi R. & Ullman J.D, "Compilers: Principles,
	 *  Techniques and Tools", Addison Wesley, 1986, pp. 433-437.
	 */

	const HashType PJW_OVERFLOW =
		(((HashType) 0xf) << (8 * sizeof(HashType) - 4));
	const int PJW_SHIFT = (8 * (sizeof(HashType) - 1));

	HashType h, g;

	for (h = 0; *key != '\0'; key++) {
		h = (h << 4) + (*key);
		if ((g = h & PJW_OVERFLOW) != 0) {
			h ^= g >> PJW_SHIFT;
			h ^= g;
		}
	}
	return h;
}

void strAppendChar (char * buffer, RepChar c)
{
	switch (c) {
	case '\n':
		strcat(buffer, "\\n");
		break;
	case '\t':
		strcat(buffer, "\\t");
		break;
	case '\r':
		strcat(buffer, "\\r");
		break;
	case '\0':
		strcat(buffer, "\\0");
		break;
	case '\\':
		strcat(buffer, "\\\\");
		break;
	case '\'':
		strcat(buffer, "\\'");
		break;
	case '\"':
		strcat(buffer, "\\\"");
		break;
	default: {
		char s[] = { '\0', '\0' };

		*s = c;
		strcat(buffer, s);
	}
	}
}

void strAppendString (char * buffer, RepString str)
{
	char * s;

	for (s = str; *s != '\0'; s++)
		strAppendChar(buffer, *s);
}


/* ---------------------------------------------------------------------
   ------ Υλοποίηση των συναρτήσεων χειρισμού του πίνακα συμβόλων ------
   --------------------------------------------------------------------- */

void initSymbolTable (unsigned int size)
{
	unsigned int i;

	/* Διάφορες αρχικοποιήσεις */

	currentScope = NULL;
	quadNext     = 1;
	tempNumber   = 1;

	/* Αρχικοποίηση του πίνακα κατακερματισμού */

	hashTableSize = size;
	hashTable = (SymbolEntry **) new SymbolEntry *[size];

	for (i = 0; i < size; i++)
		hashTable[i] = NULL;
}

void destroySymbolTable ()
{
	unsigned int i;

	/* Καταστροφή του πίνακα κατακερματισμού */

	for (i = 0; i < hashTableSize; i++)
		if (hashTable[i] != NULL)
			destroyEntry(hashTable[i]);

	delete(hashTable);
}

void openScope ()
{
	//printf("OPEN SCOPE\n");
	Scope * newScope = (Scope *) new(Scope);

	newScope->negOffset = START_NEGATIVE_OFFSET;
	newScope->parent    = currentScope;
	newScope->entries   = NULL;

	if (currentScope == NULL)
		newScope->nestingLevel = 1;
	else
		newScope->nestingLevel = currentScope->nestingLevel + 1;

	currentScope = newScope;
}

void closeScope ()
{
	//printf("CLOSE SCOPE\n");
	SymbolEntry * e = currentScope->entries;
	Scope       * t = currentScope;

	while (e != NULL) {
		SymbolEntry * next = e->nextInScope;
		hashTable[e->hashValue] = e->nextHash;
		// destroyEntry(e);
		e = next;
	}

	currentScope = currentScope->parent;
	delete(t);
}

void insertEntry (SymbolEntry * e)
{
	e->nextHash             = hashTable[e->hashValue];
	hashTable[e->hashValue] = e;
	e->nextInScope          = currentScope->entries;
	currentScope->entries   = e;
}

static SymbolEntry * newEntry (char * name)
{
	SymbolEntry * e;

	/* Έλεγχος αν υπάρχει ήδη */
	for (e = currentScope->entries; e != NULL; e = e->nextInScope)
		if (strcmp(name, e->id) == 0) {
			error("Duplicate identifier: %s", name);
			return NULL;
		}

	/* Αρχικοποίηση όλων εκτός: entryType και u */

	e = (SymbolEntry *) new(SymbolEntry);
	e->id = (char *) new char* [strlen(name) + 1];

	strcpy((char *) (e->id), name);
	e->hashValue    = PJW_hash(name) % hashTableSize;
	e->nestingLevel = currentScope->nestingLevel;
	insertEntry(e);
	return e;
}

SymbolEntry * newVariable (char * name, Type_T type)
{
	SymbolEntry * e = newEntry(name);

	if (e != NULL) {
		e->entryType = ENTRY_VARIABLE;
		e->u.eVariable.type = type;
		type->refCount++;
		// For minibasic, let's abuse the negative offset
		// and just count how many variables we have in the scope.
		e->u.eVariable.offset = currentScope->negOffset;
		currentScope->negOffset++;
		/* This is not necessary...
		   currentScope->negOffset -= sizeOfType(type);
		   e->u.eVariable.offset = currentScope->negOffset;
		 */
	}
	return e;
}

SymbolEntry * newConstant (char * name, Type_T type, ...)
{
	SymbolEntry * e;
	va_list ap;

	union {
		RepInteger vInteger;
		RepBoolean vBoolean;
		RepChar vChar;
		RepReal vReal;
		RepString vString;
	} value;

	va_start(ap, type);
	switch (type->kind) {
	case Type_tag::TYPE_INTEGER:
		value.vInteger = va_arg(ap, RepInteger);
		break;
	case Type_tag::TYPE_BOOLEAN:
		value.vBoolean = va_arg(ap, int); /* RepBool is promoted */
		break;
	case Type_tag::TYPE_CHAR:
		value.vChar = va_arg(ap, int); /* RepChar is promoted */
		break;
	case Type_tag::TYPE_REAL:
		value.vReal = va_arg(ap, RepReal);
		break;
	case Type_tag::TYPE_ARRAY:
		if (equalType(type->refType, typeChar)) {
			RepString str = va_arg(ap, RepString);

			value.vString = (char *) new const char* [strlen(str) + 1];
			strcpy((char *) (value.vString), str);
			break;
		}
		[[fallthrough]];
	default:
		internal("Invalid type for constant");
	}
	va_end(ap);

	if (name == NULL) {
		char buffer[256];

		switch (type->kind) {
		case Type_tag::TYPE_INTEGER:
			snprintf(buffer, sizeof buffer, "%d", value.vInteger);
			break;
		case Type_tag::TYPE_BOOLEAN:
			if (value.vBoolean)
				snprintf(buffer, sizeof buffer, "true");
			else
				snprintf(buffer, sizeof buffer, "false");
			break;
		case Type_tag::TYPE_CHAR:
			strcpy(buffer, "'");
			strAppendChar(buffer, value.vChar);
			strcat(buffer, "'");
			break;
		case Type_tag::TYPE_REAL:
			snprintf(buffer, sizeof buffer, "%Lg", value.vReal);
			break;
		case Type_tag::TYPE_ARRAY:
			strcpy(buffer, "\"");
			strAppendString(buffer, value.vString);
			strcat(buffer, "\"");
		default: {}
		}
		e = newEntry(buffer);
	}
	else
		e = newEntry(name);

	if (e != NULL) {
		e->entryType = ENTRY_CONSTANT;
		e->u.eConstant.type = type;
		type->refCount++;
		switch (type->kind) {
		case Type_tag::TYPE_INTEGER:
			e->u.eConstant.value.vInteger = value.vInteger;
			break;
		case Type_tag::TYPE_BOOLEAN:
			e->u.eConstant.value.vBoolean = value.vBoolean;
			break;
		case Type_tag::TYPE_CHAR:
			e->u.eConstant.value.vChar = value.vChar;
			break;
		case Type_tag::TYPE_REAL:
			e->u.eConstant.value.vReal = value.vReal;
			break;
		case Type_tag::TYPE_ARRAY:
			e->u.eConstant.value.vString = value.vString;
		default: {}
		}
	}
	return e;
}

SymbolEntry * newFunction (char * name)
{
	SymbolEntry * e;

	/* Only the current scope matters: a function may hide a name of an
	   enclosing scope, as in Pascal. */
	for (e = currentScope->entries; e != NULL; e = e->nextInScope)
		if (strcmp(name, e->id) == 0)
			break;

	if (e == NULL) {
		e = newEntry(name);
		if (e != NULL) {
			e->entryType = ENTRY_FUNCTION;
			e->u.eFunction.isForward = false;
			e->pardef = SymbolEntry_tag::PARDEF_DEFINE;
			e->u.eFunction.firstArgument = e->u.eFunction.lastArgument = NULL;
			e->u.eFunction.resultType = NULL;
		}
		return e;
	}
	else if (e->entryType == ENTRY_FUNCTION && e->u.eFunction.isForward) {
		e->u.eFunction.isForward = false;
		e->pardef = SymbolEntry_tag::PARDEF_CHECK;
		e->u.eFunction.lastArgument = NULL;
		return e;
	}
	else {
		error("Duplicate identifier: %s", name);
		return NULL;
	}
}

SymbolEntry * newParameter (char * name, Type_T type,
                            PassMode mode, SymbolEntry * f)
{
	SymbolEntry * e;

	if (f->entryType != ENTRY_FUNCTION)
		internal("Cannot add a parameter to a non-function");
	switch (f->pardef) {
	case SymbolEntry_tag::PARDEF_DEFINE:
		e = newEntry(name);
		if (e != NULL) {
			e->entryType = ENTRY_PARAMETER;
			e->u.eParameter.type = type;
			type->refCount++;
			e->u.eParameter.mode = mode;
			e->u.eParameter.next = NULL;
		}
		if (f->u.eFunction.lastArgument == NULL)
			f->u.eFunction.firstArgument = f->u.eFunction.lastArgument = e;
		else {
			f->u.eFunction.lastArgument->u.eParameter.next = e;
			f->u.eFunction.lastArgument = e;
		}
		return e;
	case SymbolEntry_tag::PARDEF_CHECK:
		e = f->u.eFunction.lastArgument;
		if (e == NULL)
			e = f->u.eFunction.firstArgument;
		else
			e = e->u.eParameter.next;
		if (e == NULL)
			error("More parameters than expected in redeclaration "
			      "of function %s", f->id);
		else if (!equalType(e->u.eParameter.type, type))
			error("Parameter type mismatch in redeclaration "
			      "of function %s", f->id);
		else if (e->u.eParameter.mode != mode)
			error("Parameter passing mode mismatch in redeclaration "
			      "of function %s", f->id);
		else if (strcmp(e->id, name) != 0)
			error("Parameter name mismatch in redeclaration "
			      "of function %s", f->id);
		else
			insertEntry(e);
		f->u.eFunction.lastArgument = e;
		return e;
	case SymbolEntry_tag::PARDEF_COMPLETE:
		fatal("Cannot add a parameter to an already defined function");
	}
	return NULL;
}

static unsigned int fixOffset (SymbolEntry * args)
{
	if (args == NULL)
		return 0;
	else {
		unsigned int rest = fixOffset(args->u.eParameter.next);

		args->u.eParameter.offset = START_POSITIVE_OFFSET + rest;
		if (args->u.eParameter.mode == PASS_BY_REFERENCE)
			return rest + 2;
		else
			return rest + sizeOfType(args->u.eParameter.type);
	}
}

void forwardFunction (SymbolEntry * f)
{
	if (f->entryType != ENTRY_FUNCTION)
		internal("Cannot make a non-function forward");
	f->u.eFunction.isForward = true;
}

void endFunctionHeader (SymbolEntry * f, Type_T type)
{
	if (f->entryType != ENTRY_FUNCTION)
		internal("Cannot end parameters in a non-function");
	switch (f->pardef) {
	case SymbolEntry_tag::PARDEF_COMPLETE:
		internal("Cannot end parameters in an already defined function");
		break;
	case SymbolEntry_tag::PARDEF_DEFINE:
		fixOffset(f->u.eFunction.firstArgument);
		f->u.eFunction.resultType = type;
		type->refCount++;
		break;
	case SymbolEntry_tag::PARDEF_CHECK:
		if ((f->u.eFunction.lastArgument != NULL &&
		     f->u.eFunction.lastArgument->u.eParameter.next != NULL) ||
		    (f->u.eFunction.lastArgument == NULL &&
		     f->u.eFunction.firstArgument != NULL))
			error("Fewer parameters than expected in redeclaration "
			      "of function %s", f->id);
		if (!equalType(f->u.eFunction.resultType, type))
			error("Result type mismatch in redeclaration of function %s",
			      f->id);
		break;
	}
	f->pardef = SymbolEntry_tag::PARDEF_COMPLETE;
}

SymbolEntry * newTemporary (Type_T type)
{
	char buffer[10];
	SymbolEntry * e;

	snprintf(buffer, sizeof buffer, "$%d", tempNumber);
	e = newEntry(buffer);

	if (e != NULL) {
		e->entryType = ENTRY_TEMPORARY;
		e->u.eVariable.type = type;
		type->refCount++;
		currentScope->negOffset -= sizeOfType(type);
		e->u.eTemporary.offset = currentScope->negOffset;
		e->u.eTemporary.number = tempNumber++;
	}
	return e;
}

void destroyEntry (SymbolEntry * e)
{
	SymbolEntry * args;

	switch (e->entryType) {
	case ENTRY_VARIABLE:
		destroyType(e->u.eVariable.type);
		break;
	case ENTRY_CONSTANT:
		if (e->u.eConstant.type->kind == Type_tag::TYPE_ARRAY)
			delete((char *) (e->u.eConstant.value.vString));
		destroyType(e->u.eConstant.type);
		break;
	case ENTRY_FUNCTION:
		args = e->u.eFunction.firstArgument;
		while (args != NULL) {
			SymbolEntry * p = args;

			destroyType(args->u.eParameter.type);
			delete((char *) (args->id));
			args = args->u.eParameter.next;
			delete(p);
		}
		destroyType(e->u.eFunction.resultType);
		break;
	case ENTRY_PARAMETER:
		/* Οι παράμετροι καταστρέφονται μαζί με τη συνάρτηση */
		return;
	case ENTRY_TEMPORARY:
		destroyType(e->u.eTemporary.type);
		break;
	}
	delete((char *) (e->id));
	delete(e);
}

SymbolEntry * lookupEntry (char * name, LookupType type, bool err)
{
	unsigned int hashValue = PJW_hash(name) % hashTableSize;
	SymbolEntry * e         = hashTable[hashValue];

	Scope * tempScope = currentScope;
	switch (type) {
	case LOOKUP_CURRENT_SCOPE:
		while (tempScope != NULL) {
			while (e != NULL && e->nestingLevel == tempScope->nestingLevel)
				if (strcmp(e->id, name) == 0)
					return e;
				else
					e = e->nextHash;
			tempScope = tempScope->parent;
		}
		break;
	case LOOKUP_ALL_SCOPES:
		while (e != NULL)
			if (strcmp(e->id, name) == 0)
				return e;
			else
				e = e->nextHash;
		break;
	}

	if (err)
		error("Unknown identifier: %s", name);
	return NULL;
}

Type_T typeArray (RepInteger size, Type_T refType)
{
	Type_T n = (Type_T) new(struct Type_tag);

	n->kind     = Type_tag::TYPE_ARRAY;
	n->refType  = refType;
	n->size     = size;
	n->refCount = 1;

	refType->refCount++;

	return n;
}

Type_T typeIArray (Type_T refType)
{
	Type_T n = (Type_T) new(struct Type_tag);

	n->kind     = Type_tag::TYPE_IARRAY;
	n->refType  = refType;
	n->refCount = 1;

	refType->refCount++;

	return n;
}

Type_T typePointer (Type_T refType)
{
	Type_T n = (Type_T) new(struct Type_tag);

	n->kind     = Type_tag::TYPE_POINTER;
	n->refType  = refType;
	n->refCount = 1;

	refType->refCount++;

	return n;
}

void destroyType (Type_T type)
{
	switch (type->kind) {
	case Type_tag::TYPE_ARRAY:
	case Type_tag::TYPE_IARRAY:
	case Type_tag::TYPE_POINTER:
		if (--(type->refCount) == 0) {
			destroyType(type->refType);
			delete(type);
		}
	default: {}
	}
}

unsigned int sizeOfType (Type_T type)
{
	switch (type->kind) {
	case Type_tag::TYPE_VOID:
		internal("Type void has no size");
		break;
	case Type_tag::TYPE_INTEGER:
	case Type_tag::TYPE_IARRAY:
	case Type_tag::TYPE_POINTER:
		return 2;
	case Type_tag::TYPE_BOOLEAN:
	case Type_tag::TYPE_CHAR:
		return 1;
	case Type_tag::TYPE_REAL:
		return 10;
	case Type_tag::TYPE_ARRAY:
		return type->size * sizeOfType(type->refType);
	}
	return 0;
}

bool equalType (Type_T type1, Type_T type2)
{
	if (type1->kind != type2->kind)
		return false;

	switch (type1->kind) {
	case Type_tag::TYPE_ARRAY:
		if (type1->size != type2->size)
			return false;
		[[fallthrough]];
	case Type_tag::TYPE_POINTER:
		return equalType(type1->refType, type2->refType);
	default: {}
	}
	return true;
}

void printType (Type_T type)
{
	if (type == NULL) {
		printf("<undefined>");
		return;
	}

	switch (type->kind) {
	case Type_tag::TYPE_VOID:
		printf("void");
		break;
	case Type_tag::TYPE_INTEGER:
		printf("integer");
		break;
	case Type_tag::TYPE_BOOLEAN:
		printf("boolean");
		break;
	case Type_tag::TYPE_CHAR:
		printf("char");
		break;
	case Type_tag::TYPE_REAL:
		printf("real");
		break;
	case Type_tag::TYPE_ARRAY:
		printf("array [%d] of ", type->size);
		printType(type->refType);
		break;
	case Type_tag::TYPE_IARRAY:
		printf("array of ");
		printType(type->refType);
		break;
	case Type_tag::TYPE_POINTER:
		printf("^");
		printType(type->refType);
		break;
	}
}

void printMode (PassMode mode)
{
	if (mode == PASS_BY_REFERENCE)
		printf("var ");
}
