'use strict';
/* ==========================================================================
   ROAD FIGHTER · Generadores de números pseudoaleatorios (PRNG) propios
   --------------------------------------------------------------------------
   Tres métodos implementados a mano, sin Math.random ni librerías:
   1. Cuadrado medio (von Neumann).
   2. Congruencial lineal mixto.
   3. Productos medios (variante del cuadrado medio con dos semillas).

   Todos comparten la misma interfaz, de modo que el juego no necesita saber
   qué método está usando:
     next()        -> número real u en [0, 1)
     nextInt(n)    -> entero en {0, 1, ..., n-1}
     range(a, b)   -> número real en [a, b)
     reset()       -> vuelve al estado inicial (misma semilla, misma secuencia)
     name, seed    -> nombre del método y semilla efectiva usada
     reseeds       -> veces que se tuvo que corregir una degeneración (ciclo/cero)

   Son PSEUDOaleatorios: cada valor se calcula con una fórmula a partir del
   anterior, así que la misma semilla produce siempre la misma secuencia.
   ========================================================================== */

const PRNG = (() => {
  /* ----------------------------------------------------------- Utilidades comunes */
  const D = 4;                 // Número de dígitos de estado en cuadrado medio y productos medios
  const MOD_D = 10 ** D;       // 10^4 = 10000 -> estados posibles 0..9999
  const MIN_D = 10 ** (D - 1); // 1000 -> mínimo para que la semilla tenga 4 cifras significativas
  const HALF = 10 ** (D / 2);  // 100 -> divisor para descartar las D/2 cifras de la derecha

  /**
   * Lleva un entero a exactamente D cifras significativas (rango [1000, 9999]).
   * Evita semillas como 0, 7 o 42, que en cuadrado medio degeneran a 0 en pocos pasos.
   * @param {number} v - Entero no negativo.
   * @returns {number}
   */
  function normalizeD(v) {
    v = Math.abs(Math.floor(v)) % MOD_D;
    if (v < MIN_D) v += MIN_D;
    return v;
  }

  /**
   * Extrae las D cifras centrales de un número de hasta 2·D cifras.
   * Ejemplo (D = 4): 32890225 -> "32|8902|25" -> 8902.
   * Con D = 4 el producto es menor que 10^8, muy por debajo de 2^53, así que
   * no hay pérdida de cifras al operar con Number.
   * @param {number} y - Producto o cuadrado (0 <= y < 10^8).
   * @returns {number}
   */
  const middleDigits = (y) => Math.floor(y / HALF) % MOD_D;

  /**
   * Clase base: implementa la interfaz común a partir de next().
   * Las subclases solo definen cómo avanza el estado.
   */
  class Base {
    /** Entero uniforme en {0, ..., n-1}. Como next() < 1, floor(u·n) <= n-1 siempre. */
    nextInt(n) {
      return Math.floor(this.next() * n);
    }
    /** Real en [a, b). Transformación lineal de u: a + u·(b - a). */
    range(a, b) {
      return a + this.next() * (b - a);
    }
  }

  /* ------------------------------------------------------------- 1. CUADRADO MEDIO */
  /**
   * Método del cuadrado medio (John von Neumann, 1946).
   *   X(n+1) = cifras centrales de X(n)^2  =  floor(X(n)^2 / 10^2) mod 10^4
   *   u(n+1) = X(n+1) / 10^4
   *
   * Parámetros: semilla (se normaliza a 4 cifras, 1000..9999).
   * Problemas conocidos: el estado tiene como máximo 10^4 valores, por lo que
   * siempre acaba en un ciclo; muchas semillas caen en 0 o en puntos fijos
   * (2500 -> 2500, 3792 -> 3792) en pocas iteraciones.
   * Corrección: si el nuevo estado es 0 o ya apareció desde la última
   * corrección, se aplica una perturbación determinista (ver perturb). Así la
   * secuencia sigue siendo reproducible con la misma semilla. Con
   * { pure: true } se desactiva la corrección para estudiar el método original.
   */
  class MiddleSquare extends Base {
    constructor(seed, opts = {}) {
      super();
      this.name = 'Cuadrado medio';
      this.short = 'CUAD. MEDIO';
      this.pure = !!opts.pure;
      this.seed = normalizeD(seed);
      this.reset();
    }
    reset() {
      this.x = this.seed;
      this.reseeds = 0;
      this.seen = new Set([this.x]);
    }
    /** Perturbación determinista: depende solo del estado y del número de correcciones. */
    perturb(x) {
      this.reseeds++;
      this.seen.clear();
      return normalizeD(x * 7 + 3571 + this.reseeds * 1237);
    }
    next() {
      let x = middleDigits(this.x * this.x);
      if (!this.pure && (x === 0 || this.seen.has(x))) x = this.perturb(x);
      this.seen.add(x);
      this.x = x;
      return x / MOD_D;
    }
  }

  /* --------------------------------------------------------- 2. CONGRUENCIAL LINEAL */
  /**
   * Generador congruencial lineal mixto (Lehmer, 1951; forma mixta de Thomson/Rotenberg).
   *   X(n+1) = (a·X(n) + c) mod m
   *   u(n+1) = X(n+1) / m
   *
   * Parámetros (tabla de Numerical Recipes):
   *   m = 2^32, a = 1664525, c = 1013904223.
   * Teorema de Hull–Dobell: el periodo es m (completo) si
   *   (1) c y m son coprimos -> c es impar ✓
   *   (2) a-1 es divisible por todos los factores primos de m (2) ✓
   *   (3) a-1 es divisible por 4 porque 4 divide a m -> 1664524 = 4·416131 ✓
   * Precisión: a·X + c llega a ~7.15·10^15, muy cerca de 2^53 ≈ 9.0·10^15
   * (límite de enteros exactos en Number); con un multiplicador mayor (p. ej.
   * 1103515245) se perderían cifras. Math.imul multiplica en enteros de 32 bits
   * (equivale a mod 2^32) y ">>> 0" lo deja sin signo, así que es exacto siempre.
   * Limitación: con m potencia de 2 los bits bajos tienen periodo corto (el
   * último bit alterna 0,1,0,1). Por eso se usa u = X/m (bits altos) y nunca X mod n.
   */
  class LCG extends Base {
    constructor(seed) {
      super();
      this.name = 'Congruencial lineal';
      this.short = 'CONGRUENCIAL';
      this.a = 1664525;
      this.c = 1013904223;
      this.m = 4294967296; // 2^32
      this.seed = Math.abs(Math.floor(seed)) >>> 0; // Cualquier entero mod 2^32 es válido (incluido 0)
      this.reset();
    }
    reset() {
      this.x = this.seed;
      this.reseeds = 0; // Nunca degenera: periodo completo
    }
    next() {
      this.x = (Math.imul(this.a, this.x) + this.c) >>> 0;
      return this.x / this.m;
    }
  }

  /* ------------------------------------------------------------- 3. PRODUCTOS MEDIOS */
  /**
   * Método de productos medios (variante del cuadrado medio).
   *   Y(n)   = X(n-1) · X(n)
   *   X(n+1) = cifras centrales de Y(n) = floor(Y(n) / 10^2) mod 10^4
   *   u(n+1) = X(n+1) / 10^4
   *
   * Parámetros: dos semillas de 4 cifras X0 y X1. Si solo se da una semilla,
   * la segunda se deriva de forma fija: X1 = normalizar(7·X0 + 1357).
   * El estado es el par (X(n-1), X(n)), hasta 10^8 combinaciones, pero también
   * puede caer en 0 o en ciclos; se aplica la misma corrección determinista
   * que en cuadrado medio (desactivable con { pure: true }).
   */
  class MiddleProduct extends Base {
    constructor(seed, opts = {}) {
      super();
      this.name = 'Productos medios';
      this.short = 'PROD. MEDIOS';
      this.pure = !!opts.pure;
      this.seed = normalizeD(seed);
      this.seed2 = opts.seed2 !== undefined ? normalizeD(opts.seed2) : normalizeD(this.seed * 7 + 1357);
      this.reset();
    }
    reset() {
      this.a = this.seed;
      this.b = this.seed2;
      this.reseeds = 0;
      this.seen = new Set([this.a * MOD_D + this.b]);
    }
    perturb(x) {
      this.reseeds++;
      this.seen.clear();
      return normalizeD(x * 7 + 3571 + this.reseeds * 1237);
    }
    next() {
      let x = middleDigits(this.a * this.b);
      if (!this.pure && (x === 0 || this.seen.has(this.b * MOD_D + x))) x = this.perturb(x);
      this.seen.add(this.b * MOD_D + x);
      this.a = this.b;
      this.b = x;
      return x / MOD_D;
    }
  }

  /* ------------------------------------------------------------- Fábrica y semillas */
  /** Métodos disponibles: clave usada en el selector -> clase. */
  const METHODS = {
    'middle-square': MiddleSquare,
    'lcg': LCG,
    'middle-product': MiddleProduct,
  };

  /**
   * Crea un generador del método indicado.
   * @param {'middle-square'|'lcg'|'middle-product'} method
   * @param {number} seed - Entero positivo.
   * @param {Object} [opts] - Opciones del método ({ pure, seed2 }).
   */
  function create(method, seed, opts) {
    const C = METHODS[method];
    if (!C) throw new Error(`Método de generador desconocido: ${method}`);
    if (!Number.isInteger(seed) || seed < 0) throw new TypeError(`Semilla inválida: ${seed}`);
    return new C(seed, opts);
  }

  /**
   * Valida el texto de semilla escrito por el jugador.
   * - Vacío: semilla automática tomada del reloj del sistema (Date.now() en ms,
   *   módulo 10^9). No es una función de azar: es la hora actual, que cambia
   *   en cada partida. Se muestra en pantalla para poder repetirla.
   * - Entero de 1 a 9 cifras mayor que 0: se usa tal cual.
   * - Cualquier otra cosa (letras, negativos, decimales, 0): se rechaza.
   * @param {string} text
   * @param {number} [now] - Marca de tiempo (inyectable para pruebas).
   * @returns {{ok: boolean, value?: number, auto?: boolean, message: string}}
   */
  function parseSeed(text, now) {
    const t = String(text === undefined || text === null ? '' : text).trim();
    if (t === '') {
      const v = Math.floor(now === undefined ? Date.now() : now) % 1e9 || 1;
      return { ok: true, value: v, auto: true, message: `Semilla automática (reloj): ${v}` };
    }
    if (!/^\d{1,9}$/.test(t)) {
      return { ok: false, message: 'La semilla debe ser un entero positivo de 1 a 9 cifras.' };
    }
    const v = Number(t);
    if (v === 0) return { ok: false, message: 'La semilla no puede ser 0.' };
    return { ok: true, value: v, auto: false, message: `Semilla fija: ${v}` };
  }

  return { MiddleSquare, LCG, MiddleProduct, METHODS, create, parseSeed, normalizeD };
})();

// Permite usar el módulo desde Node para las pruebas (node tests/prng.test.js)
if (typeof module !== 'undefined' && module.exports) module.exports = PRNG;
