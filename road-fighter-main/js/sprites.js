'use strict';
/* ==========================================================================
   ROAD FIGHTER · Sprites Procedurales en Canvas 2D
   --------------------------------------------------------------------------
   Arquitectura de renderizado gráfico:
   - Todo el arte gráfico se genera matemáticamente por código (sin imágenes externas).
   - Para maximizar rendimiento y nitidez visual (HiDPI / pantallas Retina), cada sprite
     se pre-renderiza una sola vez en un elemento <canvas> fuera de pantalla (off-screen)
     con un factor de supermuestreo (SS = 2).
   - Durante el bucle de juego, dibujar un sprite es una simple llamada nativa
     y ultrarrápida a `ctx.drawImage(...)`.
   ========================================================================== */

/**
 * Factor de supermuestreo (Supersampling x2).
 * Duplica la resolución interna de los sprites pre-renderizados para evitar pixelado
 * o bordes dentados al escalar o rotar en pantalla.
 * @type {number}
 */
const SS = 2;

/**
 * Crea y pre-renderiza un sprite en un canvas fuera de pantalla con supersampling.
 * 
 * @param {number} w - Ancho lógico del sprite en píxeles.
 * @param {number} h - Alto lógico del sprite en píxeles.
 * @param {Function} fn - Función de dibujo `fn(ctx, w, h)` que ejecuta las instrucciones vectoriales.
 * @returns {{ c: HTMLCanvasElement, w: number, h: number }} Objeto que contiene el canvas generado y sus dimensiones lógicas.
 */
function makeSprite(w, h, fn) {
  // 1. Crear canvas en memoria con dimensiones físicas multiplicadas por SS
  const c = document.createElement('canvas');
  c.width = Math.ceil(w * SS);
  c.height = Math.ceil(h * SS);

  // 2. Escalar el contexto 2D para que las coordenadas de dibujo se expresen en píxeles lógicos
  const g = c.getContext('2d');
  g.scale(SS, SS);

  // 3. Ejecutar la rutina de renderizado vectorial
  fn(g, w, h);

  // 4. Retornar el canvas pre-renderizado junto con sus medidas lógicas de referencia
  return { c, w, h };
}

/**
 * Traza un camino rectangular con esquinas redondeadas en el contexto 2D dado.
 * Reemplaza o complementa a `roundRect` nativo para máxima compatibilidad entre navegadores.
 * 
 * @param {CanvasRenderingContext2D} g - Contexto gráfico 2D.
 * @param {number} x - Posición X de la esquina superior izquierda.
 * @param {number} y - Posición Y de la esquina superior izquierda.
 * @param {number} w - Ancho del rectángulo.
 * @param {number} h - Alto del rectángulo.
 * @param {number} r - Radio de curvatura de las esquinas.
 */
