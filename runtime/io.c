#include <stdio.h>
#include "alanrt.h"

static int next_byte(void) { fflush(stdout); return getchar(); }

void alan_writeInteger(int32_t n) { printf("%d", (int)(int16_t)n); }
void alan_writeByte(uint8_t b) { alan_writeInteger(alan_extend(b)); }
void alan_writeChar(uint8_t c) { putchar(c); }
void alan_writeString(const char *s) { fputs(s, stdout); }

uint8_t alan_readChar(void) {
    int c;
    do { c = next_byte(); } while (c == '\n' || c == '\r');
    return c == EOF ? 0 : (uint8_t)c;
}

void alan_readString(int32_t size, char *buf) {
    int32_t n = 0;
    int c;
    fflush(stdout);
    while (size > 0 && n < size - 1 && (c = getchar()) != EOF && c != '\n') buf[n++] = (char)c;
    if (n > 0 && buf[n - 1] == '\r') n--;
    if (n == size - 1) {                     /* drop the rest of an over-long line */
        while ((c = getchar()) != EOF && c != '\n') {}
    }
    buf[n] = '\0';
}
