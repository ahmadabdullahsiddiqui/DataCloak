/* DataCloak â€” PII detection & replacement engine.
 *
 * Pure functions only: no DOM, no I/O, no network. This module runs inside the
 * Web Worker AND is imported directly by the Node test suite, so it must stay
 * environment-agnostic.
 *
 * A "finding" is { type, value, start, end } where [start, end) are offsets into
 * the analysed text. Detection is deterministic (regex + checksums +
 * dictionaries) â€” never an external AI.
 */

/* ------------------------------------------------------------------ */
/* Validators                                                          */
/* ------------------------------------------------------------------ */

// IBAN mod-97 check (ISO 13616). Returns true only for a valid checksum.
export function validateIBAN(raw) {
  const s = raw.replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(s)) return false;
  const rearranged = s.slice(4) + s.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const code = ch >= 'A' && ch <= 'Z' ? (ch.charCodeAt(0) - 55).toString() : ch;
    for (const d of code) remainder = (remainder * 10 + (d.charCodeAt(0) - 48)) % 97;
  }
  return remainder === 1;
}

// German tax ID (Steuer-IdNr): 11 digits with a check digit (ISO 7064 style,
// modulo 11/10). Also requires the "exactly one digit repeats" property of the
// first 10 digits, which the issuing scheme guarantees.
export function validateSteuerId(raw) {
  const d = raw.replace(/\s+/g, '');
  if (!/^\d{11}$/.test(d)) return false;

  const first10 = d.slice(0, 10).split('').map(Number);
  const counts = {};
  for (const n of first10) counts[n] = (counts[n] || 0) + 1;
  const repeated = Object.values(counts).filter((c) => c >= 2).length;
  const tripled = Object.values(counts).some((c) => c >= 3);
  if (repeated !== 1 || tripled) return false;

  let product = 10;
  for (let i = 0; i < 10; i++) {
    let sum = (first10[i] + product) % 10;
    if (sum === 0) sum = 10;
    product = (sum * 2) % 11;
  }
  let check = 11 - product;
  if (check === 10) check = 0;
  return check === Number(d[10]);
}

/* ------------------------------------------------------------------ */
/* Name dictionary (heuristic; the human review step is the real gate) */
/* ------------------------------------------------------------------ */

const FIRST_NAMES = new Set([
  'ahmad', 'ahmed', 'ali', 'anna', 'andreas', 'anja', 'bernd', 'birgit',
  'christian', 'christina', 'claudia', 'daniel', 'david', 'dieter', 'elena',
  'emma', 'fatima', 'felix', 'frank', 'franziska', 'georg', 'hans', 'hanna',
  'heike', 'helmut', 'ingrid', 'jan', 'jana', 'jens', 'johannes', 'julia',
  'jÃ¼rgen', 'jurgen', 'karin', 'karl', 'katrin', 'klaus', 'lars', 'laura',
  'lena', 'lisa', 'lukas', 'manfred', 'maria', 'markus', 'martin', 'max',
  'michael', 'monika', 'nadine', 'nico', 'nina', 'oliver', 'omar', 'paul',
  'peter', 'petra', 'phillip', 'philipp', 'rainer', 'ralf', 'renate', 'robert',
  'sabine', 'sara', 'sarah', 'sebastian', 'simon', 'sofia', 'sophie', 'stefan',
  'stephan', 'susanne', 'thomas', 'tim', 'tobias', 'ulrich', 'ursula', 'uwe',
  'vanessa', 'wolfgang', 'yusuf',
]);

/* ------------------------------------------------------------------ */
/* Detector definitions                                                */
/* ------------------------------------------------------------------ */
/*
 * Each detector:
 *   type    â€” stable key
 *   label   â€” human label (UI)
 *   token   â€” anonymisation token, e.g. "[EMAIL]"
 *   prefix  â€” pseudonym prefix, e.g. "email"  (email is special-cased)
 *   regex   â€” global regex; matched text is the value unless `group` is set
 *   group   â€” capture-group index whose text is the value (optional)
 *   validate(value) â€” optional; return false to reject a match
 */
