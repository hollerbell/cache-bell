"""Mutation run over core/*.ts: one small change at a time, the tests must fail for each.

    python tools/mutate.py <plugin dir> [file ...]

Without file names every file of core/ is mutated. The plugin is copied to a temporary folder and the copy is
mutated, so a run that is interrupted leaves no broken file behind, and a session that reads the plugin from
its folder never loads a broken core. Survivors are written to stdout as they are found, a summary at the
end. The exit code is 0 when no mutant survived, 1 when some did, 2 when the run could not start.
"""
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

TIMEOUT_S = 300

# (pattern, replacement) applied to one occurrence at a time
OPERATORS = [
    (r' === ', ' !== '), (r' !== ', ' === '),
    (r' >= ', ' > '), (r' > ', ' >= '), (r' <= ', ' < '), (r' < ', ' <= '),
    (r' && ', ' || '), (r' \|\| ', ' && '),
    (r' \+ ', ' - '), (r' - ', ' + '), (r' \* ', ' / '), (r' / ', ' * '),
    (r'\btrue\b', 'false'), (r'\bfalse\b', 'true'),
    (r'(?<![\w.\'])(\d+)(?![\w.\'])', lambda m: str(int(m.group(1)) + 1)),
]


def is_code(line: str) -> bool:
    s = line.strip()
    return not (s == '' or s.startswith(('//', 'import ', 'export type', 'type ')))


def tests_pass(claude: str, plugin: Path) -> bool:
    """A run that does not finish counts as failed tests: the mutant was noticed."""
    try:
        return subprocess.run([claude, 'plugin', 'test', str(plugin)], capture_output=True, text=True, timeout=TIMEOUT_S).returncode == 0
    except subprocess.TimeoutExpired:
        return False


def mutants(line: str):
    """Every line that differs from `line` by one operator or number, outside its trailing comment."""
    code = line.split(' // ')[0]
    for pattern, repl in OPERATORS:
        for m in re.finditer(pattern, code):
            new = repl(m) if callable(repl) else repl
            mutated = code[:m.start()] + new + code[m.end():] + line[len(code):]
            if mutated != line:
                yield mutated


def run(claude: str, plugin: Path, names: list[str]) -> int:
    if not tests_pass(claude, plugin):
        print('the tests fail before any change: nothing to mutate')
        return 2
    total = 0
    survivors = []
    for name in names:
        path = plugin / 'core' / name
        original = path.read_text(encoding='utf-8')
        lines = original.split('\n')
        try:
            for at, line in enumerate(lines):
                if not is_code(line):
                    continue
                for mutated in mutants(line):
                    path.write_text('\n'.join(lines[:at] + [mutated] + lines[at + 1:]), encoding='utf-8', newline='\n')
                    total += 1
                    if tests_pass(claude, plugin):
                        survivors.append(f'{name}:{at + 1}: {line.strip()}  ->  {mutated.strip()}')
                        print('SURVIVED', survivors[-1], flush=True)
        finally:
            path.write_text(original, encoding='utf-8', newline='\n')
        print(f'{name}: done, {total} mutants so far, {total - len(survivors)} killed', flush=True)
    print(f'TOTAL {total} mutants, {total - len(survivors)} killed, {len(survivors)} survived')
    return 1 if survivors else 0


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    source = Path(sys.argv[1])
    claude = shutil.which('claude')
    if claude is None:
        print("the command 'claude' was not found")
        return 2
    if not (source / 'core').is_dir():
        print(f'{source} has no core/ folder: give the folder of the plugin')
        return 2
    names = sys.argv[2:] or sorted(path.name for path in (source / 'core').glob('*.ts'))
    missing = [name for name in names if not (source / 'core' / name).is_file()]
    if missing:
        print('not in core/: ' + ', '.join(missing))
        return 2
    with tempfile.TemporaryDirectory(prefix='cache-bell-mutate-') as folder:
        plugin = Path(folder) / source.resolve().name
        shutil.copytree(source, plugin, ignore=shutil.ignore_patterns('node_modules', '.git', '.claude'))
        return run(claude, plugin, names)


if __name__ == '__main__':
    sys.exit(main())
