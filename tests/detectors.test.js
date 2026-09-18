import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detect, aggregate, applyReplacements, process,
  validateIBAN, validateSteuerId,
} from '../docs/detectors.js';

const types = (t, opts) => detect(t, opts).map((f) => f.type);
const values = (t, opts) => detect(t, opts).map((f) => f.value);

test('email detection', () => {
  assert.deepEqual(values('Mail: ahmad@example.de bitte'), ['ahmad@example.de']);
});

test('IBAN valid vs invalid checksum', () => {
  assert.ok(validateIBAN('DE89370400440532013000'));
  assert.ok(!validateIBAN('DE00370400440532013000'));
  assert.deepEqual(values('Konto DE89370400440532013000 hier'), ['DE89370400440532013000']);
  // invalid checksum must not be reported as IBAN
  assert.ok(!types('Konto DE00370400440532013000 hier').includes('iban'));
});

test('BIC detection', () => {
  assert.ok(types('BIC: COBADEFFXXX').includes('bic'));
});

test('IPv4 detection with boundary validation', () => {
  assert.deepEqual(values('Server 192.168.0.1 down'), ['192.168.0.1']);
  assert.ok(!types('Version 999.1.1.1 here').includes('ipv4'));
});

test('German phone detection', () => {
  assert.ok(types('Tel: +49 30 1234567').includes('phone'));
  assert.ok(types('Mobil 0170 1234567').includes('phone'));
});

test('date detection (dd.mm.yyyy and ISO)', () => {
  assert.ok(values('geboren am 12.03.1985').includes('12.03.1985'));
  assert.ok(values('Datum 1985-03-12 ok').includes('1985-03-12'));
});

test('postcode only when followed by a city', () => {
  assert.ok(values('10115 Berlin').includes('10115'));
  // a bare 5-digit id without a city should not match as PLZ
  assert.ok(!types('Nummer 10115 ohne Stadt').includes('plz'));
});

test('German tax id checksum', () => {
  assert.ok(validateSteuerId('86095742719'));
  assert.ok(!validateSteuerId('11111111111'));
});

test('Kfz plate detection', () => {
  assert.ok(values('Fahrzeug M-AB 123 gesehen').some((v) => v.startsWith('M-AB')));
});

test('context ids: customer / personnel / user', () => {
  assert.ok(values('Kundennummer: KD-12345').includes('KD-12345'));
  assert.ok(values('Personalnr. 987654').includes('987654'));
  assert.ok(values('Benutzer: j.doe_01').includes('j.doe_01'));
});

test('person name via dictionary heuristic', () => {
  assert.ok(values('Kontakt Ahmad Abdullah heute').includes('Ahmad Abdullah'));
  assert.ok(values('Herr Max Mustermann kam').includes('Max Mustermann'));
  // unknown first name should not trigger a person match
  assert.ok(!types('Xyz Qwerty war da').includes('person'));
});

test('umlauts and unicode survive', () => {
  const t = 'Frau Sabine Müller-Groß, Grüße';
  assert.ok(values(t).some((v) => v.includes('Müller')));
});

test('anonymize replaces with tokens and removes originals', () => {
  const t = 'Ahmad Abdullah, ahmad@example.de, DE89370400440532013000';
  const { output } = process(t, { mode: 'anonymize' });
  assert.ok(output.includes('[PERSON]'));
  assert.ok(output.includes('[EMAIL]'));
  assert.ok(output.includes('[IBAN]'));
  assert.ok(!output.includes('ahmad@example.de'));
  assert.ok(!output.includes('DE89370400440532013000'));
});

test('pseudonymize is stable per value', () => {
  const t = 'Ahmad Abdullah und Ahmad Abdullah, dann Max Mustermann. ' +
            'Mail a@example.de zweimal: a@example.de';
  const { rows, output } = process(t, { mode: 'pseudonymize' });
  const person = rows.filter((r) => r.type === 'person');
  assert.equal(person.length, 2);
  assert.ok(person.find((r) => r.value === 'Ahmad Abdullah').replacement === 'Person-001');
  assert.ok(person.find((r) => r.value === 'Max Mustermann').replacement === 'Person-002');
  // same email twice → one row, count 2, one alias applied both times
  const email = rows.find((r) => r.type === 'email');
  assert.equal(email.count, 2);
  assert.equal(output.match(/email-001@example\.invalid/g).length, 2);
});

test('deactivated rows are left untouched', () => {
  const t = 'Mail ahmad@example.de bleibt.';
  const findings = detect(t);
  const rows = aggregate(findings, { mode: 'anonymize' });
  rows.forEach((r) => { r.active = false; });
  const byKey = new Map(rows.map((r) => [`${r.type} ${r.value}`, r]));
  assert.equal(applyReplacements(t, findings, byKey), t);
});

test('overlapping matches are de-duplicated (no double replacement)', () => {
  const t = 'DE89370400440532013000';
  const findings = detect(t);
  // offsets must be non-overlapping
  for (let i = 1; i < findings.length; i++) {
    assert.ok(findings[i].start >= findings[i - 1].end);
  }
});

test('custom user regex rule', () => {
  const t = 'Vertrag ABC-2024-0001 gültig';
  const out = detect(t, { customRules: [{ type: 'contract', label: 'Vertrag', pattern: 'ABC-\\d{4}-\\d{4}' }] });
  assert.ok(out.some((f) => f.type === 'contract' && f.value === 'ABC-2024-0001'));
});

test('empty / non-string input is safe', () => {
  assert.deepEqual(detect(''), []);
  assert.deepEqual(detect(null), []);
  assert.deepEqual(detect(undefined), []);
});