function rrPath(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

/**
 * Modifica el brillo de un color en formato hexadecimal (#rrggbb).
 * Interpola linealmente los componentes R, G, B hacia blanco (si p > 0) o negro (si p < 0).
 * 
 * @param {string} hex - Color base en formato '#rrggbb'.
 * @param {number} p - Porcentaje de aclarado (+1.0 = blanco puro) u oscurecido (-1.0 = negro puro).
 * @returns {string} Nuevo color hexadecimal '#rrggbb'. Si el formato de entrada no es válido, retorna gris '#555555'.
 */
function shade(hex, p) {
  // Validación defensiva contra valores nulos o cadenas con formato erróneo
  if (!hex || typeof hex !== 'string' || hex[0] !== '#') return '#555555';
  const n = parseInt(hex.slice(1), 16);
  if (isNaN(n)) return '#555555';

  // Descomposición en canales rojo (r), verde (gg) y azul (b)
  let r = n >> 16, gg = (n >> 8) & 255, b = n & 255;
  const t = p < 0 ? 0 : 255, a = Math.abs(p);

  // Mezcla de componentes hacia 255 (blanco) o 0 (negro)
  r = Math.round((t - r) * a + r);
  gg = Math.round((t - gg) * a + gg);
  b = Math.round((t - b) * a + b);

  // Re-empaquetado a formato hexadecimal
  return '#' + (1 << 24 | r << 16 | gg << 8 | b).toString(16).slice(1);
}

/**
 * Generador de números pseudo-aleatorios determinista (PRNG Mulberry32 de 32 bits).
 * Permite generar variaciones naturales idénticas en vegetación o texturas basándose en una semilla.
 * 
 * @param {number} a - Semilla inicial (seed entera).
 * @returns {() => number} Función que retorna un número pseudo-aleatorio en el rango flotante [0, 1).
 */
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------------ COCHES (VISTA CENITAL 2D) */

/**
 * Dibuja un coche de carreras o tráfico en perspectiva cenital (top-down 2D).
 * Modela con detalle: ruedas de goma con relieve, carrocería con gradientes volumétricos,
 * sombra proyectada difusa, parabrisas con reflejos diagonales, techo, alerón opcional,
 * faros delanteros con resplandor cálido y pilotos traseros con luz de freno.
 * 
 * @param {CanvasRenderingContext2D} g - Contexto 2D del canvas off-screen.
 * @param {number} ox - Desplazamiento X de origen (offset).
 * @param {number} oy - Desplazamiento Y de origen (offset).
 * @param {number} w - Ancho de la carrocería en píxeles.
 * @param {number} h - Largo de la carrocería en píxeles.
 * @param {Object} o - Opciones de estilo: { color: string, stripe?: string, spoiler?: boolean }.
 */
function drawCar(g, ox, oy, w, h, o) {
  // Generar variantes de iluminación basadas en el color primario
  const base = o.color, hi = shade(base, 0.38), lo = shade(base, -0.38);
  g.save();
  g.translate(ox, oy);

  // 1. RUEDAS: Neumáticos oscuros salientes a los lados con brillo en el flanco
  g.fillStyle = '#0c0c10';
  const wh = h * 0.2; // Altura de los neumáticos relativa al largo del coche
  for (const y of [h * 0.14, h * 0.64]) {
    rrPath(g, -3, y, 8, wh, 2.6); g.fill();       // Rueda izquierda
    rrPath(g, w - 5, y, 8, wh, 2.6); g.fill();   // Rueda derecha
  }
  // Micro-reflejo en los flancos de las ruedas
  g.fillStyle = 'rgba(255,255,255,0.08)';
  for (const y of [h * 0.14, h * 0.64]) {
    g.fillRect(-2, y + 2, 1.4, wh - 4);
    g.fillRect(w + 0.6, y + 2, 1.4, wh - 4);
  }

  // 2. CARROCERÍA: Silueta estilizada mediante curvas Bézier y sombra proyectada
  g.shadowColor = 'rgba(0,0,0,0.5)';
  g.shadowBlur = 9;
  g.shadowOffsetY = 4;
  const body = () => {
    g.beginPath();
    g.moveTo(w * 0.18, h * 0.02);
    g.quadraticCurveTo(w * 0.5, -h * 0.02, w * 0.82, h * 0.02); // Morro curvado
    g.bezierCurveTo(w * 0.98, h * 0.05, w, h * 0.12, w, h * 0.22); // Aleta delantera derecha
    g.lineTo(w, h * 0.8);                                          // Lateral derecho
    g.bezierCurveTo(w, h * 0.92, w * 0.96, h * 0.99, w * 0.82, h * 0.995); // Trasera derecha
    g.lineTo(w * 0.18, h * 0.995);                                 // Borde trasero
    g.bezierCurveTo(w * 0.04, h * 0.99, 0, h * 0.92, 0, h * 0.8);  // Trasera izquierda
    g.lineTo(0, h * 0.22);                                         // Lateral izquierdo
    g.bezierCurveTo(0, h * 0.12, w * 0.02, h * 0.05, w * 0.18, h * 0.02); // Aleta delantera izq.
    g.closePath();
  };
  body();
  // Gradiente horizontal: simula volumen cilíndrico en el chasis (luz central, sombra en flancos)
  const gx = g.createLinearGradient(0, 0, w, 0);
  gx.addColorStop(0, lo); gx.addColorStop(0.28, hi); gx.addColorStop(0.55, base); gx.addColorStop(1, lo);
  g.fillStyle = gx; g.fill();
  g.shadowColor = 'transparent';
  g.lineWidth = 1; g.strokeStyle = 'rgba(0,0,0,0.4)'; g.stroke();

  // 3. BRILLO VERTICAL: Iluminación cenital difusa
  body();
  const gy = g.createLinearGradient(0, 0, 0, h);
  gy.addColorStop(0, 'rgba(255,255,255,0.22)');
  gy.addColorStop(0.4, 'rgba(255,255,255,0.02)');
  gy.addColorStop(1, 'rgba(0,0,0,0.22)');
  g.fillStyle = gy; g.fill();

  // 4. FRANJAS DEPORTIVAS (si el vehículo las tiene configuradas)
  if (o.stripe) {
    g.fillStyle = o.stripe;
    g.globalAlpha = 0.92;
    g.fillRect(w * 0.39, h * 0.03, w * 0.09, h * 0.95);
    g.fillRect(w * 0.52, h * 0.03, w * 0.09, h * 0.95);
    g.globalAlpha = 1;
  }

  // 5. CAPÓ: Línea divisoria y toma de aire con volumen
  g.strokeStyle = 'rgba(0,0,0,0.28)'; g.lineWidth = 0.8;
  g.beginPath(); g.moveTo(w * 0.1, h * 0.29); g.lineTo(w * 0.9, h * 0.29); g.stroke();
  g.fillStyle = 'rgba(255,255,255,0.14)';
  rrPath(g, w * 0.2, h * 0.06, w * 0.6, h * 0.17, 6); g.fill();

  // 6. CRISTALES: Parabrisas y luneta trasera tintados con reflejo diagonal
  const glass = g.createLinearGradient(0, h * 0.3, w, h * 0.5);
  glass.addColorStop(0, '#0d1829'); glass.addColorStop(0.55, '#2b4668'); glass.addColorStop(1, '#6f95bd');
  g.fillStyle = glass;
  g.beginPath(); // Parabrisas delantero
  g.moveTo(w * 0.15, h * 0.34); g.quadraticCurveTo(w * 0.5, h * 0.3, w * 0.85, h * 0.34);
  g.lineTo(w * 0.78, h * 0.47); g.lineTo(w * 0.22, h * 0.47); g.closePath(); g.fill();
  g.beginPath(); // Luneta trasera
  g.moveTo(w * 0.22, h * 0.67); g.lineTo(w * 0.78, h * 0.67);
  g.lineTo(w * 0.85, h * 0.77); g.quadraticCurveTo(w * 0.5, h * 0.81, w * 0.15, h * 0.77); g.closePath(); g.fill();
  // Destello diagonal sobre el parabrisas
  g.fillStyle = 'rgba(255,255,255,0.28)';
  g.beginPath(); g.moveTo(w * 0.25, h * 0.35); g.lineTo(w * 0.45, h * 0.35); g.lineTo(w * 0.33, h * 0.465); g.lineTo(w * 0.23, h * 0.465); g.closePath(); g.fill();

  // 7. TECHO DE LA CABINA
  const roof = g.createLinearGradient(0, 0, w, 0);
  roof.addColorStop(0, lo); roof.addColorStop(0.35, hi); roof.addColorStop(1, shade(base, -0.2));
  g.fillStyle = roof;
  rrPath(g, w * 0.17, h * 0.465, w * 0.66, h * 0.21, 5); g.fill();
  g.strokeStyle = 'rgba(0,0,0,0.25)'; g.stroke();
  g.fillStyle = 'rgba(255,255,255,0.18)';
  rrPath(g, w * 0.24, h * 0.49, w * 0.3, h * 0.07, 3); g.fill();

  // 8. ALERÓN TRASERO DE COMPETICIÓN (spoiler aerodinámico)
  if (o.spoiler) {
    g.fillStyle = shade(base, -0.55);
    rrPath(g, w * 0.04, h * 0.9, w * 0.92, h * 0.065, 2); g.fill();
    g.fillStyle = 'rgba(255,255,255,0.18)';
    g.fillRect(w * 0.08, h * 0.905, w * 0.84, 1.2);
  }

  // 9. FAROS DELANTEROS: Haces luminosos cálidos
  g.shadowColor = 'rgba(255,245,170,0.9)'; g.shadowBlur = 6;
  g.fillStyle = '#fffbd6';
  g.beginPath(); g.ellipse(w * 0.2, h * 0.055, w * 0.11, h * 0.02, 0.15, 0, Math.PI * 2); g.fill();
  g.beginPath(); g.ellipse(w * 0.8, h * 0.055, w * 0.11, h * 0.02, -0.15, 0, Math.PI * 2); g.fill();

  // 10. PILOTOS TRASEROS: Luces de freno rojas
  g.shadowColor = 'rgba(255,40,40,0.9)';
  g.fillStyle = '#ff3030';
  rrPath(g, w * 0.08, h * 0.955, w * 0.24, h * 0.024, 1.2); g.fill();
  rrPath(g, w * 0.68, h * 0.955, w * 0.24, h * 0.024, 1.2); g.fill();
  g.shadowColor = 'transparent';

  // 11. RETROVISORES LATERALES
  g.fillStyle = shade(base, -0.15);
  g.beginPath(); g.ellipse(-2.4, h * 0.38, 3.6, 2.4, 0, 0, Math.PI * 2); g.fill();
  g.beginPath(); g.ellipse(w + 2.4, h * 0.38, 3.6, 2.4, 0, 0, Math.PI * 2); g.fill();
  g.restore();
}

/**
 * Pre-renderiza un sprite de coche 2D añadiendo un margen de seguridad para sombras y retrovisores.
 * 
 * @param {number} w - Ancho de carrocería.
 * @param {number} h - Alto de carrocería.
 * @param {Object} o - Opciones de color, franja y alerón.
 * @returns {{ c: HTMLCanvasElement, w: number, h: number }} Sprite listo para drawImage.
 */
function carSprite(w, h, o) {
  return makeSprite(w + 20, h + 20, (g) => drawCar(g, 10, 10, w, h, o));
}

/**
 * Dibuja un camión articulado o furgón pesado en perspectiva cenital (top-down 2D).
 * Modela: cabina delantera, enganche articulado, remolque con nervaduras en el techo,
 * rótulo de carga lateral, tres ejes de ruedas dobles y ópticas delanteras/traseras.
 * 
 * @param {CanvasRenderingContext2D} g - Contexto 2D del canvas off-screen.
 * @param {number} ox - Desplazamiento X.
 * @param {number} oy - Desplazamiento Y.
 * @param {number} w - Ancho del camión en píxeles.
 * @param {number} h - Largo total del camión en píxeles.
 * @param {Object} o - Configuración: { body: string, cab: string, accent: string, label: string }.
 */
function drawTruck(g, ox, oy, w, h, o) {
  g.save();
  g.translate(ox, oy);
  const cabH = h * 0.27, gap = h * 0.025, trY = cabH + gap;

  // 1. NEUMÁTICOS: 3 pares de ruedas a lo largo del chasis (eje delantero y 2 traseros de carga)
  g.fillStyle = '#0c0c10';
  for (const y of [h * 0.06, h * 0.7, h * 0.83]) {
    rrPath(g, -3, y, 8, 17, 2.6); g.fill();
    rrPath(g, w - 5, y, 8, 17, 2.6); g.fill();
  }

  // 2. REMOLQUE / CAJA DE CARGA: Con sombra proyectada y gradiente metálico
  g.shadowColor = 'rgba(0,0,0,0.5)'; g.shadowBlur = 10; g.shadowOffsetY = 5;
  const tg = g.createLinearGradient(0, 0, w, 0);
  tg.addColorStop(0, shade(o.body, -0.3)); tg.addColorStop(0.3, shade(o.body, 0.18));
  tg.addColorStop(0.7, o.body); tg.addColorStop(1, shade(o.body, -0.35));
  g.fillStyle = tg;
  rrPath(g, 2, trY, w - 4, h - trY, 5); g.fill();
  g.shadowColor = 'transparent';
  g.strokeStyle = 'rgba(0,0,0,0.4)'; g.lineWidth = 1; g.stroke();

  // Nervaduras de refuerzo corrugado sobre el techo del remolque
  for (let y = trY + 5; y < h - 4; y += 7) {
    g.strokeStyle = 'rgba(0,0,0,0.16)'; g.beginPath(); g.moveTo(5, y); g.lineTo(w - 5, y); g.stroke();
    g.strokeStyle = 'rgba(255,255,255,0.22)'; g.beginPath(); g.moveTo(5, y + 1.2); g.lineTo(w - 5, y + 1.2); g.stroke();
  }
  g.fillStyle = 'rgba(255,255,255,0.16)';
  g.fillRect(w / 2 - 1.5, trY + 2, 3, h - trY - 4);

  // Franjas decorativas de flota y rótulo de marca vertical
  g.fillStyle = o.accent; g.globalAlpha = 0.9;
  g.fillRect(4, trY + 4, w - 8, 6);
  g.fillRect(4, h - 12, w - 8, 6);
  g.globalAlpha = 1;
  g.save();
  g.translate(w / 2, trY + (h - trY) / 2);
  g.rotate(-Math.PI / 2);
  g.fillStyle = o.accent; g.font = 'bold 15px Arial, sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(o.label, 0, 0);
  g.restore();

  // 3. ENGANCHE DE LA QUINTA RUEDA (unión entre cabina y remolque)
  g.fillStyle = '#17171c';
  g.fillRect(w * 0.3, cabH - 3, w * 0.4, gap + 6);

  // 4. CABINA MOTRIZ TRACTORA
  g.shadowColor = 'rgba(0,0,0,0.45)'; g.shadowBlur = 8; g.shadowOffsetY = 3;
  const cg = g.createLinearGradient(0, 0, w, 0);
  cg.addColorStop(0, shade(o.cab, -0.3)); cg.addColorStop(0.32, shade(o.cab, 0.25));
  cg.addColorStop(0.7, o.cab); cg.addColorStop(1, shade(o.cab, -0.35));
  g.fillStyle = cg;
  rrPath(g, 3, 0, w - 6, cabH, 10); g.fill();
  g.shadowColor = 'transparent';
  g.strokeStyle = 'rgba(0,0,0,0.4)'; g.stroke();

  // Parabrisas de la cabina
  const gl = g.createLinearGradient(0, cabH * 0.18, w, cabH * 0.5);
  gl.addColorStop(0, '#0d1829'); gl.addColorStop(0.6, '#32506f'); gl.addColorStop(1, '#7ea0c7');
  g.fillStyle = gl;
  g.beginPath(); g.moveTo(w * 0.14, cabH * 0.2); g.quadraticCurveTo(w * 0.5, cabH * 0.12, w * 0.86, cabH * 0.2);
  g.lineTo(w * 0.8, cabH * 0.46); g.lineTo(w * 0.2, cabH * 0.46); g.closePath(); g.fill();
  g.fillStyle = 'rgba(255,255,255,0.25)';
  g.beginPath(); g.moveTo(w * 0.22, cabH * 0.22); g.lineTo(w * 0.42, cabH * 0.21); g.lineTo(w * 0.3, cabH * 0.45); g.lineTo(w * 0.2, cabH * 0.45); g.closePath(); g.fill();

  // Techo y deflectores de la cabina
  g.fillStyle = shade(o.cab, -0.15);
  rrPath(g, w * 0.14, cabH * 0.52, w * 0.72, cabH * 0.4, 5); g.fill();
  g.fillStyle = 'rgba(255,255,255,0.2)';
  rrPath(g, w * 0.2, cabH * 0.56, w * 0.32, cabH * 0.12, 3); g.fill();

  // Ópticas del camión: faros delanteros y pilotos traseros
  g.shadowColor = 'rgba(255,245,170,0.9)'; g.shadowBlur = 6; g.fillStyle = '#fffbd6';
  g.beginPath(); g.ellipse(w * 0.22, 3.5, w * 0.1, 2.2, 0, 0, Math.PI * 2); g.fill();
  g.beginPath(); g.ellipse(w * 0.78, 3.5, w * 0.1, 2.2, 0, 0, Math.PI * 2); g.fill();

  g.shadowColor = 'rgba(255,40,40,0.9)'; g.fillStyle = '#ff3030';
  g.fillRect(w * 0.1, h - 3, w * 0.22, 2.4);
  g.fillRect(w * 0.68, h - 3, w * 0.22, 2.4);
  g.shadowColor = 'transparent';

  // Retrovisores de gran formato
  g.fillStyle = '#222';
  rrPath(g, -4.5, cabH * 0.28, 5, 11, 2); g.fill();
  rrPath(g, w - 0.5, cabH * 0.28, 5, 11, 2); g.fill();
  g.restore();
}

/**
 * Pre-renderiza un camión 2D con márgenes para sombras y espejos.
 * @param {number} w - Ancho.
 * @param {number} h - Alto.
 * @param {Object} o - Opciones de cabina y remolque.
 * @returns {{ c: HTMLCanvasElement, w: number, h: number }}
 */
function truckSprite(w, h, o) {
  return makeSprite(w + 20, h + 20, (g) => drawTruck(g, 10, 10, w, h, o));
}

/* ------------------------------------------------------- OBJETOS EN CALZADA (2D) */

/**
 * Genera el sprite de un charco de aceite (obstáculo que hace derrapar al jugador).
 * Cuenta con silueta orgánica multi-elíptica, brillo iridiscente petrolífero y reflejo especular.
 * @returns {{ c: HTMLCanvasElement, w: number, h: number }}
 */
function oilSprite() {
  return makeSprite(96, 70, (g) => {
    // Definición de la forma de la mancha mediante unión de elipses
    const blob = () => {
      g.beginPath();
      g.ellipse(48, 35, 36, 21, 0, 0, Math.PI * 2);
      g.ellipse(33, 29, 20, 15, 0.3, 0, Math.PI * 2);
      g.ellipse(64, 41, 22, 14, -0.3, 0, Math.PI * 2);
      g.ellipse(52, 24, 15, 9, 0.2, 0, Math.PI * 2);
    };

    // Fondo oscuro alquitranado con difuminado
    g.shadowColor = 'rgba(0,0,0,0.5)'; g.shadowBlur = 6;
    blob();
    const rg = g.createRadialGradient(40, 28, 4, 48, 35, 42);
    rg.addColorStop(0, '#2b2b36'); rg.addColorStop(1, '#07070b');
    g.fillStyle = rg; g.fill();
    g.shadowColor = 'transparent';

    // Película iridiscente multicolor (reflejo de arcoíris característico de hidrocarburos)
    g.save(); blob(); g.clip();
    const sh = g.createLinearGradient(8, 10, 88, 60);
    sh.addColorStop(0, 'rgba(120,80,255,0.55)'); sh.addColorStop(0.33, 'rgba(40,220,200,0.45)');
    sh.addColorStop(0.66, 'rgba(255,90,180,0.4)'); sh.addColorStop(1, 'rgba(90,150,255,0.45)');
    g.fillStyle = sh; g.globalAlpha = 0.65; g.fillRect(0, 0, 96, 70);

    // Punto blanco de brillo especular
    g.globalAlpha = 0.5; g.fillStyle = '#fff';
    g.beginPath(); g.ellipse(36, 26, 12, 4, -0.4, 0, Math.PI * 2); g.fill();
    g.restore();
  });
}

/**
 * Genera el sprite de un bidón de combustible coleccionable (recupera +20% de fuel).
 * Consiste en un anillo áureo pulsante, un bidón rojo tradicional y la letra 'F' estampada.
 * @returns {{ c: HTMLCanvasElement, w: number, h: number }}
 */
function fuelSprite() {
  return makeSprite(60, 60, (g) => {
    g.save(); g.translate(30, 30);

    // 1. Aura resplandeciente exterior dorada
    g.shadowColor = 'rgba(255,214,70,0.95)'; g.shadowBlur = 12;
    const ring = g.createRadialGradient(0, -6, 3, 0, 0, 23);
    ring.addColorStop(0, '#fff2a8'); ring.addColorStop(1, '#ff9d1c');
    g.fillStyle = ring; g.beginPath(); g.arc(0, 0, 23, 0, Math.PI * 2); g.fill();
    g.shadowColor = 'transparent';
    g.lineWidth = 2.5; g.strokeStyle = '#fff'; g.stroke();
    g.fillStyle = 'rgba(0,0,0,0.18)'; g.beginPath(); g.arc(0, 0, 18, 0, Math.PI * 2); g.fill();

    // 2. Bidón de gasolina con biseles metálicos
    const cg = g.createLinearGradient(-10, 0, 10, 0);
    cg.addColorStop(0, '#a50f1c'); cg.addColorStop(0.4, '#ff4a56'); cg.addColorStop(1, '#a50f1c');
    g.fillStyle = cg;
    rrPath(g, -9, -8, 18, 20, 3); g.fill();
    g.fillStyle = '#d81e2e';
    g.beginPath(); g.moveTo(-9, -8); g.lineTo(-4, -13); g.lineTo(9, -13); g.lineTo(9, -8); g.closePath(); g.fill();

    // 3. Boquilla de llenado y asa superior
    g.fillStyle = '#f3f3f3'; rrPath(g, 3, -16, 6, 5, 1.5); g.fill();
    g.strokeStyle = '#6d0a14'; g.lineWidth = 1.4;
    g.beginPath(); g.moveTo(-4, -8); g.lineTo(-4, -12); g.stroke();

    // 4. Letra 'F' (Fuel) central
    g.fillStyle = '#fff';
    g.font = 'bold 13px Arial, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('F', 0, 3);
    g.restore();
  });
}

/* -------------------------------------------------------------- DECORACIÓN Y PAISAJE (2D) */

/**
 * Traza una sombra ovalada difusa en el suelo para objetos del escenario.
 * 
 * @param {CanvasRenderingContext2D} g - Contexto 2D del canvas.
 * @param {number} cx - Coordenada X central.
 * @param {number} cy - Coordenada Y central.
 * @param {number} rx - Radio horizontal de la elipse.
 * @param {number} ry - Radio vertical de la elipse.
 */
function shadowEllipse(g, cx, cy, rx, ry) {
  g.fillStyle = 'rgba(0,0,0,0.27)';
  g.beginPath(); g.ellipse(cx + 7, cy + 10, rx, ry, 0, 0, Math.PI * 2); g.fill();
}

/**
 * Genera un árbol de copa redondeada o frutal visto desde arriba (2D).
 * Construido mediante múltiples capas concéntricas de esferas foliáceas con gradientes radiales.
 * 
 * @param {number} R - Radio general de la copa.
 * @param {string[]} cols - Paleta de colores de follaje [claro, medio, oscuro].
 * @param {number} seed - Semilla PRNG para aleatoriedad orgánica reproducible.
 * @param {string} [fruit] - Color opcional de frutos dispersos (ej. manzanas rojas).
 * @returns {{ c: HTMLCanvasElement, w: number, h: number }}
 */
function treeRound(R, cols, seed, fruit) {
  const rng = mulberry32(seed), S = R * 2 + 30;
  return makeSprite(S, S, (g) => {
    const cx = S / 2, cy = S / 2;
    // 1. Sombra en el suelo
    shadowEllipse(g, cx, cy, R * 0.95, R * 0.85);

    // 2. Capas de hojas (desde la base profunda hasta la cima iluminada)
    const layers = [[1, cols[2], 0], [0.78, cols[1], 0.12], [0.5, cols[0], 0.24]];
    for (const [k, col, off] of layers) {
      const n = 6 + Math.round(k * 3);
      for (let i = 0; i < n; i++) {
        const a = i / n * Math.PI * 2 + rng() * 0.6;
        const d = R * 0.5 * k;
        const x = cx + Math.cos(a) * d - off * R * 0.3;
        const y = cy + Math.sin(a) * d - off * R * 0.3;
        const r = R * (0.42 + 0.1 * k) + rng() * 3;
        const gr = g.createRadialGradient(x - r * 0.3, y - r * 0.3, r * 0.1, x, y, r);
        gr.addColorStop(0, shade(col, 0.28)); gr.addColorStop(1, col);
        g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
      }
    }

    // 3. Puntos de brillo y textura en la copa
    g.globalAlpha = 0.5;
    for (let i = 0; i < 16; i++) {
      const a = rng() * Math.PI * 2, d = rng() * R * 0.6;
      g.fillStyle = shade(cols[0], 0.3);
      g.beginPath(); g.arc(cx - R * 0.15 + Math.cos(a) * d, cy - R * 0.15 + Math.sin(a) * d, 1.5 + rng() * 2.2, 0, Math.PI * 2); g.fill();
    }
    g.globalAlpha = 1;

    // 4. Frutos (si están activos)
    if (fruit) {
      for (let i = 0; i < 9; i++) {
        const a = rng() * Math.PI * 2, d = rng() * R * 0.8;
        g.fillStyle = fruit;
        g.beginPath(); g.arc(cx + Math.cos(a) * d, cy + Math.sin(a) * d, 2.4, 0, Math.PI * 2); g.fill();
      }
    }
  });
}

/**
 * Genera un pino o conífera en vista cenital (2D) con capas de agujas en estrella.
 * 
 * @param {number} R - Radio de la base del pino.
 * @param {string[]} cols - Tonos verdes del follaje.
 * @param {boolean} snow - Si true, agrega nieve blanca sobre las ramas.
 * @returns {{ c: HTMLCanvasElement, w: number, h: number }}
 */
function pine(R, cols, snow) {
  const S = R * 2 + 28;
  return makeSprite(S, S, (g) => {
    const cx = S / 2, cy = S / 2;
    shadowEllipse(g, cx, cy, R * 0.9, R * 0.85);

    // Función auxiliar para trazar una estrella de múltiples puntas (ramas de conífera)
    const star = (rad, rot, inner) => {
      g.beginPath();
      const pts = 14;
      for (let i = 0; i < pts * 2; i++) {
        const a = rot + i / (pts * 2) * Math.PI * 2;
        const r = i % 2 ? rad * inner : rad;
        const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
        i ? g.lineTo(x, y) : g.moveTo(x, y);
      }
      g.closePath();
    };

    // Capas escalonadas de ramas desde abajo hacia arriba
    for (let k = 0; k < 4; k++) {
      const rad = R * (1 - k * 0.22);
      star(rad, k * 0.22, 0.68);
      const gr = g.createRadialGradient(cx - rad * 0.3, cy - rad * 0.3, 2, cx, cy, rad);
      gr.addColorStop(0, shade(cols[0], 0.1 + k * 0.08)); gr.addColorStop(1, cols[1]);
      g.fillStyle = gr; g.fill();
      g.strokeStyle = 'rgba(0,0,0,0.25)'; g.lineWidth = 1; g.stroke();

      // Nieve acumulada en niveles superiores
      if (snow && k >= 1) {
        g.save(); g.translate(-rad * 0.05, -rad * 0.05);
        star(rad * 0.8, k * 0.22, 0.7);
        g.fillStyle = 'rgba(255,255,255,0.72)'; g.fill(); g.restore();
      }
    }
    // Punta superior del pino
    g.fillStyle = snow ? '#fff' : shade(cols[0], 0.3);
    g.beginPath(); g.arc(cx, cy, 3.2, 0, Math.PI * 2); g.fill();
  });
}

/**
 * Genera una palmera tropical vista desde arriba (2D), típica de biomas desérticos o costeros.
 * 
 * @param {number} R - Longitud de las hojas o palmas.
 * @param {string[]} cols - Colores verde esmeralda y oliva.
 * @param {number} seed - Semilla para aleatoriedad orgánica.
 * @returns {{ c: HTMLCanvasElement, w: number, h: number }}
 */
function palm(R, cols, seed) {
  const rng = mulberry32(seed), S = R * 2 + 28;
  return makeSprite(S, S, (g) => {
    const cx = S / 2, cy = S / 2;
    shadowEllipse(g, cx, cy, R * 0.85, R * 0.75);

    // Trazador de una hoja de palmera individual
    const frond = (a, len, col1, col2) => {
      g.save(); g.translate(cx, cy); g.rotate(a);
      g.beginPath(); g.moveTo(0, 0);
      g.quadraticCurveTo(len * 0.5, -len * 0.26, len, 0);
      g.quadraticCurveTo(len * 0.5, len * 0.2, 0, 0); g.closePath();
      const gr = g.createLinearGradient(0, 0, len, 0);
      gr.addColorStop(0, col2); gr.addColorStop(1, col1);
      g.fillStyle = gr; g.fill();
      g.strokeStyle = 'rgba(0,0,0,0.3)'; g.lineWidth = 0.8;
      g.beginPath(); g.moveTo(0, 0); g.lineTo(len * 0.95, 0); g.stroke();
      g.restore();
    };

    // Anillo exterior de hojas largas y anillo interior de brotes frescos
    for (let i = 0; i < 9; i++) frond(i / 9 * Math.PI * 2 + rng() * 0.2, R * (0.95 + rng() * 0.1), cols[1], cols[2]);
    for (let i = 0; i < 9; i++) frond(i / 9 * Math.PI * 2 + 0.35, R * 0.7, cols[0], cols[1]);

    // Corazón central del tronco de la palmera
    const cg = g.createRadialGradient(cx - 2, cy - 2, 1, cx, cy, 8);
    cg.addColorStop(0, '#a77c4e'); cg.addColorStop(1, '#5b3b1e');
    g.fillStyle = cg; g.beginPath(); g.arc(cx, cy, 6.5, 0, Math.PI * 2); g.fill();
  });
}

/**
 * Genera una roca o peñasco irregular 2D con facetas sombreadas y resaltes especulares.
 * 
 * @param {number} R - Radio aproximado.
 * @param {string[]} cols - Colores de granito o arenisca [luz, sombra].
 * @param {number} seed - Semilla pseudo-aleatoria.
 * @returns {{ c: HTMLCanvasElement, w: number, h: number }}
 */
function rock(R, cols, seed) {
  const rng = mulberry32(seed), S = R * 2 + 24;
  return makeSprite(S, S, (g) => {
    const cx = S / 2, cy = S / 2;
    shadowEllipse(g, cx, cy, R * 0.95, R * 0.8);
    const n = 9, pts = [];
    for (let i = 0; i < n; i++) {
      const a = i / n * Math.PI * 2, r = R * (0.72 + rng() * 0.28);
      pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r * 0.9]);
    }
    const poly = (p, s, ox, oy) => {
      g.beginPath();
      p.forEach(([x, y], i) => {
        const X = cx + (x - cx) * s + ox, Y = cy + (y - cy) * s + oy;
        i ? g.lineTo(X, Y) : g.moveTo(X, Y);
      });
      g.closePath();
    };
    poly(pts, 1, 0, 0);
    const gr = g.createLinearGradient(cx - R, cy - R, cx + R, cy + R);
    gr.addColorStop(0, cols[0]); gr.addColorStop(1, cols[1]);
    g.fillStyle = gr; g.fill();
    g.strokeStyle = 'rgba(0,0,0,0.35)'; g.lineWidth = 1.2; g.stroke();
    // Faceta superior iluminada
    poly(pts, 0.55, -R * 0.12, -R * 0.14);
    g.fillStyle = 'rgba(255,255,255,0.22)'; g.fill();
  });
}

