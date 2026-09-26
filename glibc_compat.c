/* Symbols that the LLVM release libraries use but glibc before 2.33 lacks.
   CMakeLists.txt compiles this file only on such systems, so alanc keeps
   running on glibc 2.31. */
#include <malloc.h>
#include <stddef.h>

#ifdef ALAN_NEED_SINGLE_THREADED
/* glibc 2.32 sets this to 1 while a process has one thread. Zero is always
   safe: libstdc++ then uses atomic operations. */
char __libc_single_threaded = 0;
#endif

#ifdef ALAN_NEED_MALLINFO2
/* glibc 2.33 added mallinfo2, the size_t version of mallinfo. */
struct mallinfo2 {
  size_t arena, ordblks, smblks, hblks, hblkhd, usmblks, fsmblks, uordblks,
      fordblks, keepcost;
};

struct mallinfo2 mallinfo2(void) {
  struct mallinfo m = mallinfo();
  struct mallinfo2 r = {(size_t)m.arena,    (size_t)m.ordblks,
                        (size_t)m.smblks,   (size_t)m.hblks,
                        (size_t)m.hblkhd,   (size_t)m.usmblks,
                        (size_t)m.fsmblks,  (size_t)m.uordblks,
                        (size_t)m.fordblks, (size_t)m.keepcost};
  return r;
}
#endif
