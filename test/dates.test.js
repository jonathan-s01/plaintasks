'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseFriendly, findDateTokens, formatDate, relativeDue } = require('../src/dates');

const REF = new Date(2026, 10, 16); // Mon Nov 16 2026

test('parseFriendly handles ISO, weekdays, month names and relative forms', () => {
  assert.equal(parseFriendly('2026-11-20', REF), '2026-11-20');
  assert.equal(parseFriendly('fri', REF), '2026-11-20');
  assert.equal(parseFriendly('Monday', REF), '2026-11-16');
  assert.equal(parseFriendly('next mon', REF), '2026-11-23');
  assert.equal(parseFriendly('nov 20', REF), '2026-11-20');
  assert.equal(parseFriendly('20 Nov', REF), '2026-11-20');
  assert.equal(parseFriendly('jan 5', REF), '2027-01-05');
  assert.equal(parseFriendly('nov 20, 2027', REF), '2027-11-20');
  assert.equal(parseFriendly('+3d', REF), '2026-11-19');
  assert.equal(parseFriendly('in 2 weeks', REF), '2026-11-30');
  assert.equal(parseFriendly('tomorrow', REF), '2026-11-17');
});

test('parseFriendly rejects nonsense and impossible dates', () => {
  assert.equal(parseFriendly('2026-02-30', REF), null);
  assert.equal(parseFriendly('someday', REF), null);
  assert.equal(parseFriendly('', REF), null);
});

test('findDateTokens locates tokens and ignores unparseable ones', () => {
  const t = findDateTokens('call bob due:nov 20 done:2026-11-01 due:zzz', REF);
  assert.deepEqual(t.map((x) => [x.kind, x.iso]), [['due', '2026-11-20'], ['done', '2026-11-01']]);
  const one = findDateTokens('x due:fri 2 things', REF);
  assert.equal(one.length, 1);
  assert.equal(one[0].raw, 'fri');
});

test('formatDate and relativeDue are screen-reader friendly', () => {
  assert.equal(formatDate('2026-11-20', REF), 'Fri Nov 20');
  assert.equal(formatDate('2027-01-05', REF), 'Tue Jan 5 2027');
  assert.equal(relativeDue('2026-11-15', REF).text, 'overdue by 1 day');
  assert.equal(relativeDue('2026-11-16', REF).text, 'due today');
  assert.equal(relativeDue('2026-11-17', REF).text, 'due tomorrow');
  assert.equal(relativeDue('2026-11-20', REF).state, 'soon');
  assert.equal(relativeDue('2026-12-30', REF).state, 'later');
});