/**
 * Genera un arbusto denso redondeado 2D, con opción de florecillas silvestres.
 * 
 * @param {number} R - Radio.
 * @param {string[]} cols - Colores de follaje.
 * @param {number} seed - Semilla PRNG.
 * @param {string[]} [flowers] - Paleta de colores para flores.
 * @returns {{ c: HTMLCanvasElement, w: number, h: number }}
 */
function bush(R, cols, seed, flowers) {
  const rng = mulberry32(seed), S = R * 2 + 24;
  return makeSprite(S, S, (g) => {
    const cx = S / 2, cy = S / 2;
    shadowEllipse(g, cx, cy, R * 0.95, R * 0.8);
    for (let i = 0; i < 9; i++) {
      const a = i / 9 * Math.PI * 2, d = R * 0.5;
      const x = cx + Math.cos(a) * d, y = cy + Math.sin(a) * d, r = R * 0.55;
      const gr = g.createRadialGradient(x - r * 0.3, y - r * 0.3, 1, x, y, r);
      gr.addColorStop(0, shade(cols[0], 0.2)); gr.addColorStop(1, cols[1]);
      g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    }
    const gr = g.createRadialGradient(cx - 3, cy - 3, 1, cx, cy, R * 0.7);
    gr.addColorStop(0, shade(cols[0], 0.3)); gr.addColorStop(1, cols[0]);
    g.fillStyle = gr; g.beginPath(); g.arc(cx, cy, R * 0.6, 0, Math.PI * 2); g.fill();
    if (flowers) {
      for (let i = 0; i < 14; i++) {
        const a = rng() * Math.PI * 2, d = rng() * R * 0.85;
        g.fillStyle = flowers[i % flowers.length];
        g.beginPath(); g.arc(cx + Math.cos(a) * d, cy + Math.sin(a) * d, 1.9 + rng(), 0, Math.PI * 2); g.fill();
      }
    }
  });
}

/**
 * Genera un parche de flores silvestres dispersas con hojas de fondo.
 * @param {number} seed - Semilla PRNG.
 * @param {string[]} colors - Colores de los pétalos.
 * @param {string} leaf - Color de las hojas de base.
 * @returns {{ c: HTMLCanvasElement, w: number, h: number }}
 */
function flowerPatch(seed, colors, leaf) {
  const rng = mulberry32(seed), S = 64;
  return makeSprite(S, S, (g) => {
    for (let i = 0; i < 26; i++) {
      const a = rng() * Math.PI * 2, d = Math.sqrt(rng()) * 24;
      const x = S / 2 + Math.cos(a) * d, y = S / 2 + Math.sin(a) * d;
      g.fillStyle = leaf; g.beginPath(); g.ellipse(x, y + 1, 4, 2.6, rng() * 3, 0, Math.PI * 2); g.fill();
      g.fillStyle = colors[i % colors.length];
      g.beginPath(); g.arc(x, y, 2.4, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#ffe566'; g.beginPath(); g.arc(x, y, 0.9, 0, Math.PI * 2); g.fill();
    }
  });
}

/**
 * Genera un cactus saguaro desértico visto desde arriba (2D).
 * @param {number} seed - Semilla PRNG.
 * @returns {{ c: HTMLCanvasElement, w: number, h: number }}
 */
function cactus(seed) {
  const S = 66;
  return makeSprite(S, S, (g) => {
    const cx = S / 2, cy = S / 2;
    shadowEllipse(g, cx, cy, 20, 17);
    const limb = (x, y, r, rot) => {
      const gr = g.createRadialGradient(x - r * 0.3, y - r * 0.3, 1, x, y, r);
      gr.addColorStop(0, '#79c26a'); gr.addColorStop(1, '#2f7a3a');
      g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
      g.strokeStyle = 'rgba(0,50,10,0.45)'; g.lineWidth = 1;
      for (let i = 0; i < 8; i++) {
        const a = i / 8 * Math.PI * 2 + rot;
        g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r); g.stroke();
      }
    };
    g.fillStyle = '#3f8f46';
    g.fillRect(cx - 14, cy - 3, 28, 6);
    limb(cx - 14, cy, 6, 0.2); limb(cx + 14, cy, 6, 0.5);
    limb(cx, cy, 10, 0);
    g.fillStyle = '#ffd1e6';
    g.beginPath(); g.arc(cx, cy, 3, 0, Math.PI * 2); g.fill();
  });
}

/**
 * Genera una mata seca o arbusto espinoso de clima árido (2D).
 * @param {number} seed - Semilla PRNG.
 * @returns {{ c: HTMLCanvasElement, w: number, h: number }}
 */
function dryBush(seed) {
  const rng = mulberry32(seed), S = 60;
  return makeSprite(S, S, (g) => {
    shadowEllipse(g, S / 2, S / 2, 17, 13);
    g.lineCap = 'round';
    for (let i = 0; i < 26; i++) {
      const a = rng() * Math.PI * 2, l = 10 + rng() * 14;
      g.strokeStyle = ['#8c6a3f', '#a98251', '#6d4f2a'][i % 3]; g.lineWidth = 1 + rng() * 1.4;
      g.beginPath(); g.moveTo(S / 2, S / 2);
      g.quadraticCurveTo(S / 2 + Math.cos(a + 0.5) * l * 0.6, S / 2 + Math.sin(a + 0.5) * l * 0.6, S / 2 + Math.cos(a) * l, S / 2 + Math.sin(a) * l);
      g.stroke();
    }
  });
}

/**
 * Genera una casa o edificación rural 2D vista desde arriba.
 * Soporta tejado a dos aguas con tejas (y nieve opcional) o techo plano tipo adobe.
 * 
 * @param {number} w - Ancho de la casa.
 * @param {number} h - Largo de la casa.
 * @param {Object} o - Opciones: { roof: string, flat?: boolean, snow?: boolean }.
 * @returns {{ c: HTMLCanvasElement, w: number, h: number }}
 */
