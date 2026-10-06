import io, re

for f in ["bg/index.js", "content/auto.js"]:
    s = io.open(f, encoding="utf-8").read()
    t = re.sub(r"//[^\n]*", "", s)
    t = re.sub(r"/\*.*?\*/", "", t, flags=re.S)
    t = re.sub(r"'(?:\\.|[^'\\\n])*'", '""', t)
    t = re.sub(r'"(?:\\.|[^"\\\n])*"', '""', t)
    t = re.sub(r"`(?:\\.|[^`\\])*`", '""', t)
    print(f, "curly", t.count("{") - t.count("}"),
          "paren", t.count("(") - t.count(")"),
          "brack", t.count("[") - t.count("]"))