export const DETECTORS = [
  {
    type: 'email',
    label: 'E-Mail',
    token: '[EMAIL]',
    prefix: 'email',
    regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  },
  {
    type: 'url',
    label: 'URL',
    token: '[URL]',
    prefix: 'url',
    regex: /\bhttps?:\/\/[^\s<>"'()]+/g,
  },
  {
    type: 'iban',
    label: 'IBAN',
    token: '[IBAN]',
    prefix: 'IBAN',
    regex: /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]){11,30}\b/g,
    validate: validateIBAN,
  },
  {
    type: 'bic',
    label: 'BIC',
    token: '[BIC]',
    prefix: 'BIC',
    // 6 letters (bank+country) + 2 alphanum (location) + optional 3 (branch).
    regex: /\b[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}(?:[A-Z0-9]{3})?\b/g,
  },
  {
    type: 'ipv4',
    label: 'IP-Adresse',
    token: '[IP]',
    prefix: 'IP',
    // Any four dot-separated numeric groups of 1–4 digits, per requirement:
    // matches XX.XX.XX.XX, x.x.x.x, xxx.xxx.xxx.xxx, xxxx.xxxx.xxxx.xxxx —
    // not just strictly valid 0–255 octets.
    regex: /\b\d{1,4}\.\d{1,4}\.\d{1,4}\.\d{1,4}\b/g,
  },
  {
    type: 'ipv6',
    label: 'IP-Adresse',
    token: '[IP]',
    prefix: 'IP',
    regex: /\b(?:[A-Fa-f0-9]{1,4}:){2,7}[A-Fa-f0-9]{1,4}\b/g,
    // Reject times like "10:27:24": a real (uncompressed) IPv6 has 8 groups, a
    // compressed one contains "::", and hex forms contain a–f letters. A short,
    // all-decimal, colon-separated run is a clock/duration, not an address.
    validate: (v) => {
      if (v.includes('::')) return true;
      if (/[A-Fa-f]/.test(v)) return true;
      return v.split(':').length === 8;
    },
  },
  {
    type: 'steuerid',
    label: 'Steuer-IdNr',
    token: '[STEUER-ID]',
    prefix: 'SteuerID',
    regex: /\b\d{2}[ ]?\d{3}[ ]?\d{3}[ ]?\d{3}\b/g,
    validate: validateSteuerId,
  },
  {
    type: 'kfz',
    label: 'Kfz-Kennzeichen',
    token: '[KENNZEICHEN]',
    prefix: 'Kennzeichen',
    regex: /\b[A-ZÃ„Ã–Ãœ]{1,3}-[A-ZÃ„Ã–Ãœ]{1,2}[ ]?\d{1,4}[EH]?\b/g,
  },
  {
    type: 'phone',
    label: 'Telefon',
    token: '[TELEFON]',
    prefix: 'Telefon',
    // +49.., 0049.., or 0.. with common separators; validated by digit count.
    regex: /(?:\+49|0049|0)[\d\s\-/().]{6,20}\d/g,
    validate: (v) => {
      const digits = v.replace(/\D/g, '');
      return digits.length >= 7 && digits.length <= 15;
    },
  },
  {
    type: 'date',
    label: 'Datum',
    token: '[DATUM]',
    prefix: 'Datum',
    regex: /\b(?:(?:0?[1-9]|[12]\d|3[01])[.\/](?:0?[1-9]|1[0-2])[.\/](?:19|20)\d{2}|(?:19|20)\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01]))\b/g,
  },
  {
    type: 'plz',
    label: 'PLZ',
    token: '[PLZ]',
    prefix: 'PLZ',
    // 5 digits followed by a capitalised city token â€” reduces clash with IDs.
    regex: /\b\d{5}(?=\s+[A-ZÃ„Ã–Ãœ][a-zÃ¤Ã¶Ã¼ÃŸ]+)/g,
  },
  {
    type: 'customerid',
    label: 'Kundennummer',
    token: '[KUNDENNR]',
    prefix: 'Kundennr',
    regex: /\b(?:Kundennummer|Kundennr\.?|Kd-?Nr\.?)[:\s]*([A-Z0-9][A-Z0-9-]{2,})/gi,
    group: 1,
  },
  {
    type: 'personnelid',
    label: 'Personalnummer',
    token: '[PERSONALNR]',
    prefix: 'Personalnr',
    regex: /\b(?:Personalnummer|Personalnr\.?|Pers-?Nr\.?)[:\s]*([A-Z0-9][A-Z0-9-]{2,})/gi,
    group: 1,
  },
  {
    type: 'userid',
    label: 'Benutzerkennung',
    token: '[BENUTZER]',
    prefix: 'Benutzer',
    regex: /\b(?:Benutzerkennung|Benutzer(?:name)?|User(?:name|-?ID)?|Login)[:\s]*([A-Za-z0-9][A-Za-z0-9._-]{2,})/gi,
    group: 1,
  },
  {
    type: 'person',
    label: 'Person',
    token: '[PERSON]',
    prefix: 'Person',
    // Firstname (from dictionary) + capitalised Lastname. Scanner-based so a
    // leading non-name capitalised word (e.g. "Kontakt Ahmad â€¦") can't consume
    // the real first name the way a single greedy regex match would.
    find: findPersonNames,
  },
];

