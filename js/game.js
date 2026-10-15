'use strict';
/* ==========================================================================
   ROAD FIGHTER · Motor Principal del Juego (Core Game Engine)
   --------------------------------------------------------------------------
   Arquitectura del sistema:
   - Soporte de renderizado híbrido: Vista Cenital Clásica (Top-Down 2D) y Vista
     en Primera Persona (Cockpit 3D) conmutables en tiempo real con tecla 'C'.
   - Motor de física pseudo-3D tipo retro arcade (proyección perspectiva Z con
     cálculo de escala focal, curvatura horizontal con funciones seno y paralaje).
   - Generación procedural continua de tráfico y decorados mediante PRNG determinista.
   - Bucle de tiempo delta (dt) independiente de los FPS de la pantalla.
   ========================================================================== */
(() => {
  const { THEMES } = Sprites;

  /* ----------------------------------------------------------- CONSTANTES DE CONFIGURACIÓN */
  /** Ancho y alto lógico del viewport de juego en píxeles */
  const W = 560, H = 760;

  /** Posición vertical Y de referencia del coche del jugador en modo 2D */
  const PY = H - 175;

  /** Semi-ancho del asfalto (distancia del centro al borde de la calzada) */
  const ROAD_HALF = 160;

  /** Ancho del bordillo o arcén pintado */
  const CURB = 16;

  /** Borde exterior total de la carretera (asfalto + bordillo) */
  const EDGE = ROAD_HALF + CURB;

  /** Coordenadas X de los centros de los 4 carriles de circulación (-120 a +120) */
  const LANES = [-120, -40, 40, 120];

  /** Factor de conversión: píxeles recorridos en el mundo por cada km/h y segundo */
  const PX = 2.4;

  /** Altura en píxeles de cada franja horizontal de rasterizado de carretera en 2D */
  const STRIP = 4;

  /** Tipografía retro-futurista estándar para textos y HUD */
  const FONT = '"Orbitron", "Segoe UI", sans-serif';

  /**
   * Configuración de las 5 etapas o niveles del juego:
   * - name: Nombre descriptivo.
   * - theme: Índice de paleta/bioma en Sprites.THEMES.
   * - len: Longitud total de la etapa en píxeles de distancia.
   * - curve: Coeficiente de intensidad de las curvas del trazado.
   * - density: Multiplicador de frecuencia de aparición del tráfico.
   */
  const STAGES = [
    { name: 'PRADERA',   theme: 0, len: 24000, curve: 0.25, density: 1.0 },
    { name: 'DESIERTO',  theme: 1, len: 28000, curve: 0.55, density: 1.15 },
    { name: 'OTOÑO',     theme: 2, len: 32000, curve: 0.8,  density: 1.3 },
    { name: 'NIEVE',     theme: 3, len: 36000, curve: 1.0,  density: 1.45 },
    { name: 'NOCHE',     theme: 4, len: 40000, curve: 1.1,  density: 1.6 },
  ];

  // Elemento canvas principal y contexto 2D con soporte para alta densidad de píxeles (Retina/DPR)
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const DPR = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = W * DPR;
  canvas.height = H * DPR;

  // Canvas auxiliar en memoria para la máscara de iluminación nocturna
  const nightCv = document.createElement('canvas');
  nightCv.width = W * DPR; nightCv.height = H * DPR;
  const nightCtx = nightCv.getContext('2d');

  /* ---------------------------------------------------------------- UTILIDADES MATEMÁTICAS */
  /** Retorna un número aleatorio flotante entre 'a' y 'b'. */
  const rand = (a, b) => a + Math.random() * (b - a);

  /** Restringe un valor dentro del intervalo cerrado [a, b]. */
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  /** Formatea un número entero con relleno de ceros a la izquierda (ej. 000450). */
  const pad = (n, l = 6) => String(Math.floor(n)).padStart(l, '0');

  /** Convierte segundos a formato de cronómetro mm:ss. */
  const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

  /**
   * Función hash determinista de enteros para generar números pseudo-aleatorios consistentes.
   * Emplea operaciones de mezcla de bits y multiplicación entera rápida.
   * @param {number} n - Entero de entrada.
   * @returns {number} Flotante en el rango [0, 1).
   */
  function hash(n) {
    n = (n ^ 61) ^ (n >>> 16); n = n + (n << 3); n = n ^ (n >>> 4);
    n = Math.imul(n, 0x27d4eb2d); n = n ^ (n >>> 15);
    return (n >>> 0) / 4294967296;
  }

  /** Selector abreviado para elementos del DOM por su identificador único. */
  const $ = (id) => document.getElementById(id);

  /* ---------------------------------------------------------------- ESTADO GLOBAL DEL JUEGO */
  /** Mapa booleano del estado actual de los controles de entrada */
  const input = { left: false, right: false, up: false, down: false, turbo: false };

  /**
   * Objeto maestro de estado del juego (Game State).
   * Centraliza variables de simulación, física, puntuación y renderizado.
   */
  const G = {
    state: 'menu',                                                 // 'menu' | 'countdown' | 'play' | 'finish' | 'stageclear' | 'victory' | 'gameover' | 'paused'
    cameraMode: localStorage.getItem('roadfighter.cam') || 'fp',  // 'fp' (1ª persona) o 'top' (cenital 2D)
    stage: 0, theme: THEMES[0], curve: 0, len: 1e9,               // Parámetros de la etapa activa
    dist: 0, speed: 0, lat: 40, steer: 0, angle: 0, spin: 0,       // Posición y orientación del coche del jugador
    fuel: 100, lives: 3, score: 0,                                 // Recursos y puntuación
    hi: Number(localStorage.getItem('roadfighter.hi') || 0),       // Máxima puntuación histórica guardada
    entities: [], particles: [], texts: [],                        // Listas de entidades vivas en el mundo
    t: 0, cd: 0, cdLast: 0, stageTime: 0, finishT: 0,              // Temporizadores del juego
    shake: 0, invuln: 0, skid: 0, skidDir: 1, crash: null, hidden: false, // Efectos de cámara y estado del coche
    nextSpawn: 0, nextFuel: 0, c0: 0, lowFuelBeep: 0, thr: false, // Planificadores de tráfico y combustible
    demoT: 0, newRecord: false,                                    // Modo demo y récord
  };
  $('menuHi').textContent = pad(G.hi);

  /* ------------------------------------------------------------ GEOMETRÍA DE LA CARRETERA */
  /**
   * Calcula el desplazamiento lateral X del centro de la carretera en una posición longitudinal 'w'.
   * Combina dos armónicos sinusoidales modulados para generar curvas sinuosas suaves y transiciones continuas.
   * 
   * @param {number} w - Posición de distancia longitudinal a lo largo de la pista.
   * @returns {number} Desviación horizontal del centro de la calzada respecto al eje medio.
   */
  function roadCenter(w) {
    if (!G.curve) return 0;
    // Factor de atenuación: mantiene recta la pista en la salida y en la meta
    const f = clamp(w / 4000, 0, 1) * clamp((G.len - w) / 2500, 0, 1);
    return G.curve * f * (Math.sin(w / 2400) * 62 + Math.sin(w / 950 + 1.3) * 26);
  }

  /** Derivada o pendiente de la carretera en 'w' (fuerza centrífuga lateral). */
  const slopeAt = (w) => (roadCenter(w + 6) - roadCenter(w)) / 6;

  /** Coordenada X proyectada en pantalla para la posición longitudinal 'w' respecto a la cámara. */
  const cxAt = (w) => W / 2 + roadCenter(w) - G.c0;

  /** Coordenada Y en pantalla para la posición 'w' en perspectiva cenital 2D. */
  const syAt = (w) => PY - (w - G.dist);

  /* ---------------------------------------------------------- GESTIÓN Y CICLO DE VIDA DE ETAPAS */
  /**
   * Configura las variables ambientales y mecánicas para la etapa indicada.
   * @param {number} i - Índice de la etapa (0..4).
   */
  function setStageVars(i) {
    const st = STAGES[i];
    G.stage = i; G.theme = THEMES[st.theme];
    G.curve = st.curve; G.len = st.len;
  }

  /**
   * Reinicia la posición física del jugador, listas de tráfico, partículas y contadores de etapa.
   */
  function resetWorld() {
    G.dist = 0; G.speed = 0; G.lat = LANES[2]; G.steer = 0; G.angle = 0; G.spin = 0;
    G.entities = []; G.particles = []; G.texts = [];
    G.shake = 0; G.invuln = 0; G.skid = 0; G.crash = null; G.hidden = false;
    G.nextSpawn = 900; G.nextFuel = 2600; G.stageTime = 0;
  }

  /**
   * Inicia la demostración automática en el menú principal (IA de conducción suave).
   */
  function startMenuDemo() {
    setStageVars(0);
    G.len = 1e9;
    resetWorld();
    G.nextSpawn = 200;
    G.state = 'menu';
  }

  /**
   * Comienza una nueva partida completa desde la Etapa 1.
   */
  function startGame() {
    G.score = 0; G.lives = 3; G.newRecord = false;
    startStage(0);
  }

  /**
   * Inicia una etapa específica con cuenta atrás inicial de semáforo (3..2..1..YA).
   * @param {number} i - Índice de la etapa.
   */
  function startStage(i) {
    setStageVars(i);
    resetWorld();
    G.fuel = 100;
    G.invuln = 0;
    G.state = 'countdown';
    G.cd = 3.999; G.cdLast = 4;
    showOverlay(null);
    Sfx.unlock();
  }

  /**
   * Muestra el modal de interfaz con el id especificado y oculta los demás.
   * @param {string|null} id - Identificador del modal o null para ocultar todos.
   */
  function showOverlay(id) {
    for (const o of document.querySelectorAll('.overlay')) o.classList.toggle('hidden', o.id !== id);
  }

  /**
   * Guarda el récord histórico en localStorage si se supera la puntuación máxima.
   */
  function saveHi() {
    if (G.score > G.hi) {
      G.hi = Math.floor(G.score);
      localStorage.setItem('roadfighter.hi', String(G.hi));
      G.newRecord = true;
    }
  }

  /**
   * Maneja el cruce de la línea de meta, otorgando bonificaciones de combustible y vidas.
   */
  function finishStage() {
    G.state = 'finish'; G.finishT = 0; G.invuln = 999;
    Sfx.finish();
    const bonusFuel = Math.floor(G.fuel) * 10;
    const bonusLives = G.lives * 300;
    const bonusStage = (G.stage + 1) * 500;
    G.score += bonusFuel + bonusLives + bonusStage;
    G.bonus = { fuel: bonusFuel, lives: bonusLives, stage: bonusStage };
    saveHi();
  }

  /**
   * Muestra la pantalla de etapa completada o la pantalla de victoria final del juego.
   */
  function showStageClear() {
    if (G.stage >= STAGES.length - 1) {
      G.state = 'victory';
      $('vScore').textContent = pad(G.score);
      $('vHi').textContent = pad(G.hi);
      $('vNew').classList.toggle('hidden', !G.newRecord);
      showOverlay('victory');
      return;
    }
    G.state = 'stageclear';
    $('scTitle').textContent = `Etapa ${G.stage + 1} completada`;
    $('scTime').textContent = fmtTime(G.stageTime);
    $('scFuel').textContent = '+' + G.bonus.fuel;
    $('scLives').textContent = '+' + G.bonus.lives;
    $('scStage').textContent = '+' + G.bonus.stage;
    $('scScore').textContent = pad(G.score);
    $('scNext').textContent = 'Próxima: ' + STAGES[G.stage + 1].name;
    showOverlay('stageclear');
  }

  /**
   * Activa el estado de Fin de Partida (Game Over) por colisión mortal o falta de combustible.
   * @param {string} reason - Motivo del fin de partida.
   */
  function gameOver(reason) {
    if (G.state === 'gameover') return;
    G.state = 'gameover';
    Sfx.gameover();
    saveHi();
    $('goReason').textContent = reason;
    $('goStage').textContent = `${G.stage + 1} · ${STAGES[G.stage].name}`;
    $('goScore').textContent = pad(G.score);
    $('goHi').textContent = pad(G.hi);
    $('goNew').classList.toggle('hidden', !G.newRecord);
    $('menuHi').textContent = pad(G.hi);
    showOverlay('gameover');
  }

  /**
   * Retorna al menú principal y activa el demo en segundo plano.
   */
  function toMenu() {
    startMenuDemo();
    $('menuHi').textContent = pad(G.hi);
    showOverlay('menu');
  }

  /**
   * Alterna la pausa del juego durante la partida.
   */
  function togglePause() {
    if (G.state === 'play' || G.state === 'countdown') {
      G.prevState = G.state; G.state = 'paused';
      showOverlay('pause');
    } else if (G.state === 'paused') {
      G.state = G.prevState; showOverlay(null);
    }
  }

  /**
   * Ejecuta la acción primaria de botón (Start / Continuar) según el estado de la partida.
   */
  function primaryAction() {
    switch (G.state) {
      case 'menu': startGame(); break;
      case 'stageclear': startStage(G.stage + 1); break;
      case 'gameover': case 'victory': startGame(); break;
      case 'paused': togglePause(); break;
    }
  }

  /* ------------------------------------------------------------- SISTEMA DE TRÁFICO Y SPAWN */
  /**
   * Definiciones dimensionales y atributos mecánicos por tipo de entidad:
   * - hw: Semi-ancho (ancho de colisión en X).
   * - hh: Semi-alto (largo de colisión en Y/distancia longitudinal).
   * - mov: true si es un vehículo en movimiento, false si es un obstáculo estático.
   */
  const DEFS = {
    sedan: { hw: 36, hh: 70, mov: true },
    sport: { hw: 36, hh: 72, mov: true },
    truck: { hw: 46, hh: 140, mov: true },
    oil:   { hw: 70, hh: 40, mov: false },
    fuel:  { hw: 30, hh: 30, mov: false },
  };

  /**
   * Determina si un carril específico tiene suficiente espacio libre para generar un vehículo.
   * Evita solapamientos entre vehículos y atascos insalvables para el jugador.
   * 
   * @param {number} lane - Coordenada X del carril candidato (-120, -40, 40, 120).
   * @param {number} w - Posición longitudinal en el mundo.
   * @param {number} gap - Distancia de separación longitudinal mínima requerida.
   * @returns {boolean} true si el carril está despejado.
   */
  function laneFree(lane, w, gap) {
    let nearby = 0;
    for (const e of G.entities) {
      if (Math.abs(e.w - w) < gap && Math.abs(e.lat - lane) < 50) return false;
      if (Math.abs(e.w - w) < 180 && DEFS[e.type].mov) nearby++;
    }
    return nearby < 2; // Garantiza que no haya más de 2 coches a la misma altura bloqueando todos los carriles
  }

  /**
   * Mapea el sprite 2D de una entidad a su modelo homólogo 3D en primera persona.
   * Conserva el mismo color de carrocería y estilo para coherencia visual al alternar cámaras.
   * 
   * @param {Object} e - Objeto entidad.
   * @returns {{ c: HTMLCanvasElement, w: number, h: number }} Sprite 3D correspondiente.
   */
  function getFPEntitySprite(e) {
    if (e.fpSpr) return e.fpSpr;
    if (e.type === 'fuel') return Sprites.fp.fuel;
    if (e.type === 'oil') return Sprites.fp.oil;
    if (e.type === 'sedan') {
      const idx = Sprites.sedans.indexOf(e.spr);
      return Sprites.fp.sedans[idx >= 0 ? idx % Sprites.fp.sedans.length : 0];
    }
    if (e.type === 'sport') {
      const idx = Sprites.sports.indexOf(e.spr);
      return Sprites.fp.sports[idx >= 0 ? idx % Sprites.fp.sports.length : 0];
    }
    if (e.type === 'truck') {
      const idx = Sprites.trucks.indexOf(e.spr);
      return Sprites.fp.trucks[idx >= 0 ? idx % Sprites.fp.trucks.length : 0];
    }
    return e.spr;
  }

  /**
   * Fábrica instanciadora de entidades: crea y añade un nuevo elemento al mundo.
   * Configura velocidad según la etapa (k), hitboxes y variantes estéticas.
   * 
   * @param {'sedan'|'sport'|'truck'|'oil'|'fuel'} type - Tipo de objeto.
   * @param {number} w - Posición de distancia longitudinal.
   * @param {number} lane - Posición lateral X en la calzada.
   * @returns {Object} La entidad creada.
   */
  function addEntity(type, w, lane) {
    const d = DEFS[type];
    const k = 1 + G.stage * 0.07; // Incremento gradual de velocidad en etapas superiores
    const e = {
      type, w, lat: lane, lane, target: lane,
      hw: d.hw, hh: d.hh, mov: d.mov, speed: 0,
      passed: false, blink: 0,
      aggressive: Math.random() < 0.75, // 75% de los deportivos persiguen o cierran el paso al jugador
      spr: null, fpSpr: null, crashed: false
    };

    if (type === 'sedan') {
      const idx = (Math.random() * Sprites.sedans.length) | 0;
      e.spr = Sprites.sedans[idx];
      e.fpSpr = Sprites.fp.sedans[idx % Sprites.fp.sedans.length];
      e.speed = rand(62, 105) * k;
    } else if (type === 'sport') {
      const idx = (Math.random() * Sprites.sports.length) | 0;
      e.spr = Sprites.sports[idx];
      e.fpSpr = Sprites.fp.sports[idx % Sprites.fp.sports.length];
      e.speed = rand(112, 138) * k;
    } else if (type === 'truck') {
      const idx = (Math.random() * Sprites.trucks.length) | 0;
      e.spr = Sprites.trucks[idx];
      e.fpSpr = Sprites.fp.trucks[idx % Sprites.fp.trucks.length];
      e.speed = rand(52, 66) * k;
    } else if (type === 'oil') {
      e.spr = Sprites.oil;
      e.fpSpr = Sprites.fp.oil;
      e.rot = rand(0, 6.28);
    } else {
      e.spr = Sprites.fuel;
      e.fpSpr = Sprites.fp.fuel;
    }

    G.entities.push(e);
    return e;
  }

  /**
   * Genera un elemento de tráfico aleatorio en una posición 'w' determinada.
   * Elige probabilísticamente entre aceite, camiones pesados, deportivos veloces o sedanes.
   * 
   * @param {number} w - Distancia en el mundo para el spawn.
   */
  function spawnTraffic(w) {
    const r = Math.random();
    const sportP = 0.12 + G.stage * 0.045; // Mayor frecuencia de deportivos en etapas avanzadas
    let type;
    if (r < 0.1) type = 'oil';
    else if (r < 0.22) type = 'truck';
    else if (r < 0.22 + sportP) type = 'sport';
    else type = 'sedan';

    const gap = type === 'truck' ? 380 : 260;
    const lanes = LANES.slice().sort(() => Math.random() - 0.5); // Desordena carriles para aleatoriedad
    for (const lane of lanes) {
      if (laneFree(lane, w, gap)) {
        const jitter = type === 'oil' ? rand(-22, 22) : (type === 'truck' ? 0 : rand(-6, 6));
        const e = addEntity(type, w, lane + jitter);
        e.lane = lane;
        return;
      }
    }
  }

  /**
   * Generador continuo hacia adelante: rellena el mundo con tráfico y bidones
   * de combustible hasta el horizonte visible de la cámara activa.
   */
  function spawnAhead() {
    const horizon = G.dist + (G.cameraMode === 'fp' ? 1850 : H + 220);
    const dens = STAGES[G.stage].density;
    const limit = G.len - 700; // No generar tráfico inmediatamente antes de la meta

    while (G.nextSpawn < horizon && G.nextSpawn < limit) {
      spawnTraffic(G.nextSpawn);
      G.nextSpawn += rand(250, 520) / dens;
    }

    while (G.nextFuel < horizon && G.nextFuel < limit) {
      const lane = LANES[(Math.random() * 4) | 0];
      // Evitar que el bidón aparezca encima de otro vehículo
      const clash = G.entities.some((e) => Math.abs(e.w - G.nextFuel) < 260 && Math.abs(e.lat - lane) < 60);
      if (!clash) addEntity('fuel', G.nextFuel, lane);
      G.nextFuel += rand(3500, 4500);
    }
  }

  /* ------------------------------------------------------------ SISTEMA DE PARTÍCULAS Y TEXTO FLOTANTE */
  /**
   * Instancia una partícula física en el sistema de efectos visuales.
   * @param {Object} p - Parámetros: { type, w, lat, vw, vlat, life, size, grow, color }.
   */
  function particle(p) {
    G.particles.push(Object.assign({
      w: 0, lat: 0, vw: 0, vlat: 0, size: 4, grow: 0, color: '#fff', type: 'smoke'
    }, p, { max: p.life }));
  }

  /**
   * Emite una ráfaga radial de partículas explosivas (fuego o chispas incandescentes de colisión).
   * 
   * @param {number} w - Coordenada longitudinal del impacto.
   * @param {number} lat - Coordenada lateral del impacto.
   * @param {number} n - Cantidad de partículas a emitir.
   * @param {'fire'|'spark'} kind - Tipo de ráfaga.
   */
  function burst(w, lat, n, kind) {
    for (let i = 0; i < n; i++) {
      const a = rand(0, Math.PI * 2), s = rand(40, kind === 'fire' ? 260 : 380);
      if (kind === 'fire') {
        particle({
          type: 'fire', w, lat,
          vw: Math.sin(a) * s, vlat: Math.cos(a) * s,
          life: rand(0.4, 0.9), size: rand(8, 20), grow: -10,
          color: ['#fff2a0', '#ffb347', '#ff6a2b', '#ff3d1a'][i % 4]
        });
      } else {
        particle({
          type: 'spark', w, lat,
          vw: Math.sin(a) * s, vlat: Math.cos(a) * s,
          life: rand(0.25, 0.7), size: rand(1.5, 3.2),
          color: ['#fff6b0', '#ffc94d', '#ff8a2b'][i % 3]
        });
      }
    }
  }

  /**
   * Actualiza la simulación física de partículas vivas y textos flotantes temporizados.
   * @param {number} dt - Intervalo de tiempo delta en segundos.
   */
  function updateParticles(dt) {
    // 1. Partículas
    for (let i = G.particles.length - 1; i >= 0; i--) {
      const p = G.particles[i];
      p.life -= dt;
      if (p.life <= 0) { G.particles.splice(i, 1); continue; }
      p.w += p.vw * dt; p.lat += p.vlat * dt;
      p.vw *= 1 - dt * 1.5; p.vlat *= 1 - dt * 1.5; // Rozamiento del aire
      p.size = Math.max(0.1, p.size + p.grow * dt);
    }
    // 2. Textos emergentes de puntos o advertencias
    for (let i = G.texts.length - 1; i >= 0; i--) {
      const t = G.texts[i];
      t.life -= dt;
      if (t.life <= 0) G.texts.splice(i, 1);
    }
  }

  /**
   * Muestra un mensaje flotante temporal en el mundo de juego (ej. ¡LISTO!, ¡ACEITE!, +COMBUSTIBLE).
   * 
   * @param {string} txt - Texto a desplegar.
   * @param {string} color - Color hexadecimal del texto.
   * @param {number} [lat] - Posición lateral (por defecto la del jugador).
   */
  function popup(txt, color, lat) {
    G.texts.push({ txt, color, w: G.dist + 70, lat: lat === undefined ? G.lat : lat, life: 1.2, max: 1.2 });
  }

  /* --------------------------------------------------------------- FÍSICA Y CONDUCCIÓN DEL JUGADOR */
  /**
   * Comprueba si el coche del jugador ha salido del asfalto hacia el arcén o césped.
   * @returns {boolean} true si está fuera de la carretera.
   */
  function playerOffroad() { return Math.abs(G.lat) > EDGE - 6; }

  /**
   * Simulación física principal del coche del jugador:
   * - Aceleración con marchas baja (hasta 185 km/h) y alta/turbo (hasta 300 km/h).
   * - Fricción y desaceleración drástica en el césped/arcén (límite 85 km/h).
   * - Frenado activo, derrapes en aceite y dirección asistida por la velocidad.
   * - Consumo dinámico de combustible y aviso acústico de nivel crítico.
   * 
   * @param {number} dt - Tiempo delta en segundos.
   */
  function drive(dt) {
    const thr = input.up && G.fuel > 0;
    G.thr = thr;
    const high = input.turbo;
    const off = playerOffroad();
    const cap = off ? 85 : (high ? 300 : 185); // Velocidad punta según terreno y marcha

    // 1. ACELERACIÓN Y RETENCIÓN DE MOTOR
    if (thr) {
      if (G.speed < cap) {
        G.speed = Math.min(cap, G.speed + (high ? 75 : 100) * (1 - 0.5 * G.speed / 320) * dt);
      } else {
        G.speed = Math.max(cap, G.speed - (off ? 170 : 70) * dt);
      }
    } else {
      G.speed -= (G.fuel > 0 ? 26 : 55) * dt;
      if (off && G.speed > cap) G.speed -= 170 * dt;
    }
    // Freno de pie
    if (input.down) G.speed -= 190 * dt;
    G.speed = Math.max(0, G.speed);

    // 2. SISTEMA DE DIRECCIÓN Y DERRAPES
    const dir = (input.right ? 1 : 0) - (input.left ? 1 : 0);
    G.steer += (dir - G.steer) * Math.min(1, dt * 10);
    let lv = G.steer * (110 + Math.min(G.speed, 220) * 0.75) * Math.min(1, G.speed / 30);

    // Efecto de pérdida de adherencia por charco de aceite
    if (G.skid > 0) {
      G.skid -= dt;
      lv = lv * 0.35 + G.skidDir * 170 * (0.55 + 0.45 * Math.sin(G.t * 9));
      if (Math.random() < 0.6) {
        particle({
          type: 'smoke', w: G.dist - 34, lat: G.lat + rand(-14, 14),
          vw: -30, vlat: rand(-15, 15), life: 0.5, size: 7, grow: 14, color: '#d8d8e0'
        });
      }
    }
    G.lat += lv * dt;

    // Límite exterior de los márgenes de la pantalla
    const lim = EDGE + 55;
    if (Math.abs(G.lat) > lim) { G.lat = Math.sign(G.lat) * lim; G.speed *= 1 - dt * 2.5; }

    // Inclinación de la carrocería en curvas y balanceo
    G.angle = G.steer * 0.13 + (G.skid > 0 ? Math.sin(G.t * 9) * 0.22 : 0);

    // 3. CONSUMO Y GESTIÓN DE COMBUSTIBLE
    const drain = G.speed > 5 ? 1.15 + G.speed / 200 : 0.3;
    G.fuel = Math.max(0, G.fuel - drain * dt * (high && thr ? 1.25 : 1));
    if (G.fuel < 25 && G.fuel > 0) {
      G.lowFuelBeep -= dt;
      if (G.lowFuelBeep <= 0) { Sfx.warning(); G.lowFuelBeep = 1.4; }
    }
    if (G.fuel <= 0 && G.speed < 3) gameOver('Sin combustible');

    // 4. PARTÍCULAS DE POLVO FUERA DE PISTA Y CHISPAS EN TURBO
    if (off && G.speed > 20 && Math.random() < 0.8) {
      const gc = G.theme.grass[1];
      particle({
        type: 'smoke', w: G.dist - 36, lat: G.lat + rand(-16, 16),
        vw: -50, vlat: rand(-30, 30), life: 0.55, size: 5, grow: 12, color: gc
      });
    }
    if (high && thr && G.speed > 150 && Math.random() < 0.5) {
      particle({
        type: 'spark', w: G.dist - 42, lat: G.lat + rand(-8, 8),
        vw: -120, vlat: rand(-30, 30), life: 0.25, size: 2.2, color: '#ffb347'
      });
    }

    // Puntuación pasiva por distancia recorrida a alta velocidad
    G.score += G.speed * dt * 0.06;
  }

  /**
   * Inicia la secuencia de colisión y choque violento contra un vehículo u obstáculo.
   * @param {Object} e - Entidad contra la que se impactó.
   */
  function startCrash(e) {
    G.crash = { t: 0, dir: G.lat >= e.lat ? 1 : -1, exploded: false };
    G.shake = 14; // Sacudida sísmica de pantalla
    G.skid = 0;
    e.crashed = true;
    Sfx.crash();
    const w = (G.dist + e.w) / 2, lat = (G.lat + e.lat) / 2;
    burst(w, lat, 26, 'spark');
  }

  /**
   * Actualiza la cinemática del accidente:
   * - Trompo descontrolado (spin angular).
   * - Emisión densa de humo negro.
   * - Deflagración / explosión de combustible con llamaradas a los 0.8s.
   * - Resta de vidas y reactivación (respawn) a los 2.0s.
   * 
   * @param {number} dt - Tiempo delta.
   */
  function updateCrash(dt) {
    const c = G.crash;
    c.t += dt;
    G.speed = Math.max(0, G.speed - 120 * dt);
    G.lat += c.dir * 55 * dt * clamp(1 - c.t / 1.3, 0, 1);
    G.lat = clamp(G.lat, -EDGE - 55, EDGE + 55);
    G.spin = c.dir * 11 * clamp(1 - c.t / 0.9, 0.12, 1);
    G.angle += G.spin * dt;
    G.steer = 0;

    // Humo previo a la detonación
    if (!c.exploded && Math.random() < 0.9) {
      particle({
        type: 'smoke', w: G.dist + rand(-14, 14), lat: G.lat + rand(-12, 12),
        vw: rand(-30, 30), vlat: rand(-20, 20), life: 0.8, size: 8, grow: 18, color: '#4a4a52'
      });
    }

    // Gran explosión secundaria
    if (!c.exploded && c.t > 0.8) {
      c.exploded = true; G.hidden = true; G.shake = 18;
      burst(G.dist, G.lat, 34, 'fire');
      burst(G.dist, G.lat, 24, 'spark');
      Sfx.explode();
    }

    // Comprobación de vidas restantes
    if (c.t > 2.0) {
      G.lives--;
      if (G.lives <= 0) { gameOver('Te has estrellado'); return; }
      respawn();
    }
  }

  /**
   * Reaparece al jugador en pista tras un accidente, despejando el tráfico circundante
   * y otorgando 2.4 segundos de invulnerabilidad parpadeante.
   */
  function respawn() {
    G.entities = G.entities.filter((e) => Math.abs(e.w - G.dist) > 420);
    G.crash = null; G.hidden = false; G.angle = 0; G.spin = 0; G.steer = 0;
    G.speed = 0; G.skid = 0;
    G.lat = LANES[(Math.random() * 4) | 0]; // Colocar en carril seguro aleatorio
    G.invuln = 2.4;
    popup('¡LISTO!', '#7dffb0', G.lat);
  }

  /* ----------------------------------------------------------- BUCLES DE ACTUALIZACIÓN FÍSICA Y LÓGICA */
  /**
   * Actualiza el comportamiento y la inteligencia artificial (IA) del tráfico:
   * - Mantenimiento de distancia de seguridad respecto al vehículo precedente.
   * - Los vehículos tipo 'sport' agresivos detectan al jugador y se cruzan en su trayectoria activando intermitentes.
   * 
   * @param {number} dt - Tiempo delta.
   * @param {boolean} interactive - true si el jugador está en partida activa (false en modo menú o meta).
   */
  function updateEntities(dt, interactive) {
    const ents = G.entities;
    for (const e of ents) {
      if (e.mov && !e.crashed) {
        // 1. Detección de colisión frontal entre coches de la IA (mantener distancia)
        for (const f of ents) {
          if (f === e || !f.mov || f.w <= e.w) continue;
          if (Math.abs(f.lat - e.lat) < 42 && f.w - e.w < (e.hh + f.hh) / 2 + 24) {
            e.speed = Math.min(e.speed, f.speed);
            e.w = Math.min(e.w, f.w - (e.hh + f.hh) / 2 - 8);
          }
        }
        // 2. IA de deportivos rivales: maniobra de cambio de carril agresiva hacia el jugador
        if (e.type === 'sport') {
          const rel = e.w - G.dist;
          if (interactive && e.aggressive && rel > 30 && rel < 420 && !G.crash) {
            e.target = clamp(G.lat, -125, 125);
          } else {
            e.target = e.lat;
          }
          const d = e.target - e.lat;
          const mv = Math.sign(d) * Math.min(Math.abs(d), 62 * dt);
          e.lat += mv;
          e.blink = Math.abs(d) > 8 ? Math.sign(d) : 0; // Enciende intermitente ámbar según el giro
        }
      }
      // Avance cinemático longitudinal según velocidad propia
      e.w += e.speed * PX * dt;
    }
  }

  /**
   * Bucle principal de simulación durante el estado 'play':
   * - Aplica aceleración, deriva por curva de carretera y avance de distancia.
   * - Comprueba colisiones con bidones (+28% fuel, chispas y puntos).
   * - Detecta derrapes en manchas de aceite.
   * - Evalúa adelantamientos al límite (+150 pts si el roce es cercano, +40 pts normal).
   * - Procesa impactos contra otros vehículos y llegada a meta.
   * 
   * @param {number} dt - Tiempo delta.
   */
  function updatePlay(dt) {
    G.stageTime += dt;
    if (G.invuln > 0) G.invuln -= dt;
    if (G.shake > 0) G.shake = Math.max(0, G.shake - dt * 30);

    // Conducción o cinemática de choque
    if (G.crash) updateCrash(dt); else drive(dt);
    if (G.state !== 'play') return;

    // Desplazamiento longitudinal y arrastre centrífugo en curvas
    const dw = G.speed * PX * dt;
    G.lat -= slopeAt(G.dist) * dw * 0.55;
    G.dist += dw;

    // Generar nuevos objetos por delante y mover el tráfico
    spawnAhead();
    updateEntities(dt, true);

    const crashed = !!G.crash;
    for (let i = G.entities.length - 1; i >= 0; i--) {
      const e = G.entities[i];
      const rel = e.w - G.dist;
      // Eliminar entidades que han quedado muy atrás para liberar memoria
      if (rel < -420) { G.entities.splice(i, 1); continue; }
      if (crashed) continue;

      const dx = Math.abs(G.lat - e.lat), dy = Math.abs(rel);

      // Recolección de combustible
      if (e.type === 'fuel') {
        if (dx < 34 && dy < 40) {
          G.fuel = Math.min(100, G.fuel + 28);
          G.score += 200;
          Sfx.pickup();
          popup('+COMBUSTIBLE', '#ffe14d', e.lat);
          for (let k = 0; k < 14; k++) {
            particle({
              type: 'spark', w: e.w, lat: e.lat,
              vw: rand(-160, 160), vlat: rand(-160, 160),
              life: 0.5, size: 2.4, color: '#ffe14d'
            });
          }
          G.entities.splice(i, 1);
        }
        continue;
      }

      // Pérdida de tracción en charco de aceite
      if (e.type === 'oil') {
        if (dx < e.hw / 2 + 14 && dy < e.hh / 2 + 24 && G.skid <= 0) {
          G.skid = 1.6; G.skidDir = Math.random() < 0.5 ? -1 : 1;
          Sfx.skid(); popup('¡ACEITE!', '#c7a4ff');
        }
        continue;
      }

      // Bonificación de adelantamiento limpio
      if (!e.passed && rel < -50) {
        e.passed = true;
        const gap = dx - (34 + e.hw) / 2;
        if (gap < 20 && gap > -4) {
          G.score += 150; popup('¡POR POCO! +150', '#7dffb0', G.lat);
        } else {
          G.score += 40;
        }
        Sfx.pass();
      }

      // Colisión contra vehículos del tráfico
      if (G.invuln <= 0 && !e.crashed && dx < (34 + e.hw) / 2 && dy < (68 + e.hh) / 2) {
        startCrash(e);
      }
    }

    // Comprobación de cruce de línea de meta
    if (G.state === 'play' && !G.crash && G.dist >= G.len) finishStage();
  }

  /**
   * Cinemática tras cruzar la meta: el vehículo desacelera y se alinea en el carril central.
   * @param {number} dt - Tiempo delta.
   */
  function updateFinish(dt) {
    G.finishT += dt;
    G.speed = Math.max(60, G.speed - 80 * dt);
    const dw = G.speed * PX * dt;
    G.lat += (LANES[1] - G.lat) * Math.min(1, dt * 1.6);
    G.lat -= slopeAt(G.dist) * dw * 0.55;
    G.dist += dw;
    G.angle = (LANES[1] - G.lat) * 0.002;
    updateEntities(dt, false);
    if (G.finishT > 2.6) showStageClear();
  }

  /**
   * Conducción autónoma en modo demostración para el menú inicial.
   * @param {number} dt - Tiempo delta.
   */
  function updateMenuDemo(dt) {
    G.demoT += dt;
    G.speed = 150;
    G.dist += G.speed * PX * dt;
    G.lat = Math.sin(G.demoT * 0.6) * 90;
    G.steer = Math.cos(G.demoT * 0.6) * 0.5;
    G.angle = G.steer * 0.13;
    spawnAhead();
    updateEntities(dt, false);
    G.entities = G.entities.filter((e) => e.w - G.dist > -420);
  }

  /**
   * Despachador maestro de actualización de simulación y sincronización sonora.
   * @param {number} dt - Tiempo transcurrido entre fotogramas en segundos.
   */
  function update(dt) {
    G.t += dt;
    switch (G.state) {
      case 'menu': updateMenuDemo(dt); break;
      case 'countdown': {
        G.cd -= dt;
        const n = Math.ceil(G.cd);
        if (n !== G.cdLast) {
          G.cdLast = n;
          if (n > 0) Sfx.beep(false); else { Sfx.beep(true); }
        }
        if (G.cd <= 0) { G.state = 'play'; popup('¡YA!', '#7dffb0', G.lat); }
        break;
      }
      case 'play': updatePlay(dt); break;
      case 'finish': updateFinish(dt); break;
      case 'gameover': case 'stageclear': case 'victory':
        G.speed = Math.max(0, G.speed - 100 * dt);
        break;
    }
    if (G.state !== 'paused') updateParticles(dt);

    // Sincronización del sintetizador de audio procedural (ruedas, motor, música)
    const racing = G.state === 'play' || G.state === 'finish';
    Sfx.engine(G.speed, G.thr && G.state === 'play', racing || G.state === 'countdown');
    Sfx.setMusic(G.state === 'play' || G.state === 'countdown' || G.state === 'finish');
  }

  /* ==========================================================================
     8. PIPELINE DE RENDERIZADO 2D (CENITAL / TOP-DOWN)
     ========================================================================== */

  /**
   * Patrones de textura precargados para el terreno exterior (césped, arena, etc.).
   * Se generan a partir de los lienzos procedimentales de cada tema.
   * @type {CanvasPattern[]}
   */
  const grassPatterns = THEMES.map((t) => ctx.createPattern(t.grassTile, 'repeat'));

  /**
   * Patrones de textura precargados para el asfalto de la calzada.
   * @type {CanvasPattern[]}
   */
  const asphaltPatterns = THEMES.map((t) => ctx.createPattern(t.asphaltTile, 'repeat'));

  /** Tamaño de repetición del patrón de césped (píxeles) */
  const GT = 256;
  /** Tamaño de repetición del patrón de asfalto (píxeles) */
  const AT = 128;
  /** Número de tiras horizontales en las que se divide la pantalla vertical para proyectar la curva */
  const ROWS = Math.ceil(H / STRIP) + 1;
  /** Búfer de memoria contigua para almacenar las coordenadas X calculadas del centro de la calzada en cada tira */
  const cxRow = new Float32Array(ROWS);

  /**
   * Dibuja el fondo del terreno exterior a ambos lados de la carretera.
   * Utiliza traslación vertical cíclica según la distancia recorrida (`G.dist`)
   * para producir sensación continua de movimiento y dibuja franjas sutiles
   * de césped segado para aumentar la percepción de velocidad.
   */
  function drawGround() {
    const idx = THEMES.indexOf(G.theme);
    const off = G.dist % GT; // Desfase para el scroll continuo del patrón

    // Renderizado del tapiz de césped continuo
    ctx.save();
    ctx.translate(0, off);
    ctx.fillStyle = grassPatterns[idx];
    ctx.fillRect(0, -GT, W, H + GT * 2);
    ctx.restore();

    // Bandas horizontales de siega alternadas (efecto césped de campo de carreras)
    ctx.fillStyle = 'rgba(255,255,255,0.045)';
    const band = 180;
    const first = Math.floor((G.dist - PY - 10) / band);
    for (let k = first; k < first + H / band + 3; k++) {
      if (k & 1) continue; // Saltear franjas alternadas
      const y = PY - (k * band - G.dist) - band;
      ctx.fillRect(0, y, W, band);
    }
  }

  /**
   * Dibuja la calzada de asfalto, bordillos bicolores, líneas viales y marcas de pista.
   * La carretera se renderiza conectando trapezoides entre las franjas horizontales (`ROWS`)
   * siguiendo la curvatura calculada en `cxRow`.
   */
  function drawRoad() {
    const th = G.theme, idx = THEMES.indexOf(th);

    // 1. Precomputar las posiciones horizontales del centro de la vía para cada fila de la pantalla
    for (let r = 0; r < ROWS; r++) {
      const y = r * STRIP + STRIP / 2;
      cxRow[r] = cxAt(G.dist + PY - y);
    }

    // 2. Trazado del polígono de asfalto con textura repetitiva desfasada por el avance
    const off = G.dist % AT;
    ctx.save();
    ctx.translate(0, off);
    ctx.fillStyle = asphaltPatterns[idx];
    ctx.beginPath();
    // Borde izquierdo de la calzada
    for (let r = 0; r < ROWS; r++) {
      const x = cxRow[r] - ROAD_HALF, y = r * STRIP - off;
      r ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    // Borde derecho de la calzada (recorrido en orden inverso para cerrar el contorno)
    for (let r = ROWS - 1; r >= 0; r--) {
      ctx.lineTo(cxRow[r] + ROAD_HALF, r * STRIP - off);
    }
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // 3. Pintado de elementos línea a línea (bordillos, líneas viales, marcas de salida/meta)
    for (let r = 0; r < ROWS; r++) {
      const x = cxRow[r], y = r * STRIP;
      const w = G.dist + PY - (y + STRIP / 2); // Coordenada en metros de pista

      // Sombras exteriores de los bordillos
      ctx.fillStyle = 'rgba(0,0,0,0.22)';
      ctx.fillRect(x - EDGE - 8, y, 8, STRIP);
      ctx.fillRect(x + EDGE, y, 8, STRIP);

      // Bordillos de protección alternados (rojo/blanco, azul/blanco, etc.)
      ctx.fillStyle = (Math.floor(w / 40) & 1) ? th.curbA : th.curbB;
      ctx.fillRect(x - EDGE, y, CURB, STRIP);
      ctx.fillRect(x + ROAD_HALF, y, CURB, STRIP);

      // Sombra interior de los bordillos sobre el asfalto
      ctx.fillStyle = 'rgba(0,0,0,0.18)';
      ctx.fillRect(x - ROAD_HALF - 6, y, 6, STRIP);
      ctx.fillRect(x + ROAD_HALF, y, 6, STRIP);

      // Marcas oscuras de huellas de rodada en cada carril (mayor realismo visual)
      ctx.fillStyle = 'rgba(0,0,0,0.055)';
      for (const l of LANES) {
        ctx.fillRect(x + l - 18, y, 9, STRIP);
        ctx.fillRect(x + l + 9, y, 9, STRIP);
      }

      // Líneas continuas de demarcación en los arcenes
      ctx.fillStyle = '#f1f1f1';
      ctx.fillRect(x - ROAD_HALF + 8, y, 4, STRIP);
      ctx.fillRect(x + ROAD_HALF - 12, y, 4, STRIP);

      // Líneas discontinuas entre carriles interiores (separadas periódicamente)
      if ((Math.floor(w / 50) & 1) === 0) {
        ctx.fillStyle = 'rgba(245,245,245,0.92)';
        ctx.fillRect(x - 82, y, 4, STRIP);
        ctx.fillRect(x - 2, y, 4, STRIP);
        ctx.fillRect(x + 78, y, 4, STRIP);
      }

      // Línea transversal de parrilla de salida
      if (w >= 120 && w < 128) {
        ctx.fillStyle = '#fff';
        ctx.fillRect(x - ROAD_HALF, y, ROAD_HALF * 2, STRIP);
      }

      // Línea de meta ajedrezada (patrón de banderas de carreras)
      if (w >= G.len && w < G.len + 32) {
        const row = Math.floor((w - G.len) / 16);
        for (let i = 0; i < 16; i++) {
          ctx.fillStyle = ((i + row) & 1) ? '#111' : '#fff';
          ctx.fillRect(x - ROAD_HALF + i * 20, y, 20, STRIP);
        }
      }
    }
  }

  /**
   * Dibuja los elementos decorativos del paisaje exterior (árboles, rocas, casas, etc.).
   * Se generan de manera puramente pseudo-aleatoria pero determinista basándose en una semilla hash
   * para que no cambien de posición al mover la cámara.
   */
  function drawDecor() {
    const th = G.theme, ti = THEMES.indexOf(th);
    const SEG = 74; // Espaciado entre segmentos de comprobación
    const first = Math.floor((G.dist - 250) / SEG);
    const last = Math.floor((G.dist + H) / SEG) + 2;

    for (let i = last; i >= first; i--) {
      for (const side of [-1, 1]) { // Lado izquierdo (-1) y lado derecho (1)
        const seed = i * 2 + (side > 0 ? 1 : 0) + ti * 100003;
        if (hash(seed) > 0.78) continue; // Probabilidad de aparición de objeto

        const cat = hash(seed + 11);
        let list, lat;
        if (cat < 0.55) {
          // Elementos grandes (árboles, palmeras)
          list = th.big; lat = 224 + hash(seed + 13) * 70;
        } else if (cat < 0.92) {
          // Elementos pequeños (arbustos, flores, rocas)
          list = th.small; lat = 206 + hash(seed + 13) * 110;
        } else {
          // Elementos raros (casas, estanques)
          if (i % 4 !== 0) continue;
          list = th.rare; lat = 262 + hash(seed + 13) * 40;
        }

        const spr = list[Math.floor(hash(seed + 17) * list.length) % list.length];
        const w = i * SEG + hash(seed + 19) * SEG;
        const y = syAt(w);
        if (y < -90 || y > H + 90) continue; // Fuera del frustum vertical

        const x = cxAt(w) + side * lat;
        if (x < -80 || x > W + 80) continue; // Fuera del frustum horizontal

        ctx.save();
        ctx.translate(x, y);
        // Pequeña rotación aleatoria para romper la monotonía (excepto casas)
        if (list !== th.rare) ctx.rotate(hash(seed + 23) * 6.28);
        ctx.drawImage(spr.c, -spr.w / 2, -spr.h / 2, spr.w, spr.h);
        ctx.restore();
      }
    }
  }

  /**
   * Dibuja los pórticos metálicos elevados sobre la carretera (SALIDA y META).
   * @param {number} w - Coordenada longitudinal del pórtico en la pista.
   * @param {'start'|'finish'} kind - Tipo de pancarta ('start' o 'finish').
   */
  function drawGantry(w, kind) {
    const y = syAt(w);
    if (y < -80 || y > H + 80) return;
    const x = cxAt(w);
    const half = EDGE + 22;

    // Sombra proyectada del pórtico sobre la calzada
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.fillRect(x - half + 16, y - 10 + 18, half * 2, 24);
    ctx.fillRect(x - half + 16, y - 12 + 18, 16, 28);
    ctx.fillRect(x + half - 2 + 16, y - 12 + 18, 16, 28);

    // Pilares metálicos laterales con gradiente plateado
    for (const px of [x - half - 2, x + half - 14]) {
      const pg = ctx.createLinearGradient(px, 0, px + 16, 0);
      pg.addColorStop(0, '#6c7288');
      pg.addColorStop(0.5, '#c3c8d8');
      pg.addColorStop(1, '#5a6075');
      ctx.fillStyle = pg;
      ctx.fillRect(px, y - 14, 16, 28);
      ctx.strokeStyle = 'rgba(0,0,0,0.4)';
      ctx.strokeRect(px, y - 14, 16, 28);
    }

    // Viga central y cartel publicitario
    const bx = x - half + 12, bw = half * 2 - 24, bh = 26;
    const bg = ctx.createLinearGradient(0, y - bh / 2, 0, y + bh / 2);
    if (kind === 'finish') {
      bg.addColorStop(0, '#2a2f45'); bg.addColorStop(1, '#10131f');
    } else {
      bg.addColorStop(0, '#ff4a5f'); bg.addColorStop(1, '#b8142a');
    }
    ctx.fillStyle = bg;
    ctx.fillRect(bx, y - bh / 2, bw, bh);

    // Damero blanco y negro en los bordes para el arco de meta
    if (kind === 'finish') {
      for (let i = 0; i < bw / 10; i++) {
        ctx.fillStyle = (i & 1) ? '#fff' : '#111';
        ctx.fillRect(bx + i * 10, y - bh / 2, 10, 5);
        ctx.fillStyle = (i & 1) ? '#111' : '#fff';
        ctx.fillRect(bx + i * 10, y + bh / 2 - 5, 10, 5);
      }
    }

    // Borde brillante y texto tipográfico
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(bx, y - bh / 2, bw, bh);
    ctx.fillStyle = '#fff';
    ctx.font = `900 16px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(kind === 'finish' ? 'M E T A' : 'S A L I D A', x, y + 1);
  }

  /**
   * Dibuja todas las entidades dinámicas activas (coches, camiones, bidones, manchas).
   * Se ordenan en profundidad según su distancia (`w`) para respetar la oclusión.
   */
  function drawEntities() {
    const list = G.entities.slice().sort((a, b) => b.w - a.w);
    for (const e of list) {
      const y = syAt(e.w);
      const spr = e.spr;
      if (y < -spr.h || y > H + spr.h) continue;
      const x = cxAt(e.w) + e.lat;

      ctx.save();
      ctx.translate(x, y);

      // Animaciones particulares según el tipo de entidad
      if (e.type === 'fuel') {
        // Latido pulsante del bidón de combustible para atraer la atención del jugador
        const pulse = 1 + Math.sin(G.t * 6) * 0.07;
        ctx.scale(pulse, pulse);
        ctx.globalAlpha = 1;
      } else if (e.type === 'oil') {
        // Orientación aleatoria fija para cada mancha de aceite
        ctx.rotate(e.rot);
        ctx.globalAlpha = 0.95;
      } else if (e.type === 'sport' && e.blink) {
        // Ligera inclinación del deportivo al virar de carril
        ctx.rotate(e.blink * 0.08);
      }

      ctx.drawImage(spr.c, -spr.w / 2, -spr.h / 2, spr.w, spr.h);
      ctx.restore();

      // Intermitentes ámbar activos y brillantes en los deportivos
      if (e.type === 'sport' && e.blink && Math.floor(G.t * 8) % 2 === 0) {
        ctx.save();
        ctx.fillStyle = '#ffa800';
        ctx.shadowColor = '#ffa800';
        ctx.shadowBlur = 10;
        const s = e.blink;
        ctx.beginPath(); ctx.arc(x + s * 22, y - 36, 3.4, 0, 6.3); ctx.fill();
        ctx.beginPath(); ctx.arc(x + s * 22, y + 36, 3.4, 0, 6.3); ctx.fill();
        ctx.restore();
      }
    }
  }

  /**
   * Dibuja el bólido rojo del jugador en la vista 2D cenital.
   * Incluye efectos de escape con fuego/nitro, luces de freno traseras y parpadeo durante invulnerabilidad.
   */
  function drawPlayer() {
    if (G.hidden) return; // Oculto durante explosión
    // Parpadeo durante los segundos de invulnerabilidad tras reaparecer
    if (G.invuln > 0 && G.invuln < 900 && Math.floor(G.t * 12) % 2 === 0) return;

    const x = W / 2 + G.lat, y = PY;
    const spr = Sprites.player;

    // Llamas de turbo en marcha alta (High Gear + acelerador a fondo)
    if (G.state === 'play' && !G.crash && input.turbo && G.thr && G.speed > 150) {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(G.angle);
      const f = 18 + Math.random() * 14;
      for (const sx of [-12, 12]) {
        const gr = ctx.createLinearGradient(0, 40, 0, 40 + f);
        gr.addColorStop(0, 'rgba(255,255,220,0.95)');
        gr.addColorStop(0.4, 'rgba(255,170,40,0.85)');
        gr.addColorStop(1, 'rgba(255,60,20,0)');
        ctx.fillStyle = gr;
        ctx.beginPath();
        ctx.moveTo(sx - 4, 40);
        ctx.lineTo(sx + 4, 40);
        ctx.lineTo(sx, 40 + f);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
    }

    // Dibujo del sprite del coche rotado según el derrape o dirección
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(G.angle);
    ctx.drawImage(spr.c, -spr.w / 2, -spr.h / 2, spr.w, spr.h);

    // Resplandor de luces de freno rojas al decelerar
    if (input.down && G.speed > 0 && !G.crash) {
      ctx.globalCompositeOperation = 'lighter';
      for (const sx of [-14, 14]) {
        const gr = ctx.createRadialGradient(sx, 40, 1, sx, 40, 22);
        gr.addColorStop(0, 'rgba(255,40,40,0.95)');
        gr.addColorStop(1, 'rgba(255,40,40,0)');
        ctx.fillStyle = gr;
        ctx.fillRect(sx - 22, 18, 44, 44);
      }
    }
    ctx.restore();
  }

  /**
   * Dibuja el sistema de partículas 2D (humo, chispas, explosiones)
   * y los textos flotantes de puntuación (+1000 FUEL, etc.).
   */
  function drawParticles() {
    for (const p of G.particles) {
      const y = syAt(p.w);
      if (y < -40 || y > H + 40) continue;
      const x = cxAt(p.w) + p.lat;
      const a = clamp(p.life / p.max, 0, 1);

      if (p.type === 'smoke') {
        // Humo translúcido
        ctx.globalAlpha = a * 0.55;
        ctx.fillStyle = p.color;
        ctx.beginPath(); ctx.arc(x, y, p.size, 0, 6.3); ctx.fill();
      } else if (p.type === 'fire') {
        // Fuego brillante con mezcla aditiva
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = a;
        const gr = ctx.createRadialGradient(x, y, 0, x, y, p.size);
        gr.addColorStop(0, p.color);
        gr.addColorStop(1, 'rgba(255,60,20,0)');
        ctx.fillStyle = gr;
        ctx.fillRect(x - p.size, y - p.size, p.size * 2, p.size * 2);
        ctx.globalCompositeOperation = 'source-over';
      } else {
        // Chispas de fricción y asfalto
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = a;
        ctx.fillStyle = p.color;
        ctx.beginPath(); ctx.arc(x, y, p.size, 0, 6.3); ctx.fill();
        ctx.globalCompositeOperation = 'source-over';
      }
      ctx.globalAlpha = 1;
    }

    // Textos emergentes flotantes de bonificación
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const t of G.texts) {
      const age = 1 - t.life / t.max;
      const x = cxAt(t.w) + t.lat;
      const y = syAt(t.w) - age * 60 - 40;
      ctx.globalAlpha = clamp(t.life / 0.35, 0, 1);
      ctx.font = `900 15px ${FONT}`;
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.strokeText(t.txt, x, y);
      ctx.fillStyle = t.color;
      ctx.fillText(t.txt, x, y);
      ctx.globalAlpha = 1;
    }
  }

  /**
   * Genera el filtro de oscuridad ambiental e iluminación dinámica nocturna para la Etapa 5.
   * Utiliza un lienzo auxiliar `nightCv` y mezcla `destination-out` para recortar los haces
   * de luz de los faros delanteros del jugador y las luces de los coches rivales.
   */
  function drawNight() {
    const g = nightCtx;
    g.setTransform(DPR, 0, 0, DPR, 0, 0);
    g.globalCompositeOperation = 'source-over';
    g.clearRect(0, 0, W, H);

    // Velo de oscuridad nocturna azul oscuro
    g.fillStyle = 'rgba(2,5,22,0.8)';
    g.fillRect(0, 0, W, H);

    // Operación para perforar la oscuridad mediante luz
    g.globalCompositeOperation = 'destination-out';
    const px = W / 2 + G.lat, py = PY;

    // Resplandor tenue alrededor del jugador
    let gr = g.createRadialGradient(px, py, 10, px, py, 150);
    gr.addColorStop(0, 'rgba(0,0,0,0.85)');
    gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr;
    g.fillRect(px - 150, py - 150, 300, 300);

    // Cono de faros delanteros hacia adelante
    if (!G.hidden) {
      g.save();
      try { g.filter = 'blur(6px)'; } catch (e) { /* fallback si el navegador no soporta filter en canvas */ }
      const cone = g.createLinearGradient(0, py - 34, 0, py - 440);
      cone.addColorStop(0, 'rgba(0,0,0,1)');
      cone.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = cone;
      g.translate(px, py - 34);
      g.rotate(G.angle * 0.8);
      g.beginPath();
      g.moveTo(-16, 0);
      g.lineTo(-120, -406);
      g.lineTo(120, -406);
      g.lineTo(16, 0);
      g.closePath();
      g.fill();
      g.restore();
    }

    // Luz emitida por otros vehículos y bidones luminosos
    for (const e of G.entities) {
      const y = syAt(e.w);
      if (y < -120 || y > H + 120) continue;
      const x = cxAt(e.w) + e.lat;
      const r = e.type === 'fuel' ? 70 : 60;
      const gg = g.createRadialGradient(x, y, 4, x, y, r);
      gg.addColorStop(0, 'rgba(0,0,0,0.75)');
      gg.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = gg;
      g.fillRect(x - r, y - r, r * 2, r * 2);
    }

    // Estampar la capa nocturna perforada sobre el canvas principal del juego
    ctx.drawImage(nightCv, 0, 0, W, H);

    // Luces traseras rojas incandescentes de los coches delante
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const e of G.entities) {
      if (!e.mov) continue;
      const y = syAt(e.w);
      if (y < -120 || y > H + 120) continue;
      const x = cxAt(e.w) + e.lat;
      for (const sx of [-14, 14]) {
        const rg = ctx.createRadialGradient(x + sx, y + e.hh / 2, 1, x + sx, y + e.hh / 2, 14);
        rg.addColorStop(0, 'rgba(255,50,50,0.8)');
        rg.addColorStop(1, 'rgba(255,50,50,0)');
        ctx.fillStyle = rg;
        ctx.fillRect(x + sx - 14, y + e.hh / 2 - 14, 28, 28);
      }
    }
    ctx.restore();
  }

  /* ==========================================================================
     HUD (HEADS-UP DISPLAY / INTERFAZ EN PANTALLA)
     ========================================================================== */

  /**
   * Dibuja un rectángulo con esquinas redondeadas y estilo de vidrio oscuro (glassmorphism).
   * @param {number} x - Posición X de inicio.
   * @param {number} y - Posición Y de inicio.
   * @param {number} w - Ancho de la tarjeta.
   * @param {number} h - Alto de la tarjeta.
   * @param {number} r - Radio de redondeo de las esquinas.
   */
  function panel(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
    ctx.fillStyle = 'rgba(8,11,28,0.66)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  /**
   * Renderiza todos los indicadores del HUD sobre la pantalla de juego:
   * marcador de puntos, récord, etapa actual, medidor vertical de combustible con avisos,
   * minimapa vertical de progreso del circuito, velocímetro circular analógico/digital,
   * indicador de marchas, vidas restantes y avisos de texto en pantalla (countdown, finish, low fuel).
   */
  function drawHUD() {
    ctx.save();
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.textBaseline = 'middle';

    // 1. Barra superior (Puntuación, Etapa y Récord Máximo)
    panel(12, 12, W - 24, 52, 14);

    // Puntos actuales
    ctx.textAlign = 'left';
    ctx.fillStyle = '#98a2c8'; ctx.font = `600 10px ${FONT}`; ctx.fillText('PUNTOS', 28, 28);
    ctx.fillStyle = '#fff'; ctx.font = `700 20px ${FONT}`; ctx.fillText(pad(G.score), 28, 48);

    // Etapa actual
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ffb02e'; ctx.font = `600 10px ${FONT}`; ctx.fillText(`ETAPA ${G.stage + 1}/${STAGES.length}`, W / 2, 28);
    ctx.fillStyle = '#fff'; ctx.font = `700 16px ${FONT}`; ctx.fillText(STAGES[G.stage].name, W / 2, 48);

    // Récord histórico (High Score)
    ctx.textAlign = 'right';
    ctx.fillStyle = '#98a2c8'; ctx.font = `600 10px ${FONT}`; ctx.fillText('RÉCORD', W - 28, 28);
    ctx.fillStyle = '#ffd34d'; ctx.font = `700 20px ${FONT}`; ctx.fillText(pad(Math.max(G.hi, G.score)), W - 28, 48);

    const playing = G.state !== 'menu';
    if (!playing) { ctx.restore(); return; }

    // 2. Medidor vertical de combustible (Lateral Izquierdo)
    const fx = 16, fy = H - 336, fw = 30, fh = 190;
    panel(fx - 6, fy - 36, fw + 12, fh + 46, 10);
    const fr = clamp(G.fuel / 100, 0, 1);
    const low = fr < 0.25;

    // Etiqueta de combustible (parpadea en rojo si está crítico)
    ctx.fillStyle = low && Math.floor(G.t * 5) % 2 === 0 ? '#ff4a5f' : '#98a2c8';
    ctx.font = `700 9px ${FONT}`; ctx.textAlign = 'center'; ctx.fillText('FUEL', fx + fw / 2, fy - 22);

    // Fondo del tanque de combustible
    ctx.fillStyle = 'rgba(255,255,255,0.1)'; ctx.fillRect(fx, fy, fw, fh);

    // Barra de llenado con gradiente tricolor (verde -> amarillo -> rojo)
    const fg = ctx.createLinearGradient(0, fy + fh, 0, fy);
    fg.addColorStop(0, '#ff3d54'); fg.addColorStop(0.35, '#ffb02e'); fg.addColorStop(1, '#4cf08a');
    ctx.fillStyle = fg; ctx.fillRect(fx, fy + fh * (1 - fr), fw, fh * fr);

    // Marcas de división del tanque
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    for (let i = 1; i < 10; i++) ctx.fillRect(fx, fy + fh * i / 10, fw, 1.5);
    ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.strokeRect(fx, fy, fw, fh);

    // Porcentaje numérico de combustible restante
    ctx.fillStyle = '#fff'; ctx.font = `700 10px ${FONT}`; ctx.fillText(Math.ceil(G.fuel) + '%', fx + fw / 2, fy + fh + 14);

    // 3. Minimapa de progreso vertical de la etapa (Lateral Derecho)
    const rx = W - 36, ry = 100, rh = H - 330;
    panel(rx - 14, ry - 24, 38, rh + 62, 10);

    // Pista vertical
    const trk = ctx.createLinearGradient(0, ry, 0, ry + rh);
    trk.addColorStop(0, 'rgba(255,255,255,0.3)'); trk.addColorStop(1, 'rgba(255,255,255,0.1)');
    ctx.fillStyle = trk; ctx.fillRect(rx, ry, 10, rh);

    // Barra de relleno con gradiente cian a verde
    const prog = clamp(G.dist / G.len, 0, 1);
    const pg = ctx.createLinearGradient(0, ry + rh, 0, ry);
    pg.addColorStop(0, '#2ee6d6'); pg.addColorStop(1, '#4cf08a');
    ctx.fillStyle = pg; ctx.fillRect(rx, ry + rh * (1 - prog), 10, rh * prog);

    // Bandera de meta en la cima del minimapa
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 2; j++) {
        ctx.fillStyle = (i + j) & 1 ? '#111' : '#fff';
        ctx.fillRect(rx - 3 + i * 4, ry - 16 + j * 4, 4, 4);
      }
    }

    // Flecha indicadora de la posición del coche rojo
    const my = ry + rh * (1 - prog);
    ctx.fillStyle = '#e3172b'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(rx - 7, my);
    ctx.lineTo(rx - 1, my - 6);
    ctx.lineTo(rx - 1, my + 6);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Porcentaje completado de la etapa
    ctx.fillStyle = '#fff'; ctx.font = `700 10px ${FONT}`; ctx.textAlign = 'center';
    ctx.fillText(Math.floor(prog * 100) + '%', rx + 5, ry + rh + 20);

    // 4. Velocímetro circular analógico y digital (Esquina Inferior Derecha)
    const cx = W - 84, cy = H - 84, R = 58;
    ctx.beginPath(); ctx.arc(cx, cy, R + 8, 0, 6.3);
    ctx.fillStyle = 'rgba(8,11,28,0.72)'; ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.18)'; ctx.lineWidth = 1.5; ctx.stroke();

    // Arco de fondo
    const a0 = Math.PI * 0.75, a1 = Math.PI * 2.25;
    ctx.lineWidth = 8; ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.beginPath(); ctx.arc(cx, cy, R - 4, a0, a1); ctx.stroke();

    // Arco de velocidad iluminado según la aceleración
    const sp = clamp(G.speed / 320, 0, 1);
    const sg = ctx.createLinearGradient(cx - R, cy, cx + R, cy);
    sg.addColorStop(0, '#2ee6d6');
    sg.addColorStop(0.55, '#ffb02e');
    sg.addColorStop(1, '#ff3d54');
    ctx.strokeStyle = sg;
    if (sp > 0.01) {
      ctx.beginPath();
      ctx.arc(cx, cy, R - 4, a0, a0 + (a1 - a0) * sp);
      ctx.stroke();
    }
    ctx.lineCap = 'butt';

    // Velocidad digital en KM/H
    ctx.fillStyle = '#fff'; ctx.textAlign = 'center';
    ctx.font = `900 26px ${FONT}`; ctx.fillText(Math.round(G.speed), cx, cy - 4);
    ctx.fillStyle = '#98a2c8'; ctx.font = `600 9px ${FONT}`; ctx.fillText('KM/H', cx, cy + 16);

    // Marcha seleccionada (High Gear / Low Gear)
    const hi = input.turbo;
    ctx.fillStyle = hi ? '#ff7a2b' : '#4cf08a'; ctx.font = `700 9px ${FONT}`;
    ctx.fillText(hi ? 'MARCHA ALTA' : 'MARCHA BAJA', cx, cy + 32);

    // 5. Contador de vidas restantes (Esquina Inferior Izquierda)
    const ls = Sprites.player;
    for (let i = 0; i < G.lives; i++) {
      ctx.drawImage(ls.c, 18 + i * 28, H - 98, ls.w * 0.34, ls.h * 0.34);
    }
    ctx.fillStyle = '#98a2c8'; ctx.font = `600 9px ${FONT}`; ctx.textAlign = 'left';
    ctx.fillText('VIDAS', 18, H - 104);

    // 6. Alerta parpadeante de combustible bajo en mitad de pantalla
    if (G.state === 'play' && low) {
      if (Math.floor(G.t * 3) % 2 === 0) {
        ctx.textAlign = 'center'; ctx.font = `900 18px ${FONT}`;
        ctx.lineWidth = 5; ctx.strokeStyle = 'rgba(0,0,0,0.7)';
        ctx.strokeText('¡COMBUSTIBLE BAJO!', W / 2 - 24, 96);
        ctx.fillStyle = '#ff4a5f'; ctx.fillText('¡COMBUSTIBLE BAJO!', W / 2 - 24, 96);
      }
    }

    // 7. Animación tipográfica de cuenta regresiva (3, 2, 1...)
    if (G.state === 'countdown') {
      const n = Math.ceil(G.cd);
      const frac = G.cd - Math.floor(G.cd);
      const s = 1 + (1 - frac) * 0.0 + frac * 0.5; // Efecto de escala pulsante
      ctx.save();
      ctx.translate(W / 2, H / 2 - 60); ctx.scale(s, s);
      ctx.globalAlpha = clamp(frac * 2.2, 0.2, 1);
      ctx.font = `900 120px ${FONT}`; ctx.textAlign = 'center';
      ctx.lineWidth = 10; ctx.strokeStyle = 'rgba(80,0,15,0.85)'; ctx.strokeText(n, 0, 0);
      const cg = ctx.createLinearGradient(0, -60, 0, 60);
      cg.addColorStop(0, '#fff'); cg.addColorStop(1, '#ff7a4a');
      ctx.fillStyle = cg; ctx.fillText(n, 0, 0);
      ctx.restore();
    }

    // 8. Rótulo de ¡META! al cruzar la línea de llegada
    if (G.state === 'finish') {
      ctx.textAlign = 'center'; ctx.font = `900 44px ${FONT}`;
      const a = clamp(G.finishT * 2, 0, 1);
      ctx.globalAlpha = a;
      ctx.lineWidth = 8; ctx.strokeStyle = 'rgba(0,30,40,0.85)';
      ctx.strokeText('¡META!', W / 2, H / 2 - 80);
      ctx.fillStyle = '#7dffb0'; ctx.fillText('¡META!', W / 2, H / 2 - 80);
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }

  /**
   * Orquestador general del modo de cámara cenital tradicional (Top-Down 2D).
   * Ejecuta en orden secuencial todas las capas de dibujo: suelo, asfalto, decoración,
   * pórticos, entidades, jugador, partículas, noche y efectos de viñeta/choque.
   */
  function renderTopDown() {
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    G.c0 = roadCenter(G.dist);

    ctx.save();
    // Efecto de sacudida de pantalla (Screen Shake) ante choques y derrapes fuertes
    if (G.shake > 0) ctx.translate(rand(-1, 1) * G.shake * 0.6, rand(-1, 1) * G.shake * 0.6);

    drawGround();
    drawRoad();
    drawDecor();
    drawGantry(120, 'start');
    drawEntities();
    drawPlayer();
    drawParticles();
    drawGantry(G.len, 'finish');
    if (G.theme.night) drawNight();
    ctx.restore();

    // Viñeta estética periférica
    const vg = ctx.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, H * 0.78);
    vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,0.38)');
    ctx.fillStyle = vg; ctx.fillRect(0, 0, W, H);

    // Destello blanco cegador en el momento exacto del impacto
    if (G.crash && G.crash.t < 0.12) {
      ctx.fillStyle = `rgba(255,255,255,${0.5 * (1 - G.crash.t / 0.12)})`; ctx.fillRect(0, 0, W, H);
    }
  }

  /* ==========================================================================
     9. PIPELINE DE RENDERIZADO 3D (PRIMERA PERSONA / COCKPIT)
     ========================================================================== */

  /**
   * Dibuja el cielo y la atmósfera lejana en perspectiva 3D según el tema de la etapa.
   * Renderiza un gradiente vertical, el astro celeste (sol brillante o luna nocturna con estrellas)
   * y capas de nubes con efecto de paralaje horizontal en función del giro del volante.
   * @param {number} horizonY - Coordenada vertical Y de la línea del horizonte.
   */
  function drawFPSky(horizonY) {
    const th = G.theme, ti = THEMES.indexOf(th);
    const grad = ctx.createLinearGradient(0, 0, 0, horizonY);

    // Paleta de gradiente celeste según la hora del día de cada circuito
    if (ti === 0) {
      // Costa soleada: Azul diurno radiante
      grad.addColorStop(0, '#175eb8'); grad.addColorStop(0.55, '#3b92e6'); grad.addColorStop(1, '#8fc4f5');
    } else if (ti === 1) {
      // Cañón desértico: Tonos cálidos de atardecer rojizo
      grad.addColorStop(0, '#9a2414'); grad.addColorStop(0.45, '#e05322'); grad.addColorStop(1, '#ffb442');
    } else if (ti === 2) {
      // Montaña crepuscular: Violeta y púrpura
      grad.addColorStop(0, '#3e1554'); grad.addColorStop(0.5, '#913554'); grad.addColorStop(1, '#eb944b');
    } else if (ti === 3) {
      // Bosque nórdico: Azul frío invernal
      grad.addColorStop(0, '#27425e'); grad.addColorStop(0.6, '#527594'); grad.addColorStop(1, '#a8c5d4');
    } else {
      // Autopista nocturna: Negro azulado profundo
      grad.addColorStop(0, '#040612'); grad.addColorStop(0.65, '#0b1126'); grad.addColorStop(1, '#171f40');
    }
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, horizonY);

    // Posicionamiento horizontal del sol o luna con desplazamiento por el giro
    const sunOffX = (ti * 80 + 380 - G.angle * 120) % (W + 100);

    if (ti === 4) {
      // Luna llena y cielo estrellado para la etapa de noche
      ctx.save();
      ctx.fillStyle = '#f8fbff'; ctx.shadowColor = 'rgba(200,230,255,0.7)'; ctx.shadowBlur = 24;
      ctx.beginPath(); ctx.arc(sunOffX, 85, 20, 0, Math.PI * 2); ctx.fill();
      ctx.shadowColor = 'transparent';
      ctx.restore();

      // Manto de estrellas titilantes
      for (let s = 0; s < 40; s++) {
        const sx = (hash(s * 71 + 3) * W + G.dist * 0.005) % W;
        const sy = hash(s * 97 + 11) * (horizonY - 20);
        const sa = 0.35 + 0.55 * Math.sin(G.t * 3 + s);
        ctx.fillStyle = `rgba(255,255,255,${sa})`;
        ctx.fillRect(sx, sy, 1.6, 1.6);
      }
    } else {
      // Sol diurno con halo resplandeciente
      ctx.save();
      const sunY = ti === 1 ? 135 : 95;
      const sg = ctx.createRadialGradient(sunOffX, sunY, 4, sunOffX, sunY, 44);
      sg.addColorStop(0, ti === 1 ? '#fff1b8' : '#ffffff');
      sg.addColorStop(0.3, ti === 1 ? '#ffa834' : 'rgba(255,245,180,0.8)');
      sg.addColorStop(1, 'rgba(255,200,50,0)');
      ctx.fillStyle = sg;
      ctx.beginPath(); ctx.arc(sunOffX, sunY, 44, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }

    // Nubes en capas con paralaje suave
    if (ti !== 4) {
      ctx.fillStyle = ti === 1 ? 'rgba(255,180,140,0.22)' : 'rgba(255,255,255,0.32)';
      const cloudDrift = (G.t * 8 - G.angle * 160) % (W + 200);
      for (let c = 0; c < 5; c++) {
        const cx = ((c * 150 + cloudDrift) % (W + 200)) - 100;
        const cy = 35 + (c % 3) * 32;
        const cw = 70 + (c % 2) * 30;
        ctx.beginPath();
        ctx.ellipse(cx, cy, cw, 15, 0, 0, Math.PI * 2);
        ctx.ellipse(cx + 18, cy - 7, cw * 0.6, 13, 0, 0, Math.PI * 2);
        ctx.ellipse(cx - 16, cy - 4, cw * 0.5, 11, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  /**
   * Dibuja las siluetas montañosas lejanas en el horizonte con efecto de paralaje multicapa.
   * La cordillera se desplaza lateralmente con la curvatura de la carretera y el giro del coche.
   * @param {number} horizonY - Coordenada vertical Y de la línea del horizonte.
   */
  function drawFPDistantHills(horizonY) {
    const ti = THEMES.indexOf(G.theme);
    const pan = -G.angle * 260 - roadCenter(G.dist) * 0.08;
    const mColors = [
      ['#2f6345', '#1e4832'], // Verde costa
      ['#8c3b24', '#591e12'], // Cañón ocre
      ['#54253e', '#331224'], // Púrpura montaña
      ['#41607a', '#243e54'], // Azul nórdico
      ['#0c1022', '#060814'], // Silueta nocturna
    ][ti];

    // Capa 1: Cordillera montañosa de fondo (más lejana y lenta)
    ctx.fillStyle = mColors[0];
    ctx.beginPath();
    ctx.moveTo(0, horizonY);
    const segs = 14;
    const segW = W / segs;
    for (let i = 0; i <= segs; i++) {
      const x = i * segW;
      const hPeak = 24 + Math.sin(i * 0.9 + pan * 0.008) * 16 + Math.cos(i * 1.8 + 2) * 10;
      ctx.lineTo(x, horizonY - hPeak);
    }
    ctx.lineTo(W, horizonY);
    ctx.closePath();
    ctx.fill();

    // Capa 2: Colinas intermedias (más cercanas con crestas más pronunciadas)
    ctx.fillStyle = mColors[1];
    ctx.beginPath();
    ctx.moveTo(0, horizonY);
    for (let i = 0; i <= segs; i++) {
      const x = i * segW;
      const hPeak = 12 + Math.sin(i * 1.3 + pan * 0.015 + 1.2) * 10 + Math.cos(i * 2.5) * 6;
      ctx.lineTo(x, horizonY - hPeak);
    }
    ctx.lineTo(W, horizonY);
    ctx.closePath();
    ctx.fill();
  }

  /**
   * Renderiza la carretera pseudo-3D en perspectiva cónica desde el horizonte hacia el capó.
   * Modela el asfalto proyectando trapezoides de altura `dy` donde la escala `sc = (y - horizonY) / camHeight`
   * y la distancia en profundidad `z = focal / sc`.
   * @param {number} horizonY - Coordenada vertical Y de la línea del horizonte.
   */
  function drawFP3DRoad(horizonY) {
    const th = G.theme;
    const focal = 275, camHeight = 65;
    const dy = 4; // Grosor de cada tira trapezoidal de proyección
    const startY = Math.ceil(horizonY);
    const endY = H;

    for (let y = startY; y < endY; y += dy) {
      const y1 = y;
      const y2 = y + dy + 0.6; // Ligero solape para evitar costuras de renderizado
      const sc1 = (y1 - horizonY) / camHeight;
      const sc2 = (y2 - horizonY) / camHeight;
      if (sc1 <= 0 || sc2 <= 0) continue;

      // Profundidad métrica Z correspondiente a cada franja vertical de pantalla
      const z1 = focal / sc1, z2 = focal / sc2;
      const w1 = G.dist + z1, w2 = G.dist + z2;

      // Desplazamiento horizontal relativo por curvas y posición lateral del jugador
      const rc1 = roadCenter(w1) - roadCenter(G.dist) - G.lat;
      const rc2 = roadCenter(w2) - roadCenter(G.dist) - G.lat;
      const turnOff = -G.angle * 220;

      // Coordenadas X proyectadas en pantalla para el centro de la calzada
      const cx1 = W / 2 + rc1 * sc1 + turnOff;
      const cx2 = W / 2 + rc2 * sc2 + turnOff;

      // Anchos escalados de la pista y los bordillos
      const rw1 = ROAD_HALF * sc1, rw2 = ROAD_HALF * sc2;
      const ew1 = (ROAD_HALF + CURB) * sc1, ew2 = (ROAD_HALF + CURB) * sc2;

      // 1. Terreno exterior (césped/arena) a izquierda y derecha
      const g1 = (th.grass && th.grass[0]) || '#5db04a';
      const g2 = (th.grass && (th.grass[1] || th.grass[0])) || '#7cc863';
      const gColor = (Math.floor(w1 / 55) & 1) ? g1 : g2;
      ctx.fillStyle = gColor;

      // Terreno izquierdo
      ctx.beginPath();
      ctx.moveTo(0, y1); ctx.lineTo(cx1 - ew1, y1);
      ctx.lineTo(cx2 - ew2, y2); ctx.lineTo(0, y2);
      ctx.closePath(); ctx.fill();

      // Terreno derecho
      ctx.beginPath();
      ctx.moveTo(cx1 + ew1, y1); ctx.lineTo(W, y1);
      ctx.lineTo(W, y2); ctx.lineTo(cx2 + ew2, y2);
      ctx.closePath(); ctx.fill();

      // 2. Bordillos bicolores
      const curbColor = (Math.floor(w1 / 38) & 1) ? (th.curbA || '#e53935') : (th.curbB || '#f5f5f5');
      ctx.fillStyle = curbColor;

      // Bordillo izquierdo
      ctx.beginPath();
      ctx.moveTo(cx1 - ew1, y1); ctx.lineTo(cx1 - rw1, y1);
      ctx.lineTo(cx2 - rw2, y2); ctx.lineTo(cx2 - ew2, y2);
      ctx.closePath(); ctx.fill();

      // Bordillo derecho
      ctx.beginPath();
      ctx.moveTo(cx1 + rw1, y1); ctx.lineTo(cx1 + ew1, y1);
      ctx.lineTo(cx2 + ew2, y2); ctx.lineTo(cx2 + rw2, y2);
      ctx.closePath(); ctx.fill();

      // 3. Asfalto principal con franjas de matiz sutil alternadas
      const isAlt = (Math.floor(w1 / 38) & 1) === 0;
      const roadBase = th.asphalt || '#3c3f4a';
      ctx.fillStyle = isAlt ? roadBase : shade(roadBase, 0.08);
      ctx.beginPath();
      ctx.moveTo(cx1 - rw1, y1); ctx.lineTo(cx1 + rw1, y1);
      ctx.lineTo(cx2 + rw2, y2); ctx.lineTo(cx2 - rw2, y2);
      ctx.closePath(); ctx.fill();

      // 4. Líneas viales exteriores continuas
      ctx.fillStyle = 'rgba(240,240,245,0.85)';
      const lw1 = 3.5 * sc1, lw2 = 3.5 * sc2;
      const elOffset = ROAD_HALF - 8;

      // Línea exterior izquierda
      ctx.beginPath();
      ctx.moveTo(cx1 - elOffset * sc1 - lw1, y1); ctx.lineTo(cx1 - elOffset * sc1 + lw1, y1);
      ctx.lineTo(cx2 - elOffset * sc2 + lw2, y2); ctx.lineTo(cx2 - elOffset * sc2 - lw2, y2);
      ctx.closePath(); ctx.fill();

      // Línea exterior derecha
      ctx.beginPath();
      ctx.moveTo(cx1 + elOffset * sc1 - lw1, y1); ctx.lineTo(cx1 + elOffset * sc1 + lw1, y1);
      ctx.lineTo(cx2 + elOffset * sc2 + lw2, y2); ctx.lineTo(cx2 + elOffset * sc2 - lw2, y2);
      ctx.closePath(); ctx.fill();

      // 5. Líneas de separación de carril discontinuas
      if ((Math.floor(w1 / 44) & 1) === 0) {
        ctx.fillStyle = 'rgba(255,255,255,0.92)';
        for (const laneOffset of [-80, 0, 80]) {
          const lx1 = cx1 + laneOffset * sc1;
          const lx2 = cx2 + laneOffset * sc2;
          ctx.beginPath();
          ctx.moveTo(lx1 - lw1, y1); ctx.lineTo(lx1 + lw1, y1);
          ctx.lineTo(lx2 + lw2, y2); ctx.lineTo(lx2 - lw2, y2);
          ctx.closePath(); ctx.fill();
        }
      }

      // 6. Línea de salida transversal
      if (w1 >= 116 && w1 <= 128) {
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.moveTo(cx1 - rw1, y1); ctx.lineTo(cx1 + rw1, y1);
        ctx.lineTo(cx2 + rw2, y2); ctx.lineTo(cx2 - rw2, y2);
        ctx.closePath(); ctx.fill();
      } else if (w1 >= G.len && w1 <= G.len + 32) {
        // 7. Línea de llegada ajedrezada en perspectiva cónica
        const row = Math.floor((w1 - G.len) / 16);
        const checks = 12;
        const cstep1 = (rw1 * 2) / checks, cstep2 = (rw2 * 2) / checks;
        for (let c = 0; c < checks; c++) {
          ctx.fillStyle = ((c + row) & 1) ? '#111118' : '#ffffff';
          ctx.beginPath();
          ctx.moveTo(cx1 - rw1 + c * cstep1, y1);
          ctx.lineTo(cx1 - rw1 + (c + 1) * cstep1, y1);
          ctx.lineTo(cx2 - rw2 + (c + 1) * cstep2, y2);
          ctx.lineTo(cx2 - rw2 + c * cstep2, y2);
          ctx.closePath(); ctx.fill();
        }
      }
    }
  }

  /**
   * Dibuja los pórticos metálicos 3D elevados sobre la calzada (Salida o Meta)
   * proyectados con escala inversamente proporcional a la distancia del observador.
   * @param {'start'|'finish'} kind - Tipo de arco.
   * @param {number} w - Coordenada de pista longitudinal del arco.
   * @param {number} horizonY - Altura actual del horizonte.
   */
  function drawFPGantry3D(kind, w, horizonY) {
    const focal = 275, camHeight = 65;
    const z = w - G.dist;
    if (z < 20 || z > 1800) return; // Fuera del rango de visión

    const sc = focal / z;
    const sy = horizonY + camHeight * sc;
    const rc = roadCenter(w) - roadCenter(G.dist) - G.lat;
    const sx = W / 2 + rc * sc - G.angle * 220;

    const spanW = (ROAD_HALF + CURB + 16) * sc;
    const lx = sx - spanW, rx = sx + spanW;
    const pw = 12 * sc;
    const gh = 90 * sc;
    const topY = sy - gh;

    // Pilares metálicos laterales
    for (const px of [lx, rx]) {
      const pg = ctx.createLinearGradient(px - pw / 2, 0, px + pw / 2, 0);
      pg.addColorStop(0, '#5a6075'); pg.addColorStop(0.5, '#c3c8d8'); pg.addColorStop(1, '#4a5062');
      ctx.fillStyle = pg;
      ctx.fillRect(px - pw / 2, topY, pw, gh);
      ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = 1;
      ctx.strokeRect(px - pw / 2, topY, pw, gh);
    }

    // Viga superior con pancarta publicitaria
    const bw = spanW * 2 + pw;
    const bh = 24 * sc;
    const by = topY;
    const bg = ctx.createLinearGradient(0, by, 0, by + bh);
    if (kind === 'finish') {
      bg.addColorStop(0, '#22283a'); bg.addColorStop(1, '#0c1018');
    } else {
      bg.addColorStop(0, '#ff3b50'); bg.addColorStop(1, '#b01024');
    }
    ctx.fillStyle = bg;
    ctx.fillRect(lx - pw / 2, by, bw, bh);

    // Damero blanco y negro en la meta
    if (kind === 'finish') {
      const chSize = 8 * sc;
      if (chSize > 2) {
        for (let i = 0; i < bw / chSize; i++) {
          ctx.fillStyle = (i & 1) ? '#fff' : '#111';
          ctx.fillRect(lx - pw / 2 + i * chSize, by, chSize, 4 * sc);
          ctx.fillRect(lx - pw / 2 + i * chSize, by + bh - 4 * sc, chSize, 4 * sc);
        }
      }
    }

    ctx.strokeStyle = 'rgba(255,255,255,0.4)'; ctx.lineWidth = 1.2;
    ctx.strokeRect(lx - pw / 2, by, bw, bh);

    // Letrero tipográfico
    if (bh > 8) {
      ctx.fillStyle = '#ffffff';
      ctx.font = `900 ${Math.max(9, Math.round(15 * sc))}px ${FONT}`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(kind === 'finish' ? 'M E T A' : 'S A L I D A', sx, by + bh / 2);
    }
  }

  /**
   * Ordena y dibuja todos los objetos 3D de la escena según el algoritmo del pintor (de más lejos a más cerca).
   * Fusiona árboles/decoración del paisaje, vehículos de tráfico (con proporciones fieles al carril),
   * bidones de combustible, manchas de aceite, pórticos y partículas en 3D.
   * @param {number} horizonY - Altura de la línea del horizonte.
   */
  function drawFPSorted3DObjects(horizonY) {
    const focal = 275, camHeight = 65;
    const renderList = [];
    const ti = THEMES.indexOf(G.theme);

    // 1. Recolección de elementos decorativos del paisaje en los laterales
    const SEG = 72;
    const firstSeg = Math.floor(G.dist / SEG) + 1;
    const lastSeg = Math.floor((G.dist + 1700) / SEG);
    const sceneryList = G.theme.scenery3D || Sprites.THEMES[0].scenery3D;

    if (sceneryList && sceneryList.length) {
      for (let i = lastSeg; i >= firstSeg; i--) {
        for (const side of [-1, 1]) {
          const seed = i * 2 + (side > 0 ? 1 : 0) + ti * 100003;
          if (hash(seed) > 0.76) continue;
          const w = i * SEG + hash(seed + 19) * SEG;
          const z = w - G.dist;
          if (z < 32 || z > 1750) continue;
          const lat = side * (214 + hash(seed + 13) * 110);
          const spr = sceneryList[Math.floor(hash(seed + 17) * sceneryList.length) % sceneryList.length];
          renderList.push({ z, type: 'scenery', w, lat, spr });
        }
      }
    }

    // 2. Recolección de entidades dinámicas (rivales, obstáculos, combustible)
    for (const e of G.entities) {
      const z = e.w - G.dist;
      if (z >= 18 && z <= 1780) {
        renderList.push({ z, type: 'entity', e, w: e.w, lat: e.lat });
      }
    }

    // 3. Recolección de pórticos de Salida y Meta
    const zStart = 120 - G.dist;
    if (zStart >= 20 && zStart <= 1780) {
      renderList.push({ z: zStart, type: 'gantry', kind: 'start', w: 120, lat: 0 });
    }
    const zFinish = G.len - G.dist;
    if (zFinish >= 20 && zFinish <= 1780) {
      renderList.push({ z: zFinish, type: 'gantry', kind: 'finish', w: G.len, lat: 0 });
    }

    // 4. Recolección de partículas en el espacio tridimensional
    for (const p of G.particles) {
      const z = p.w - G.dist;
      if (z >= 14 && z <= 1300) {
        renderList.push({ z, type: 'particle', p, w: p.w, lat: p.lat });
      }
    }

    // Ordenar rigurosamente de mayor profundidad Z (más lejos) a menor Z (más cerca)
    renderList.sort((a, b) => b.z - a.z);

    // Renderizar cada elemento proyectado
    for (const item of renderList) {
      const z = item.z;
      const sc = focal / z;
      const sy = horizonY + camHeight * sc;
      const rc = roadCenter(item.w) - roadCenter(G.dist) - G.lat + item.lat;
      const sx = W / 2 + rc * sc - G.angle * 220;

      if (item.type === 'scenery') {
        // Árboles, casas o rocas en los costados
        const spr = item.spr;
        const dw = spr.w * sc * 2.1, dh = spr.h * sc * 2.1;
        if (sx + dw / 2 < -60 || sx - dw / 2 > W + 60) continue;
        // Sombra elíptica sobre el césped
        ctx.fillStyle = 'rgba(0,0,0,0.22)';
        ctx.beginPath();
        ctx.ellipse(sx, sy - 2, dw * 0.36, dh * 0.08, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.drawImage(spr.c, sx - dw / 2, sy - dh, dw, dh);
      } else if (item.type === 'entity') {
        const e = item.e;
        const spr = getFPEntitySprite(e);
        if (e.type === 'fuel') {
          // Bidón de combustible flotante
          const itemScale = sc * 0.6;
          const dw = spr.w * itemScale, dh = spr.h * itemScale;
          const hover = (Math.sin(G.t * 7 + e.w) * 10 + 10) * sc;
          ctx.fillStyle = 'rgba(255,214,70,0.3)';
          ctx.beginPath(); ctx.ellipse(sx, sy - 1, dw * 0.45, Math.max(1.5, 3 * sc), 0, 0, Math.PI * 2); ctx.fill();
          ctx.drawImage(spr.c, sx - dw / 2, sy - dh - hover, dw, dh);
        } else if (e.type === 'oil') {
          // Mancha de aceite en el suelo
          const itemScale = sc * 0.65;
          const dw = spr.w * itemScale, dh = spr.h * itemScale * 0.75;
          ctx.drawImage(spr.c, sx - dw / 2, sy - dh / 2, dw, dh);
        } else {
          // Vehículos de tráfico (deportivos y camiones) escalados exactamente para ajustarse al carril (~43px vs 80px)
          const carScale = e.type === 'truck' ? sc * 0.62 : sc * 0.64;
          const dw = spr.w * carScale, dh = spr.h * carScale;
          // Sombra proyectada del vehículo
          ctx.fillStyle = 'rgba(0,0,0,0.36)';
          ctx.beginPath(); ctx.ellipse(sx, sy - 1, dw * 0.44, Math.max(1.8, dh * 0.05), 0, 0, Math.PI * 2); ctx.fill();
          ctx.drawImage(spr.c, sx - dw / 2, sy - dh, dw, dh);

          // Intermitente ámbar parpadeante en los deportivos que cambian de carril
          if (e.type === 'sport' && e.blink && Math.floor(G.t * 8) % 2 === 0) {
            ctx.fillStyle = '#ffa800'; ctx.shadowColor = '#ffa800'; ctx.shadowBlur = 8;
            const blinkX = sx + e.blink * (dw * 0.4);
            ctx.beginPath(); ctx.arc(blinkX, sy - dh * 0.45, Math.max(1.5, 3.5 * carScale), 0, Math.PI * 2); ctx.fill();
            ctx.shadowColor = 'transparent';
          }

          // Luces traseras rojas incandescentes en la noche
          if (G.theme.night) {
            ctx.fillStyle = 'rgba(255,30,30,0.85)'; ctx.shadowColor = '#ff2020'; ctx.shadowBlur = 10;
            const tlOff = dw * 0.36;
            ctx.beginPath(); ctx.arc(sx - tlOff, sy - dh * 0.35, Math.max(1.5, 3 * carScale), 0, Math.PI * 2); ctx.fill();
            ctx.beginPath(); ctx.arc(sx + tlOff, sy - dh * 0.35, Math.max(1.5, 3 * carScale), 0, Math.PI * 2); ctx.fill();
            ctx.shadowColor = 'transparent';
          }
        }
      } else if (item.type === 'gantry') {
        drawFPGantry3D(item.kind, item.w, horizonY);
      } else if (item.type === 'particle') {
        const p = item.p;
        const size = Math.max(1, p.size * sc * 1.6);
        ctx.fillStyle = p.color;
        ctx.globalAlpha = clamp(p.life / p.max, 0, 1);
        ctx.beginPath();
        ctx.arc(sx, sy - 12 * sc, size, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    }
  }

  /**
   * Dibuja los haces de luz de los faros delanteros del jugador iluminando el asfalto nocturno.
   * Utiliza composición `lighter` para un resplandor fotométrico realista.
   * @param {number} horizonY - Altura de la línea del horizonte.
   */
  function drawFPNightLighting(horizonY) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const beamY = 560;
    for (const hx of [W / 2 - 40, W / 2 + 40]) {
      const lg = ctx.createRadialGradient(hx, beamY, 20, W / 2, horizonY + 30, 280);
      lg.addColorStop(0, 'rgba(255,245,200,0.38)');
      lg.addColorStop(0.5, 'rgba(255,235,160,0.16)');
      lg.addColorStop(1, 'rgba(255,220,120,0)');
      ctx.fillStyle = lg;
      ctx.beginPath();
      ctx.moveTo(hx - 24, beamY);
      ctx.lineTo(W / 2 - 80, horizonY + 20);
      ctx.lineTo(W / 2 + 80, horizonY + 20);
      ctx.lineTo(hx + 24, beamY);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  /**
   * Renderiza el interior de la cabina del piloto (Cockpit) en primera persona:
   * - Capó exterior rojo con franjas de carreras reaccionando a la dirección y derrapes.
   * - Salpicadero en cuero con costuras realistas.
   * - Consola digital de instrumentos (velocímetro, tacómetro LED de revoluciones, indicador HIGH/LOW y combustible).
   * - Volante de competición con rotación dinámica e impacto de vibración en choques.
   * @param {number} bob - Oscilación vertical natural producida por la velocidad.
   * @param {number} roll - Inclinación angular en curvas.
   */
  function drawFPCockpit(bob, roll) {
    ctx.save();

    // 1. Capó deportivo rojo con franjas blancas
    const hoodSpr = Sprites.fp.hood;
    const hoodX = W / 2 - G.steer * 26;
    const hoodY = 538 + bob * 1.2 + (input.up || input.turbo ? -4 : 0) + (input.down ? 4 : 0);
    const hoodRot = -G.steer * 0.04 + (G.skid ? -G.skidDir * 0.08 : 0);

    ctx.save();
    ctx.translate(hoodX, hoodY);
    ctx.rotate(hoodRot);
    const hw = hoodSpr.w * 1.08;
    const hh = hoodSpr.h * 1.08;
    ctx.drawImage(hoodSpr.c, -hw / 2, 0, hw, hh);
    ctx.restore();

    // 2. Salpicadero de la cabina
    const dashY = 590 + bob * 0.4;
    const dg = ctx.createLinearGradient(0, dashY - 14, 0, H);
    dg.addColorStop(0, '#101017');
    dg.addColorStop(0.18, '#181822');
    dg.addColorStop(0.5, '#121219');
    dg.addColorStop(1, '#08080c');
    ctx.fillStyle = dg;
    ctx.beginPath();
    ctx.moveTo(0, dashY + 12);
    ctx.quadraticCurveTo(W / 2, dashY - 12, W, dashY + 12);
    ctx.lineTo(W, H);
    ctx.lineTo(0, H);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Línea de costura en cuero deportivo
    ctx.strokeStyle = '#2b2b3a';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(20, dashY + 24);
    ctx.quadraticCurveTo(W / 2, dashY + 2, W - 20, dashY + 24);
    ctx.stroke();
    ctx.setLineDash([]);

    // 3. Cuadro de mandos digital (Instrument Cluster)
    const clusterX = W / 2, clusterY = 636 + bob * 0.3;
    const clW = 220, clH = 74;
    rrPath(ctx, clusterX - clW / 2, clusterY - clH / 2, clW, clH, 12);
    ctx.fillStyle = '#0a0c14'; ctx.fill();
    ctx.strokeStyle = '#2c3245'; ctx.lineWidth = 2; ctx.stroke();

    // Resplandor del display LCD
    const clGlow = ctx.createRadialGradient(clusterX, clusterY, 10, clusterX, clusterY, clW / 2);
    clGlow.addColorStop(0, 'rgba(18,34,58,0.7)'); clGlow.addColorStop(1, 'rgba(6,10,18,0.9)');
    ctx.fillStyle = clGlow;
    rrPath(ctx, clusterX - clW / 2 + 4, clusterY - clH / 2 + 4, clW - 8, clH - 8, 9);
    ctx.fill();

    // Velocímetro digital luminoso
    ctx.fillStyle = '#38e8d8';
    ctx.font = `900 24px ${FONT}`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(Math.round(G.speed), clusterX, clusterY - 8);
    ctx.fillStyle = '#7a8ba8';
    ctx.font = `700 8px ${FONT}`;
    ctx.fillText('KM/H', clusterX, clusterY + 10);

    // Barra LED indicadora de revoluciones (RPM / Shift lights: verde -> amarillo -> rojo)
    const rpmFraction = clamp(G.speed / (input.turbo ? 320 : 205), 0, 1);
    const bars = 10;
    const barW = 12, barH = 5, barGap = 4;
    const totalBarsW = bars * barW + (bars - 1) * barGap;
    const startBarX = clusterX - totalBarsW / 2;
    for (let b = 0; b < bars; b++) {
      const bx = startBarX + b * (barW + barGap);
      const by = clusterY + 20;
      const active = (b / bars) <= rpmFraction;
      if (active) {
        ctx.fillStyle = b < 5 ? '#38e878' : (b < 8 ? '#ffb82e' : '#ff3852');
        ctx.shadowColor = ctx.fillStyle; ctx.shadowBlur = 6;
      } else {
        ctx.fillStyle = '#181e2b';
        ctx.shadowColor = 'transparent';
      }
      ctx.fillRect(bx, by, barW, barH);
    }
    ctx.shadowColor = 'transparent';

    // Indicador digital de marcha activa (HIGH o LOW)
    ctx.font = `700 8px ${FONT}`;
    ctx.fillStyle = input.turbo ? '#ff7a2b' : '#38e878';
    ctx.fillText(input.turbo ? 'HIGH' : 'LOW', clusterX - 44, clusterY - 10);

    // Indicador digital de combustible en cabina
    ctx.fillStyle = G.fuel < 25 ? '#ff3852' : '#38e8d8';
    ctx.fillText(`FUEL ${Math.round(G.fuel)}%`, clusterX + 44, clusterY - 10);

    // 4. Volante deportivo interactivo
    const wheelSpr = Sprites.fp.steeringWheel;
    const wheelX = W / 2;
    const wheelY = 676 + bob * 0.5;
    const wheelRot = G.steer * 0.9 + (G.skid ? G.skidDir * 0.5 : 0) + (G.crash ? Math.sin(G.t * 30) * 0.8 : 0);

    ctx.save();
    ctx.translate(wheelX, wheelY);
    ctx.rotate(wheelRot);
    ctx.drawImage(wheelSpr.c, -wheelSpr.w / 2, -wheelSpr.h / 2, wheelSpr.w, wheelSpr.h);
    ctx.restore();

    ctx.restore();
  }

  /**
   * Dibuja el espejo retrovisor interior funcional en el borde superior de la pantalla.
   * Proyecta en perspectiva inversa la carretera trasera y los coches rivales que se aproximan.
   */
  function drawFPRearviewMirror() {
    const mirrorSpr = Sprites.fp.mirror;
    const mx = W / 2;
    const my = 88;
    const mw = mirrorSpr.w;
    const mh = mirrorSpr.h;

    ctx.save();
    // Soporte de anclaje al techo
    ctx.fillStyle = '#16161f';
    ctx.fillRect(mx - 5, 60, 10, my - mh / 2 - 58);
    // Marco exterior cromado/mate
    ctx.drawImage(mirrorSpr.c, mx - mw / 2, my - mh / 2, mw, mh);

    const gw = mw - 14, gh = mh - 12;
    const gx = mx - gw / 2, gy = my - gh / 2;

    // Recorte al área interna del cristal del espejo
    ctx.save();
    rrPath(ctx, gx, gy, gw, gh, 8);
    ctx.clip();

    // Fondo del espejo (cielo y suelo traseros)
    const mg = ctx.createLinearGradient(0, gy, 0, gy + gh);
    mg.addColorStop(0, '#162338'); mg.addColorStop(0.48, '#324a66');
    mg.addColorStop(0.5, '#222630'); mg.addColorStop(1, '#12141a');
    ctx.fillStyle = mg;
    ctx.fillRect(gx, gy, gw, gh);

    // Calzada trasera proyectada en perspectiva inversa
    const mvx = mx, mvy = gy + gh * 0.48;
    ctx.fillStyle = '#2b303e';
    ctx.beginPath();
    ctx.moveTo(mvx - 6, mvy); ctx.lineTo(mvx + 6, mvy);
    ctx.lineTo(mvx + 46, gy + gh); ctx.lineTo(mvx - 46, gy + gh);
    ctx.closePath(); ctx.fill();

    // Línea central de la carretera trasera
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(mvx, mvy); ctx.lineTo(mvx, gy + gh);
    ctx.stroke();

    // Vehículos perseguidores reflejados en el retrovisor
    for (const e of G.entities) {
      const rel = e.w - G.dist;
      if (rel < 0 && rel > -380) { // Si están detrás y a menos de 380m
        const mDist = -rel;
        const mScale = clamp(1 - mDist / 380, 0.12, 0.95);
        const msx = mvx - (e.lat - G.lat) * 0.22 * mScale;
        const msy = mvy + (gy + gh - mvy) * mScale * 0.88;
        const mdw = 22 * mScale, mdh = 13 * mScale;

        // Carrocería del coche detrás
        ctx.fillStyle = e.type === 'truck' ? '#3d4454' : (e.type === 'sport' ? '#d93838' : '#3069b3');
        ctx.fillRect(msx - mdw / 2, msy - mdh, mdw, mdh);
        // Faros delanteros brillantes del rival
        ctx.fillStyle = '#fff9d6';
        ctx.beginPath(); ctx.arc(msx - mdw * 0.35, msy - mdh * 0.25, 1.8 * mScale, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(msx + mdw * 0.35, msy - mdh * 0.25, 1.8 * mScale, 0, Math.PI * 2); ctx.fill();
      }
    }

    // Reflejo diagonal de brillo sobre el cristal
    const sh = ctx.createLinearGradient(gx, gy, gx + gw, gy + gh);
    sh.addColorStop(0, 'rgba(255,255,255,0.22)');
    sh.addColorStop(0.35, 'rgba(255,255,255,0.03)');
    sh.addColorStop(1, 'rgba(0,0,0,0.25)');
    ctx.fillStyle = sh;
    ctx.fillRect(gx, gy, gw, gh);

    ctx.restore();
    ctx.restore();
  }

  /**
   * Dibuja los textos emergentes en perspectiva tridimensional 3D (bonificaciones de FUEL o puntos).
   * @param {number} horizonY - Altura del horizonte.
   */
  function drawFPTexts(horizonY) {
    const focal = 275, camHeight = 65;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const t of G.texts) {
      const age = 1 - t.life / t.max;
      const z = t.w - G.dist;
      let sx = W / 2, sy = 280 - age * 40;
      if (z >= 12 && z <= 1200) {
        const sc = focal / z;
        sy = horizonY + camHeight * sc - age * 65 * sc - 25;
        const rc = roadCenter(t.w) - roadCenter(G.dist) - G.lat + t.lat;
        sx = W / 2 + rc * sc - G.angle * 220;
      }
      ctx.globalAlpha = clamp(t.life / 0.35, 0, 1);
      ctx.font = `900 16px ${FONT}`;
      ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(0,0,0,0.8)'; ctx.strokeText(t.txt, sx, sy);
      ctx.fillStyle = t.color; ctx.fillText(t.txt, sx, sy);
      ctx.globalAlpha = 1;
    }
  }

  /**
   * Superpone capas cinemáticas sobre la vista en primera persona:
   * - Viñeta periférica de inmersión.
   * - Líneas de aceleración turbo ("Speed lines" de hipervelocidad).
   * - Destello cegador y efecto de parabrisas agrietado por impacto tras una colisión.
   * @param {number} horizonY - Altura del horizonte.
   */
  function drawFPOverlays(horizonY) {
    // 1. Viñeta fotográfica ambiental
    const vg = ctx.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, H * 0.78);
    vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,0.38)');
    ctx.fillStyle = vg; ctx.fillRect(0, 0, W, H);

    // 2. Líneas cinemáticas de velocidad en modo turbo
    if (input.turbo && G.thr && G.speed > 160 && !G.crash) {
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.32)';
      ctx.lineWidth = 1.4;
      const count = 18;
      for (let i = 0; i < count; i++) {
        const a = (i / count) * Math.PI * 2 + hash(Math.floor(G.dist * 0.5) + i * 17) * 0.4;
        const r1 = 80 + hash(i * 13 + 5) * 50;
        const r2 = r1 + 60 + hash(i * 29 + 9) * 120;
        ctx.beginPath();
        ctx.moveTo(W / 2 + Math.cos(a) * r1, horizonY + Math.sin(a) * r1 * 0.6);
        ctx.lineTo(W / 2 + Math.cos(a) * r2, horizonY + Math.sin(a) * r2 * 0.6);
        ctx.stroke();
      }
      ctx.restore();
    }

    // 3. Destello de choque y fracturas de cristal en el parabrisas
    if (G.crash) {
      if (G.crash.t < 0.14) {
        ctx.fillStyle = `rgba(255,255,255,${0.65 * (1 - G.crash.t / 0.14)})`;
        ctx.fillRect(0, 0, W, H);
      }
      ctx.save();
      ctx.strokeStyle = `rgba(255,255,255,${clamp(0.9 - G.crash.t * 0.4, 0.2, 0.85)})`;
      ctx.lineWidth = 1.6;
      const cx = W / 2, cy = 420;
      for (let i = 0; i < 9; i++) {
        const a = (i / 9) * Math.PI * 2;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        let px = cx, py = cy;
        for (let seg = 1; seg <= 5; seg++) {
          const r = seg * 32 + hash(i * 7 + seg) * 16;
          px = cx + Math.cos(a + hash(seg * 13) * 0.3) * r;
          py = cy + Math.sin(a + hash(seg * 13) * 0.3) * r * 0.7;
          ctx.lineTo(px, py);
        }
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  /**
   * Orquestador maestro del renderizado tridimensional en primera persona (Cockpit 3D).
   * Calcula cabeceo por aceleración/frenado (pitch), balanceo (roll), vibración del motor (bob)
   * y dibuja en secuencia: cielo, montañas lejanas, asfalto 3D, objetos ordenados en Z,
   * iluminación nocturna, textos, cabina con volante y parabrisas con retrovisor.
   */
  function renderFirstPerson() {
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    G.c0 = roadCenter(G.dist);

    ctx.save();
    // Sacudida de cámara (Screen Shake)
    if (G.shake > 0) ctx.translate(rand(-1, 1) * G.shake * 0.7, rand(-1, 1) * G.shake * 0.7);

    // Oscilación vertical por vibración de motor y rodaje
    const bob = Math.sin(G.t * 16) * (G.speed > 5 ? Math.min(2.4, G.speed * 0.012) : 0);
    // Cabeceo por aceleración o frenado brusco
    const pitch = (input.up || input.turbo ? -3 : 0) + (input.down ? 4 : 0);
    // Balanceo lateral angular en curvas
    const roll = G.steer * 0.035 + (G.skid ? G.skidDir * 0.08 : 0);
    // Posición Y de la línea del horizonte
    const horizonY = 305 + bob + pitch;

    drawFPSky(horizonY);
    drawFPDistantHills(horizonY);
    drawFP3DRoad(horizonY);
    drawFPSorted3DObjects(horizonY);
    if (G.theme.night) drawFPNightLighting(horizonY);
    drawFPTexts(horizonY);
    drawFPCockpit(bob, roll);
    drawFPRearviewMirror();
    drawFPOverlays(horizonY);

    ctx.restore();
  }

  /**
   * Conmutador principal de renderizado según la cámara seleccionada (`top` o `fp`),
   * asegurando siempre el dibujado posterior de la interfaz de usuario HUD.
   */
  function render() {
    if (G.cameraMode === 'fp') {
      renderFirstPerson();
    } else {
      renderTopDown();
    }
    drawHUD();
  }

  /* ==========================================================================
     10. BUCLE PRINCIPAL DE ANIMACIÓN Y GESTIÓN DE ENTRADAS
     ========================================================================== */

  /** Marca de tiempo del cuadro de animación anterior (en milisegundos) */
  let last = performance.now();

  /**
   * Bucle central de juego (Game Loop) ejecutado a 60 FPS mediante `requestAnimationFrame`.
   * Calcula el tiempo delta (`dt`) transcurrido y ejecuta secuencialmente la física y el dibujado.
   * @param {number} now - Marca de tiempo de alta resolución proporcionada por el navegador.
   */
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000); // Límite de seguridad para evitar saltos temporales gigantes
    last = now;
    update(dt);
    render();
    requestAnimationFrame(frame);
  }

  /**
   * Tabla de mapeo para controles duales: Flechas direccionales y teclado WASD.
   * @type {Record<string, 'left'|'right'|'up'|'down'|'turbo'>}
   */
  const KEYMAP = {
    ArrowLeft: 'left', KeyA: 'left',
    ArrowRight: 'right', KeyD: 'right',
    ArrowUp: 'up', KeyW: 'up',
    ArrowDown: 'down', KeyS: 'down',
    Space: 'turbo', ShiftLeft: 'turbo', ShiftRight: 'turbo',
  };

  /**
   * Escuchador global de pulsación de teclas (`keydown`).
   * Desbloquea el subsistema de audio en la primera interacción del usuario
   * y despacha acciones rápidas (pausa, silenciar, alternar cámara, iniciar carrera).
   */
  window.addEventListener('keydown', (e) => {
    const k = e.code;
    if (KEYMAP[k] || k === 'Space') e.preventDefault(); // Evitar scroll de la página web
    Sfx.unlock(); // Habilitar WebAudio
    if (KEYMAP[k]) input[KEYMAP[k]] = true;
    if (e.repeat) return; // Ignorar repeticiones del sistema operativo para atajos de pulsación única
    if (k === 'KeyP' || k === 'Escape') togglePause();
    else if (k === 'KeyM') syncMute(Sfx.toggleMute());
    else if (k === 'KeyC') toggleCamera();
    else if (k === 'Enter' || k === 'Space') primaryAction();
  });

  /**
   * Escuchador global de liberación de teclas (`keyup`).
   */
  window.addEventListener('keyup', (e) => {
    if (KEYMAP[e.code]) input[KEYMAP[e.code]] = false;
  });

  /**
   * Escuchador de pérdida de foco de la ventana (`blur`).
   * Desactiva automáticamente todas las teclas presionadas y pone el juego en pausa para proteger al jugador.
   */
  window.addEventListener('blur', () => {
    for (const k in input) input[k] = false;
    if (G.state === 'play' || G.state === 'countdown') togglePause();
  });

  /**
   * Actualiza el aspecto visual del botón de silencio y su icono vectorial SVG.
   * @param {boolean} m - Estado de silencio (true = muteado).
   */
  function syncMute(m) {
    $('muteBtn').classList.toggle('off', m);
    $('muteIcon').setAttribute('d', m
      ? 'M3 9v6h4l5 4V5L7 9H3zm13.6 3l2.4-2.4-1.4-1.4-2.4 2.4-2.4-2.4-1.4 1.4 2.4 2.4-2.4 2.4 1.4 1.4 2.4-2.4 2.4 2.4 1.4-1.4z'
      : 'M3 9v6h4l5 4V5L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 8v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z');
  }

  // Evento de clic en el botón de silenciar audio
  $('muteBtn').addEventListener('click', (e) => {
    Sfx.unlock();
    syncMute(Sfx.toggleMute());
    e.currentTarget.blur();
  });

  /**
   * Actualiza la interfaz visual del botón selector de cámara flotante ("1ª PERS." / "CENITAL").
   */
  function syncCameraUI() {
    const isFp = G.cameraMode === 'fp';
    const btn = $('camBtn');
    const lbl = $('camLabel');
    if (lbl) lbl.textContent = isFp ? '1ª PERS.' : 'CENITAL';
    if (btn) {
      btn.classList.toggle('active', isFp);
      btn.title = `Cámara: ${isFp ? '1ª Persona' : 'Cenital'} (Tecla C)`;
    }
  }

  /**
   * Alterna entre el modo de vista cenital (Top-down) y el modo de vista en primera persona (Cockpit 3D).
   * Almacena la preferencia en `localStorage` para recordarla entre sesiones.
   */
  function toggleCamera() {
    G.cameraMode = G.cameraMode === 'fp' ? 'top' : 'fp';
    try { localStorage.setItem('roadfighter.cam', G.cameraMode); } catch (e) { /* ignorar modo incógnito */ }
    syncCameraUI();
    popup(G.cameraMode === 'fp' ? 'CÁMARA: 1ª PERSONA' : 'CÁMARA: CENITAL', '#4cf08a');
    Sfx.unlock();
  }

  // Evento de clic en el botón de conmutar cámara
  const camBtnEl = $('camBtn');
  if (camBtnEl) camBtnEl.addEventListener('click', (e) => {
    toggleCamera();
    e.currentTarget.blur();
  });

  // Conexión de botones de interfaz HTML (Play, Pausa, Salir, Reintentar, Siguiente)
  $('btnPlay').addEventListener('click', () => { Sfx.unlock(); startGame(); });
  $('btnResume').addEventListener('click', togglePause);
  $('btnQuit').addEventListener('click', toMenu);
  $('btnNext').addEventListener('click', () => startStage(G.stage + 1));
  $('btnRetry').addEventListener('click', startGame);
  $('btnMenu1').addEventListener('click', toMenu);
  $('btnAgain').addEventListener('click', startGame);

  // Botones táctiles virtuales para dispositivos móviles (Pointer Events)
  for (const b of document.querySelectorAll('#touch button')) {
    const k = b.dataset.key;
    const on = (e) => { e.preventDefault(); Sfx.unlock(); input[k] = true; b.classList.add('active'); };
    const off = (e) => { e.preventDefault(); input[k] = false; b.classList.remove('active'); };
    b.addEventListener('pointerdown', on);
    b.addEventListener('pointerup', off);
    b.addEventListener('pointercancel', off);
    b.addEventListener('pointerleave', off);
  }

  // En dispositivos táctiles, tocar el lienzo de juego también activa el audio
  canvas.addEventListener('pointerdown', () => Sfx.unlock());

  // Generación automática de previsualizaciones de sprites en los minicanvases de la guía de juego
  for (const c of document.querySelectorAll('canvas[data-sprite]')) {
    const map = { fuel: Sprites.fuel, oil: Sprites.oil, sport: Sprites.sports[0], truck: Sprites.trucks[0] };
    const spr = map[c.dataset.sprite];
    c.width = 104; c.height = 104;
    const g = c.getContext('2d');
    const s = Math.min(100 / spr.w, 100 / spr.h) * (c.dataset.sprite === 'oil' ? 1 : 0.95);
    const dw = spr.w * s, dh = spr.h * s;
    g.drawImage(spr.c, (104 - dw) / 2, (104 - dh) / 2, dw, dh);
  }

  /* ==========================================================================
     ARRANQUE E INICIALIZACIÓN DEL SISTEMA
     ========================================================================== */
  syncCameraUI();
  startMenuDemo();
  showOverlay('menu');
  requestAnimationFrame(frame);

  // Hook para depuración y pruebas unitarias rápidas mediante hash en URL (ejemplo: #test=2,turbo)
  // TEST-HOOK-START
  {
    const m = /test=(\d)(?:,(\w+))?/.exec(location.hash);
    if (m) {
      startStage(+m[1]);
      input.up = true;
      input.turbo = m[2] === 'turbo';
      G.cd = 0.5;
      setTimeout(() => { G.invuln = 999; }, 600);
    }
  }
  // TEST-HOOK-END

  /**
   * Exposición del objeto de estado y métodos principales en `window` para inspección en consola de depuración.
   */
  window.__RF = { G, startGame, startStage, STAGES, input };
})();
