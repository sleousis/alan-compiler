%{
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

\"(\\.|[^"\\])*\"		{
  /* strdup would stop at a NUL byte and lose the closing quote. */
  if (strlen(yytext) != (size_t) yyleng) yyerror("NUL character in string literal");
  yylval.c = strdup(yytext);
  return T_string;
}

"\'"({L}|{D}|{S}|" "|"\\n"|"\\t"|"\\r"|"\\0"|"\\\\"|"\\\'"|"\\\""|"\\x"({D}|[a-f]){2})"\'" { yylval.c = strdup(yytext); return T_char; }

{L}({L}|{D}|_)*     { yylval.c = strdup(yytext); return T_id; }
{D}+     	 		{ yylval.n = atoi(yytext); return T_const; }

{W}+     			{ /* nothing */ }
\n       			{ ++lineno; }

{D}+{L}({L}|{D}|_)* { yyerror ("Illegal phrase!"); }

. { yyerror ("Illegal character or phrase!"); }

%%
