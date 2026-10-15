'use strict';
/* ==========================================================================
   Pruebas de los generadores pseudoaleatorios (js/prng.js)
   Ejecutar desde la carpeta del proyecto:   node tests/prng.test.js
   No necesita instalar nada: solo usa el módulo 'assert' de Node.
   ========================================================================== */
const assert = require('assert');
const PRNG = require('../js/prng.js');

const METHODS = Object.keys(PRNG.METHODS); // ['middle-square', 'lcg', 'middle-product']
let passed = 0, failed = 0;

function test(name, fn) {
  try { fn(); passed++; console.log(`  ✔ ${name}`); }
  catch (e) { failed++; console.log(`  ✘ ${name}\n      ${e.message}`); }
}
const take = (g, n) => Array.from({ length: n }, () => g.next());

console.log('\nPRUEBAS OBLIGATORIAS');

test('Interfaz común: los 3 métodos tienen next, nextInt, range, reset, name, seed', () => {
  for (const m of METHODS) {
    const g = PRNG.create(m, 1234);
    for (const f of ['next', 'nextInt', 'range', 'reset']) assert.strictEqual(typeof g[f], 'function', `${m}.${f}`);
    assert.ok(g.name && Number.isInteger(g.seed), m);
  }
});

test('Misma semilla → misma secuencia (1000 valores, cada método)', () => {
  for (const m of METHODS) {
    assert.deepStrictEqual(take(PRNG.create(m, 98765), 1000), take(PRNG.create(m, 98765), 1000), m);
  }
});

test('reset() vuelve a empezar la misma secuencia', () => {
  for (const m of METHODS) {
    const g = PRNG.create(m, 4321);
    const a = take(g, 300); g.reset();
    assert.deepStrictEqual(take(g, 300), a, m);
  }
});

test('Semillas distintas → secuencias distintas', () => {
  for (const m of METHODS) {
    assert.notDeepStrictEqual(take(PRNG.create(m, 1111), 50), take(PRNG.create(m, 2222), 50), m);
  }
});

test('Cuadrado medio, cálculo a mano: 5735² = 32|8902|25 → 0.8902', () => {
  const g = PRNG.create('middle-square', 5735);
  assert.strictEqual(g.next(), 0.8902);
  // 8902² = 79245604 → 79|2456|04 → 0.2456
  assert.strictEqual(g.next(), 0.2456);
});

test('Congruencial lineal, cálculo a mano: X0=0 → X1=c=1013904223; X2=(a·X1+c) mod 2^32', () => {
  const g = PRNG.create('lcg', 0);
  g.next();
  assert.strictEqual(g.x, 1013904223);
  g.next();
  const expected = Number((1664525n * 1013904223n + 1013904223n) % 4294967296n); // BigInt: aritmética exacta
  assert.strictEqual(g.x, expected);
});

test('Productos medios, cálculo a mano: 5015·5734 = 28|7560|10 → 0.7560', () => {
  const g = new PRNG.MiddleProduct(5015, { seed2: 5734 });
  assert.strictEqual(g.next(), 0.756);
  // 5734·7560 = 43349040 → 43|3490|40 → 0.3490
  assert.strictEqual(g.next(), 0.349);
});

test('Valores en rango: next() ∈ [0,1), nextInt(4) ∈ {0,1,2,3} y salen los 4, range(250,520) ∈ [250,520)', () => {
  for (const m of METHODS) {
    const g = PRNG.create(m, 2024);
    const seen = new Set();
    for (let i = 0; i < 20000; i++) {
      const u = g.next();
      assert.ok(u >= 0 && u < 1, `${m}: u=${u}`);
      const k = g.nextInt(4);
      assert.ok(Number.isInteger(k) && k >= 0 && k <= 3, `${m}: k=${k}`);
      seen.add(k);
      const r = g.range(250, 520);
      assert.ok(r >= 250 && r < 520, `${m}: r=${r}`);
    }
    assert.strictEqual(seen.size, 4, `${m}: no aparecieron los 4 carriles`);
  }
});

test('Puntos fijos del cuadrado medio (2500, 3792) se corrigen y la secuencia no queda constante', () => {
  for (const s of [2500, 3792]) {
    const pure = new PRNG.MiddleSquare(s, { pure: true });
    assert.strictEqual(new Set(take(pure, 20)).size, 1, `${s} debería ser punto fijo en el método puro`);
    const g = PRNG.create('middle-square', s);
    assert.ok(new Set(take(g, 200)).size > 20, `${s}: secuencia corregida demasiado repetitiva`);
    assert.ok(g.reseeds > 0, `${s}: no se registró la corrección`);
  }
});

