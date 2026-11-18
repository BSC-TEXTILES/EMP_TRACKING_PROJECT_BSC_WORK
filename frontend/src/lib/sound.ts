/**
 * BSC Textiles Workforce - Sound & Audio Notification Engine
 * 
 * Provides:
 * 1. Realistic telephone dual-frequency ringing for incoming calls (repeating cadence).
 * 2. Realistic telephone ringback tone for outgoing calls.
 * 3. Crisp, cheerful messaging tone for incoming chat messages.
 * 4. System notification chimes for workforce events (tasks, reports, approvals, tickets).
 * 5. Browser autoplay policy audio unlocker (primes WebAudio on first user interaction).
 * 6. Dual-engine architecture: WebAudio with synthesized WAV data-URI fallback.
 */

let sharedContext: AudioContext | null = null;
let audioUnlocked = false;

/**
 * Lazily creates and returns the singleton AudioContext.
 */
export function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  try {
    const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    if (!sharedContext) {
      sharedContext = new Ctor();
    }
    if (sharedContext.state === 'suspended') {
      void sharedContext.resume().catch(() => undefined);
    }
    return sharedContext;
  } catch {
    return null;
  }
}

/**
 * Primes and unlocks WebAudio upon the first user interaction anywhere in the window.
 * This ensures browser autoplay restrictions don't silence incoming calls or alerts.
 */
export function initAudioUnlock(): void {
  if (typeof window === 'undefined' || audioUnlocked) return;

  const unlock = () => {
    if (audioUnlocked) return;
    try {
      const ctx = getAudioContext();
      if (ctx) {
        if (ctx.state === 'suspended') {
          void ctx.resume();
        }
        // Play a silent 1-sample buffer to satisfy autoplay policy
        const buffer = ctx.createBuffer(1, 1, 22050);
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(ctx.destination);
        source.start(0);
        audioUnlocked = true;
      }
    } catch {
      /* ignore */
    } finally {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
      window.removeEventListener('touchstart', unlock);
      window.removeEventListener('click', unlock);
    }
  };

  window.addEventListener('pointerdown', unlock, { once: true, passive: true });
  window.addEventListener('keydown', unlock, { once: true, passive: true });
  window.addEventListener('touchstart', unlock, { once: true, passive: true });
  window.addEventListener('click', unlock, { once: true, passive: true });
}

// Auto-register unlock listener immediately upon script evaluation
initAudioUnlock();

/**
 * Builds a valid mono PCM WAV data URI for fallback playback.
 */
function buildWavUri(sampleRate: number, durationSec: number, sampleFn: (t: number) => number): string {
  const numSamples = Math.floor(sampleRate * durationSec);
  const buffer = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(buffer);

  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i += 1) view.setUint8(off + i, s.charCodeAt(i));
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + numSamples * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // Mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, numSamples * 2, true);

  for (let i = 0; i < numSamples; i += 1) {
    const val = Math.max(-1, Math.min(1, sampleFn(i / sampleRate)));
    view.setInt16(44 + i * 2, Math.round(val * 32767), true);
  }

  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return `data:audio/wav;base64,${btoa(binary)}`;
}

// Pre-generated WAV data URIs for instant zero-latency fallback
let cachedIncomingRingWav: string | null = null;
let cachedOutgoingRingWav: string | null = null;
let cachedMessagePingWav: string | null = null;
let cachedNotificationChimeWav: string | null = null;

function getIncomingRingWav(): string {
  if (!cachedIncomingRingWav) {
    // 3.0s cycle: double-ring (0.4s on, 0.2s pause, 0.4s on, 2.0s pause) with 440Hz + 480Hz dual-frequency
    cachedIncomingRingWav = buildWavUri(8000, 3.0, (t) => {
      let activeT = -1;
      if (t >= 0 && t < 0.4) activeT = t;
      else if (t >= 0.6 && t < 1.0) activeT = t - 0.6;

      if (activeT >= 0) {
        const env = Math.min(1, activeT / 0.02, (0.4 - activeT) / 0.02);
        const s1 = Math.sin(2 * Math.PI * 440 * t);
        const s2 = Math.sin(2 * Math.PI * 480 * t);
        return 0.5 * (s1 + s2) * 0.35 * env;
      }
      return 0;
    });
  }
  return cachedIncomingRingWav;
}

