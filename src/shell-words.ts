/**
 * Python's `shlex.split(text)`: POSIX shell words with single and double quotes and
 * backslashes, no comments. Throws Python's messages for an unclosed quote or escape.
 */
export function shellWords(text: string): string[] {
  const words: string[] = [];
  let word = "";
  let inWord = false;
  let state: "space" | "word" | "'" | '"' | "escape" = "space";
  let escapedFrom: "word" | '"' = "word";
  for (const char of text) {
    if (state === "escape") {
      if (escapedFrom === '"' && char !== "\\" && char !== '"') {
        word += "\\";
      }
      word += char;
      state = escapedFrom;
    } else if (state === "'") {
      if (char === "'") {
        state = "word";
      } else {
        word += char;
      }
    } else if (state === '"') {
      if (char === '"') {
        state = "word";
      } else if (char === "\\") {
        escapedFrom = '"';
        state = "escape";
      } else {
        word += char;
      }
    } else if (" \t\r\n".includes(char)) {
      if (state === "word" && inWord) {
        words.push(word);
        word = "";
        inWord = false;
      }
      state = "space";
    } else {
      inWord = true;
      if (char === "\\") {
        escapedFrom = "word";
        state = "escape";
      } else if (char === "'" || char === '"') {
        state = char;
      } else {
        word += char;
        state = "word";
      }
    }
  }
  if (state === "'" || state === '"') {
    throw new SyntaxError("No closing quotation");
  }
  if (state === "escape") {
    throw new SyntaxError("No escaped character");
  }
  if (inWord) {
    words.push(word);
  }
  return words;
}