// Tokenise into words (letters, optionally hyphenated) with offsets, then emit
// "Firstname Lastname" where Firstname is a known first name, both tokens are
// capitalised, and only whitespace separates them.
function findPersonNames(text) {
  const out = [];
  const re = /\p{L}+(?:-\p{L}+)*/gu;
  const toks = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    toks.push({ value: m[0], start: m.index, end: m.index + m[0].length });
  }
  const isUpper = (w) => w[0] !== w[0].toLowerCase();
  for (let i = 0; i < toks.length - 1; i++) {
    const a = toks[i];
    const b = toks[i + 1];
    if (!isUpper(a.value) || !isUpper(b.value)) continue;
    if (!FIRST_NAMES.has(a.value.toLowerCase())) continue;
    if (!/^[ \t]+$/.test(text.slice(a.end, b.start))) continue; // same line, no punctuation/newline
    out.push({ value: text.slice(a.start, b.end), start: a.start, end: b.end });
  }
  return out;
}

const DETECTOR_BY_TYPE = new Map(DETECTORS.map((d) => [d.type, d]));

/* ------------------------------------------------------------------ */
/* Detection                                                           */
/* ------------------------------------------------------------------ */

// Compute the value's [start,end) for a match, honouring an optional group.
function locate(match, detector) {
  if (detector.group == null) {
    return { value: match[0], start: match.index, end: match.index + match[0].length };
  }
  const value = match[detector.group];
  if (value == null) return null;
  const rel = match[0].indexOf(value);
  const start = match.index + (rel < 0 ? 0 : rel);
  return { value, start, end: start + value.length };
}

/*
 * detect(text, options)
 *   options.enabledTypes â€” optional Set/array of type keys to run (default: all)
 *   options.customRules  â€” optional [{type,label,pattern,flags?}] user regexes
 * Returns non-overlapping findings sorted by start offset.
 */
export function detect(text, options = {}) {
  if (typeof text !== 'string' || text.length === 0) return [];

  const enabled = options.enabledTypes
    ? new Set(options.enabledTypes)
    : null;

  const detectors = [...DETECTORS];
  if (Array.isArray(options.customRules)) {
    for (const r of options.customRules) {
      let regex;
      try {
        regex = new RegExp(r.pattern, (r.flags || '').includes('g') ? r.flags : (r.flags || '') + 'g');
      } catch {
        continue; // ignore invalid user pattern
      }
      detectors.push({
        type: r.type || 'custom',
        label: r.label || r.type || 'Custom',
        token: r.token || `[${(r.label || r.type || 'CUSTOM').toUpperCase()}]`,
        prefix: r.prefix || r.type || 'ID',
        regex,
      });
    }
  }

  const raw = [];
  for (const det of detectors) {
    if (enabled && !enabled.has(det.type)) continue;

    if (typeof det.find === 'function') {
      for (const loc of det.find(text)) {
        if (loc.value === '') continue;
        if (det.validate && !det.validate(loc.value)) continue;
        raw.push({ type: det.type, value: loc.value, start: loc.start, end: loc.end });
      }
      continue;
    }

    const re = new RegExp(det.regex.source, det.regex.flags.includes('g') ? det.regex.flags : det.regex.flags + 'g');
    let m;
    let guard = 0;
    while ((m = re.exec(text)) !== null) {
      if (m.index === re.lastIndex) re.lastIndex++; // zero-width guard
      if (++guard > 1_000_000) break;
      const loc = locate(m, det);
      if (!loc || loc.value === '') continue;
      if (det.validate && !det.validate(loc.value)) continue;
      raw.push({ type: det.type, value: loc.value, start: loc.start, end: loc.end });
    }
  }

  return dedupeOverlaps(raw);
}

