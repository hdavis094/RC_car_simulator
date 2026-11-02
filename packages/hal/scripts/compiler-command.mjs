// Parse compiler/launcher words without evaluating a shell, expansions or substitutions.
export function compilerWords(command) {
  const words = [];
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
export function makeCompiler(words) {
  return words
    .map((word) => "'" + word.replaceAll('$', () => '$$').replaceAll("'", "'\\''") + "'")
    .join(' ');
}