function getOutgoingRingWav(): string {
  if (!cachedOutgoingRingWav) {
    // 3.0s cycle: 1.0s soft ringback tone, 2.0s pause
    cachedOutgoingRingWav = buildWavUri(8000, 3.0, (t) => {
      if (t >= 0 && t < 1.0) {
        const env = Math.min(1, t / 0.04, (1.0 - t) / 0.04);
        const s1 = Math.sin(2 * Math.PI * 440 * t);
        const s2 = Math.sin(2 * Math.PI * 480 * t);
        return 0.5 * (s1 + s2) * 0.16 * env;
      }
      return 0;
    });
  }
  return cachedOutgoingRingWav;
}

function getMessagePingWav(): string {
  if (!cachedMessagePingWav) {
    // 3-note ascending cheerful messenger chime (D5 -> A5 -> D6)
    cachedMessagePingWav = buildWavUri(11025, 0.38, (t) => {
      if (t < 0.06) {
        const env = Math.min(1, t / 0.005, (0.06 - t) / 0.005);
        return Math.sin(2 * Math.PI * 587.33 * t) * 0.25 * env;
      }
      if (t < 0.12) {
        const t2 = t - 0.06;
        const env = Math.min(1, t2 / 0.005, (0.06 - t2) / 0.005);
        return Math.sin(2 * Math.PI * 880 * t) * 0.3 * env;
      }
      const t3 = t - 0.12;
      const env = Math.exp(-t3 * 9);
      return Math.sin(2 * Math.PI * 1174.66 * t) * 0.35 * env;
    });
  }
  return cachedMessagePingWav;
}

function getNotificationChimeWav(): string {
  if (!cachedNotificationChimeWav) {
    // 2-note pleasant chime (C6 -> G6)
    cachedNotificationChimeWav = buildWavUri(11025, 0.32, (t) => {
      if (t < 0.08) {
        const env = Math.min(1, t / 0.005, (0.08 - t) / 0.005);
        return Math.sin(2 * Math.PI * 1046.5 * t) * 0.25 * env;
      }
      const t2 = t - 0.08;
      const env = Math.exp(-t2 * 10);
      return Math.sin(2 * Math.PI * 1567.98 * t) * 0.3 * env;
    });
  }
  return cachedNotificationChimeWav;
}

/**
 * Plays the signature BSC Textiles messaging tone for new chat messages.
 */