// Longer, earlier matches win. Structured types beat name/date on ties via length.
function dedupeOverlaps(findings) {
  findings.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
  const kept = [];
  let lastEnd = -1;
  for (const f of findings) {
    if (f.start >= lastEnd) {
      kept.push(f);
      lastEnd = f.end;
    }
  }
  return kept;
}

/* ------------------------------------------------------------------ */
/* Aggregation â†’ replacement table                                     */
/* ------------------------------------------------------------------ */

function pad(n) {
  return String(n).padStart(3, '0');
}

function pseudonym(detector, index) {
  if (detector && detector.type === 'email') return `email-${pad(index)}@example.invalid`;
  const prefix = (detector && detector.prefix) || 'ID';
  return `${prefix}-${pad(index)}`;
}

function tokenFor(detector, type) {
  if (detector && detector.token) return detector.token;
  return `[${String(type).toUpperCase()}]`;
}

/*
 * aggregate(findings, options) â†’ array of replacement rows:
 *   { type, label, value, replacement, count, active }
 * mode: 'anonymize' (default) | 'pseudonymize'
 * Identical values within a document always get the same replacement.
 */
export function aggregate(findings, options = {}) {
  const mode = options.mode === 'pseudonymize' ? 'pseudonymize' : 'anonymize';
  const rows = new Map(); // key `${type} ${value}` -> row
  const perTypeCounter = new Map();

  for (const f of findings) {
    const key = keyOf(f.type, f.value);
    let row = rows.get(key);
    if (!row) {
      const det = DETECTOR_BY_TYPE.get(f.type);
      let replacement;
      if (mode === 'anonymize') {
        replacement = tokenFor(det, f.type);
      } else {
        const n = (perTypeCounter.get(f.type) || 0) + 1;
        perTypeCounter.set(f.type, n);
        replacement = pseudonym(det, n);
      }
      row = {
        type: f.type,
        label: det ? det.label : f.type,
        value: f.value,
        replacement,
        count: 0,
        active: true,
      };
      rows.set(key, row);
    }
    row.count++;
  }

  return [...rows.values()];
}

/* ------------------------------------------------------------------ */
/* Applying replacements                                               */
/* ------------------------------------------------------------------ */

// The single source of truth for the replacement-map key. Everything that
// builds or reads the map (aggregate, applyReplacements, the worker, docx) MUST
// use this so keys can never diverge between producer and consumer.
export function keyOf(type, value) {
  return type + ' ' + value; // real space; type slugs never contain spaces
}

/*
 * applyReplacements(text, findings, rowsByKey)
 *   rowsByKey: Map or plain object keyed by keyOf(type, value) -> { replacement, active }
 * Applies right-to-left so offsets stay valid as lengths change.
 */
export function applyReplacements(text, findings, rowsByKey) {
  const get = (k) =>
    typeof rowsByKey.get === 'function' ? rowsByKey.get(k) : rowsByKey[k];

  // Single left-to-right pass: collect the untouched gaps and replacements, then
  // join once. O(text + findings) instead of O(findings × text) from repeated
  // slicing — essential for large documents. Findings are non-overlapping.
  const ordered = [...findings].sort((a, b) => a.start - b.start);
  const out = [];
  let pos = 0;
  for (const f of ordered) {
    if (f.start < pos) continue; // safety: skip any overlap
    const row = get(keyOf(f.type, f.value));
    if (!row || row.active === false) continue;
    out.push(text.slice(pos, f.start), row.replacement);
    pos = f.end;
  }
  out.push(text.slice(pos));
  return out.join('');
}

// Convenience for the common flow: detect â†’ aggregate â†’ apply, returning both
// the new text and the replacement rows.
export function process(text, options = {}) {
  const findings = detect(text, options);
  const rows = aggregate(findings, options);
  const byKey = new Map(rows.map((r) => [keyOf(r.type, r.value), r]));
  const output = applyReplacements(text, findings, byKey);
  return { findings, rows, output };
}
