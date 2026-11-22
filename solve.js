// A faster drop-in for csv-reader 1.0.0 (make.fun's own CSV reader).
//
// Same answers as csv-reader on every input: the same records, the same
// {columns, rows, errors}. The reference reads one character at a time and
// builds every field a character at a time; this one finds each field's end
// with indexOf and takes whole runs with slice, so a plain field costs one
// slice instead of one step per character. Quoted fields take the same
// shortcut: the run between quotes is sliced whole unless it holds a line
// break (counted, and turned into LF) or a doubled quote.
//
// Pure: no clock, no randomness, no locale, nothing kept from one call to
// the next. Dependency-free ES module; run(input) is the whole surface.

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** The next comma, CR or LF: one scan instead of three indexOf calls. */
const DELIM = /[,\r\n]/g;
/** The next CR or LF inside a quoted run. */
const BREAK = /[\r\n]/g;

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const len = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0;
  let line = 1;
  if (text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it
  // takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  // The field just read, shared so no per-field object is allocated.
  let fieldValue = '';
  let fieldEnded = END;
  let fieldAdded = 0;

  function pushError(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // Reads an unquoted field starting at pos onto `value`: up to the next
  // comma or line break; a CR not followed by LF is dropped (stray_cr).
  // Sets fieldValue/fieldEnded/fieldAdded; `added` counts the characters kept.
  function readUnquoted(value) {
    let added = 0;
    let start = pos;
    for (;;) {
      DELIM.lastIndex = pos;
      const hit = DELIM.exec(text);
      if (hit === null) {
        if (start < len) { value += text.slice(start, len); added += len - start; }
        pos = len;
        fieldValue = value;
        fieldEnded = END;
        fieldAdded = added;
        return;
      }
      const m = hit.index;
      const ch = hit[0];
      if (ch === ',') {
        value += text.slice(start, m);
        added += m - start;
        pos = m + 1;
        fieldValue = value;
        fieldEnded = COMMA;
        fieldAdded = added;
        return;
      }
      if (ch === '\n') {
        value += text.slice(start, m);
        added += m - start;
        pos = m + 1;
        line += 1;
        fieldValue = value;
        fieldEnded = LINE_BREAK;
        fieldAdded = added;
        return;
      }
      if (text.charCodeAt(m + 1) === 10) {
        value += text.slice(start, m);
        added += m - start;
        pos = m + 2;
        line += 1;
        fieldValue = value;
        fieldEnded = LINE_BREAK;
        fieldAdded = added;
        return;
      }
      pushError('stray_cr');
      value += text.slice(start, m);
      added += m - start;
      pos = m + 1;
      start = pos;
    }
  }

  // Appends text[a, b) as quoted-field content: each CRLF or lone CR in it
  // is one LF, and every line break is counted.
  function appendQuoted(value, a, b) {
    BREAK.lastIndex = a;
    const hit = BREAK.exec(text);
    if (hit === null || hit.index >= b) return value + text.slice(a, b);
    let out = value;
    let s = a;
    while (s < b) {
      BREAK.lastIndex = s;
      const hit = BREAK.exec(text);
      if (hit === null || hit.index >= b) {
        out += text.slice(s, b);
        break;
      }
      const m = hit.index;
      const isCr = hit[0] === '\r';
      out += text.slice(s, m);
      out += '\n';
      line += 1;
      s = isCr && text.charCodeAt(m + 1) === 10 ? m + 2 : m + 1;
    }
    return out;
  }

  // Reads a quoted field whose opening quote is at pos. Sets
  // fieldValue/fieldEnded (fieldAdded is the junk scan's, when there is one).
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let value = '';
    let segStart = pos + 1;
    let p = pos + 1;
    for (;;) {
      const q = text.indexOf('"', p);
      if (q === -1) {
        // The quote never closes: it is a literal character, and the text
        // after it is read again as unquoted.
        pos = open + 1;
        line = openLine;
        pushError('unterminated_quote');
        readUnquoted('"');
        return;
      }
      if (text.charCodeAt(q + 1) === 34) {
        value = appendQuoted(value, segStart, q);
        value += '"';
        p = q + 2;
        segStart = q + 2;
        continue;
      }
      value = appendQuoted(value, segStart, q);
      pos = q + 1;
      if (pos >= len) {
        fieldValue = value;
        fieldEnded = END;
        fieldAdded = 0;
        return;
      }
      const ch = text.charCodeAt(pos);
      if (ch === 44) {
        pos += 1;
        fieldValue = value;
        fieldEnded = COMMA;
        fieldAdded = 0;
        return;
      }
      if (ch === 10) {
        pos += 1;
        line += 1;
        fieldValue = value;
        fieldEnded = LINE_BREAK;
        fieldAdded = 0;
        return;
      }
      if (ch === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
        fieldValue = value;
        fieldEnded = LINE_BREAK;
        fieldAdded = 0;
        return;
      }
      // What follows the closing quote is appended as it stands, up to the
      // next comma or line break.
      readUnquoted(value);
      if (fieldAdded > 0) pushError('quote_junk');
      return;
    }
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let quoted;
    do {
      quoted = text.charCodeAt(pos) === 34;
      if (quoted) readQuoted();
      else readUnquoted('');
      fields.push(fieldValue);
    } while (fieldEnded === COMMA);

    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
