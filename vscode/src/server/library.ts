// The Alan standard library, as declared in the library table of ast.cpp at
// the repository root. Parameter names are the ones the compiler uses.

export interface LibFunc { name: string; params: { name: string; type: string }[]; ret: string; doc: string; }

const STR = "reference byte[]";

export const LIBRARY: LibFunc[] = [
  { name: "writeInteger", params: [{ name: "n", type: "int" }], ret: "proc", doc: "Prints an integer." },
  { name: "writeByte", params: [{ name: "b", type: "byte" }], ret: "proc", doc: "Prints a byte as a number." },
  { name: "writeChar", params: [{ name: "b", type: "byte" }], ret: "proc", doc: "Prints a byte as a character." },
  { name: "writeString", params: [{ name: "s", type: STR }], ret: "proc", doc: "Prints a string." },
  { name: "readInteger", params: [], ret: "int", doc: "Reads an integer from the input." },
  { name: "readByte", params: [], ret: "byte", doc: "Reads a number from the input as a byte." },
  { name: "readChar", params: [], ret: "byte", doc: "Reads one character from the input." },
  {
    name: "readString", params: [{ name: "n", type: "int" }, { name: "s", type: STR }], ret: "proc",
    doc: "Reads a line of at most n - 1 characters into s.",
  },
  { name: "extend", params: [{ name: "b", type: "byte" }], ret: "int", doc: "Turns a byte into an int." },
  { name: "shrink", params: [{ name: "i", type: "int" }], ret: "byte", doc: "Turns an int into a byte, keeping the low 8 bits." },
  { name: "strlen", params: [{ name: "s", type: STR }], ret: "int", doc: "Returns the length of a string." },
  {
    name: "strcmp", params: [{ name: "s1", type: STR }, { name: "s2", type: STR }], ret: "int",
    doc: "Compares two strings. Returns 0 when equal, a negative number when s1 comes first, a positive one otherwise.",
  },
  {
    name: "strcpy", params: [{ name: "trg", type: STR }, { name: "src", type: STR }], ret: "proc",
    doc: "Copies the string src into trg.",
  },
  {
    name: "strcat", params: [{ name: "trg", type: STR }, { name: "src", type: STR }], ret: "proc",
    doc: "Appends the string src to trg.",
  },
];

/** A function header as Alan text, such as "readString (n : int, s : reference byte[]) : proc". */
export function signature(f: { name: string; params: { name: string; type: string }[]; ret: string }): string {
  return `${f.name} (${f.params.map((p) => `${p.name} : ${p.type}`).join(", ")}) : ${f.ret}`;
}
