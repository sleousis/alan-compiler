// The error messages the compiler prints, word for word, so the editor shows
// what `alanc check` would show. They come from lexer.l, ast.cpp and
// symbol.cpp at the repository root, without their colour escapes. The
// messages of the editor's own parser are in parser.ts.

/** Alan types as the compiler names them in messages. */
export type TypeWord = "int" | "byte" | "proc" | "void";

export const MSG = {
  // lexer.l
  unterminatedComment: "Unterminated comment",
  stringNotClosed: "String literal not closed on this line",
  invalidEscape: (seq: string) => `Invalid escape sequence \\${seq} in string literal`,
  nulInString: "NUL character in string literal",
  invalidChar: "Invalid character constant",
  intOutOfRange: (digits: string) => `Integer constant ${digits} is out of range (0 to 2147483647)`,
  illegalPhrase: "Illegal phrase!",
  illegalCharacter: "Illegal character or phrase!",

  // symbol.cpp
  duplicate: (name: string) => `Duplicate identifier: ${name}`,

  // ast.cpp, declarations
  mainParameters: (name: string) => `The main function ${name} cannot have parameters.`,
  arraySize: "Array size must be a positive int.",
  arrayByValue: (fn: string) => `In function ${fn}, array must be a reference parameter.`,

  // ast.cpp, names
  identifierNotFound: (name: string) => `Identifier ${name} not found.`,
  functionAsValue: (name: string) => `${name} is a function, so it needs arguments in parentheses.`,
  expectedArray: "Expected array.",
  indexNotInt: "Index of array must be an int.",

  // ast.cpp, calls
  functionNotDeclared: (name: string) => `Function ${name} is not declared in this Scope.`,
  notAFunction: (name: string) => `${name} is not a function.`,
  noParameters: (fn: string) => `Function ${fn} cannot have any Parameters.`,
  needsParameters: (fn: string) => `Function ${fn} must have Parameters.`,
  tooManyArguments: (fn: string) => `Error at Parameter ${fn}, there are too many Parameters.`,
  tooFewArguments: (param: string) => `Error at Parameter ${param}, there must exist more Parameters.`,
  arrayExpected: (param: string) => `${param} Parameter Type Mismatch (an array is expected).`,
  noArraysAllowed: (param: string) => `${param} Parameter Type Mismatch (no arrays allowed).`,
  parameterType: (param: string, arg: TypeWord, want: TypeWord) =>
    `${param} Parameter Type Mismatch (type ${arg} with type ${want}).`,
  referenceNeedsLValue: (param: string) => `Only L-values can be passed by reference (parameter ${param}).`,
  resultUnused: (fn: string, ret: TypeWord) => `Function ${fn} returns ${ret}, so it cannot be called as a statement.`,

  // ast.cpp, statements and operators
  assignArray: "Can't assign whole arrays or strings by = operator.",
  assignTypes: (left: TypeWord, right: TypeWord) => `Can't assign different types (type ${left} with type ${right}).`,
  procReturnsValue: (fn: string) => `Function ${fn} is a proc, so its return cannot have a value.`,
  returnArray: "Can't return whole array.",
  mustReturn: (fn: string, ret: TypeWord) => `Function ${fn} must return ${ret}.`,
  operatorArray: (op: string) => `type mismatch in ${op} operator (can't use array in expression).`,
  operatorTypes: (op: string, left: TypeWord, right: TypeWord) =>
    `type mismatch in ${op} operator (type ${left} with type ${right}).`,
  operatorKind: (op: string, type: TypeWord) =>
    `type mismatch in ${op} operator (operands must be int or byte, not ${type}).`,
} as const;
