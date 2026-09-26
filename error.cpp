/******************************************************************************
 *  CVS version:
 *     $Id: error.c,v 1.2 2004/05/05 22:00:08 nickie Exp $
 ******************************************************************************
 *
 *  C code file : error.c
 *  Project     : PCL Compiler
 *  Version     : 1.0 alpha
 *  Written by  : Nikolaos S. Papaspyrou (nickie@softlab.ntua.gr)
 *  Date        : May 14, 2003
 *  Description : Generic symbol table in C, simple error handler
 *
 *  Comments: (in Greek iso-8859-7)
 *  ---------
 *  Åèíéêü Ìåôóüâéï Ðïëõôå÷íåßï.
 *  Ó÷ïëÞ Çëåêôñïëüãùí Ìç÷áíéêþí êáé Ìç÷áíéêþí Õðïëïãéóôþí.
 *  ÔïìÝáò Ôå÷íïëïãßáò ÐëçñïöïñéêÞò êáé Õðïëïãéóôþí.
 *  ÅñãáóôÞñéï Ôå÷íïëïãßáò Ëïãéóìéêïý
 */


/* ---------------------------------------------------------------------
   ---------------------------- Header files ---------------------------
   --------------------------------------------------------------------- */

#include <stdio.h>
#include <stdlib.h>
#include <stdarg.h>
#include <string.h>
#ifdef _WIN32
#include <io.h>
#define isatty _isatty
#define fileno _fileno
#else
#include <unistd.h>
#endif

#include "general.hpp"
#include "error.hpp"

/* ---------------------------------------------------------------------
   --------- Õëïðïßçóç ôùí óõíáñôÞóåùí ôïõ ÷åéñéóôÞ óöáëìÜôùí ----------
   --------------------------------------------------------------------- */

/* Colour escapes are printed only when stderr is a terminal. */
bool stderr_is_tty (void)
{
	return isatty(fileno(stderr));
}

static const char * colour (const char * escape)
{
	return stderr_is_tty() ? escape : "";
}

/* Set by error_prefix() so that error() does not print a second prefix. */
static bool prefix_printed = false;

void error_prefix (int line)
{
	fprintf(stderr, "%s%s:%d:%s ", colour("\033[1m"), filename, line,
	        colour("\033[0m"));
	linecount = line;
	prefix_printed = true;
}

/* Print a message, dropping its "\033[...m" colour escapes when stderr is
   not a terminal. */
static void print_message (const char * fmt, va_list ap)
{
	char buf[1024];

	vsnprintf(buf, sizeof(buf), fmt, ap);
	if (!stderr_is_tty()) {
		char * out = buf;
		for (const char * in = buf; *in != '\0'; in++) {
			if (in[0] == '\033' && in[1] == '[') {
				const char * end = strchr(in, 'm');
				if (end != NULL) {
					in = end;
					continue;
				}
			}
			*out++ = *in;
		}
		*out = '\0';
	}
	fputs(buf, stderr);
}

void internal (const char * fmt, ...)
{
	va_list ap;

	va_start(ap, fmt);
	if (fmt[0] == '\r')
		fmt++;
	else
		fprintf(stderr, "%s:%d: ", filename, linecount);
	fprintf(stderr, "%sinternal:%s ", colour("\033[1;31m"), colour("\033[0m"));
	print_message(fmt, ap);
	fprintf(stderr, "\n");
	va_end(ap);
	exit(1);
}

void fatal (const char * fmt, ...)
{
	va_list ap;

	va_start(ap, fmt);
	if (fmt[0] == '\r')
		fmt++;
	else
		fprintf(stderr, "%s:%d: ", filename, linecount);
	fprintf(stderr, "%sfatal:%s ", colour("\033[1;31m"), colour("\033[0m"));
	print_message(fmt, ap);
	fprintf(stderr, "\n");
	va_end(ap);
	exit(1);
}

void error (const char * fmt, ...)
{
	va_list ap;

	va_start(ap, fmt);
	if (fmt[0] == '\r')
		fmt++;
	else if (!prefix_printed)
		fprintf(stderr, "%s%s:%d:%s ", colour("\033[1m"), filename, linecount,
		        colour("\033[0m"));
	fprintf(stderr, "%serror:%s ", colour("\033[1;31m"), colour("\033[0m"));
	print_message(fmt, ap);
	fprintf(stderr, "\n");
	va_end(ap);
	fprintf(stderr, "The alan compiler is lazy and aborts...\n");
	exit(1);
}

void warning (const char * fmt, ...)
{
	va_list ap;

	va_start(ap, fmt);
	if (fmt[0] == '\r')
		fmt++;
	else
		fprintf(stderr, "%s:%d: ", filename, linecount);
	fprintf(stderr, "%swarning:%s ", colour("\033[1;33m"), colour("\033[0m"));
	print_message(fmt, ap);
	fprintf(stderr, "\n");
	va_end(ap);
}
