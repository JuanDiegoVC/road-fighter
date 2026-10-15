'use strict';
/* ==========================================================================
   ROAD FIGHTER · Motor de Audio Procedural (WebAudio API)
   --------------------------------------------------------------------------
   Arquitectura de sonido 100% sintetizada por código en tiempo real:
   1. Sintetizador del motor: Osciladores diente de sierra + cuadrado filtrados
      por paso bajo dinámico ligado a las RPM y velocidad del coche.
   2. Generador de efectos de sonido (SFX): Tonos, ruido blanco y modulaciones.
   3. Secuenciador musical chiptune arcade: Scheduler en tiempo real con
      bajo analógico, arpegios retro, melodías de plomo y percusión sintética.
   Sin ficheros MP3/WAV externos: máxima ligereza, cero latencia y 60 FPS.
   ========================================================================== */

const Sfx = (() => {
  /* ----------------------------------------------------------- Variables de contexto */
  /** @type {AudioContext|null} Contexto principal de Web Audio */
  let ac = null;
  /** @type {GainNode|null} Nodo de volumen maestro global */
  let master = null;
  /** @type {boolean} Estado de silencio (mute) activado/desactivado */
  let muted = false;

  /* ---------------------------------------------------- Sintetizador del motor */
  /**
   * eng contiene los nodos de Web Audio para simular el sonido del motor:
   * - o1: Oscilador principal en onda 'sawtooth' (tono áspero de pistones)
   * - o2: Sub-oscilador en onda 'square' a media frecuencia (cuerpo y graves)
   * - f:  Filtro Biquad paso bajo (abre armónicos agudos al acelerar)
   * - g:  Nodo de ganancia que controla el volumen del motor
   */
  const eng = {};

  /* ---------------------------------------------------- Secuenciador musical arcade */
  let musicOn = false;   // Bandera para activar/desactivar la música de fondo
  let nextT = 0;         // Marca de tiempo en segundos para la siguiente semicorchea
  let step = 0;          // Índice de paso en el bucle rítmico musical
  const TEMPO = 150;     // Tempo en BPM (Beats Por Minuto)
  const STEP = 60 / TEMPO / 2; // Duración de cada semicorchea en segundos (~0.2s)

  // Notas base (MIDI) de la progresión armónica arcade: Am - F - C - G
  const ROOTS = [45, 41, 48, 43];
  // Intervalos de acordes (semitonos): menor, mayor, mayor, mayor
  const CHORDS = [[0, 3, 7], [0, 4, 7], [0, 4, 7], [0, 4, 7]];

  /**
   * Convierte un número de nota MIDI a frecuencia en Hertz (Hz).
   * La fórmula estándar es: f = 440 * 2^((m - 69) / 12)
   * @param {number} m - Número de nota MIDI (ej. 69 = La 440 Hz)
   * @returns {number} Frecuencia resultante en Hz
   */
  const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

  /** Estado del congruencial lineal usado para el ruido blanco (semilla fija) */
  let noiseX = 12345;

  /* ------------------------------------------------------------- Inicialización */
  /**
   * Desbloquea el AudioContext ante la primera interacción del usuario (tecla o clic).
   * Los navegadores modernos bloquean el audio automático hasta una interacción explícita.
   */
  function unlock() {
    if (!ac) {
      try {
        ac = new (window.AudioContext || window.webkitAudioContext)();
      } catch (e) {
        return; // Navegador no compatible con Web Audio API
      }
      master = ac.createGain();
      master.gain.value = muted ? 0 : 0.7;
      master.connect(ac.destination);

      initEngine(); // Prepara los osciladores del motor

      nextT = ac.currentTime + 0.1;
      // Scheduler que programa notas ligeramente en el futuro para evitar jitter
      setInterval(scheduler, 40);
    }
    // Si la pestaña estuvo en segundo plano y el navegador suspendió el audio, reanudar
    if (ac.state === 'suspended') ac.resume();
  }

  /**
   * Configura la cadena de nodos de audio para el sintetizador de motor continuo.
   */
  function initEngine() {
    // Oscilador 1: Diente de sierra (timbre metálico y rugoso)
    eng.o1 = ac.createOscillator();
    eng.o1.type = 'sawtooth';

    // Oscilador 2: Cuadrada (graves y resonancia de escape)
    eng.o2 = ac.createOscillator();
    eng.o2.type = 'square';

    // Filtro paso bajo: corta armónicos altos a bajas RPM y se abre a altas velocidades
    eng.f = ac.createBiquadFilter();
    eng.f.type = 'lowpass';
    eng.f.frequency.value = 500;

    // Control de volumen independiente del motor
    eng.g = ac.createGain();
    eng.g.gain.value = 0;

    // Conexión: [o1 + o2] -> Filtro -> Ganancia -> Master
    eng.o1.connect(eng.f);
    eng.o2.connect(eng.f);
    eng.f.connect(eng.g);
    eng.g.connect(master);

    eng.o1.start();
    eng.o2.start();
  }

  /**
   * Modula dinámicamente el sonido del motor en cada frame según la telemetría del juego.
   * @param {number} speed - Velocidad actual del coche (0 a 320 km/h)
   * @param {boolean} throttle - True si el jugador tiene el acelerador pulsado
   * @param {boolean} active - True si el juego está en marcha (cuenta atrás o carrera)
   */
  function engine(speed, throttle, active) {
    if (!ac) return;
    const t = ac.currentTime;

    // Frecuencia fundamental del motor: base de ralentí (42 Hz) + incremento por velocidad
    const f = 42 + speed * 0.38 + (throttle ? 8 : 0);
    eng.o1.frequency.setTargetAtTime(f, t, 0.06);
    eng.o2.frequency.setTargetAtTime(f * 0.5, t, 0.06);

    // Apertura del filtro: simula el rugido del escape abriéndose a gran velocidad
    eng.f.frequency.setTargetAtTime(260 + speed * 3.2, t, 0.08);

    // Volumen suave con atenuación para no tapar los efectos de sonido
    eng.g.gain.setTargetAtTime(active ? 0.05 + (throttle ? 0.025 : 0) : 0, t, 0.08);
  }

  /* ------------------------------------------------------------- Generadores básicos */
  /**
   * Sintetiza un tono melódico simple con envolvente ADSR (Attack-Decay) exponencial.
   * @param {number} freq - Frecuencia inicial en Hz
   * @param {number} dur - Duración total en segundos
   * @param {OscillatorType} [type='square'] - Forma de onda ('square', 'sine', 'sawtooth', 'triangle')
   * @param {number} [vol=0.1] - Nivel de volumen pico
   * @param {number} [when=0] - Retardo de inicio relativo en segundos
   * @param {number} [slideTo] - Frecuencia final para crear un glissando/pitch bend
   * @param {AudioNode} [dest] - Nodo de destino (por defecto master)
   */
  function tone(freq, dur, type, vol, when, slideTo, dest) {
    if (!ac) return;
    const t = ac.currentTime + (when || 0);
    const o = ac.createOscillator(), g = ac.createGain();

    o.type = type || 'square';
    o.frequency.setValueAtTime(freq, t);
    // Deslizamiento de tono si se requiere (ej. caídas de tono en explosiones o subidas en turbo)
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);

    // Envolvente de volumen: ataque rápido y desvanecimiento suave (anti-clic)
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol || 0.1, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    o.connect(g);
    g.connect(dest || master);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  /**
   * Genera una ráfaga de ruido blanco sintético filtrado (utilizado para choques, derrapes y caja de batería).
   * @param {number} dur - Duración de la ráfaga en segundos
   * @param {number} [vol=0.2] - Volumen pico del ruido
   * @param {number} [fc=1200] - Frecuencia de corte del filtro paso bajo (Hz)
   * @param {number} [when=0] - Retardo de inicio relativo
   * @param {AudioNode} [dest] - Nodo destino
   */
  function noise(dur, vol, fc, when, dest) {
    if (!ac) return;
    const t = ac.currentTime + (when || 0);
    const n = Math.floor(ac.sampleRate * dur);
    const buf = ac.createBuffer(1, n, ac.sampleRate);
    const d = buf.getChannelData(0);

    // Ruido blanco con decaimiento lineal, generado con un congruencial lineal propio
    // (solo afecta al timbre del sonido, no a la mecánica del juego)
    for (let i = 0; i < n; i++) {
      noiseX = (Math.imul(1664525, noiseX) + 1013904223) >>> 0;
      d[i] = (noiseX / 4294967296 * 2 - 1) * (1 - i / n);
    }

    const s = ac.createBufferSource();
    s.buffer = buf;

    const f = ac.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = fc || 1200;

    const g = ac.createGain();
    g.gain.value = vol || 0.2;

    s.connect(f);
    f.connect(g);
    g.connect(dest || master);
    s.start(t);
  }

  /* ------------------------------------------------------------- Secuenciador chiptune */
  /**
   * Bucle del planificador de notas musicales (WebAudio lookahead pattern).
   * Programa notas con 200 ms de antelación para que la música no tenga micro-pausas.
   */
  function scheduler() {
    if (!ac) return;
    if (!musicOn || ac.state !== 'running') {
      nextT = Math.max(nextT, ac.currentTime + 0.05);
      return;
    }
    while (nextT < ac.currentTime + 0.2) {
      playStep(nextT, step++);
      nextT += STEP;
    }
  }

  /**
   * Dispara los instrumentos correspondientes a un paso de la secuencia rítmica.
   * @param {number} t - Tiempo absoluto del audio en que sonará el paso
   * @param {number} s - Número correlativo del paso
   */
  function playStep(t, s) {
    const bar = Math.floor(s / 8) % 4, i = s % 8;
    const root = ROOTS[bar], chord = CHORDS[bar];
    const w = t - ac.currentTime;

    // 1. Línea de bajo continuo (onda triangular retro)
    tone(mtof(root + (i % 4 >= 2 ? 12 : 0)), STEP * 0.85, 'triangle', 0.13, w);

    // 2. Arpegio rítmico (onda cuadrada estilo GameBoy/NES)
    const arp = [0, 1, 2, 1, 2, 1, 2, 1][i];
    tone(mtof(root + 24 + chord[arp]), STEP * 0.7, 'square', 0.028, w);

    // 3. Melodía solista (onda diente de sierra sincronizada con los compases)
    if (bar % 2 === 0 && (i === 0 || i === 3 || i === 6)) {
      tone(mtof(root + 36 + chord[(i / 3) | 0]), STEP * 1.6, 'sawtooth', 0.02, w);
    }

    // 4. Percusión sintetizada: Bombo (pitch drop senoidal) y Caja (ruido filtrado)
    if (i % 4 === 0) tone(150, 0.12, 'sine', 0.2, w, 40); // Bombo
    if (i % 2 === 1) noise(0.04, 0.05, 7000, w);          // Caja / Hi-hat
  }

  /* ------------------------------------------------------------- API pública exportada */
  return {
    unlock,
    engine,
    /** Activa o apaga la música chiptune de fondo */
    setMusic(on) { musicOn = on; },
    /** Devuelve el estado de silencio actual */
    get muted() { return muted; },
    /**
     * Alterna entre sonido activado y silenciado.
     * @returns {boolean} Nuevo estado de mute
     */
    toggleMute() {
      muted = !muted;
      if (master) master.gain.setTargetAtTime(muted ? 0 : 0.7, ac.currentTime, 0.03);
      return muted;
    },
    /** Pitido de la cuenta atrás (grave para 3, 2, 1; agudo para ¡YA!) */
    beep(go) { tone(go ? 1040 : 520, go ? 0.5 : 0.18, 'square', 0.12); },
    /** Efecto ascendente al recoger un bidón de combustible */
    pickup() { [660, 880, 1320].forEach((f, i) => tone(f, 0.12, 'square', 0.1, i * 0.07)); },
    /** Impacto o roce con otro vehículo */
    crash() {
      noise(0.5, 0.5, 2200);
      tone(180, 0.45, 'sawtooth', 0.2, 0, 40);
    },
    /** Explosión mayor al chocar contra camión o salir despedido contra el bordillo */
    explode() {
      noise(1.1, 0.7, 900);
      tone(110, 0.9, 'sawtooth', 0.25, 0, 28);
    },
    /** Derrape sobre mancha de aceite (chirrido de ruedas agudo) */
    skid() { noise(0.35, 0.12, 5200); },
    /** Golpe seco de la suspensión al caer en un bache */
    bump() {
      tone(90, 0.22, 'sine', 0.35, 0, 45);
      noise(0.18, 0.3, 600);
    },
    /** Moneda arcade al insertar una ficha (dos notas agudas) */
    coin() { tone(988, 0.08, 'square', 0.1); tone(1319, 0.3, 'square', 0.1, 0.08); },
    /** Arpegio ascendente al ganar una vida extra */
    extraLife() { [523, 659, 784, 1046, 1319].forEach((f, i) => tone(f, 0.12, 'triangle', 0.12, i * 0.06)); },
    /** Pitido de semáforo peatonal cuando una persona empieza a cruzar */
    crossing() { [0, 0.16, 0.32].forEach((w) => tone(1480, 0.07, 'square', 0.05, w)); },
    /** Zumbido dinámico de adelantamiento a gran velocidad ("¡Por poco!") */
    pass() { tone(900, 0.07, 'triangle', 0.06, 0, 1300); },
    /** Alerta de combustible bajo en reserva */
    warning() { tone(740, 0.08, 'square', 0.07); tone(740, 0.08, 'square', 0.07, 0.14); },
    /** Fanfarria victoriosa al cruzar la línea de meta */
    finish() { [523, 659, 784, 1046, 784, 1046].forEach((f, i) => tone(f, 0.2, 'square', 0.1, i * 0.12)); },
    /** Jingle descendente de Game Over */
    gameover() { [392, 330, 262, 196].forEach((f, i) => tone(f, 0.35, 'sawtooth', 0.12, i * 0.22)); },
  };
})();
