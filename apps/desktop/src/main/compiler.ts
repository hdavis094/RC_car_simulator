import { spawnSync } from 'node:child_process';

/** Parse compiler words the same way the HAL build driver does. */
export function compilerWords(command: string): string[] {
  const words: string[] = [];
  let word = '',
    quote = '',
    started = false,
    escaped = false;
  for (const c of command) {
    if (escaped) {
      word += c;
      escaped = false;
      started = true;
    } else if (c === '\\' && quote !== "'") {
      escaped = true;
      started = true;
    } else if (quote) {
      if (c === quote) quote = '';
      else word += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      started = true;
    } else if (/\s/.test(c)) {
      if (started) words.push(word);
      word = '';
      started = false;
    } else {
      word += c;
      started = true;
    }
  }
  if (escaped || quote) throw new Error('unterminated quote or escape in CXX');
  if (started) words.push(word);
  if (!words.length || !words[0]) throw new Error('CXX is empty');
  return words;
}

export interface CompilerCheck {
  readonly ok: boolean;
  readonly command?: string;
  readonly message?: string;
}

export function checkCompiler(): CompilerCheck {
  const configured = process.env['CXX']?.trim() || 'c++';
  let words: string[];
  try {
    words = compilerWords(configured);
  } catch (error) {
    return { ok: false, message: `Invalid CXX value: ${String(error)}` };
  }
  const [command = 'c++', ...prefix] = words;
  const result = spawnSync(command, [...prefix, '--version'], { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    const setup =
      process.platform === 'darwin'
        ? 'Install the Xcode Command Line Tools with `xcode-select --install`.'
        : 'Install a C++ compiler, e.g. `sudo apt-get install build-essential clang`.';
    return {
      ok: false,
      message: `No usable C++ compiler was found (${configured}). ${setup} You can also set CXX to a working compiler.`,
    };
  }
  return { ok: true, command: configured };
}