export function playMessageSound(): void {
  try {
    const ctx = getAudioContext();
    if (ctx && ctx.state !== 'closed') {
      const now = ctx.currentTime;

      // Note 1: D5 (587.33 Hz)
      const osc1 = ctx.createOscillator();
      const gain1 = ctx.createGain();
      osc1.type = 'sine';
      osc1.frequency.setValueAtTime(587.33, now);
      gain1.gain.setValueAtTime(0.0001, now);
      gain1.gain.exponentialRampToValueAtTime(0.2, now + 0.01);
      gain1.gain.exponentialRampToValueAtTime(0.0001, now + 0.06);
      osc1.connect(gain1);
      gain1.connect(ctx.destination);
      osc1.start(now);
      osc1.stop(now + 0.065);

      // Note 2: A5 (880.00 Hz)
      const osc2 = ctx.createOscillator();
      const gain2 = ctx.createGain();
      osc2.type = 'sine';
      osc2.frequency.setValueAtTime(880, now + 0.065);
      gain2.gain.setValueAtTime(0.0001, now + 0.065);
      gain2.gain.exponentialRampToValueAtTime(0.25, now + 0.075);
      gain2.gain.exponentialRampToValueAtTime(0.0001, now + 0.125);
      osc2.connect(gain2);
      gain2.connect(ctx.destination);
      osc2.start(now + 0.065);
      osc2.stop(now + 0.13);

      // Note 3: D6 (1174.66 Hz) with smooth harmonic tail
      const osc3 = ctx.createOscillator();
      const gain3 = ctx.createGain();
      osc3.type = 'sine';
      osc3.frequency.setValueAtTime(1174.66, now + 0.13);
      gain3.gain.setValueAtTime(0.0001, now + 0.13);
      gain3.gain.exponentialRampToValueAtTime(0.3, now + 0.14);
      gain3.gain.exponentialRampToValueAtTime(0.0001, now + 0.38);
      osc3.connect(gain3);
      gain3.connect(ctx.destination);
      osc3.start(now + 0.13);
      osc3.stop(now + 0.39);
      return;
    }
  } catch {
    /* fallback to audio element */
  }

  try {
    const audio = new Audio(getMessagePingWav());
    audio.volume = 0.5;
    void audio.play().catch(() => undefined);
  } catch {
    /* audio blocked */
  }
}

/**
 * Plays workforce notification chimes (task assignment, daily report submission, approvals, etc.)
 */
export function playNotificationSound(kind: 'chime' | 'urgent' | 'message' | 'call' = 'chime'): void {
  if (kind === 'message') {
    playMessageSound();
    return;
  }

  try {
    const ctx = getAudioContext();
    if (ctx && ctx.state !== 'closed') {
      const now = ctx.currentTime;
      if (kind === 'urgent') {
        // 3-tone ascending alert (E5 -> G#5 -> B5)
        const notes = [659.25, 830.6, 987.77];
        notes.forEach((freq, idx) => {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          const start = now + idx * 0.08;
          osc.type = 'triangle';
          osc.frequency.setValueAtTime(freq, start);
          gain.gain.setValueAtTime(0.0001, start);
          gain.gain.exponentialRampToValueAtTime(0.28, start + 0.015);
          gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.16);
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.start(start);
          osc.stop(start + 0.17);
        });
        return;
      }

      // Pleasant standard 2-tone chime (C6 -> G6)
      const osc1 = ctx.createOscillator();
      const gain1 = ctx.createGain();
      osc1.type = 'sine';
      osc1.frequency.setValueAtTime(1046.5, now);
      gain1.gain.setValueAtTime(0.0001, now);
      gain1.gain.exponentialRampToValueAtTime(0.2, now + 0.01);
      gain1.gain.exponentialRampToValueAtTime(0.0001, now + 0.08);
      osc1.connect(gain1);
      gain1.connect(ctx.destination);
      osc1.start(now);
      osc1.stop(now + 0.085);

      const osc2 = ctx.createOscillator();
      const gain2 = ctx.createGain();
      osc2.type = 'sine';
      osc2.frequency.setValueAtTime(1567.98, now + 0.085);
      gain2.gain.setValueAtTime(0.0001, now + 0.085);
      gain2.gain.exponentialRampToValueAtTime(0.25, now + 0.095);
      gain2.gain.exponentialRampToValueAtTime(0.0001, now + 0.32);
      osc2.connect(gain2);
      gain2.connect(ctx.destination);
      osc2.start(now + 0.085);
      osc2.stop(now + 0.33);
      return;
    }
  } catch {
    /* fallback to audio element */
  }

  try {
    const audio = new Audio(getNotificationChimeWav());
    audio.volume = 0.5;
    void audio.play().catch(() => undefined);
  } catch {
    /* audio blocked */
  }
}

