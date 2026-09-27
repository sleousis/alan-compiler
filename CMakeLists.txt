cmake_minimum_required(VERSION 3.28)
# C is enabled because LLVMConfig runs C checks for its dependencies.
project(alanc C CXX)
set(CMAKE_CXX_STANDARD 17)
if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
  set(CMAKE_BUILD_TYPE Release)
endif()
if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
  # Link zlib statically, so alanc needs only glibc.
  set(ZLIB_USE_STATIC_LIBS ON)
endif()
# LLVMConfigVersion only accepts major.minor, so check the major version here.
find_package(LLVM REQUIRED CONFIG)
if(NOT LLVM_VERSION_MAJOR EQUAL 23)
  message(FATAL_ERROR "LLVM 23 is required, found ${LLVM_PACKAGE_VERSION} in ${LLVM_DIR}")
endif()
find_package(BISON 3.8 REQUIRED)
find_package(FLEX 2.6 REQUIRED)
BISON_TARGET(Parser parser.y ${CMAKE_BINARY_DIR}/parser.cpp DEFINES_FILE ${CMAKE_BINARY_DIR}/parser.hpp)
set(FLEX_FLAGS "-s")
if(WIN32)
  # win_flex includes io.h instead of unistd.h
  string(APPEND FLEX_FLAGS " --wincompat")
endif()
FLEX_TARGET(Lexer lexer.l ${CMAKE_BINARY_DIR}/lexer.cpp COMPILE_FLAGS ${FLEX_FLAGS})
ADD_FLEX_BISON_DEPENDENCY(Lexer Parser)
# alanc --version prints this outside a bundle. A bundle's VERSION file wins.
set(ALAN_VERSION "dev" CACHE STRING "version compiled into alanc")
add_executable(alanc ast.cpp symbol.cpp error.cpp general.cpp cli.cpp emit.cpp debuginfo.cpp
               ${BISON_Parser_OUTPUTS} ${FLEX_Lexer_OUTPUTS})
target_include_directories(alanc PRIVATE ${CMAKE_SOURCE_DIR} ${CMAKE_BINARY_DIR})
target_compile_definitions(alanc PRIVATE "ALAN_VERSION=\"${ALAN_VERSION}\"")
# SYSTEM, so warnings in LLVM's headers are not reported (/external:I on MSVC).
target_include_directories(alanc SYSTEM PRIVATE ${LLVM_INCLUDE_DIRS})
# The project's own sources, generated ones included, must build without warnings.
if(MSVC)
  target_compile_options(alanc PRIVATE /W3 /WX)
  # InstructionWorklist.h in LLVM builds a std::pair that narrows, and the
  # standard library reports that C4244 inside <utility> whatever the external
  # warning level is. This turns C4244 off only inside the standard headers.
  target_compile_definitions(alanc PRIVATE _STL_EXTRA_DISABLED_WARNINGS=4244)
else()
  target_compile_options(alanc PRIVATE -Wall -Werror)
endif()
separate_arguments(LLVM_DEFS NATIVE_COMMAND ${LLVM_DEFINITIONS})
target_compile_definitions(alanc PRIVATE ${LLVM_DEFS})
llvm_map_components_to_libnames(LLVM_LIBS core support target passes
  x86codegen x86asmparser x86desc x86info
  aarch64codegen aarch64asmparser aarch64desc aarch64info)
find_package(Threads REQUIRED)
target_link_libraries(alanc PRIVATE ${LLVM_LIBS} Threads::Threads)
if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
  # alanc must run on glibc 2.31 without a matching libstdc++ installed.
  target_link_options(alanc PRIVATE -static-libstdc++ -static-libgcc)
  include(CheckSymbolExists)
  check_symbol_exists(__libc_single_threaded "sys/single_threaded.h" HAVE_LIBC_SINGLE_THREADED)
  check_symbol_exists(mallinfo2 "malloc.h" HAVE_MALLINFO2)
  if(NOT HAVE_LIBC_SINGLE_THREADED OR NOT HAVE_MALLINFO2)
    target_sources(alanc PRIVATE glibc_compat.c)
    if(NOT HAVE_LIBC_SINGLE_THREADED)
      target_compile_definitions(alanc PRIVATE ALAN_NEED_SINGLE_THREADED)
    endif()
    if(NOT HAVE_MALLINFO2)
      target_compile_definitions(alanc PRIVATE ALAN_NEED_MALLINFO2)
    endif()
  endif()
endif()
if(UNIX AND TARGET zstd::libzstd_shared AND zstd_STATIC_LIBRARY)
  # Link zstd statically too, so alanc needs no zstd (or Homebrew) library.
  set_target_properties(zstd::libzstd_shared PROPERTIES IMPORTED_LOCATION "${zstd_STATIC_LIBRARY}")
endif()
if(MSVC)
  set_property(TARGET alanc PROPERTY MSVC_RUNTIME_LIBRARY "MultiThreaded")
  # Windows gives the main thread 1 MB of stack, and LLVM's code generator
  # recurses deeply on long expressions. Linux and macOS give 8 MB.
  target_link_options(alanc PRIVATE /STACK:16777216)
  target_compile_definitions(alanc PRIVATE YY_NO_UNISTD_H _CRT_SECURE_NO_WARNINGS _CRT_NONSTDC_NO_WARNINGS)
endif()
