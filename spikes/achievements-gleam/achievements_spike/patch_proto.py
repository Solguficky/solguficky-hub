"""Минимальные правки proto, без которых protozoa 2.0.3 не генерирует код.

1. Строки `reserved ...;` удаляются: парсер принимает их за поле.
2. Пустое тело `{}` в одной строке разносится на две: иначе `}` уходит в имя типа.
"""
import pathlib, re, sys

src, dst = map(pathlib.Path, sys.argv[1:3])
for p in src.rglob("*.proto"):
    text = p.read_text()
    text = re.sub(r"^\s*reserved [^;]*;\n", "", text, flags=re.M)
    text = re.sub(r"^(\s*)(message|enum) (\w+) \{\}", r"\1\2 \3 {\n\1}", text, flags=re.M)
    out = dst / p.relative_to(src)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(text)
