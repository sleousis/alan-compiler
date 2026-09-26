#include "alanrt.h"

/* Follows alan_lib_v2/auxil/parsei.asm step by step. The assembly adds digits
   into a 64-bit register but only checks its low 16 bits, so values past 65535
   wrap instead of overflowing. Returns the 16-bit result, 0 on overflow. */
static uint16_t parse_int16(const char *s) {
    while (*s == ' ') s++;
    int neg = 0;
    if (*s == '-') { neg = 1; s++; }
    uint64_t acc = 0;
    while (*s >= '0' && *s <= '9') {
        acc = acc * 10 + (uint64_t)(*s - '0');
        if ((uint16_t)acc > 0x8000) return 0;     /* cmp r9w, 0x8000; ja .overflow */
        s++;
    }
    uint16_t low = (uint16_t)acc;
    if (neg) {
        if (low != 0x8000) low = (uint16_t)(0u - low);   /* neg r9w */
    } else if (low > 0x7fff) {
        return 0;
    }
    return low;
}

int32_t alan_readInteger(void) {
    char line[256];
    line[0] = (char)alan_readChar();
    alan_readString(255, line + 1);
    return (int32_t)parse_int16(line);      /* zero-extended like the assembly */
}

uint8_t alan_readByte(void) { return (uint8_t)(alan_readInteger() & 0xFF); }
int32_t alan_extend(uint8_t b) { return (int32_t)b; }
uint8_t alan_shrink(int32_t n) { return (uint8_t)(n & 0xFF); }
