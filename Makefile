.PHONY: clean distclean default

CXX=g++
CXXFLAGS=-Wall -g -std=c++17 `llvm-config --cxxflags`
LDFLAGS=`llvm-config --link-static --ldflags --libs core support target x86 aarch64 passes` `llvm-config --link-static --system-libs`

default: alanc

lexer.cpp: lexer.l
	flex -s -o lexer.cpp lexer.l

lexer.o: lexer.cpp parser.hpp

parser.hpp parser.cpp: parser.y
	bison -dv -o parser.cpp parser.y

parser.o: parser.cpp

ast.o: ast.cpp ast.hpp

%.o: %.cpp
		$(CXX) $(CXXFLAGS) -c $<

emit.o: emit.cpp emit.hpp

cli.o: cli.cpp cli.hpp emit.hpp error.hpp

alanc: lexer.o parser.o ast.o error.o general.o symbol.o cli.o emit.o
	$(CXX) $(CXXFLAGS) -o alanc $^ $(LDFLAGS)

clean:
	$(RM) lexer.cpp parser.cpp parser.hpp parser.output a.* *.o *~

distclean: clean
	$(RM) alanc
