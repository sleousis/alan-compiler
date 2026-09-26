/* Alan runtime library: the functions Alan programs call for I/O and strings. */
#ifndef ALANRT_H
#define ALANRT_H

#include <stdint.h>

void    alan_writeInteger(int32_t n);
void    alan_writeByte(uint8_t b);
void    alan_writeChar(uint8_t c);
void    alan_writeString(const char *s);
int32_t alan_readInteger(void);
uint8_t alan_readByte(void);
uint8_t alan_readChar(void);
void    alan_readString(int32_t size, char *buf);
int32_t alan_extend(uint8_t b);
uint8_t alan_shrink(int32_t n);
int32_t alan_strlen(const char *s);
int32_t alan_strcmp(const char *a, const char *b);
void    alan_strcpy(char *dst, const char *src);
void    alan_strcat(char *dst, const char *src);

#endif
