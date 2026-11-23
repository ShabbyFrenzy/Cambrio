const test = require('node:test');
const assert = require('node:assert');
const { Matchmaker } = require('../server/matchmaking');

function setup(opts = {}) {
  let t = 0;
  const matches = [], timeouts = [], status = {};
  const mm = new Matchmaker({
    now: () => t,
    onMatch: (p) => matches.push(p.map((x) => x.id)),
    onTimeout: (p) => timeouts.push(p.id),
    onStatus: (id, s) => (status[id] = s),
    ...opts,
  });
  return { mm, matches, timeouts, status, advance: (sec) => { t += sec * 1000; mm.tick(); } };
}

test('4 players make a game straight away', () => {
  const { mm, matches } = setup();
  ['a', 'b', 'c'].forEach((id) => mm.join(id));
  assert.equal(matches.length, 0);
  mm.join('d');
  assert.deepEqual(matches, [['a', 'b', 'c', 'd']]);
  assert.equal(mm.queue.length, 0);
});

test('a lone player is never matched with nobody', () => {
  const { mm, matches, advance } = setup();
  mm.join('a');
  advance(100);
  assert.equal(matches.length, 0);
});

test('3 players start after 20s, 2 after 45s', () => {
  const { mm, matches, advance } = setup();
  mm.join('a'); mm.join('b'); mm.join('c');
  advance(19);
  assert.equal(matches.length, 0);
  advance(1);
  assert.deepEqual(matches, [['a', 'b', 'c']]);

  mm.join('x'); mm.join('y');
  advance(44);
  assert.equal(matches.length, 1);
  advance(1);
  assert.deepEqual(matches[1], ['x', 'y']);
});

test('9 players at once make two games of 4 and keep 1 waiting', () => {
  const { mm, matches } = setup();
  for (let i = 0; i < 9; i++) mm.join('p' + i);
  assert.equal(matches.length, 2);
  assert.deepEqual(mm.queue.map((p) => p.id), ['p8']);
});

test('joining twice is ignored and leaving removes the player', () => {
  const { mm, matches, status } = setup();
  assert.equal(mm.join('a'), true);
  assert.equal(mm.join('a'), false);
  mm.join('b');
  assert.equal(status.b.position, 2);
  mm.leave('a');
  assert.equal(status.b.position, 1);
  mm.join('c'); mm.join('d');
  assert.equal(matches.length, 0); // only 3 left
});

test('players time out after 120s alone', () => {
  const { mm, timeouts, advance } = setup();
  mm.join('a');
  advance(119);
  assert.deepEqual(timeouts, []);
  advance(1);
  assert.deepEqual(timeouts, ['a']);
  assert.equal(mm.queue.length, 0);
});

test('if creating the room fails, players keep their place', () => {
  let fail = true;
  const got = [];
  const mm = new Matchmaker({
    now: () => 0,
    onMatch: (p) => { if (fail) throw new Error('boom'); got.push(p.length); },
  });
  const err = console.error; console.error = () => {};
  ['a', 'b', 'c', 'd'].forEach((id) => mm.join(id));
  console.error = err;
  assert.deepEqual(mm.queue.map((p) => p.id), ['a', 'b', 'c', 'd']);
  fail = false;
  mm.tick();
  assert.deepEqual(got, [4]);
});