function house(w, h, o) {
  const P = 24;
  return makeSprite(w + P, h + P, (g) => {
    const x = P / 2 - 4, y = P / 2 - 4;
    // Sombra del edificio
    g.fillStyle = 'rgba(0,0,0,0.3)';
    g.beginPath(); g.moveTo(x + 8, y + 10); g.lineTo(x + w + 12, y + 10); g.lineTo(x + w + 12, y + h + 12); g.lineTo(x + 8, y + h + 12); g.fill();

    if (o.flat) {
      // Techo plano estilo adobe desértico
      const gr = g.createLinearGradient(x, y, x + w, y + h);
      gr.addColorStop(0, shade(o.roof, 0.15)); gr.addColorStop(1, shade(o.roof, -0.15));
      g.fillStyle = gr; rrPath(g, x, y, w, h, 5); g.fill();
      g.strokeStyle = shade(o.roof, -0.35); g.lineWidth = 2; g.stroke();
      g.fillStyle = shade(o.roof, -0.1);
      rrPath(g, x + 7, y + 7, w - 14, h - 14, 3); g.fill();
      g.fillStyle = '#6fb7c9'; g.fillRect(x + w - 24, y + 12, 14, 14); // Depósito o tragaluz
    } else {
      // Tejado a dos aguas tradicional con cumbrera central
      const mid = y + h / 2;
      const top = g.createLinearGradient(0, y, 0, mid);
      top.addColorStop(0, shade(o.roof, 0.18)); top.addColorStop(1, o.roof);
      g.fillStyle = top; g.fillRect(x, y, w, h / 2);
      const bot = g.createLinearGradient(0, mid, 0, y + h);
      bot.addColorStop(0, shade(o.roof, -0.22)); bot.addColorStop(1, shade(o.roof, -0.42));
      g.fillStyle = bot; g.fillRect(x, mid, w, h / 2);
      g.strokeStyle = 'rgba(0,0,0,0.2)'; g.lineWidth = 1;
      // Hiladas de tejas
      for (let yy = y + 5; yy < y + h; yy += 6) {
        if (Math.abs(yy - mid) < 2) continue;
        g.beginPath(); g.moveTo(x, yy); g.lineTo(x + w, yy); g.stroke();
      }
      g.fillStyle = shade(o.roof, -0.5); g.fillRect(x, mid - 1.5, w, 3); // Cumbrera
      g.strokeStyle = shade(o.roof, -0.55); g.lineWidth = 2; g.strokeRect(x, y, w, h);
      // Nieve acumulada en la vertiente
      if (o.snow) {
        g.fillStyle = 'rgba(255,255,255,0.82)';
        rrPath(g, x + 3, y + 3, w - 6, h / 2 - 6, 6); g.fill();
        g.fillStyle = 'rgba(235,243,255,0.9)';
        rrPath(g, x + 3, mid + 4, w - 6, h / 2 - 8, 6); g.fill();
      }
      // Chimenea con boca oscura
      g.fillStyle = '#7b6a5b'; g.fillRect(x + w * 0.7, y + 6, 11, 11);
      g.fillStyle = '#2b2018'; g.fillRect(x + w * 0.7 + 2.5, y + 8.5, 6, 6);
    }
  });
}

/**
 * Genera una charca, estanque o lago pequeño 2D con orilla de tierra,
 * agua cristalina graduada, ondas de superficie y nenúfares.
 * 
 * @param {number} w - Ancho del estanque.
 * @param {number} h - Alto del estanque.
 * @param {Object} o - Opciones: { shore: string, water: [string, string], pads?: boolean }.
 * @returns {{ c: HTMLCanvasElement, w: number, h: number }}
 */
function pond(w, h, o) {
  const P = 14;
  return makeSprite(w + P * 2, h + P * 2, (g) => {
    const cx = (w + P * 2) / 2, cy = (h + P * 2) / 2;
    // 1. Orilla o margen de tierra/arena
    g.fillStyle = o.shore;
    g.beginPath(); g.ellipse(cx, cy, w / 2 + 7, h / 2 + 7, 0.1, 0, Math.PI * 2); g.fill();

    // 2. Espejo de agua con gradiente radial de profundidad
    const gr = g.createRadialGradient(cx - w * 0.15, cy - h * 0.2, 4, cx, cy, w / 2);
    gr.addColorStop(0, o.water[0]); gr.addColorStop(1, o.water[1]);
    g.fillStyle = gr;
    g.beginPath(); g.ellipse(cx, cy, w / 2, h / 2, 0.1, 0, Math.PI * 2); g.fill();

    // 3. Ondas blancas de superficie
    g.strokeStyle = 'rgba(255,255,255,0.35)'; g.lineWidth = 1.4;
    g.beginPath(); g.ellipse(cx - 6, cy - 4, w * 0.25, h * 0.18, 0.1, 3.4, 5.4); g.stroke();
    g.beginPath(); g.ellipse(cx + 8, cy + 6, w * 0.16, h * 0.1, 0.1, 0.2, 2.2); g.stroke();

    // 4. Hojas de nenúfar con flor de loto
    if (o.pads) {
      for (const [dx, dy] of [[-18, 6], [14, -8], [4, 12]]) {
        g.fillStyle = '#3f9a49'; g.beginPath(); g.arc(cx + dx, cy + dy, 6, 0.4, Math.PI * 2 - 0.4); g.lineTo(cx + dx, cy + dy); g.fill();
      }
      g.fillStyle = '#ffd1e6'; g.beginPath(); g.arc(cx + 14, cy - 8, 2.6, 0, Math.PI * 2); g.fill();
    }
  });
}

/* --------------------------------------------------------------- TEXTURAS PROCEDURALES REPETIBLES (TILING) */

/**
 * Genera un patrón o mosaico continuo (seamless tile) de césped o terreno exterior.
 * Crea gradientes de color dispersos y briznas de hierba con cobertura infinita en los bordes.
 * 
 * @param {string} base - Color de fondo dominante del suelo.
 * @param {string[]} lights - Colores claros para briznas y motas de sol.
 * @param {string[]} darks - Colores oscuros para sombras y relieve del terreno.
 * @param {number} T - Dimensión del mosaico en píxeles (ancho y alto cuadrado).
 * @param {string[]|null} [flowers] - Paleta de motas florales dispersas.
 * @returns {HTMLCanvasElement} Canvas en memoria listo para usar como patrón repetitivo en el suelo.
 */
function makeGrassTile(base, lights, darks, T, flowers) {
  const c = document.createElement('canvas');
  c.width = c.height = T;
  const g = c.getContext('2d');
  const rng = mulberry32(base.length * 977 + lights[0].charCodeAt(2));

  // Capa base uniforme
  g.fillStyle = base; g.fillRect(0, 0, T, T);

  // Manchas suaves grandes de iluminación (con repetición toroidal en bordes para continuidad perfecta)
  for (let i = 0; i < 26; i++) {
    const x = rng() * T, y = rng() * T, r = 20 + rng() * 40;
    const col = rng() < 0.5 ? lights[0] : darks[0];
    for (const dx of [-T, 0, T]) for (const dy of [-T, 0, T]) {
      const gr = g.createRadialGradient(x + dx, y + dy, 0, x + dx, y + dy, r);
      gr.addColorStop(0, col + '30'); gr.addColorStop(1, col + '00');
      g.fillStyle = gr; g.fillRect(x + dx - r, y + dy - r, r * 2, r * 2);
    }
  }

  // Briznas de hierba individuales con envolvente periódica
  g.lineCap = 'round';
  for (let i = 0; i < 1100; i++) {
    const x = rng() * T, y = rng() * T, l = 2 + rng() * 4, a = -Math.PI / 2 + (rng() - 0.5) * 1.1;
    g.strokeStyle = (rng() < 0.55 ? lights : darks)[Math.floor(rng() * 2) % 2] + '66';
    g.lineWidth = 1;
    for (const dx of [-T, 0, T]) for (const dy of [-T, 0, T]) {
      if (x + dx < -8 || x + dx > T + 8 || y + dy < -8 || y + dy > T + 8) continue;
      g.beginPath(); g.moveTo(x + dx, y + dy); g.lineTo(x + dx + Math.cos(a) * l, y + dy + Math.sin(a) * l); g.stroke();
    }
  }

  // Flores silvestres salpicadas en la pradera
  if (flowers) {
    for (let i = 0; i < 38; i++) {
      const x = rng() * T, y = rng() * T;
      g.fillStyle = flowers[i % flowers.length];
      g.beginPath(); g.arc(x, y, 1.3, 0, Math.PI * 2); g.fill();
    }
  }
  return c;
}

/**
 * Genera un mosaico repetible continuo (seamless tile) de pavimento de asfalto.
 * Simula la textura granulada de áridos minerales y grietas longitudinales del pavimento.
 * 
 * @param {string} base - Color hexadecimal base del alquitrán.
 * @param {number} T - Tamaño de la loseta cuadrada en píxeles.
 * @returns {HTMLCanvasElement} Canvas en memoria con la textura de asfalto.
 */
function makeAsphaltTile(base, T) {
  const c = document.createElement('canvas');
  c.width = c.height = T;
  const g = c.getContext('2d');
  const rng = mulberry32(4242);

  // Fondo del asfalto
  g.fillStyle = base; g.fillRect(0, 0, T, T);

  // Áridos y gravilla (micro-granos claros y oscuros)
  for (let i = 0; i < 2200; i++) {
    const x = rng() * T, y = rng() * T;
    g.fillStyle = rng() < 0.5 ? 'rgba(255,255,255,0.045)' : 'rgba(0,0,0,0.09)';
    g.fillRect(x, y, 1 + rng() * 1.5, 1 + rng() * 1.5);
  }

  // Fisuras sutiles de desgaste en la calzada
  g.strokeStyle = 'rgba(0,0,0,0.18)'; g.lineWidth = 1;
  for (let i = 0; i < 4; i++) {
    let x = rng() * T, y = rng() * T;
    g.beginPath(); g.moveTo(x, y);
    for (let k = 0; k < 5; k++) { x += (rng() - 0.5) * 18; y += (rng() - 0.3) * 14; g.lineTo(x, y); }
    g.stroke();
  }
  return c;
}

/* ============================================================== CATÁLOGO DE SPRITES 2D Y TEMAS */

/**
 * Contenedor global de recursos gráficos y modelos pre-renderizados del juego.
 * @type {Object}
 */
const Sprites = {};

// Coche deportivo del jugador (rojo brillante con franja blanca de carreras y alerón)
Sprites.player = carSprite(44, 80, { color: '#e3172b', stripe: '#ffffff', spoiler: true });

// Tráfico: Sedanes urbanos comunes con variada gama cromática
Sprites.sedans = ['#2f6df0', '#f3f4f6', '#12b5a6', '#8e44ad', '#8a95a0', '#ff8a1f', '#1f9d55']
  .map((c) => carSprite(44, 78, { color: c }));

// Tráfico: Deportivos veloces con alerón y franja negra
Sprites.sports = ['#ffd400', '#ff2d95', '#00d4ff']
  .map((c) => carSprite(44, 80, { color: c, stripe: '#14141a', spoiler: true }));

// Tráfico pesado: Camiones de mercancías con decoraciones corporativas
Sprites.trucks = [
  { body: '#e9ecef', cab: '#d64545', accent: '#d64545', label: 'TRANS' },
  { body: '#2c7be5', cab: '#f0f2f5', accent: '#ffffff', label: 'CARGO' },
  { body: '#2e9d57', cab: '#f4c430', accent: '#ffffff', label: 'EXPRESS' },
].map((o) => truckSprite(54, 150, o));

// Objetos coleccionables y peligros en pista
Sprites.oil = oilSprite();   // Mancha de aceite
Sprites.fuel = fuelSprite(); // Bidón de recarga de combustible

/**
 * Definición de biomas y ambientaciones para las 5 etapas del juego.
 * Cada bioma configura paleta de hierba, asfalto, bordillos y colecciones de elementos
 * de atrezo (grandes, pequeños y raros) que se colocan proceduralmente en los márgenes de la pista.
 */
Sprites.THEMES = [
  { // 0 · ETAPA 1: PRADERA SOLEADA (Vegetación abundante, árboles frutales y estanques)
    name: 'PRADERA', night: false,
    grass: ['#5db04a', '#7cc863', '#4a9a3a'],
    asphalt: '#3c3f4a', curbA: '#e53935', curbB: '#f5f5f5',
    big: [
      treeRound(34, ['#6fcf5a', '#3f9e3b', '#2a7a2e'], 11),
      treeRound(28, ['#8bdc62', '#4ea63d', '#307f30'], 12),
      pine(30, ['#3f9a5a', '#1d6a3a'], false),
      treeRound(30, ['#7ad05a', '#3f9e3b', '#2a7a2e'], 13, '#ff4d4d'),
    ],
    small: [
      bush(15, ['#58b94a', '#2f8a34'], 21),
      bush(13, ['#6fcf5a', '#3a9a3a'], 22, ['#ff6fa5', '#ffffff', '#ffd54a']),
      rock(13, ['#b9bec6', '#6f7580'], 23),
      flowerPatch(24, ['#ff6fa5', '#ffffff', '#ffd54a', '#b58cff'], '#3d8f3a'),
    ],
    rare: [
      house(86, 62, { roof: '#c0503f' }),
      pond(92, 58, { shore: '#7a6a45', water: ['#7fd6ff', '#2a86c9'], pads: true }),
      house(70, 54, { roof: '#4f6fb5' }),
    ],
  },
  { // 1 · ETAPA 2: DESIERTO ÁRIDO (Arenas cálidas, cactus, palmeras y casas de adobe)
    name: 'DESIERTO', night: false,
    grass: ['#e6c27d', '#f2d596', '#d6b068'],
    asphalt: '#46433f', curbA: '#e2602d', curbB: '#f7efe0',
    big: [
      palm(40, ['#78c25a', '#3e9a45', '#25702f'], 31),
      palm(34, ['#8ed062', '#43a24a', '#2b7a34'], 32),
      rock(30, ['#d9b98a', '#9a7a52'], 33),
    ],
    small: [
      cactus(41), cactus(42), dryBush(43), dryBush(44),
      rock(13, ['#d1b184', '#8f7048'], 45),
    ],
    rare: [
      house(88, 62, { roof: '#e0b98a', flat: true }),
      pond(80, 50, { shore: '#7fb35a', water: ['#7cf0e1', '#1c9fb8'], pads: false }),
    ],
  },
  { // 2 · ETAPA 3: OTOÑO DORADO (Árboles caducifolios de hojas cobrizas y rojizas)
    name: 'OTOÑO', night: false,
    grass: ['#9aa43d', '#b2bb52', '#868f30'],
    asphalt: '#403e44', curbA: '#b8531f', curbB: '#f3e9d2',
    big: [
      treeRound(34, ['#ffb347', '#e0731d', '#a8450f'], 51),
      treeRound(30, ['#ff8a5c', '#d1452a', '#8f2a1a'], 52),
      treeRound(32, ['#ffd45e', '#e0a41d', '#a8730f'], 53),
      pine(30, ['#4d7a3a', '#2a5128'], false),
    ],
    small: [
      bush(14, ['#d98a2b', '#9a5a14'], 54),
      bush(13, ['#c7552a', '#8a3217'], 55),
      rock(13, ['#b5aea3', '#6e665c'], 56),
      flowerPatch(57, ['#ffa94d', '#ffd54a', '#ff7a5a'], '#7a8a2e'),
    ],
    rare: [
      house(86, 62, { roof: '#7a4a2b' }),
      pond(92, 58, { shore: '#6a5a35', water: ['#8ad0e8', '#2f7aa6'], pads: false }),
    ],
  },
  { // 3 · ETAPA 4: NIEVE Y MONTAÑA (Paisaje invernal, pinos nevados y bordillos azulados)
    name: 'NIEVE', night: false,
    grass: ['#e9f2fa', '#ffffff', '#d3e2f0'],
    asphalt: '#4a4f5c', curbA: '#2f6fd8', curbB: '#f5f9ff',
    big: [
      pine(34, ['#3f8f6a', '#1d5a46'], true),
      pine(28, ['#4a9a74', '#216650'], true),
      treeRound(30, ['#ffffff', '#cfe0f0', '#9fb8d0'], 61),
    ],
    small: [
      bush(14, ['#f4f9ff', '#b8cde2'], 62),
      rock(13, ['#cfd8e2', '#7b8795'], 63),
      bush(12, ['#e8f1fb', '#a8bfd6'], 64),
    ],
    rare: [
      house(86, 62, { roof: '#a54a3a', snow: true }),
      pond(92, 58, { shore: '#dfe9f3', water: ['#d8f3ff', '#7fc3e6'], pads: false }),
    ],
  },
];

