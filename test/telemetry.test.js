import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLapTime, fmtLap, fmtDelta, fitMarkers, fitRatio, stateAt, bestOf, moveMarker } from '../public/telemetry/laps.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, a + ' ≈ ' + b);

test('время круга читается и пишется как на сайте хронометража', () => {
  assert.equal(parseLapTime('37.322'), 37.322);
  near(parseLapTime('1:09.311'), 69.311);
  assert.equal(parseLapTime('37,5'), 37.5);
  assert.ok(Number.isNaN(parseLapTime('P2')));
  assert.equal(fmtLap(37.322), '37.322');
  assert.equal(fmtLap(69.311), '1:09.311');
  assert.equal(fmtLap(5.04, 2), '5.04');
  // Бегущее время не округляется вверх.
  assert.equal(fmtLap(36.999, 2), '36.99');
  assert.equal(fmtLap(61.5, 2), '1:01.50');
  assert.equal(fmtDelta(0.4), '+0.400');
  assert.equal(fmtDelta(-0.12), '−0.120');
});

test('метки расставляются между стартом и финишем пропорционально кругам', () => {
  const laps = [{ t: 40 }, { t: 38 }, { t: 42 }];
  const m = fitMarkers(laps, 10, 10 + 120 * 1.01);
  assert.equal(m.length, 4);
  assert.equal(m[0], 10);
  near(m[1], 10 + 40 * 1.01);
  near(m[2], 10 + 78 * 1.01);
  near(m[3], 10 + 121.2);
  near(fitRatio(laps, m), 1.01);
  // Без финиша — по сумме кругов.
  const m2 = fitMarkers(laps, 5, NaN);
  near(m2[3], 125);
});

test('состояние в момент видео: текущий, последний и лучший круг', () => {
  const laps = [{ t: 40, pos: 3 }, { t: 38, pos: 2 }, { t: 39, pos: 2 }];
  // Видео идёт вдвое медленнее хронометража — бегущее время всё равно доходит ровно до времени круга.
  const m = fitMarkers(laps, 100, 100 + 117 * 2);
  assert.equal(stateAt(50, laps, m).phase, 'pre');
  const a = stateAt(100 + 40, laps, m); // середина первого круга
  assert.equal(a.phase, 'lap');
  assert.equal(a.lap, 0);
  near(a.current, 20);
  assert.equal(a.last, null);
  assert.equal(a.best, null);
  const b = stateAt(m[1] + 1, laps, m);
  assert.equal(b.lap, 1);
  assert.equal(b.last.t, 40);
  assert.equal(b.last.isBest, true);
  assert.equal(b.last.pos, 3);
  assert.deepEqual(b.best, { t: 40, i: 0 });
  const c = stateAt(m[2] + 0.5, laps, m);
  assert.equal(c.last.t, 38);
  assert.equal(c.last.isBest, true);
  near(c.last.delta, -2);
  const d = stateAt(m[3] + 5, laps, m);
  assert.equal(d.phase, 'done');
  assert.equal(d.last.t, 39);
  assert.equal(d.last.isBest, false);
  near(d.last.delta, 1);
  assert.deepEqual(d.best, { t: 38, i: 1 });
  // Итоговый лучший виден с самого начала.
  assert.deepEqual(stateAt(50, laps, m, { final: true }).best, { t: 38, i: 1 });
});

test('выключенный круг не становится лучшим', () => {
  const laps = [{ t: 40 }, { t: 30, on: false }, { t: 39 }];
  assert.deepEqual(bestOf(laps), { t: 39, i: 2 });
  const m = fitMarkers(laps, 0, NaN);
  const s = stateAt(m[2] + 0.1, laps, m);
  assert.equal(s.last.isBest, false);
  assert.ok(Number.isNaN(s.last.delta));
});

test('метку нельзя перетащить за соседнюю', () => {
  const m = [0, 10, 20, 30];
  assert.deepEqual(moveMarker(m, 1, 25), [0, 19.8, 20, 30]);
  assert.deepEqual(moveMarker(m, 2, 12), [0, 10, 12, 30]);
});
