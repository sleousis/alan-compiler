#include <stdio.h>
#include "alanrt.h"
#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#endif

/* Input goes through in_byte, which can take back two bytes: a line that
   fills the buffer needs to look past a '\r' for a '\n'. */
static int pushed[2];
static int npushed;

static int in_byte(void) {
    if (npushed > 0) return pushed[--npushed];
#ifdef _WIN32
    /* In text mode Windows ends the input at byte 0x1A. Binary mode keeps
       every byte, and the readers below drop the '\r' of "\r\n". */
    static int binary;
    if (!binary) { binary = 1; _setmode(_fileno(stdin), _O_BINARY); }
#endif
    fflush(stdout);
    return getchar();
}

static void unread(int c) {
    if (c != EOF) pushed[npushed++] = c;
}

void alan_writeInteger(int32_t n) { printf("%d", (int)n); }
void alan_writeByte(uint8_t b) { alan_writeInteger(alan_extend(b)); }
/* Like writec.asm, byte 0 prints nothing. */
void alan_writeChar(uint8_t c) { if (c != 0) putchar(c); }
void alan_writeString(const char *s) { fputs(s, stdout); }

uint8_t alan_readChar(void) {
    int c;
    do { c = in_byte(); } while (c == '\n' || c == '\r');
    return c == EOF ? 0 : (uint8_t)c;
}

/* Reads up to size-1 bytes of the current line into buf. Returns 1 when the
   line ended (its "\n" or "\r\n" consumed, or the input ended), 0 when the
   buffer filled first and the rest of the line is still unread. */
static int read_part(int32_t size, char *buf) {
    int32_t n = 0;
    int c;
    int ended = 0;
    while (n < size - 1) {
        c = in_byte();
        if (c == '\n' || c == EOF) { ended = 1; break; }
        buf[n++] = (char)c;
    }
    if (!ended) {                 /* full: the line may still end right here */
        c = in_byte();
        if (c == '\n' || c == EOF) {
            ended = 1;
        } else if (c == '\r') {
            int d = in_byte();
            if (d == '\n' || d == EOF) ended = 1;
            else { unread(d); unread(c); }
        } else {
            unread(c);
        }
    }
    if (ended && n > 0 && buf[n - 1] == '\r') n--;
    buf[n] = '\0';
    return ended;
}

/* An over-long line continues on the next call (spec 1.6.1). */
void alan_readString(int32_t size, char *buf) {
    if (size <= 0) return;
    read_part(size, buf);
}

void alan_rt_readLine(int32_t size, char *buf) {
    if (!read_part(size, buf)) {
        int c;
        while ((c = in_byte()) != EOF && c != '\n') {}
    }
}