test('Cuadrado medio y productos medios nunca devuelven 0 tras la corrección (5000 valores)', () => {
  for (const m of ['middle-square', 'middle-product']) {
    for (const s of [1, 10, 100, 1000, 9999, 123456789]) {
      const vals = take(PRNG.create(m, s), 5000);
      assert.ok(!vals.includes(0), `${m} semilla ${s}`);
    }
  }
});

test('Semillas normalizadas a 4 cifras en CM/PM (7 → 1007, 123456 → 3456)', () => {
  assert.strictEqual(PRNG.create('middle-square', 7).seed, 1007);
  assert.strictEqual(PRNG.create('middle-product', 123456).seed, 3456);
});

test('Validación de semillas del menú', () => {
  assert.strictEqual(PRNG.parseSeed('12345').value, 12345);
  assert.strictEqual(PRNG.parseSeed('  42 ').value, 42);
  for (const bad of ['abc', '-5', '1.5', '0', '1e3', '1234567890']) {
    assert.strictEqual(PRNG.parseSeed(bad).ok, false, `"${bad}" debería rechazarse`);
  }
  const auto = PRNG.parseSeed('', 1739999999123);
  assert.ok(auto.ok && auto.auto && auto.value === 999999123);
  assert.throws(() => PRNG.create('lcg', -1));
  assert.throws(() => PRNG.create('lcg', 1.5));
  assert.throws(() => PRNG.create('otro', 1));
});

test('Cambiar de método con la misma semilla cambia la secuencia de carriles', () => {
  const lanes = (m) => { const g = PRNG.create(m, 12345); return Array.from({ length: 30 }, () => g.nextInt(4)).join(''); };
  const [a, b, c] = METHODS.map(lanes);
  assert.ok(a !== b && b !== c && a !== c, `${a}\n${b}\n${c}`);
});

/* -------------------------------------------------------------------------- */
console.log('\nDATOS INFORMATIVOS (describen el comportamiento; no prueban calidad)');

/** Longitud de la cola (pasos antes de entrar al ciclo) y del ciclo en el método puro. */
function cycle(g, stateOf, max = 200000) {
  const first = new Map();
  for (let i = 0; i < max; i++) {
    const s = stateOf(g);
    if (first.has(s)) return { tail: first.get(s), period: i - first.get(s) };
    first.set(s, i);
    g.next();
  }
  return { tail: max, period: '>' + max };
}
console.log('\n  Cuadrado medio PURO (sin corrección): pasos hasta repetir');
for (const s of [1234, 5735, 6239, 9876, 2500]) {
  const r = cycle(new PRNG.MiddleSquare(s, { pure: true }), (g) => g.x);
  console.log(`    semilla ${s}: cola ${r.tail}, ciclo de longitud ${r.period}`);
}
console.log('  Productos medios PURO: pasos hasta repetir el par de estado');
for (const s of [1234, 5735, 6239, 9876]) {
  const r = cycle(new PRNG.MiddleProduct(s, { pure: true }), (g) => g.a * 10000 + g.b);
  console.log(`    semilla ${s}: cola ${r.tail}, ciclo de longitud ${r.period}`);
}
console.log('  Congruencial lineal: periodo teórico 2^32 = 4 294 967 296 (Hull–Dobell)');

console.log('\n  Frecuencia de carriles nextInt(4): 10 000 valores por semilla (esperado 2500 por carril)');
console.log('  Prueba χ² con 3 g.l.; valor crítico al 5 % = 7.815. Con un generador uniforme se esperaría');
console.log('  que ~1 de cada 20 semillas lo supere por azar; muchas más indican sesgo.');
const SEEDS = Array.from({ length: 20 }, (_, i) => 1000 + i * 4111);
for (const m of METHODS) {
  let sum = 0, over = 0, reseeds = 0, ex = '';
  for (const s of SEEDS) {
    const g = PRNG.create(m, s), f = [0, 0, 0, 0];
    for (let i = 0; i < 10000; i++) f[g.nextInt(4)]++;
    const chi = f.reduce((acc, o) => acc + (o - 2500) ** 2 / 2500, 0);
    sum += chi; if (chi > 7.815) over++; reseeds += g.reseeds;
    if (s === SEEDS[0]) ex = `[${f.join(', ')}]`;
  }
  console.log(`    ${PRNG.create(m, 1).name.padEnd(20)} χ² medio = ${(sum / SEEDS.length).toFixed(2).padStart(6)}` +
    `  superan 7.815: ${String(over).padStart(2)}/20  correcciones medias = ${(reseeds / SEEDS.length).toFixed(0).padStart(3)}` +
    `  ej. semilla ${SEEDS[0]}: ${ex}`);
}

console.log(`\n${passed} pruebas superadas, ${failed} fallidas\n`);
process.exit(failed ? 1 : 0);
