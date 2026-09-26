#include <string.h>
#include "alanrt.h"

int32_t alan_strlen(const char *s) { return (int32_t)strlen(s); }
int32_t alan_strcmp(const char *a, const char *b) {
    int r = strcmp(a, b);
    return r < 0 ? -1 : (r > 0 ? 1 : 0);
}
void alan_strcpy(char *d, const char *s) { strcpy(d, s); }
void alan_strcat(char *d, const char *s) { strcat(d, s); }