/**
 * High-fidelity phone ringtone engine for incoming & outgoing calls.
 * 
 * Incoming: Dual-tone 440 Hz + 480 Hz in the classic telephone double-ring cadence:
 *           [0.4s tone] - [0.2s pause] - [0.4s tone] - [2.0s pause]
 * 
 * Outgoing: Soft 440 Hz + 480 Hz ringback pulse:
 *           [1.0s tone] - [2.0s pause]
 */
export class PhoneRingtone {
  private timer: number | null = null;
  private audioFallback: HTMLAudioElement | null = null;
  private activeNodes: { osc1: OscillatorNode; osc2: OscillatorNode; gain: GainNode }[] = [];
  private isPlaying = false;

  start(kind: 'incoming' | 'outgoing'): void {
    this.stop();
    this.isPlaying = true;

    const ctx = getAudioContext();
    if (ctx && ctx.state !== 'closed') {
      try {
        const playCycle = () => {
          if (!this.isPlaying || !ctx || ctx.state === 'closed') return;
          const now = ctx.currentTime;

          const playDualTone = (startTime: number, duration: number, volume: number) => {
            const osc1 = ctx.createOscillator();
            const osc2 = ctx.createOscillator();
            const gain = ctx.createGain();

            osc1.type = 'sine';
            osc1.frequency.setValueAtTime(440, startTime);
            osc2.type = 'sine';
            osc2.frequency.setValueAtTime(480, startTime);

            // Envelope ramp
            gain.gain.setValueAtTime(0.0001, startTime);
            gain.gain.exponentialRampToValueAtTime(volume, startTime + 0.02);
            gain.gain.setValueAtTime(volume, startTime + duration - 0.02);
            gain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);

            osc1.connect(gain);
            osc2.connect(gain);
            gain.connect(ctx.destination);

            osc1.start(startTime);
            osc2.start(startTime);
            osc1.stop(startTime + duration + 0.01);
            osc2.stop(startTime + duration + 0.01);

            const record = { osc1, osc2, gain };
            this.activeNodes.push(record);
            window.setTimeout(() => {
              this.activeNodes = this.activeNodes.filter((n) => n !== record);
            }, (duration + 0.05) * 1000);
          };

          if (kind === 'incoming') {
            // Authentic double-ring telephone pattern
            // Burst 1: 0 to 0.4s
            playDualTone(now, 0.4, 0.28);
            // Burst 2: 0.6s to 1.0s
            playDualTone(now + 0.6, 0.4, 0.28);
          } else {
            // Outgoing caller ringback: 1.0s pulse
            playDualTone(now, 1.0, 0.12);
          }
        };

        playCycle();
        // Cycle repeats every 3.0 seconds
        this.timer = window.setInterval(playCycle, 3000);
        return;
      } catch (err) {
        console.warn('[PhoneRingtone] WebAudio failed, switching to audio element fallback', err);
      }
    }

    // Audio element fallback with pre-synthesized WAV loop
    try {
      const src = kind === 'incoming' ? getIncomingRingWav() : getOutgoingRingWav();
      const audio = new Audio(src);
      audio.loop = true;
      audio.volume = kind === 'incoming' ? 0.7 : 0.35;
      void audio.play().catch(() => undefined);
      this.audioFallback = audio;
    } catch (err) {
      console.warn('[PhoneRingtone] Audio fallback playback error:', err);
    }
  }

  stop(): void {
    this.isPlaying = false;
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }

    // Stop and disconnect any active WebAudio nodes immediately
    for (const node of this.activeNodes) {
      try {
        node.gain.gain.setValueAtTime(0.0001, 0);
        node.osc1.stop();
        node.osc2.stop();
        node.gain.disconnect();
      } catch {
        /* ignore */
      }
    }
    this.activeNodes = [];

    // Stop audio element fallback
    if (this.audioFallback) {
      try {
        this.audioFallback.pause();
        this.audioFallback.currentTime = 0;
        this.audioFallback.removeAttribute('src');
      } catch {
        /* ignore */
      }
      this.audioFallback = null;
    }
  }
}
