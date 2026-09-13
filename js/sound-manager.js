/**
 * Sound Manager - Web Audio API
 * Separate volume controls for gameplay effects and announcer voices.
 */

class SoundManager {
    constructor() {
        this.ctx = null;
        this.buffers = {};
        this.audioPools = {};
        this.loaded = false;
        this.effectVolume = 0.5;
        this.announcerVolume = 0.7;
        this.ready = this.init();
    }

    async init() {
        try {
            const AudioCtx = window.AudioContext || window.webkitAudioContext;
            if (!AudioCtx) return;
            this.ctx = new AudioCtx();

            const unlock = () => {
                if (this.ctx && this.ctx.state === 'suspended') {
                    this.ctx.resume().catch(() => {});
                }
            };
            window.addEventListener('keydown', unlock);
            window.addEventListener('click', unlock);
            window.addEventListener('touchstart', unlock);

            await Promise.all([
                this._loadSound('clap', 'sounds/normal-hitclap.wav'),
                this._loadSound('normal', 'sounds/normal-hitnormal.wav'),
                this._loadSound('horn', 'sounds/horn.mp3'),
                this._loadSound('title', 'sounds/Title Screen.wav'),
                this._loadSound('combo50', 'sounds/50 Combo!.wav'),
                this._loadSound('combo100', 'sounds/100 Combo!.wav'),
                this._loadSound('combo200', 'sounds/200 Combo!.wav'),
                this._loadSound('combo300', 'sounds/300 Combo!.wav'),
                this._loadSound('combo400', 'sounds/400 Combo!.wav'),
                this._loadSound('combo500', 'sounds/500 Combo!.wav'),
                this._loadSound('combo600', 'sounds/600 Combo!.wav'),
                this._loadSound('combo700', 'sounds/700 Combo!.wav'),
                this._loadSound('combo800', 'sounds/800 Combo!.wav'),
                this._loadSound('combo900', 'sounds/900 Combo!.wav'),
                this._loadSound('combo1000', 'sounds/1000 Combo!.wav')
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
            try {
                this.audioPools[name] = [new Audio(url), new Audio(url), new Audio(url), new Audio(url)];
            } catch (_) {}
        }
    }

    setEffectVolume(value) {
        this.effectVolume = Math.max(0, Math.min(1, Number(value) || 0));
    }

    setAnnouncerVolume(value) {
        this.announcerVolume = Math.max(0, Math.min(1, Number(value) || 0));
    }

    play(name, volume = this.effectVolume) {
        const finalVolume = Math.max(0, Math.min(1, Number(volume) || 0));

        if (this.ctx && this.buffers[name]) {
            if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
            try {
                const source = this.ctx.createBufferSource();
                source.buffer = this.buffers[name];
                const gainNode = this.ctx.createGain();
                gainNode.gain.value = finalVolume;
                source.connect(gainNode);
                gainNode.connect(this.ctx.destination);
                source.start(0);
                return;
            } catch (e) {
                console.error('Error playing sound buffer:', e);
            }
        }

        if (this.audioPools && this.audioPools[name]) {
            const pool = this.audioPools[name];
            const audio = pool.find(a => a.paused || a.ended) || pool[0];
            if (audio) {
                try {
                    audio.currentTime = 0;
                    audio.volume = finalVolume;
                    audio.play().catch(() => {});
                } catch (_) {}
            }
        }
    }

    playDon() {
        this.play('normal', this.effectVolume);
    }

    playKa() {
        this.play('clap', this.effectVolume);
    }

    playHorn(variant = 0, volume = 0.08) {
        if (!this.ctx) return;
        if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});

        const finalVolume = Math.max(0, Math.min(1, volume * this.effectVolume));

        if (this.buffers['horn']) {
            try {
                const source = this.ctx.createBufferSource();
                source.buffer = this.buffers['horn'];
                const pitchRates = [0.94, 1.0, 1.06, 1.14];
                source.playbackRate.value = pitchRates[variant % pitchRates.length] || 1.0;
                const gainNode = this.ctx.createGain();
                gainNode.gain.value = finalVolume;
                source.connect(gainNode);
                gainNode.connect(this.ctx.destination);
                source.start(0);
                return;
            } catch (e) {
                console.error('Error playing horn sample:', e);
            }
        }

        try {
            const ctx = this.ctx;
            const now = ctx.currentTime;
            const pitches = [233.08, 349.23, 466.16, 587.33];
            const baseFreq = pitches[variant % pitches.length] || 349.23;
            const osc1 = ctx.createOscillator();
            const osc2 = ctx.createOscillator();
            const osc3 = ctx.createOscillator();
            osc1.type = 'sawtooth'; osc2.type = 'sawtooth'; osc3.type = 'triangle';
            osc1.frequency.setValueAtTime(baseFreq * 0.92, now);
            osc1.frequency.exponentialRampToValueAtTime(baseFreq, now + 0.04);
            osc2.frequency.setValueAtTime(baseFreq * 1.008 * 0.92, now);
            osc2.frequency.exponentialRampToValueAtTime(baseFreq * 1.008, now + 0.04);
            osc3.frequency.setValueAtTime(baseFreq * 0.5, now);
            const vibrato = ctx.createOscillator();
            const vibratoGain = ctx.createGain();
            vibrato.frequency.value = 6.0;
            vibratoGain.gain.value = baseFreq * 0.025;
            vibrato.connect(vibratoGain);
            vibratoGain.connect(osc1.frequency);
            vibratoGain.connect(osc2.frequency);
            const filter = ctx.createBiquadFilter();
            filter.type = 'lowpass'; filter.Q.value = 4.5;
            filter.frequency.setValueAtTime(250, now);
            filter.frequency.exponentialRampToValueAtTime(Math.min(5000, baseFreq * 6), now + 0.05);
            filter.frequency.exponentialRampToValueAtTime(baseFreq * 3.0, now + 0.25);
            const gain = ctx.createGain();
            gain.gain.setValueAtTime(0.001, now);
            gain.gain.linearRampToValueAtTime(finalVolume * 0.8, now + 0.03);
            gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, finalVolume * 0.6), now + 0.20);
            gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.50);
            osc1.connect(filter); osc2.connect(filter); osc3.connect(filter);
            filter.connect(gain); gain.connect(ctx.destination);
            osc1.start(now); osc2.start(now); osc3.start(now); vibrato.start(now + 0.08);
            osc1.stop(now + 0.52); osc2.stop(now + 0.52); osc3.stop(now + 0.52); vibrato.stop(now + 0.52);
        } catch (e) {
            console.error('Error playing fallback horn sound:', e);
        }
    }

    playTitleScreen() {
        this.play('title', 0.9);
    }

    playCombo(combo) {
        const supported = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];
        if (!supported.includes(combo)) return;
        this.play(`combo${combo}`, this.announcerVolume);
    }
}

window.soundManager = new SoundManager();
