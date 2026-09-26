.PHONY: clean distclean default

CXX=g++
CXXFLAGS=-Wall -g -std=c++17 `llvm-config --cxxflags`
LDFLAGS=`llvm-config --ldflags --system-libs --libs all`

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

alanc: lexer.o parser.o ast.o error.o general.o symbol.o cli.o
	$(CXX) $(CXXFLAGS) -o alanc $^ $(LDFLAGS)

clean:
	$(RM) lexer.cpp parser.cpp parser.hpp parser.output a.* *.o *~

distclean: clean
	$(RM) alanc