// ETAPA 5: NOCHE (Reutiliza el escenario de pradera bajo iluminación nocturna y haz de faros)
Sprites.THEMES.push({
  name: 'NOCHE', night: true,
  grass: ['#3f8f4a', '#58a860', '#2f7a3c'],
  asphalt: '#3a3d48', curbA: '#e53935', curbB: '#f5f5f5',
  big: Sprites.THEMES[0].big, small: Sprites.THEMES[0].small, rare: Sprites.THEMES[0].rare,
});

// Pre-renderizado de los patrones repetibles de césped y asfalto para cada etapa
for (const t of Sprites.THEMES) {
  t.grassTile = makeGrassTile(t.grass[0], [t.grass[1], t.grass[1]], [t.grass[2], t.grass[2]], 256,
    t.name === 'PRADERA' || t.name === 'NOCHE' ? ['#ffffff', '#ffd54a'] : null);
  t.asphaltTile = makeAsphaltTile(t.asphalt, 128);
}

/* ============================================================== MODELOS Y SPRITES 3D (VISTA EN PRIMERA PERSONA) */

/**
 * Dibuja la vista trasera (rear view) de un coche de carreras o tráfico en 3D.
 * Se escala y proyecta según la profundidad Z en la perspectiva de primera persona.
 * Incluye: neumáticos anchos de competición, doble tubo de escape con interior oscuro,
 * difusor aerodinámico, placa de matrícula personalizada, luneta trasera con reflejos,
 * alerón con soportes verticales, pilotos de freno LED y luces de intermitente ámbar.
 * 
 * @param {CanvasRenderingContext2D} g - Contexto 2D del canvas off-screen.
 * @param {number} ox - Desplazamiento X.
 * @param {number} oy - Desplazamiento Y.
 * @param {number} w - Ancho del coche.
 * @param {number} h - Alto del coche.
 * @param {Object} o - Opciones: { color: string, plate?: string, stripe?: string, spoiler?: boolean }.
 */
function drawRearCar(g, ox, oy, w, h, o) {
  const base = o.color, hi = shade(base, 0.4), lo = shade(base, -0.45);
  g.save();
  g.translate(ox, oy);

  // 1. Sombra elíptica proyectada en el asfalto bajo los neumáticos
  g.fillStyle = 'rgba(0,0,0,0.45)';
  g.beginPath();
  g.ellipse(w / 2, h - 2, w * 0.52, 6, 0, 0, Math.PI * 2);
  g.fill();

  // 2. Ruedas traseras anchas (slick o semi-slick deportivo con banda de rodadura)
  const tw = w * 0.18, th = h * 0.44;
  g.fillStyle = '#0a0a0e';
  rrPath(g, 1, h - th - 3, tw, th, 4); g.fill();
  rrPath(g, w - tw - 1, h - th - 3, tw, th, 4); g.fill();
  g.fillStyle = '#1c1c24';
  g.fillRect(3, h - th + 2, tw - 4, th - 8);
  g.fillRect(w - tw + 1, h - th + 2, tw - 4, th - 8);

  // 3. Subchasis inferior y salidas dobles de escape metálicas cromadas
  g.fillStyle = '#151518';
  rrPath(g, tw - 2, h - 14, w - (tw - 2) * 2, 10, 2); g.fill();
  const exW = 6, exH = 4.5;
  for (const ex of [tw + 4, w - tw - 4 - exW]) {
    g.fillStyle = '#8a92a5';
    rrPath(g, ex, h - 11, exW, exH, 2); g.fill();
    g.fillStyle = '#111';
    g.beginPath(); g.ellipse(ex + exW / 2, h - 11 + exH / 2, exW * 0.35, exH * 0.35, 0, 0, Math.PI * 2); g.fill();
  }

  // 4. Difusor aerodinámico con aletas verticales
  g.fillStyle = '#1a1a20';
  for (let fx = w * 0.36; fx <= w * 0.64; fx += 7) {
    g.fillRect(fx, h - 12, 2, 7);
  }

  // 5. Paragolpes trasero esculpido con gradiente de iluminación cenital
  const by = h * 0.42, bw = w - 4, bh = h * 0.44;
  const bg = g.createLinearGradient(0, by, 0, by + bh);
  bg.addColorStop(0, hi); bg.addColorStop(0.3, base); bg.addColorStop(0.85, lo); bg.addColorStop(1, shade(base, -0.6));
  g.fillStyle = bg;
  rrPath(g, 2, by, bw, bh, 7); g.fill();
  g.strokeStyle = 'rgba(0,0,0,0.35)'; g.lineWidth = 1; g.stroke();

  // 6. Placa de matrícula trasera con marco blanco y tipografía retro dorada
  g.fillStyle = '#0a0d18';
  rrPath(g, w / 2 - 14, h - 21, 28, 9, 2); g.fill();
  g.strokeStyle = '#fff'; g.lineWidth = 0.6; g.stroke();
  g.fillStyle = '#ffe04a'; g.font = 'bold 6px sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(o.plate || 'RF 84', w / 2, h - 16.5);

  // 7. Cabina / Pilares C traseros con perfil trapezoidal
  const cy = h * 0.12, cw = w * 0.72, ch = h * 0.34;
  const cx0 = (w - cw) / 2;
  const tg = g.createLinearGradient(0, cy, 0, cy + ch);
  tg.addColorStop(0, shade(base, 0.25)); tg.addColorStop(1, lo);
  g.fillStyle = tg;
  g.beginPath();
  g.moveTo(cx0 + 8, cy); g.lineTo(cx0 + cw - 8, cy);
  g.lineTo(cx0 + cw, cy + ch); g.lineTo(cx0, cy + ch);
  g.closePath(); g.fill(); g.stroke();

  // 8. Luneta trasera tintada con reflejo luminoso angular
  const gl = g.createLinearGradient(0, cy + 3, 0, cy + ch);
  gl.addColorStop(0, '#0f1c30'); gl.addColorStop(0.6, '#28466b'); gl.addColorStop(1, '#537ea8');
  g.fillStyle = gl;
  g.beginPath();
  g.moveTo(cx0 + 11, cy + 4); g.lineTo(cx0 + cw - 11, cy + 4);
  g.lineTo(cx0 + cw - 4, cy + ch - 2); g.lineTo(cx0 + 4, cy + ch - 2);
  g.closePath(); g.fill();
  g.fillStyle = 'rgba(255,255,255,0.22)';
  g.beginPath();
  g.moveTo(cx0 + 16, cy + 4); g.lineTo(cx0 + 28, cy + 4);
  g.lineTo(cx0 + 20, cy + ch - 2); g.lineTo(cx0 + 8, cy + ch - 2);
  g.closePath(); g.fill();

  // 9. Franjas deportivas de carreras (si están configuradas)
  if (o.stripe) {
    g.fillStyle = o.stripe;
    g.globalAlpha = 0.9;
    g.fillRect(w / 2 - 7, cy, 5, h - cy - 8);
    g.fillRect(w / 2 + 2, cy, 5, h - cy - 8);
    g.globalAlpha = 1;
  }

  // 10. Alerón aerodinámico trasero con soportes verticales
  if (o.spoiler) {
    const sw = w * 0.92, sx = (w - sw) / 2, sy = cy - 2;
    g.fillStyle = '#111';
    g.fillRect(w * 0.32, sy + 3, 3, 9);
    g.fillRect(w * 0.65, sy + 3, 3, 9);
    const spg = g.createLinearGradient(0, sy, 0, sy + 6);
    spg.addColorStop(0, '#2b2b35'); spg.addColorStop(0.5, '#4a4a58'); spg.addColorStop(1, '#1b1b22');
    g.fillStyle = spg;
    rrPath(g, sx, sy, sw, 6, 2); g.fill();
    g.fillStyle = shade(base, 0.2);
    g.fillRect(sx + 2, sy + 1, sw - 4, 1.5);
    g.fillStyle = lo;
    g.fillRect(sx - 1, sy - 2, 3, 10);
    g.fillRect(sx + sw - 2, sy - 2, 3, 10);
  }

  // 11. Pilotos de freno traseros con glow rojo e intermitentes ámbar
  const lw = 15, lh = 8, ly = by + 5;
  for (const lx of [6, w - 6 - lw]) {
    g.fillStyle = '#2a0006';
    rrPath(g, lx, ly, lw, lh, 2.5); g.fill();
    g.shadowColor = 'rgba(255,30,40,0.85)'; g.shadowBlur = 6;
    g.fillStyle = '#ff2233';
    rrPath(g, lx + 1.5, ly + 1.5, lw - 3, lh - 3, 1.5); g.fill();
    g.shadowColor = 'transparent';
    g.fillStyle = '#ffb02e';
    g.fillRect(lx === 6 ? lx + lw - 4 : lx + 1, ly + 2, 3, lh - 4);
  }
  // Tercera luz de freno en la parte alta de la luneta
  g.fillStyle = '#ff1122';
  g.fillRect(w / 2 - 8, cy + 2, 16, 2.2);

  g.restore();
}

/**
 * Pre-renderiza la trasera de un coche en primera persona con margen para sombras y alerón.
 * @param {number} w - Ancho base.
 * @param {number} h - Alto base.
 * @param {Object} o - Opciones de color, matrícula y alerón.
 * @returns {{ c: HTMLCanvasElement, w: number, h: number }}
 */
function rearCarSprite(w, h, o) {
  return makeSprite(w + 16, h + 16, (g) => drawRearCar(g, 8, 8, w, h, o));
}

/**
 * Dibuja la vista trasera de un camión pesado en 3D (primera persona).
 * Cuenta con doble eje de ruedas gemelas, faldillas guardabarros 'RF',
 * paragolpes antiempotramiento a rayas de seguridad amarillas/negras,
 * puertas dobles de carga con fallebas de acero y luces de gálibo superiores.
 * 
 * @param {CanvasRenderingContext2D} g - Contexto 2D.
 * @param {number} ox - Desplazamiento X.
 * @param {number} oy - Desplazamiento Y.
 * @param {number} w - Ancho del camión.
 * @param {number} h - Alto del camión.
 * @param {Object} o - Opciones: { body: string, accent: string, label: string }.
 */
