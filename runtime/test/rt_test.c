#include <stdio.h>
#include "../alanrt.h"

int main(void) {
    alan_writeInteger(42); alan_writeChar('\n');
    alan_writeInteger(-7); alan_writeChar('\n');
    alan_writeInteger(70000); alan_writeChar('\n');      /* the full int: 70000 */
    alan_writeByte(200); alan_writeChar('\n');
    alan_writeString("hi\n");
    int32_t a = alan_readInteger();                       /* "12" */
    alan_writeInteger(a); alan_writeChar('\n');
    int32_t b = alan_readInteger();                       /* "-5" -> -5 */
    alan_writeInteger(b); alan_writeChar('\n');
    printf("%d\n", b);
    uint8_t c = alan_readChar();                          /* skips newline, 'x' */
    alan_writeChar(c); alan_writeChar('\n');
    char buf[8];
    alan_readString(8, buf);                              /* rest of line after x: "yz" */
    alan_writeString(buf); alan_writeChar('\n');
    alan_readString(8, buf);                              /* "abcdefghij": "abcdefg" */
    alan_writeString(buf); alan_writeChar('\n');
    alan_readString(8, buf);                              /* the rest of it: "hij" */
    alan_writeString(buf); alan_writeChar('\n');
    alan_writeChar(0);                                    /* prints nothing */
    alan_writeInteger(alan_strlen("abc")); alan_writeChar('\n');
    alan_writeInteger(alan_strcmp("a", "b")); alan_writeChar('\n');
    char d[16]; alan_strcpy(d, "ab"); alan_strcat(d, "cd"); alan_writeString(d);
    alan_writeChar('\n');
    alan_writeInteger(alan_extend(255)); alan_writeChar('\n');
    alan_writeInteger(alan_shrink(300)); alan_writeChar('\n');
    /* integer parsing wraps like parsei.asm, then sign-extends */
    int32_t v;
    v = alan_readInteger(); alan_writeInteger(v); printf(" %d\n", v);  /* 65636 */
    v = alan_readInteger(); alan_writeInteger(v); printf(" %d\n", v);  /* 40000 */
    v = alan_readInteger(); alan_writeInteger(v); printf(" %d\n", v);  /* 32768 */
    v = alan_readInteger(); alan_writeInteger(v); printf(" %d\n", v);  /* -32768 */
    v = alan_readInteger(); alan_writeInteger(v); printf(" %d\n", v);  /* 70000 */
    v = alan_readInteger(); alan_writeInteger(v); printf(" %d\n", v);  /* -70000 */
    /* a line of 300 bytes: readInteger uses all of it */
    v = alan_readInteger(); alan_writeInteger(v); alan_writeChar('\n'); /* 33 */
    /* "ab\r\n" fills 3 bytes, and its "\r\n" still ends the line */
    alan_readString(4, buf); alan_writeString(buf); alan_writeChar('\n');  /* "ab" */
    alan_readString(8, buf); alan_writeString(buf); alan_writeChar('\n');  /* "XY" */
    return 0;
}
