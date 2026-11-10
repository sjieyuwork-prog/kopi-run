import assert from 'node:assert/strict';
import test from 'node:test';
import { drinkName, validateDrink, withBase } from '../public/menu.js';

const name = (order) => drinkName(validateDrink(order));

test('names follow kopitiam word order', () => {
  assert.equal(name({ base: 'kopi' }), 'Kopi');
  assert.equal(name({ base: 'kopi', milk: 'o', sugar: 'kosong', temp: 'peng' }), 'Kopi O Kosong Peng');
  assert.equal(name({ base: 'kopi', milk: 'c', sugar: 'siu-dai' }), 'Kopi C Siu Dai');
  assert.equal(name({ base: 'kopi', milk: 'o', sugar: 'kosong', strength: 'gao' }), 'Kopi O Kosong Gao');
  assert.equal(name({ base: 'teh', milk: 'c', sugar: 'ga-dai', strength: 'po', temp: 'peng' }), 'Teh C Ga Dai Po Peng');
  assert.equal(name({ base: 'yuan-yang', temp: 'peng' }), 'Yuan Yang Peng');
});

test('the milk word goes inside Teh Halia', () => {
  assert.equal(name({ base: 'teh-halia' }), 'Teh Halia');
  assert.equal(name({ base: 'teh-halia', milk: 'o', sugar: 'kosong' }), 'Teh O Halia Kosong');
});

test('drinks only accept the options they offer', () => {
  assert.equal(validateDrink({ base: 'latte' }), null);
  assert.equal(validateDrink({ base: 'kopi', milk: 'oat' }), null);
  assert.equal(validateDrink({ base: 'milo', sugar: 'ga-dai' }), null);
  assert.deepEqual(validateDrink({ base: 'diao-yu', milk: 'c', temp: 'peng' }), { base: 'diao-yu', temp: 'peng' });
  assert.equal(validateDrink(null), null);
});

test('switching drink keeps the choices the new drink also offers', () => {
  const kopi = validateDrink({ base: 'kopi', milk: 'o', sugar: 'ga-dai', strength: 'di-lo', temp: 'peng' });
  assert.deepEqual(withBase(kopi, 'milo'), { base: 'milo', sugar: 'normal', strength: 'normal', temp: 'peng' });
  assert.deepEqual(withBase(kopi, 'teh'), { ...kopi, base: 'teh' });
});