function drawRearTruck(g, ox, oy, w, h, o) {
  g.save();
  g.translate(ox, oy);

  // 1. Sombra bajo el eje trasero
  g.fillStyle = 'rgba(0,0,0,0.5)';
  g.beginPath();
  g.ellipse(w / 2, h - 2, w * 0.5, 7, 0, 0, Math.PI * 2);
  g.fill();

  // 2. Ruedas gemelas traseras (doble neumático por flanco)
  g.fillStyle = '#0d0d12';
  for (const wx of [2, 11, w - 21, w - 12]) {
    rrPath(g, wx, h - 24, 9, 23, 3); g.fill();
  }
  // Faldillas guardabarros con iniciales 'RF'
  g.fillStyle = '#1c1c24';
  g.fillRect(2, h - 18, 19, 14);
  g.fillRect(w - 21, h - 18, 19, 14);
  g.fillStyle = '#fff';
  g.font = 'bold 5px sans-serif'; g.textAlign = 'center';
  g.fillText('RF', 11, h - 6);
  g.fillText('RF', w - 11, h - 6);

  // 3. Paragolpes antiempotramiento a franjas diagonales de advertencia
  g.fillStyle = '#222';
  g.fillRect(16, h - 15, w - 32, 6);
  for (let i = 0; i < 6; i++) {
    g.fillStyle = i % 2 === 0 ? '#ffb82e' : '#111';
    g.fillRect(18 + i * 8, h - 15, 8, 6);
  }

  // 4. Carrocería de la caja de carga con puertas dobles
  const tw = w - 8, th = h - 22;
  const tg = g.createLinearGradient(4, 0, 4 + tw, 0);
  tg.addColorStop(0, shade(o.body, -0.25)); tg.addColorStop(0.5, o.body); tg.addColorStop(1, shade(o.body, -0.3));
  g.fillStyle = tg;
  rrPath(g, 4, 2, tw, th, 4); g.fill();
  g.strokeStyle = 'rgba(0,0,0,0.4)'; g.lineWidth = 1; g.stroke();

  // Batientes de las puertas con nervaduras de refuerzo
  const dw = tw / 2 - 2;
  for (const dx of [6, 4 + dw + 2]) {
    g.strokeStyle = 'rgba(0,0,0,0.25)'; g.lineWidth = 1;
    g.strokeRect(dx, 5, dw, th - 6);
    for (let y = 14; y < th - 8; y += 9) {
      g.strokeStyle = 'rgba(0,0,0,0.14)';
      g.beginPath(); g.moveTo(dx + 2, y); g.lineTo(dx + dw - 2, y); g.stroke();
      g.strokeStyle = 'rgba(255,255,255,0.18)';
      g.beginPath(); g.moveTo(dx + 2, y + 1); g.lineTo(dx + dw - 2, y + 1); g.stroke();
    }
  }

  // Barras de cerrojo verticales de acero y manetas de bloqueo
  g.fillStyle = '#b0b8c6';
  g.fillRect(w / 2 - 8, 8, 3, th - 12);
  g.fillRect(w / 2 + 5, 8, 3, th - 12);
  g.fillStyle = '#333';
  g.fillRect(w / 2 - 11, th * 0.6, 6, 4);
  g.fillRect(w / 2 + 5, th * 0.6, 6, 4);

  // Rótulo publicitario central
  g.fillStyle = o.accent; g.font = 'bold 13px Orbitron, sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(o.label, w / 2, th * 0.35);

  // 5. Luces de gálibo superiores
  for (let i = 0; i < 5; i++) {
    g.fillStyle = '#ff3030';
    g.beginPath(); g.arc(w * 0.28 + i * (w * 0.44 / 4), 5, 1.8, 0, Math.PI * 2); g.fill();
  }

  // 6. Pilotos traseros triples (intermitente ámbar, freno rojo y marcha atrás blanco)
  for (const lx of [23, w - 38]) {
    g.fillStyle = '#111'; g.fillRect(lx, h - 22, 15, 6);
    g.fillStyle = '#ffb82e'; g.fillRect(lx + 1, h - 21, 3.5, 4);
    g.fillStyle = '#ff2020'; g.fillRect(lx + 5.5, h - 21, 4, 4);
    g.fillStyle = '#ffffff'; g.fillRect(lx + 10.5, h - 21, 3.5, 4);
  }

  g.restore();
}

/**
 * Pre-renderiza la trasera de un camión en primera persona.
 * @param {number} w - Ancho.
 * @param {number} h - Alto.
 * @param {Object} o - Opciones.
 * @returns {{ c: HTMLCanvasElement, w: number, h: number }}
 */
function rearTruckSprite(w, h, o) {
  return makeSprite(w + 16, h + 16, (g) => drawRearTruck(g, 8, 8, w, h, o));
}

/**
 * Genera un árbol 3D en alzado vertical para primera persona.
 * Presenta tronco ensanchado en la base con corteza estriada y copa en 3 niveles esféricos.
 * 
 * @param {number} R - Radio de la copa.
 * @param {string[]} cols - Tonos verdes o rojizos.
 * @param {number} seed - Semilla PRNG.
 * @param {string} [fruit] - Frutos decorativos opcionales.
 * @returns {{ c: HTMLCanvasElement, w: number, h: number }}
 */
function tree3D(R, cols, seed, fruit) {
  const rng = mulberry32(seed), W = R * 2.2 + 20, H = R * 2.6 + 30;
  return makeSprite(W, H, (g) => {
    const cx = W / 2, by = H - 6;
    g.fillStyle = 'rgba(0,0,0,0.3)';
    g.beginPath(); g.ellipse(cx, by, R * 0.8, 8, 0, 0, Math.PI * 2); g.fill();

    // Tronco leñoso con ensanchamiento en raíces
    const trW = R * 0.28, trH = R * 1.0;
    const tg = g.createLinearGradient(cx - trW, 0, cx + trW, 0);
    tg.addColorStop(0, '#3e2716'); tg.addColorStop(0.4, '#6b4629'); tg.addColorStop(1, '#2c190c');
    g.fillStyle = tg;
    g.beginPath();
    g.moveTo(cx - trW * 0.6, by - trH);
    g.lineTo(cx + trW * 0.6, by - trH);
    g.quadraticCurveTo(cx + trW * 0.8, by - trH * 0.4, cx + trW * 1.1, by);
    g.lineTo(cx - trW * 1.1, by);
    g.quadraticCurveTo(cx - trW * 0.8, by - trH * 0.4, cx - trW * 0.6, by - trH);
    g.closePath(); g.fill();

    // Niveles foliáceos esféricos de la copa
    const cy = by - trH - R * 0.7;
    for (let k = 0; k < 3; k++) {
      const rad = R * (1 - k * 0.18);
      const dy = k * R * 0.25;
      const gr = g.createRadialGradient(cx - rad * 0.3, cy - dy - rad * 0.3, rad * 0.1, cx, cy - dy, rad);
      gr.addColorStop(0, shade(cols[k % cols.length], 0.3));
      gr.addColorStop(1, cols[(k + 1) % cols.length]);
      g.fillStyle = gr;
      g.beginPath(); g.arc(cx, cy - dy, rad, 0, Math.PI * 2); g.fill();
    }
    // Frutos dispersos
    if (fruit) {
      for (let i = 0; i < 8; i++) {
        const a = rng() * Math.PI * 2, d = rng() * R * 0.7;
        g.fillStyle = fruit;
        g.beginPath(); g.arc(cx + Math.cos(a) * d, cy + Math.sin(a) * d * 0.8, 3, 0, Math.PI * 2); g.fill();
      }
    }
  });
}

/**
 * Genera un pino 3D en alzado vertical para primera persona con pisos triangulares escalonados.
 * @param {number} R - Radio.
 * @param {string[]} cols - Tonos verdes.
 * @param {boolean} snow - Si true, añade crestas de nieve.
 * @returns {{ c: HTMLCanvasElement, w: number, h: number }}
 */
function pine3D(R, cols, snow) {
  const W = R * 2.2 + 20, H = R * 3.0 + 30;
  return makeSprite(W, H, (g) => {
    const cx = W / 2, by = H - 6;
    g.fillStyle = 'rgba(0,0,0,0.3)';
    g.beginPath(); g.ellipse(cx, by, R * 0.7, 7, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#4a2c16';
    g.fillRect(cx - 5, by - R * 0.8, 10, R * 0.8);

    // 4 niveles cónicos superpuestos
    const tiers = 4;
    for (let t = 0; t < tiers; t++) {
      const tw = R * (1.1 - t * 0.2);
      const ty0 = by - R * 0.6 - t * R * 0.55;
      const th = R * 0.75;
      const pg = g.createLinearGradient(cx - tw, 0, cx + tw, 0);
      pg.addColorStop(0, shade(cols[0], -0.2)); pg.addColorStop(0.4, shade(cols[0], 0.15)); pg.addColorStop(1, cols[1]);
      g.fillStyle = pg;
      g.beginPath();
      g.moveTo(cx, ty0 - th);
      g.lineTo(cx + tw, ty0);
      g.lineTo(cx - tw, ty0);
      g.closePath(); g.fill();
      if (snow) {
        g.fillStyle = 'rgba(255,255,255,0.85)';
        g.beginPath();
        g.moveTo(cx, ty0 - th);
        g.lineTo(cx + tw * 0.7, ty0 - th * 0.35);
        g.lineTo(cx - tw * 0.7, ty0 - th * 0.35);
        g.closePath(); g.fill();
      }
    }
  });
}

/**
 * Genera una palmera 3D en alzado vertical para primera persona con tronco esbelto arqueado.
 * @param {number} R - Longitud de las palmas.
 * @param {string[]} cols - Tonos verdes.
 * @param {number} seed - Semilla PRNG.
 * @returns {{ c: HTMLCanvasElement, w: number, h: number }}
 */
function palm3D(R, cols, seed) {
  const rng = mulberry32(seed), W = R * 2.4 + 20, H = R * 3.2 + 30;
  return makeSprite(W, H, (g) => {
    const cx = W / 2, by = H - 6;
    g.fillStyle = 'rgba(0,0,0,0.3)';
    g.beginPath(); g.ellipse(cx, by, R * 0.6, 6, 0, 0, Math.PI * 2); g.fill();

    // Tronco leñoso arqueado con anillos
    g.strokeStyle = '#7c5836'; g.lineWidth = 10; g.lineCap = 'round';
    g.beginPath();
    g.moveTo(cx, by);
    const midX = cx + (rng() - 0.5) * 20;
    const topX = cx + (rng() - 0.5) * 30;
    const topY = by - H + 28;
    g.quadraticCurveTo(midX, by - H * 0.5, topX, topY);
    g.stroke();

    // Anillos de corteza
    g.strokeStyle = '#53381e'; g.lineWidth = 1.8;
    for (let k = 0.1; k < 0.9; k += 0.08) {
      const y = by - H * k;
      g.beginPath(); g.moveTo(midX - 5, y); g.lineTo(midX + 5, y); g.stroke();
    }

    // Palmas curvadas hacia abajo por gravedad
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const len = R * (0.8 + rng() * 0.25);
      const ex = topX + Math.cos(a) * len;
      const ey = topY + Math.sin(a) * len * 0.5 + len * 0.35;
      g.strokeStyle = cols[i % 2]; g.lineWidth = 3.5;
      g.beginPath(); g.moveTo(topX, topY);
      g.quadraticCurveTo(topX + Math.cos(a) * len * 0.6, topY - 14, ex, ey);
      g.stroke();
    }
  });
}

/**
 * Genera un cactus saguaro 3D en alzado vertical para primera persona con brazos laterales.
 * @param {number} seed - Semilla PRNG.
 * @returns {{ c: HTMLCanvasElement, w: number, h: number }}
 */
function cactus3D(seed) {
  const S = 70;
  return makeSprite(S, S * 1.3, (g) => {
    const cx = S / 2, by = S * 1.3 - 4;
    g.fillStyle = 'rgba(0,0,0,0.3)';
    g.beginPath(); g.ellipse(cx, by, 18, 5, 0, 0, Math.PI * 2); g.fill();
    const cg = g.createLinearGradient(cx - 10, 0, cx + 10, 0);
    cg.addColorStop(0, '#2e6b36'); cg.addColorStop(0.4, '#5ab464'); cg.addColorStop(1, '#204e28');
    g.fillStyle = cg;

    // Tronco principal y brazos en 'U'
    rrPath(g, cx - 9, by - 65, 18, 65, 8); g.fill();
    rrPath(g, cx - 24, by - 46, 17, 10, 4); g.fill();
    rrPath(g, cx - 24, by - 58, 10, 20, 5); g.fill();
    rrPath(g, cx + 7, by - 38, 17, 10, 4); g.fill();
    rrPath(g, cx + 14, by - 52, 10, 22, 5); g.fill();

    // Espinas y flor de cactus rosada en la cúspide
    g.strokeStyle = 'rgba(0,40,10,0.35)'; g.lineWidth = 0.8;
    g.beginPath(); g.moveTo(cx - 4, by - 62); g.lineTo(cx - 4, by); g.stroke();
    g.beginPath(); g.moveTo(cx + 4, by - 62); g.lineTo(cx + 4, by); g.stroke();
    g.fillStyle = '#ff7ab4';
    g.beginPath(); g.arc(cx, by - 67, 3.5, 0, Math.PI * 2); g.fill();
  });
}

/**
 * Genera una roca poliédrica 3D en perspectiva vertical.
 * @param {number} R - Radio.
 * @param {string[]} cols - Colores de roca.
 * @param {number} seed - Semilla PRNG.
 * @returns {{ c: HTMLCanvasElement, w: number, h: number }}
 */
function rock3D(R, cols, seed) {
  const rng = mulberry32(seed), W = R * 2 + 16, H = R * 1.6 + 12;
  return makeSprite(W, H, (g) => {
    const cx = W / 2, by = H - 4;
    g.fillStyle = 'rgba(0,0,0,0.35)';
    g.beginPath(); g.ellipse(cx, by, R * 0.9, 6, 0, 0, Math.PI * 2); g.fill();
    const pts = [
      [cx - R * 0.85, by - R * 0.2],
      [cx - R * 0.65, by - R * 0.85],
      [cx - R * 0.1, by - R * 1.1],
      [cx + R * 0.55, by - R * 0.95],
      [cx + R * 0.9, by - R * 0.3],
      [cx + R * 0.6, by],
      [cx - R * 0.5, by]
    ];
    g.beginPath();
    pts.forEach(([x, y], i) => i ? g.lineTo(x, y) : g.moveTo(x, y));
    g.closePath();
    const gr = g.createLinearGradient(cx - R, by - R, cx + R, by);
    gr.addColorStop(0, cols[0]); gr.addColorStop(1, cols[1]);
    g.fillStyle = gr; g.fill();
    g.strokeStyle = 'rgba(0,0,0,0.4)'; g.lineWidth = 1.2; g.stroke();
    g.fillStyle = 'rgba(255,255,255,0.2)';
    g.beginPath();
    g.moveTo(cx - R * 0.65, by - R * 0.85);
    g.lineTo(cx - R * 0.1, by - R * 1.1);
    g.lineTo(cx + R * 0.1, by - R * 0.5);
    g.lineTo(cx - R * 0.4, by - R * 0.4);
    g.closePath(); g.fill();
  });
}

/**
 * Genera una casa o construcción 3D vista desde el nivel del suelo (primera persona).
 * Cuenta con fachada, puerta de madera, ventana acristalada con cruceta y tejado.
 * 
 * @param {number} w - Ancho de fachada.
 * @param {number} h - Alto de la construcción.
 * @param {Object} o - Opciones: { roof: string, flat?: boolean, snow?: boolean }.
 * @returns {{ c: HTMLCanvasElement, w: number, h: number }}
 */
