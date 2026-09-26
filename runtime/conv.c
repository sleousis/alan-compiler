#include "alanrt.h"

static int16_t parse_int16(const char *s, int *ok) {
    while (*s == ' ') s++;
    int neg = 0;
    if (*s == '-') { neg = 1; s++; }
    int32_t v = 0;
    while (*s >= '0' && *s <= '9') {
        v = v * 10 + (*s - '0');
        if (v > 0x8000) { *ok = 0; return 0; }
        s++;
    }
    if (!neg && v > 0x7fff) { *ok = 0; return 0; }
    *ok = 1;
    return (int16_t)(neg ? -v : v);
}

int32_t alan_readInteger(void) {
    char line[256];
    line[0] = (char)alan_readChar();
    alan_readString(255, line + 1);
    int ok;
    int16_t v = parse_int16(line, &ok);
    return (int32_t)(uint16_t)v;             /* zero-extended like the assembly */
}

uint8_t alan_readByte(void) { return (uint8_t)(alan_readInteger() & 0xFF); }
int32_t alan_extend(uint8_t b) { return (int32_t)b; }
uint8_t alan_shrink(int32_t n) { return (uint8_t)(n & 0xFF); }
