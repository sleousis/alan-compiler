%{
#include <string>
#include "ast.hpp"
#include "parser.hpp"
#define T_eof 0

int lineno = 1;
/* Line where the outermost (* comment starts, for an unterminated one. */
static int comment_line;

void yyerror (const char msg[]);
%}

L [a-zA-Z]
D [0-9]
W [ \t\r]
S [!|&<>()\[\]{},:+\-*%/;]
H [0-9a-fA-F]
/* The escape sequences of the spec's table 1. */
E \\([ntr0\\'"]|x{H}{H})
/* A common character: printable ASCII except ' " and \ (spec 1.1). */
C [ !#-&(-\[\]-~]
/* What a string may hold besides escapes: anything but the closing quote,
   a backslash, the end of the line and NUL. */
T [^"\\\n\0]

%x comment
%option stack
%option noyywrap
%option nounput noinput noyy_top_state
%%

"while"  	{ return T_while; }
"if"     	{ return T_if; }
"else"     	{ return T_else; }
"return"    { return T_ret; }
"int"     	{ return T_int; }
"byte"     	{ return T_byte; }
"reference"	{ return T_ref; }
"proc"     	{ return T_proc; }
"true"     	{ yylval.c = strdup(yytext); return T_true; }
"false"    	{ yylval.c = strdup(yytext); return T_false; }
"=="    	{ return T_equal; }
"!="    	{ return T_notequal; }
">="    	{ return T_grequal; }
"<="    	{ return T_lequal; }
"="    		{ return T_assign; }


{S}  { return yytext[0]; }


\-\-.*                     	{ }

"(*" {
  comment_line = lineno;
  yy_push_state(comment);
}
<comment>{
  "(*"       { yy_push_state(comment); }
  "*)"       { yy_pop_state(); }
  [^*()\n]+  { }
  [*()]      { }
  \n         { ++lineno; }
  <<EOF>>    {
    lineno = comment_line;
    yyerror("Unterminated comment");
  }
}

\"({T}|{E})*\"		{ yylval.c = strdup(yytext); return T_string; }
 /* The longest match picks one of these when a string goes wrong. On a
    tie the first one wins, so "a\" is reported as not closed. A backslash
    at the end of the line (before CR LF too) is not closed either. */
\"({T}|{E})*		{ yyerror("String literal not closed on this line"); }
\"({T}|{E})*\\[^\r\n]	{
  std::string msg = std::string("Invalid escape sequence \\") +
                    (yytext + yyleng - 1) + " in string literal";
  yyerror(msg.c_str());
}
\"({T}|{E})*\0		{ yyerror("NUL character in string literal"); }

\'({C}|{E})\'		{ yylval.c = strdup(yytext); return T_char; }
\'			{ yyerror("Invalid character constant"); }

{L}({L}|{D}|_)*     { yylval.c = strdup(yytext); return T_id; }
{D}+     	 		{
  /* int is 32 bits, so a constant must be at most 2147483647. */
  long long value = 0;
  for (const char *p = yytext; *p != '\0'; p++) {
    value = value * 10 + (*p - '0');
    if (value > 2147483647LL) {
      std::string msg = std::string("Integer constant ") + yytext +
                        " is out of range (0 to 2147483647)";
      yyerror(msg.c_str());
    }
  }
  yylval.n = (int) value;
  return T_const;
}

{W}+     			{ /* nothing */ }
\n       			{ ++lineno; }

{D}+{L}({L}|{D}|_)* { yyerror ("Illegal phrase!"); }

. { yyerror ("Illegal character or phrase!"); }

%%