function house3D(w, h, o) {
  const W = w + 16, H = h + 24;
  return makeSprite(W, H, (g) => {
    const cx = W / 2, by = H - 4;
    g.fillStyle = 'rgba(0,0,0,0.35)';
    g.beginPath(); g.ellipse(cx, by, w * 0.55, 8, 0, 0, Math.PI * 2); g.fill();

    // Muros de fachada
    const wallY = by - h * 0.55, wallH = h * 0.55;
    g.fillStyle = '#d8d3c5';
    g.fillRect(cx - w * 0.45, wallY, w * 0.9, wallH);
    g.strokeStyle = 'rgba(0,0,0,0.3)'; g.lineWidth = 1; g.strokeRect(cx - w * 0.45, wallY, w * 0.9, wallH);

    // Puerta de entrada y ventana con cristal reflectante
    g.fillStyle = '#5c3a21';
    g.fillRect(cx - 7, by - 22, 14, 22);
    g.fillStyle = '#6ab8d9';
    g.fillRect(cx + 14, by - 20, 14, 14);
    g.strokeStyle = '#fff'; g.lineWidth = 1; g.strokeRect(cx + 14, by - 20, 14, 14);

    // Tejado triangular o plano
    if (o && o.flat) {
      g.fillStyle = o.roof;
      rrPath(g, cx - w * 0.48, wallY - 8, w * 0.96, 10, 2); g.fill();
    } else {
      const roofCol = (o && o.roof) || '#a83c2e';
      g.fillStyle = roofCol;
      g.beginPath();
      g.moveTo(cx, wallY - h * 0.45);
      g.lineTo(cx + w * 0.52, wallY);
      g.lineTo(cx - w * 0.52, wallY);
      g.closePath(); g.fill();
      g.strokeStyle = 'rgba(0,0,0,0.3)'; g.stroke();
      if (o && o.snow) {
        g.fillStyle = 'rgba(255,255,255,0.85)';
        g.beginPath();
        g.moveTo(cx, wallY - h * 0.45);
        g.lineTo(cx + w * 0.35, wallY - h * 0.2);
        g.lineTo(cx - w * 0.35, wallY - h * 0.2);
        g.closePath(); g.fill();
      }
    }
  });
}

/* ==================================================== CATÁLOGO EN PRIMERA PERSONA (FP) Y CABINA */

/**
 * Catálogo de sprites optimizados para la cámara 3D en primera persona (Cockpit).
 * Incluye tráfico trasero, bidón y aceite 3D, volante de carreras animado,
 * capó aerodinámico y espejo retrovisor panorámico funcional.
 */
Sprites.fp = {
  // Sedanes de tráfico con matrículas retro variadas (RF 84, TURBO, GT-16, etc.)
  sedans: ['#2f6df0', '#f3f4f6', '#12b5a6', '#8e44ad', '#8a95a0', '#ff8a1f', '#1f9d55']
    .map((c, i) => rearCarSprite(68, 48, { color: c, plate: ['RF 84', 'TURBO', 'GT-16', '16V', 'SPEED', 'ARCADE', 'DRIFT'][i % 7] })),

  // Deportivos veloces con alerón trasero de competición
  sports: ['#ffd400', '#ff2d95', '#00d4ff']
    .map((c, i) => rearCarSprite(72, 48, { color: c, stripe: '#14141a', spoiler: true, plate: ['NITRO', 'GT-R', 'VMAX'][i % 3] })),

  // Camiones de transporte vistos por detrás
  trucks: [
    { body: '#e9ecef', accent: '#d64545', label: 'TRANS' },
    { body: '#2c7be5', accent: '#ffffff', label: 'CARGO' },
    { body: '#2e9d57', accent: '#ffffff', label: 'EXPRESS' },
  ].map((o) => rearTruckSprite(88, 82, o)),

  // Bidón de combustible 3D con halo áureo
  fuel: makeSprite(56, 56, (g) => {
    g.translate(28, 28);
    g.shadowColor = 'rgba(255,214,70,0.95)'; g.shadowBlur = 14;
    const ring = g.createRadialGradient(0, 0, 4, 0, 0, 24);
    ring.addColorStop(0, '#fff3a8'); ring.addColorStop(1, '#ff9d1c');
    g.fillStyle = ring; g.beginPath(); g.arc(0, 0, 24, 0, Math.PI * 2); g.fill();
    g.shadowColor = 'transparent';
    g.lineWidth = 2.5; g.strokeStyle = '#fff'; g.stroke();
    const cg = g.createLinearGradient(-10, 0, 10, 0);
    cg.addColorStop(0, '#9e0d19'); cg.addColorStop(0.4, '#ff4755'); cg.addColorStop(1, '#9e0d19');
    g.fillStyle = cg;
    rrPath(g, -9, -9, 18, 20, 3); g.fill();
    g.fillStyle = '#fff'; g.font = 'bold 12px Orbitron, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('F', 0, 1);
  }),

  // Charco de aceite elíptico achatado por perspectiva de carretera
  oil: makeSprite(84, 38, (g) => {
    const blob = () => {
      g.beginPath();
      g.ellipse(42, 19, 36, 14, 0, 0, Math.PI * 2);
    };
    g.shadowColor = 'rgba(0,0,0,0.45)'; g.shadowBlur = 6;
    blob();
    const rg = g.createRadialGradient(36, 15, 2, 42, 19, 38);
    rg.addColorStop(0, '#2b2b36'); rg.addColorStop(1, '#07070b');
    g.fillStyle = rg; g.fill();
    g.shadowColor = 'transparent';
    g.save(); blob(); g.clip();
    const sh = g.createLinearGradient(10, 6, 74, 32);
    sh.addColorStop(0, 'rgba(120,80,255,0.6)'); sh.addColorStop(0.33, 'rgba(40,220,200,0.5)');
    sh.addColorStop(0.66, 'rgba(255,90,180,0.45)'); sh.addColorStop(1, 'rgba(90,150,255,0.5)');
    g.fillStyle = sh; g.fillRect(0, 0, 84, 38);
    g.fillStyle = 'rgba(255,255,255,0.45)';
    g.beginPath(); g.ellipse(32, 14, 14, 3, -0.2, 0, Math.PI * 2); g.fill();
    g.restore();
  }),

  // Volante deportivo de tres radios, con cuero perforado, marca centradora roja a las 12h y logo 'RF'
  steeringWheel: makeSprite(220, 220, (g) => {
    const cx = 110, cy = 110, R = 88;
    g.shadowColor = 'rgba(0,0,0,0.55)'; g.shadowBlur = 12; g.shadowOffsetY = 6;
    g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2);
    g.lineWidth = 17; g.strokeStyle = '#121216'; g.stroke();
    g.shadowColor = 'transparent';

    // Aro exterior forrado en cuero con textura volumétrica
    const rg = g.createRadialGradient(cx - 30, cy - 30, R - 20, cx, cy, R + 20);
    rg.addColorStop(0, '#3a3a46'); rg.addColorStop(0.6, '#18181f'); rg.addColorStop(1, '#0c0c10');
    g.strokeStyle = rg; g.lineWidth = 16; g.stroke();

    // Empuñaduras laterales microperforadas antideslizantes
    for (const a of [0, Math.PI]) {
      g.save(); g.translate(cx, cy); g.rotate(a);
      g.fillStyle = 'rgba(255,255,255,0.06)';
      for (let dx = -14; dx <= 14; dx += 5) {
        for (let dy = -6; dy <= 6; dy += 4) {
          g.beginPath(); g.arc(R + dy, dx, 0.8, 0, Math.PI * 2); g.fill();
        }
      }
      g.restore();
    }

    // Marca centradora roja de carreras a las 12 en punto
    g.fillStyle = '#ff2b3d';
    g.fillRect(cx - 4.5, cy - R - 8, 9, 16);

    // Radios de aluminio perforados
    const spoke = (rot) => {
      g.save(); g.translate(cx, cy); g.rotate(rot);
      const sg = g.createLinearGradient(0, 0, R, 0);
      sg.addColorStop(0, '#2d2d38'); sg.addColorStop(0.5, '#424250'); sg.addColorStop(1, '#1b1b22');
      g.fillStyle = sg;
      g.beginPath();
      g.moveTo(22, -9); g.lineTo(R - 4, -13); g.lineTo(R - 4, 13); g.lineTo(22, 9);
      g.closePath(); g.fill();
      g.strokeStyle = 'rgba(0,0,0,0.4)'; g.lineWidth = 1; g.stroke();
      for (const hx of [38, 54, 70]) {
        g.fillStyle = '#0a0a0f';
        g.beginPath(); g.arc(hx, 0, 3.2, 0, Math.PI * 2); g.fill();
      }
      g.restore();
    };
    spoke(Math.PI);     // Radio izquierdo (a las 9h)
    spoke(0);           // Radio derecho (a las 3h)
    spoke(Math.PI / 2); // Radio inferior (a las 6h)

    // Núcleo central del claxon con tornillos Allen y escudo dorado 'RF'
    const ng = g.createRadialGradient(cx - 8, cy - 8, 2, cx, cy, 32);
    ng.addColorStop(0, '#424252'); ng.addColorStop(0.8, '#1b1b24'); ng.addColorStop(1, '#0d0d12');
    g.fillStyle = ng;
    g.beginPath(); g.arc(cx, cy, 32, 0, Math.PI * 2); g.fill();
    g.strokeStyle = '#5a5a6e'; g.lineWidth = 1.5; g.stroke();
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const bx = cx + Math.cos(a) * 25, by = cy + Math.sin(a) * 25;
      g.fillStyle = '#8a92a5'; g.beginPath(); g.arc(bx, by, 2, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#111'; g.beginPath(); g.arc(bx, by, 0.9, 0, Math.PI * 2); g.fill();
    }
    const eg = g.createLinearGradient(cx - 16, cy - 16, cx + 16, cy + 16);
    eg.addColorStop(0, '#ff3d54'); eg.addColorStop(1, '#b01025');
    g.fillStyle = eg;
    g.beginPath(); g.arc(cx, cy, 18, 0, Math.PI * 2); g.fill();
    g.strokeStyle = '#ffd700'; g.lineWidth = 1.2; g.stroke();
    g.fillStyle = '#fff'; g.font = '900 12px Orbitron, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('RF', cx, cy);
  }),

  // Capó del coche del jugador visto desde el parabrisas (rojo bermellón, franjas dobles y toma de aire)
  hood: makeSprite(460, 160, (g) => {
    const w = 460, h = 160;
    const topW = w * 0.62, botW = w;
    const topX = (w - topW) / 2, botX = 0;

    // Perfil trapezoidal del morro
    const body = () => {
      g.beginPath();
      g.moveTo(topX, 0);
      g.lineTo(topX + topW, 0);
      g.quadraticCurveTo(w - 6, h * 0.6, botW, h);
      g.lineTo(botX, h);
      g.quadraticCurveTo(6, h * 0.6, topX, 0);
      g.closePath();
    };
    body();
    const hg = g.createLinearGradient(0, 0, 0, h);
    hg.addColorStop(0, '#c71020'); hg.addColorStop(0.3, '#ff2e42'); hg.addColorStop(0.7, '#d61528'); hg.addColorStop(1, '#8f0a17');
    g.fillStyle = hg; g.fill();
    g.strokeStyle = '#5a060e'; g.lineWidth = 2; g.stroke();

    // Reflejo curvo del cielo y el horizonte sobre la chapa
    g.save(); body(); g.clip();
    const sh = g.createLinearGradient(0, 0, w, 0);
    sh.addColorStop(0, 'rgba(0,0,0,0.25)');
    sh.addColorStop(0.35, 'rgba(255,255,255,0.25)');
    sh.addColorStop(0.65, 'rgba(255,255,255,0.25)');
    sh.addColorStop(1, 'rgba(0,0,0,0.25)');
    g.fillStyle = sh; g.fillRect(0, 0, w, h);

    // Franjas gemelas blancas de carreras
    g.fillStyle = 'rgba(255,255,255,0.92)';
    const stW0 = 16, stW1 = 28;
    g.beginPath();
    g.moveTo(w / 2 - stW0 - 4, 0); g.lineTo(w / 2 - 4, 0);
    g.lineTo(w / 2 - 6, h); g.lineTo(w / 2 - stW1 - 6, h);
    g.closePath(); g.fill();
    g.beginPath();
    g.moveTo(w / 2 + 4, 0); g.lineTo(w / 2 + stW0 + 4, 0);
    g.lineTo(w / 2 + stW1 + 6, h); g.lineTo(w / 2 + 6, h);
    g.closePath(); g.fill();

    // Toma de aire central del motor con rejilla de disipación térmica
    g.fillStyle = '#1c0306';
    rrPath(g, w / 2 - 32, 18, 64, 22, 5); g.fill();
    g.fillStyle = '#ff4a5a';
    rrPath(g, w / 2 - 30, 20, 60, 4, 2); g.fill();
    g.fillStyle = '#0a0a0f';
    for (let x = w / 2 - 26; x <= w / 2 + 24; x += 5) {
      g.fillRect(x, 25, 2, 12);
    }
    g.restore();
  }),

  // Marco y soporte del espejo retrovisor interior panorámico
  mirror: makeSprite(160, 46, (g) => {
    g.fillStyle = 'rgba(0,0,0,0.45)';
    g.beginPath(); g.ellipse(80, 26, 76, 18, 0, 0, Math.PI * 2); g.fill();
    const cg = g.createLinearGradient(0, 2, 0, 44);
    cg.addColorStop(0, '#2d2d38'); cg.addColorStop(1, '#0e0e13');
    g.fillStyle = cg;
    rrPath(g, 4, 2, 152, 40, 9); g.fill();
    g.strokeStyle = '#4a4a58'; g.lineWidth = 1.5; g.stroke();
    g.fillStyle = '#1b1b22';
    g.fillRect(75, 0, 10, 5); // Anclaje superior al parabrisas
  })
};

/* ------------------------------------------------ ASIGNACIÓN DE PAISAJES 3D POR ETAPA */
Sprites.THEMES[0].scenery3D = [
  tree3D(36, ['#6fcf5a', '#3f9e3b', '#2a7a2e'], 11),
  tree3D(30, ['#8bdc62', '#4ea63d', '#307f30'], 12),
  pine3D(32, ['#3f9a5a', '#1d6a3a'], false),
  tree3D(32, ['#7ad05a', '#3f9e3b'], 13, '#ff4d4d'),
  rock3D(16, ['#b9bec6', '#6f7580'], 23),
  house3D(70, 50, { roof: '#c0503f' })
];

