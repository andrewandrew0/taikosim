/**
 * Sound Manager - Web Audio API for Zero-Latency Hitsounds
 * Plays normal-hitclap for Ka (D, K) and normal-hitnormal for Don (F, J)
 */

class SoundManager {
    constructor() {
        this.ctx = null;
        this.buffers = {};
        this.audioPools = {};
        this.loaded = false;
        this.init();
    }

    async init() {
        try {
            const AudioCtx = window.AudioContext || window.webkitAudioContext;
            if (!AudioCtx) return;
            this.ctx = new AudioCtx();

            const unlock = () => {
                if (this.ctx && this.ctx.state === 'suspended') {
                    this.ctx.resume();
                }
                window.removeEventListener('keydown', unlock);
                window.removeEventListener('click', unlock);
                window.removeEventListener('touchstart', unlock);
            };
            window.addEventListener('keydown', unlock);
            window.addEventListener('click', unlock);
            window.addEventListener('touchstart', unlock);

            // Fetch and decode hitsound files + real horn sound
            await Promise.all([
                this._loadSound('clap', 'sounds/normal-hitclap.wav'),
                this._loadSound('normal', 'sounds/normal-hitnormal.wav'),
                this._loadSound('horn', 'sounds/horn.mp3')
            ]);
            this.loaded = true;
        } catch (e) {
            console.warn('SoundManager initialization error:', e);
        }
    }

    async _loadSound(name, url) {
        try {
            const resp = await fetch(url);
            if (!resp.ok) throw new Error('HTTP ' + resp.status);
            const arrayBuf = await resp.arrayBuffer();
            const audioBuf = await this.ctx.decodeAudioData(arrayBuf);
            this.buffers[name] = audioBuf;
        } catch (e) {
            // HTMLAudioElement fallback pool for file:/// protocol & offline usage
            try {
                this.audioPools[name] = [new Audio(url), new Audio(url), new Audio(url), new Audio(url)];
            } catch (_) {}
        }
    }

    play(name, volume = 0.9) {
        if (this.ctx && this.buffers[name]) {
            if (this.ctx.state === 'suspended') {
                this.ctx.resume();
            }
            try {
                const source = this.ctx.createBufferSource();
                source.buffer = this.buffers[name];
                const gainNode = this.ctx.createGain();
                gainNode.gain.value = volume;
                source.connect(gainNode);
                gainNode.connect(this.ctx.destination);
                source.start(0);
                return;
            } catch (e) {
                console.error('Error playing hitsound buffer:', e);
            }
        }

        // HTMLAudio fallback for file:/// protocol
        if (this.audioPools && this.audioPools[name]) {
            const pool = this.audioPools[name];
            const audio = pool.find(a => a.paused || a.ended) || pool[0];
            if (audio) {
                try {
                    audio.currentTime = 0;
                    audio.volume = Math.max(0, Math.min(1, volume));
                    audio.play().catch(() => {});
                } catch (_) {}
            }
        }
    }

    playDon(volume = 0.3) {
        this.play('normal', volume);
    }

    playKa(volume = 0.3) {
        this.play('clap', volume);
    }

    playHorn(variant = 0, volume = 0.08) {
        if (!this.ctx) return;
        if (this.ctx.state === 'suspended') {
            this.ctx.resume();
        }

        // If real horn audio sample is loaded, play authentic horn with pitch variation
        if (this.buffers['horn']) {
            try {
                const source = this.ctx.createBufferSource();
                source.buffer = this.buffers['horn'];
                // Subtle pitch variance per runner (0.95 to 1.1)
                const pitchRates = [0.94, 1.0, 1.06, 1.14];
                source.playbackRate.value = pitchRates[variant % pitchRates.length] || 1.0;

                const gainNode = this.ctx.createGain();
                gainNode.gain.value = volume; // pleasant, a bit quieter
                source.connect(gainNode);
                gainNode.connect(this.ctx.destination);
                source.start(0);
                return;
            } catch (e) {
                console.error('Error playing horn sample:', e);
            }
        }

        // Fallback brass horn synthesis (a bit quieter)
        try {
            const ctx = this.ctx;
            const now = ctx.currentTime;

            const pitches = [233.08, 349.23, 466.16, 587.33];
            const baseFreq = pitches[variant % pitches.length] || 349.23;

            const osc1 = ctx.createOscillator();
            const osc2 = ctx.createOscillator();
            const osc3 = ctx.createOscillator();

            osc1.type = 'sawtooth';
            osc2.type = 'sawtooth';
            osc3.type = 'triangle';

            osc1.frequency.setValueAtTime(baseFreq * 0.92, now);
            osc1.frequency.exponentialRampToValueAtTime(baseFreq, now + 0.04);
            osc2.frequency.setValueAtTime(baseFreq * 1.008 * 0.92, now);
            osc2.frequency.exponentialRampToValueAtTime(baseFreq * 1.008, now + 0.04);
            osc3.frequency.setValueAtTime(baseFreq * 0.5, now);

            const vibrato = ctx.createOscillator();
            const vibratoGain = ctx.createGain();
            vibrato.frequency.value = 6.0;
            vibratoGain.gain.value = baseFreq * 0.025;
            vibrato.connect(osc1.frequency);
            vibrato.connect(osc2.frequency);
            vibrato.start(now + 0.08);

            const filter = ctx.createBiquadFilter();
            filter.type = 'lowpass';
            filter.Q.value = 4.5;
            filter.frequency.setValueAtTime(250, now);
            filter.frequency.exponentialRampToValueAtTime(Math.min(5000, baseFreq * 6), now + 0.05);
            filter.frequency.exponentialRampToValueAtTime(baseFreq * 3.0, now + 0.25);

            const gain = ctx.createGain();
            gain.gain.setValueAtTime(0.001, now);
            gain.gain.linearRampToValueAtTime(volume * 0.8, now + 0.03);
            gain.gain.exponentialRampToValueAtTime(volume * 0.6, now + 0.20);
            gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.50);

            osc1.connect(filter);
            osc2.connect(filter);
            osc3.connect(filter);
            filter.connect(gain);
            gain.connect(ctx.destination);

            osc1.start(now);
            osc2.start(now);
            osc3.start(now);

            osc1.stop(now + 0.52);
            osc2.stop(now + 0.52);
            osc3.stop(now + 0.52);
            vibrato.stop(now + 0.52);
        } catch (e) {
            console.error('Error playing fallback horn sound:', e);
        }
    }
}

// Global singleton instance
window.soundManager = new SoundManager();