Sprites.THEMES[1].scenery3D = [
  palm3D(42, ['#78c25a', '#3e9a45'], 31),
  palm3D(36, ['#8ed062', '#43a24a'], 32),
  rock3D(30, ['#d9b98a', '#9a7a52'], 33),
  cactus3D(41),
  cactus3D(42),
  rock3D(16, ['#d1b184', '#8f7048'], 45),
  house3D(70, 50, { roof: '#e0b98a', flat: true })
];

Sprites.THEMES[2].scenery3D = [
  tree3D(36, ['#ffb347', '#e0731d', '#a8450f'], 51),
  tree3D(32, ['#ff8a5c', '#d1452a', '#8f2a1a'], 52),
  tree3D(34, ['#ffd45e', '#e0a41d', '#a8730f'], 53),
  pine3D(32, ['#4d7a3a', '#2a5128'], false),
  rock3D(16, ['#b5aea3', '#6e665c'], 56),
  house3D(70, 50, { roof: '#7a4a2b' })
];

Sprites.THEMES[3].scenery3D = [
  pine3D(36, ['#3f8f6a', '#1d5a46'], true),
  pine3D(30, ['#4a9a74', '#216650'], true),
  rock3D(16, ['#cfd8e2', '#7b8795'], 63),
  house3D(70, 50, { roof: '#a54a3a', snow: true })
];

// La etapa 5 (noche) comparte el catálogo de atrezo 3D de la pradera
Sprites.THEMES[4].scenery3D = Sprites.THEMES[0].scenery3D;



/* ==========================================================================
   OBSTÁCULOS ADICIONALES: PEATONES, BACHES, BARRERAS DE OBRA Y PASO DE CEBRA
   Cada uno tiene versión cenital (2D) y versión en primera persona (fp).
   ========================================================================== */

/**
 * Peatón visto desde arriba (vista cenital), orientado hacia arriba.
 * Dos fotogramas con las piernas alternadas para animar la caminata.
 * @param {string} shirt - Color de la camiseta.
 * @param {string} hair - Color del pelo.
 * @param {number} step - Fotograma (0 o 1).
 */
function pedTopSprite(shirt, hair, step) {
  return makeSprite(30, 30, (g) => {
    g.translate(15, 15);
    // Sombra
    g.fillStyle = 'rgba(0,0,0,0.3)';
    g.beginPath(); g.ellipse(2, 3, 10, 7, 0, 0, Math.PI * 2); g.fill();
    // Piernas (una adelantada según el fotograma)
    g.fillStyle = '#2b3550';
    const s = step ? 1 : -1;
    rrPath(g, -6, -2 - 5 * s, 4.5, 9, 2); g.fill();
    rrPath(g, 1.5, -2 + 5 * s, 4.5, 9, 2); g.fill();
    // Brazos
    g.fillStyle = '#f0c29a';
    g.beginPath(); g.arc(-9, 2 * s, 2.4, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.arc(9, -2 * s, 2.4, 0, Math.PI * 2); g.fill();
    // Torso (hombros)
    g.fillStyle = shirt;
    rrPath(g, -9, -4, 18, 9, 4); g.fill();
    g.strokeStyle = 'rgba(0,0,0,0.3)'; g.lineWidth = 1; g.stroke();
    // Cabeza
    g.fillStyle = hair;
    g.beginPath(); g.arc(0, 0, 5, 0, Math.PI * 2); g.fill();
  });
}

/**
 * Peatón visto de frente (primera persona), de pie o caminando.
 * @param {string} shirt - Color de la camiseta.
 * @param {string} hair - Color del pelo.
 * @param {number} step - Fotograma (0 o 1).
 */
function pedFrontSprite(shirt, hair, step) {
  return makeSprite(30, 66, (g) => {
    const s = step ? 1 : -1;
    // Piernas
    g.fillStyle = '#2b3550';
    rrPath(g, 9 + s, 40, 5.5, 24, 2); g.fill();
    rrPath(g, 15.5 - s, 40, 5.5, 24, 2); g.fill();
    // Zapatos
    g.fillStyle = '#1a1a1f';
    rrPath(g, 8 + s, 61, 7.5, 4, 1.5); g.fill();
    rrPath(g, 14.5 - s, 61, 7.5, 4, 1.5); g.fill();
    // Torso
    g.fillStyle = shirt;
    rrPath(g, 7, 18, 16, 24, 4); g.fill();
    // Brazos balanceándose
    g.fillStyle = shirt;
    rrPath(g, 3 - s, 19, 4.5, 18, 2); g.fill();
    rrPath(g, 22.5 + s, 19, 4.5, 18, 2); g.fill();
    g.fillStyle = '#f0c29a';
    g.beginPath(); g.arc(5.2 - s, 38, 2.4, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.arc(24.8 + s, 38, 2.4, 0, Math.PI * 2); g.fill();
    // Cabeza y pelo
    g.fillStyle = '#f0c29a';
    g.beginPath(); g.arc(15, 10, 7, 0, Math.PI * 2); g.fill();
    g.fillStyle = hair;
    g.beginPath(); g.arc(15, 8, 7, Math.PI, Math.PI * 2); g.fill();
  });
}

/** Paleta de peatones: [camiseta, pelo] */
const PED_LOOKS = [['#ff5a5f', '#3b2a1e'], ['#4cc9f0', '#111'], ['#ffd166', '#6b4226'], ['#9b5de5', '#2b1d12']];

/** Peatones en vista cenital: Sprites.peds[i] = [fotograma0, fotograma1] */
Sprites.peds = PED_LOOKS.map(([s, h]) => [pedTopSprite(s, h, 0), pedTopSprite(s, h, 1)]);

/**
 * Bache (hueco en el asfalto) en vista cenital: borde irregular claro y fondo oscuro.
 */
Sprites.hole = makeSprite(56, 42, (g) => {
  const shape = (k) => {
    g.beginPath();
    for (let i = 0; i <= 12; i++) {
      const a = i / 12 * Math.PI * 2;
      const r = 1 + 0.12 * Math.sin(a * 3 + 1) + 0.08 * Math.cos(a * 5);
      const x = 28 + Math.cos(a) * 24 * r * k, y = 21 + Math.sin(a) * 16 * r * k;
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.closePath();
  };
  g.fillStyle = '#9a9aa2'; shape(1); g.fill();        // borde de asfalto roto
  const rg = g.createRadialGradient(26, 18, 2, 28, 21, 22);
  rg.addColorStop(0, '#050506'); rg.addColorStop(1, '#2a2a30');
  g.fillStyle = rg; shape(0.82); g.fill();             // fondo del hueco
  g.strokeStyle = 'rgba(0,0,0,0.5)'; g.lineWidth = 1; shape(1); g.stroke();
  // Grietas alrededor
  g.strokeStyle = 'rgba(20,20,24,0.7)'; g.lineWidth = 1.2;
  g.beginPath(); g.moveTo(3, 12); g.lineTo(8, 16); g.moveTo(52, 30); g.lineTo(47, 26); g.moveTo(30, 40); g.lineTo(29, 36); g.stroke();
});

/**
 * Barrera de obras en vista cenital: tablón a rayas rojas y blancas con un cono a cada lado.
 */
Sprites.barrier = makeSprite(70, 30, (g) => {
  g.fillStyle = 'rgba(0,0,0,0.3)';
  rrPath(g, 6, 11, 60, 14, 3); g.fill();
  // Tablón a rayas
  g.save();
  rrPath(g, 6, 8, 58, 12, 3); g.clip();
  for (let x = -10; x < 70; x += 12) {
    g.fillStyle = (x / 12) % 2 === 0 ? '#e63946' : '#ffffff';
    g.beginPath(); g.moveTo(x, 8); g.lineTo(x + 12, 8); g.lineTo(x + 4, 20); g.lineTo(x - 8, 20); g.closePath(); g.fill();
  }
  g.restore();
  g.strokeStyle = 'rgba(0,0,0,0.45)'; g.lineWidth = 1; rrPath(g, 6, 8, 58, 12, 3); g.stroke();
  // Conos (vistos desde arriba: círculos concéntricos)
  for (const cx of [6, 64]) {
    g.fillStyle = '#ff7b00'; g.beginPath(); g.arc(cx, 14, 6.5, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#fff'; g.beginPath(); g.arc(cx, 14, 4, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#ff7b00'; g.beginPath(); g.arc(cx, 14, 2, 0, Math.PI * 2); g.fill();
  }
  // Luz ámbar de aviso
  g.fillStyle = '#ffd400'; g.shadowColor = '#ffd400'; g.shadowBlur = 6;
  g.beginPath(); g.arc(35, 6, 3, 0, Math.PI * 2); g.fill();
});

/**
 * Paso de cebra (vista cenital) que cubre el ancho de la calzada (320 px).
 */
Sprites.zebra = makeSprite(320, 40, (g) => {
  g.fillStyle = 'rgba(255,255,255,0.9)';
  for (let x = 6; x < 320; x += 32) g.fillRect(x, 2, 18, 36);
});

/* --------------------------------------------- Versiones en primera persona (fp) */
Sprites.fp.peds = PED_LOOKS.map(([s, h]) => [pedFrontSprite(s, h, 0), pedFrontSprite(s, h, 1)]);

/** Bache aplanado por la perspectiva (como el charco de aceite) */
Sprites.fp.hole = makeSprite(80, 30, (g) => {
  g.fillStyle = '#8d8d95';
  g.beginPath(); g.ellipse(40, 15, 37, 13, 0, 0, Math.PI * 2); g.fill();
  const rg = g.createRadialGradient(40, 12, 2, 40, 15, 34);
  rg.addColorStop(0, '#020203'); rg.addColorStop(1, '#25252b');
  g.fillStyle = rg;
  g.beginPath(); g.ellipse(40, 16, 31, 10, 0, 0, Math.PI * 2); g.fill();
});

/** Barrera de obras vista de frente: tablón a rayas sobre dos patas, con conos y luz ámbar */
Sprites.fp.barrier = makeSprite(90, 48, (g) => {
  // Patas
  g.fillStyle = '#d9d9de';
  g.fillRect(14, 22, 5, 24); g.fillRect(71, 22, 5, 24);
  // Tablón a rayas
  g.save();
  rrPath(g, 6, 14, 78, 13, 2); g.clip();
  for (let x = -14; x < 96; x += 14) {
    g.fillStyle = (x / 14) % 2 === 0 ? '#e63946' : '#ffffff';
    g.beginPath(); g.moveTo(x, 14); g.lineTo(x + 14, 14); g.lineTo(x + 4, 27); g.lineTo(x - 10, 27); g.closePath(); g.fill();
  }
  g.restore();
  g.strokeStyle = 'rgba(0,0,0,0.5)'; g.lineWidth = 1; rrPath(g, 6, 14, 78, 13, 2); g.stroke();
  // Conos
  for (const cx of [4, 86]) {
    g.fillStyle = '#ff7b00';
    g.beginPath(); g.moveTo(cx, 26); g.lineTo(cx + 6, 46); g.lineTo(cx - 6, 46); g.closePath(); g.fill();
    g.fillStyle = '#fff'; g.fillRect(cx - 3.5, 34, 7, 3.5);
  }
  // Luz ámbar
  g.fillStyle = '#ffd400'; g.shadowColor = '#ffd400'; g.shadowBlur = 8;
  g.beginPath(); g.arc(45, 8, 4.5, 0, Math.PI * 2); g.fill();
});

/* ==========================================================================
   SEÑAL DE CURVA PELIGROSA (antes de cada curva cerrada del trazado generado)
   Índice 0 = curva a la izquierda, 1 = curva a la derecha.
   ========================================================================== */

/**
 * Rombo amarillo con dos chevrones negros que apuntan hacia el sentido de la curva.
 * @param {CanvasRenderingContext2D} g - Contexto de dibujo.
 * @param {number} cx - Centro X.
 * @param {number} cy - Centro Y.
 * @param {number} r - Semidiagonal del rombo.
 * @param {number} dir - -1 izquierda, 1 derecha.
 */
function drawCurveDiamond(g, cx, cy, r, dir) {
  g.beginPath();
  g.moveTo(cx, cy - r); g.lineTo(cx + r, cy); g.lineTo(cx, cy + r); g.lineTo(cx - r, cy); g.closePath();
  g.fillStyle = '#ffd400'; g.fill();
  g.lineWidth = Math.max(1.5, r * 0.12); g.strokeStyle = '#1a1a1f'; g.stroke();
  g.fillStyle = '#1a1a1f';
  for (const off of [-0.32, 0.12]) {
    const x = cx + dir * off * r;
    g.beginPath();
    g.moveTo(x - dir * r * 0.12, cy - r * 0.38);
    g.lineTo(x + dir * r * 0.26, cy);
    g.lineTo(x - dir * r * 0.12, cy + r * 0.38);
    g.lineTo(x - dir * r * 0.3, cy + r * 0.38);
    g.lineTo(x + dir * r * 0.08, cy);
    g.lineTo(x - dir * r * 0.3, cy - r * 0.38);
    g.closePath(); g.fill();
  }
}

/** Vista cenital: el rombo visto desde arriba con su sombra sobre la acera */
Sprites.curveSign = [-1, 1].map((dir) => makeSprite(40, 40, (g) => {
  g.fillStyle = 'rgba(0,0,0,0.3)';
  g.beginPath(); g.ellipse(22, 24, 15, 15, 0, 0, Math.PI * 2); g.fill();
  drawCurveDiamond(g, 20, 20, 17, dir);
}));

/** Primera persona: rombo sobre un poste */
Sprites.fp.curveSign = [-1, 1].map((dir) => makeSprite(44, 80, (g) => {
  g.fillStyle = '#9aa0a8'; g.fillRect(20, 36, 4, 44);
  drawCurveDiamond(g, 22, 22, 20, dir);
}));
