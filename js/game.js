/**
 * TJA Game Engine - Authentic Taiko no Tatsujin Style
 *
 * Updated Features:
 * - Playfield shifted to the right and made significantly larger & taller
 * - 4-zone Taiko Drum UI: Left rim (D), Left face (F), Right face (J), Right rim (K)
 * - Combo-scaled score with floating RED score increment popups (+300, +400, +800, etc.)
 * - Balanced anti-mash logic: tight 12ms clash detection so fast streams/bursts won't accidentally miss
 * - Streamlined note priority for fast alternating drumrolls (D/F/J/K)
 * - Tamashii (Soul) Gauge scorebar with segmented LEDs, Clear threshold, and burning Soul orb
 * - Authentic Japanese judgments: 良 (GOOD), 可 (OK), 不可 (BAD/MISS)
 */

class Game {
    /**
     * @param {HTMLCanvasElement} canvas
     * @param {Object} options
     */
    constructor(canvas, options) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.notes = options.notes.map(n => ({
            ...n,
            hit: false,
            result: null,
            popped: false,
            rollCount: 0,
            hitsRequired: n.hitsRequired || 5,
            hitsLeft: (n.hitsLeft !== undefined && n.hitsLeft !== null && !isNaN(n.hitsLeft)) ? n.hitsLeft : (n.hitsRequired || 5)
        }));
        this.audioUrl = options.audioUrl;
        this.offset = options.offset;
        this.title = options.title || '';
        this.courseName = options.courseName || 'Oni';
        this.level = options.level || 0;
        this.onEnd = options.onEnd || (() => {});
        this.onBack = options.onBack || (() => {});

        this.options = options;

        // Total hittable notes
        this.totalHittableNotes = this.notes.filter(n =>
            n.type === 'don' || n.type === 'ka' || n.type === 'bigDon' || n.type === 'bigKa'
        ).length || 1;

        // Authentic timing windows
        const isEasyOrNormal = (this.courseName.toLowerCase() === 'easy' || this.courseName.toLowerCase() === 'normal');
        this.GOOD_WINDOW = isEasyOrNormal ? 0.0417 : 0.0250;
        this.OK_WINDOW   = isEasyOrNormal ? 0.1084 : 0.0751;
        this.BAD_WINDOW  = isEasyOrNormal ? 0.1251 : 0.1084;

        // Soul Gauge (Tamashii Gauge) - Reaches full capacity (100%) around 75% through the song
        this.gauge = 0;
        this.smoothGauge = 0;
        this.clearThreshold = isEasyOrNormal ? 50 : 60;
        this.gaugeGain = 100 / (Math.max(1, this.totalHittableNotes) * 0.75);
        this.gaugeLoss = 0.8;

        // Scoring & Stats
        this.baseSpeed = 780; // Fast scroll speed scaling with BPM
        this.score = 0;
        this.combo = 0;
        this.maxCombo = 0;
        this.goodCount = 0;
        this.okCount = 0;
        this.missCount = 0;
        this.totalDrumrollHits = 0;
        this.lastMissTime = 0;

        // Layout variables (computed in _updateLayout)
        this.plateWidth = 0;
        this.laneY = 0;
        this.laneHeight = 0;
        this.hitX = 0;
        this.noteRadius = 0;
        this.bigNoteRadius = 0;
        this._updateLayout();

        // Visual effects
        this.judgment = null; // { kanji, eng, color, time, isBig }
        this.hitRingAnim = 0;
        this.hitEffects = []; // Multi-phase expanding shockwaves
        this.gogoActive = false;
        this.gogoPhase = 0;
        this.sparkles = [];
        this.scorePopups = []; // Floating red score popups: { text, x, y, vy, alpha, birth }
        this.stageSparklers = []; // Flying sparklers thrown across stage on GOOD
        this.audienceBursts = []; // Dramatic bursty confetti/stars on GOOD
        this.stageStarbursts = []; // Explosive colorful starburst fireworks on GOOD
        this.lastGoodHitTime = 0;
        this.lastHitTime = 0;
        this.audienceYOffset = 0; // Continuous vertical boost offset in pixels
        this.audienceVy = 0; // Continuous vertical boost velocity
        this.lastUpdatePerf = 0;
        this.lastDragonTime = 0;
        this.activeDragon = null; // Cool festival dragon flying through crowd
        this.hornPlayers = []; // Large fat horn players popping into the crowd
        this.lastHornPlayerTime = 0;
        this.flyingGaugeNotes = []; // Hit notes flying towards the soul gauge
        this.gaugeRipples = []; // Splash sparkles when flying notes hit the gauge
        this.donSpeech = null; // Don-chan combo speech banner: { text, birth, duration }

        // Lane flashing effects on keypress: D/K (blue), F/J (red)
        this.laneFlashBlue = 0;
        this.laneFlashRed = 0;

        // 4-zone drum input tracking: D, F, J, K
        this.leftKaHit = 0;   // D
        this.leftDonHit = 0;  // F
        this.rightDonHit = 0; // J
        this.rightKaHit = 0;  // K

        // Audio clock tracking (Interpolated 144Hz silky-smooth scroll)
        this.songBpm = options.bpm || 150;
        this.audio = null;
        this.running = false;
        this.finished = false;
        this.resultsActive = false;
        this.resultsStartTime = 0;
        this.animFrameId = null;
        this.lastAudioTime = 0;
        this.lastAudioUpdatePerf = 0;

        // Input handling
        this._keydownHandler = this._onKeyDown.bind(this);
        this._keyupHandler = this._onKeyUp.bind(this);
        this._clickHandler = this._onClick.bind(this);
        this.recentInputs = []; // For tight simultaneous press check
        this.retryBtnRect = null;
        this.backBtnRect = null;

        // Pause state
        this.isPaused = false;
        this.pausedChartTime = 0;
        this.pauseStartTime = 0;
        this.pauseButtons = {};
    }

    _updateLayout() {
        const w = this.canvas.width;
        const h = this.canvas.height;

        // Scaled down by 40% (60% of previous oversized playfield)
        this.plateWidth = Math.max(340, Math.min(480, w * 0.28));

        // Note sizes: small notes (diameter 92px), big notes (diameter 130px)
        this.noteRadius = 46;
        this.bigNoteRadius = 65;

        // Playing lane height: twice as large as big ka/don (130px * 2 = 260px)
        this.laneHeight = (this.bigNoteRadius * 2) * 2;

        this.laneY = Math.max(170, h * 0.36);
        this.hitX = this.plateWidth + this.bigNoteRadius + 32;

        // Interactive 4-zone drum dimensions
        this.drumR = Math.min(74, this.laneHeight * 0.28);
        this.drumX = this.plateWidth - this.drumR - 30;
        this.drumY = this.laneY;
    }

    _getNoteSpeed(note) {
        const bpm = note.bpm || this.songBpm || 150;
        const scroll = (note.scroll !== undefined && note.scroll !== null) ? note.scroll : 1.0;
        // Scroll speed scales linearly with BPM (150 reference) and #SCROLL
        return this.baseSpeed * (bpm / 150) * scroll;
    }

    async start() {
        this._updateLayout();
        this.audio = new Audio(this.audioUrl);
        this.audio.volume = 0.7;

        await new Promise((resolve, reject) => {
            this.audio.addEventListener('canplaythrough', resolve, { once: true });
            this.audio.addEventListener('error', reject, { once: true });
            this.audio.load();
        });

        // 2-second pre-roll pause so player can react as notes scroll in
        this.preRollDuration = 2.0;
        this.preRollStartTime = performance.now();
        this.audioStarted = false;

        document.addEventListener('keydown', this._keydownHandler);
        document.addEventListener('keyup', this._keyupHandler);
        this.canvas.addEventListener('click', this._clickHandler);

        this.running = true;

        this.audio.addEventListener('ended', () => {
            this._endGame();
        });

        this._gameLoop();
    }

    stop() {
        this.running = false;
        if (this.animFrameId) {
            cancelAnimationFrame(this.animFrameId);
            this.animFrameId = null;
        }
        if (this.audio) {
            this.audio.pause();
            this.audio.src = '';
            this.audio = null;
        }
        document.removeEventListener('keydown', this._keydownHandler);
        document.removeEventListener('keyup', this._keyupHandler);
        this.canvas.removeEventListener('click', this._clickHandler);
    }

    _onClick(e) {
        const rect = this.canvas.getBoundingClientRect();
        const scaleX = this.canvas.width / rect.width;
        const scaleY = this.canvas.height / rect.height;
        const clickX = (e.clientX - rect.left) * scaleX;
        const clickY = (e.clientY - rect.top) * scaleY;

        if (this.isPaused) {
            const hitResume = (this.pauseButtons.resumeBtn &&
                clickX >= this.pauseButtons.resumeBtn.x && clickX <= this.pauseButtons.resumeBtn.x + this.pauseButtons.resumeBtn.w &&
                clickY >= this.pauseButtons.resumeBtn.y && clickY <= this.pauseButtons.resumeBtn.y + this.pauseButtons.resumeBtn.h) ||
                (this.pauseButtons.continueBtn &&
                clickX >= this.pauseButtons.continueBtn.x && clickX <= this.pauseButtons.continueBtn.x + this.pauseButtons.continueBtn.w &&
                clickY >= this.pauseButtons.continueBtn.y && clickY <= this.pauseButtons.continueBtn.y + this.pauseButtons.continueBtn.h);

            const hitRetry = (this.pauseButtons.retryBtn &&
                clickX >= this.pauseButtons.retryBtn.x && clickX <= this.pauseButtons.retryBtn.x + this.pauseButtons.retryBtn.w &&
                clickY >= this.pauseButtons.retryBtn.y && clickY <= this.pauseButtons.retryBtn.y + this.pauseButtons.retryBtn.h);

            const hitExit = (this.pauseButtons.exitBtn &&
                clickX >= this.pauseButtons.exitBtn.x && clickX <= this.pauseButtons.exitBtn.x + this.pauseButtons.exitBtn.w &&
                clickY >= this.pauseButtons.exitBtn.y && clickY <= this.pauseButtons.exitBtn.y + this.pauseButtons.exitBtn.h) ||
                (this.pauseButtons.quitBtn &&
                clickX >= this.pauseButtons.quitBtn.x && clickX <= this.pauseButtons.quitBtn.x + this.pauseButtons.quitBtn.w &&
                clickY >= this.pauseButtons.quitBtn.y && clickY <= this.pauseButtons.quitBtn.y + this.pauseButtons.quitBtn.h);

            if (hitResume) {
                this.resume();
                return;
            }
            if (hitRetry) {
                this.resume();
                this.restart();
                return;
            }
            if (hitExit) {
                this.stop();
                this.onBack();
                return;
            }
            return;
        }

        if (this.resultsActive) {
            if (this.retryBtnRect &&
                clickX >= this.retryBtnRect.x && clickX <= this.retryBtnRect.x + this.retryBtnRect.w &&
                clickY >= this.retryBtnRect.y && clickY <= this.retryBtnRect.y + this.retryBtnRect.h) {
                this.restart();
                return;
            }

            if (this.backBtnRect &&
                clickX >= this.backBtnRect.x && clickX <= this.backBtnRect.x + this.backBtnRect.w &&
                clickY >= this.backBtnRect.y && clickY <= this.backBtnRect.y + this.backBtnRect.h) {
                this.stop();
                this.onBack();
                return;
            }
        }
    }

    pause() {
        if (this.isPaused || this.finished || !this.running) return;
        this.isPaused = true;
        this.pausedChartTime = this._chartTime();
        this.pauseStartTime = performance.now();
        if (this.audio && !this.audio.paused) {
            this.audio.pause();
        }
    }

    resume() {
        if (!this.isPaused || this.finished || !this.running) return;
        const now = performance.now();
        const pauseDt = now - this.pauseStartTime;
        this.preRollStartTime += pauseDt;
        this.lastAudioUpdatePerf = now;
        this.isPaused = false;
        if (this.audio && this.audioStarted && !this.audio.ended) {
            this.audio.play().catch(() => {});
        }
    }

    _chartTime() {
        if (!this.running) return 0;
        if (this.isPaused) return this.pausedChartTime || 0;
        const now = performance.now();
        const preRollElapsed = (now - this.preRollStartTime) / 1000;

        if (preRollElapsed < this.preRollDuration) {
            // Negative time during pre-roll so notes scroll into view smoothly
            return (preRollElapsed - this.preRollDuration) + this.offset;
        }

        // Start audio once pre-roll finishes
        if (!this.audioStarted && this.audio) {
            this.audioStarted = true;
            this.audio.play();
            this.lastAudioTime = 0;
            this.lastAudioUpdatePerf = now;
        }

        if (!this.audio) return 0;

        // Sub-millisecond smooth interpolation (eliminates 30Hz stepped audio choppiness!)
        const audioTime = this.audio.currentTime;
        if (audioTime !== this.lastAudioTime) {
            this.lastAudioTime = audioTime;
            this.lastAudioUpdatePerf = now;
        }

        const dt = Math.max(0, (now - this.lastAudioUpdatePerf) / 1000);
        const smoothTime = this.lastAudioTime + dt;
        const clampedTime = Math.abs(smoothTime - audioTime) > 0.12 ? audioTime : smoothTime;

        return clampedTime + this.offset;
    }

    // ═══════════════════════════════════════════
    //  INPUT HANDLING (4 DRUM ZONES & REFINED HIT LOGIC)
    // ═══════════════════════════════════════════

    _onKeyDown(e) {
        if (e.repeat) return;
        const key = e.key.toLowerCase();

        // When on Results Screen:
        if (this.resultsActive) {
            if (key === 'f' || key === 'j' || key === 'enter') {
                e.preventDefault();
                this.restart();
                return;
            }
            if (key === 'escape') {
                e.preventDefault();
                this.stop();
                this.onBack();
                return;
            }
        }

        // When Paused:
        if (this.isPaused) {
            if (key === 'escape' || key === 'p' || key === 'enter' || key === 'f' || key === 'j' || key === ' ') {
                e.preventDefault();
                this.resume();
                return;
            }
            if (key === 'r') {
                e.preventDefault();
                this.resume();
                this.restart();
                return;
            }
            if (key === 'q' || key === 'backspace') {
                e.preventDefault();
                this.stop();
                this.onBack();
                return;
            }
            return;
        }

        // Pressing ESC during gameplay pauses the game!
        if (key === 'escape' || key === 'p') {
            e.preventDefault();
            this.pause();
            return;
        }

        const now = performance.now();
        let inputType = null;

        // 4 distinct zones for DF and JK
        if (key === 'd') {
            inputType = 'ka';
            this.leftKaHit = now;
            this.laneFlashBlue = 1.0;
            if (window.soundManager) window.soundManager.playKa();
        } else if (key === 'f') {
            inputType = 'don';
            this.leftDonHit = now;
            this.laneFlashRed = 1.0;
            if (window.soundManager) window.soundManager.playDon();
        } else if (key === 'j') {
            inputType = 'don';
            this.rightDonHit = now;
            this.laneFlashRed = 1.0;
            if (window.soundManager) window.soundManager.playDon();
        } else if (key === 'k') {
            inputType = 'ka';
            this.rightKaHit = now;
            this.laneFlashBlue = 1.0;
            if (window.soundManager) window.soundManager.playKa();
        }

        if (!inputType) return;

        // Tight clash detection: only trigger if Don and Ka are hit within < 12ms (same frame stroke)
        this.recentInputs.push({ type: inputType, key, time: now });
        this.recentInputs = this.recentInputs.filter(inp => now - inp.time < 12);

        const hasDon = this.recentInputs.some(inp => inp.type === 'don');
        const hasKa  = this.recentInputs.some(inp => inp.type === 'ka');

        if (hasDon && hasKa) {
            // Player mashed both Don and Ka on the exact same frame
            this._triggerClashMiss();
            return;
        }

        this._processHit(inputType);
    }

    _onKeyUp(e) {}

    _triggerClashMiss() {
        const chartTime = this._chartTime();

        // Skip clash detection if an active drumroll or balloon is ongoing (mashing is expected!)
        const activeRoll = this.notes.find(n =>
            (n.type === 'drumroll' || n.type === 'bigDrumroll') &&
            chartTime >= n.time - 0.05 && chartTime <= n.endTime
        );
        if (activeRoll) return;

        const activeBalloon = this.notes.find(n =>
            n.type === 'balloon' &&
            !n.hit && !n.popped &&
            chartTime >= n.time - 0.05 && chartTime <= (n.endTime || n.time + 2.5)
        );
        if (activeBalloon) return;

        let targetIndex = -1;
        let minDiff = Infinity;

        for (let i = 0; i < this.notes.length; i++) {
            const note = this.notes[i];
            if (note.hit) continue;
            if (note.type === 'drumroll' || note.type === 'bigDrumroll' ||
                note.type === 'balloon' || note.type === 'endHold') continue;

            const diff = Math.abs(note.time - chartTime);
            if (diff <= this.BAD_WINDOW && diff < minDiff) {
                minDiff = diff;
                targetIndex = i;
            }
        }

        if (targetIndex >= 0) {
            const note = this.notes[targetIndex];
            note.hit = true;
            note.result = 'miss';
            this.combo = 0;
            this.missCount++;
            this.gauge = Math.max(0, this.gauge - this.gaugeLoss);
            this.judgment = {
                kanji: '不可',
                eng: 'MISS (MASH)',
                color: '#7070a0',
                time: performance.now(),
                isBig: false
            };
            this.hitRingAnim = 0.8;
        }
    }

    /**
     * Balanced hit processing:
     * - Balloons: F and J spam until counter reaches 0
     * - Drumrolls: Spam any button (D, F, J, K), counter goes up with score
     * - Normal notes: Prioritized matching hit logic
     */
    _processHit(inputType) {
        const chartTime = this._chartTime();

        // 1. Check for active Balloon (F and J spam until counter reaches 0)
        const activeBalloon = this.notes.find(n =>
            n.type === 'balloon' &&
            !n.hit &&
            !n.popped &&
            chartTime >= (n.time - 0.15) &&
            chartTime <= (n.endTime || (n.time + 2.5))
        );

        if (activeBalloon) {
            if (inputType === 'don') {
                // F or J hit on balloon
                const curHits = (activeBalloon.hitsLeft !== undefined && !isNaN(activeBalloon.hitsLeft))
                    ? activeBalloon.hitsLeft
                    : (activeBalloon.hitsRequired || 5);
                activeBalloon.hitsLeft = Math.max(0, curHits - 1);
                activeBalloon.lastHitTime = performance.now();

                let pts = 300;
                if (activeBalloon.isGogo) pts = Math.floor(pts * 1.2);

                if (activeBalloon.hitsLeft <= 0) {
                    // Balloon POPPED!
                    activeBalloon.popped = true;
                    activeBalloon.hit = true;
                    pts += 5000; // Big pop bonus!
                    this.gauge = Math.min(100, this.gauge + 0.5);
                    this.judgment = {
                        kanji: '割れた!',
                        eng: 'POP!',
                        color: '#ffd700',
                        time: performance.now(),
                        isBig: true
                    };
                    this._spawnSparkles(this.hitX, this.laneY, 25, '#ff4444');
                    this._spawnSparkles(this.hitX, this.laneY, 25, '#ffd700');
                } else {
                    this._spawnSparkles(this.hitX, this.laneY, 6, '#ff8844');
                }

                this.score += pts;
                this.hitRingAnim = 1.0;
                this._spawnScorePopup(pts);
            }
            return;
        }

        // 2. Check for active Drumroll (spam any button: D, F, J, K - gives score only, 0 gauge)
        const activeRoll = this.notes.find(n =>
            (n.type === 'drumroll' || n.type === 'bigDrumroll') &&
            chartTime >= (n.time - 0.15) &&
            chartTime <= (n.endTime || (n.time + 1.8))
        );

        if (activeRoll) {
            activeRoll.rollCount = (activeRoll.rollCount || 0) + 1;
            this.totalDrumrollHits = (this.totalDrumrollHits || 0) + 1;
            activeRoll.lastHitTime = performance.now();

            let pts = (activeRoll.type === 'bigDrumroll') ? 200 : 100;
            if (activeRoll.isGogo) pts = Math.floor(pts * 1.2);

            this.score += pts;
            this.hitRingAnim = 1.0;
            this._spawnSparkles(this.hitX, this.laneY, 6, '#ffd700');
            this._spawnScorePopup(pts);
            return;
        }

        // 3. Normal note hit detection
        let bestMatchIndex = -1;
        let bestMatchDiff = Infinity;

        let closestAnyIndex = -1;
        let closestAnyDiff = Infinity;

        for (let i = 0; i < this.notes.length; i++) {
            const note = this.notes[i];
            if (note.hit) continue;
            if (note.type === 'drumroll' || note.type === 'bigDrumroll' ||
                note.type === 'balloon' || note.type === 'endHold') continue;

            const diff = Math.abs(note.time - chartTime);
            if (diff > this.BAD_WINDOW) continue;

            const isDon = (note.type === 'don' || note.type === 'bigDon');
            const isKa  = (note.type === 'ka'  || note.type === 'bigKa');
            const matches = (inputType === 'don' && isDon) || (inputType === 'ka' && isKa);

            if (matches && diff < bestMatchDiff) {
                bestMatchDiff = diff;
                bestMatchIndex = i;
            }

            if (diff < closestAnyDiff) {
                closestAnyDiff = diff;
                closestAnyIndex = i;
            }
        }

        // If there's a valid matching note within the window, hit it!
        // This ensures fast bursts (e.g. D-F-J-K) won't accidentally trigger a miss
        // if an adjacent note is nearby.
        if (bestMatchIndex >= 0) {
            const note = this.notes[bestMatchIndex];
            this._scoreNoteHit(note, bestMatchDiff);
            return;
        }

        // If there is NO matching note, but a wrong note is directly on the hit line (within OK_WINDOW):
        if (closestAnyIndex >= 0 && closestAnyDiff <= this.OK_WINDOW) {
            const note = this.notes[closestAnyIndex];
            note.hit = true;
            note.result = 'miss';
            this.missCount++;
            this.combo = 0;
            this.gauge = Math.max(0, this.gauge - this.gaugeLoss);
            this.judgment = {
                kanji: '不可',
                eng: 'MISS',
                color: '#7070a0',
                time: performance.now(),
                isBig: (note.type === 'bigDon' || note.type === 'bigKa')
            };
            this.hitRingAnim = 0.7;
        }
    }

    /**
     * Score a successful note hit with combo scaling & floating red score popup
     */
    _scoreNoteHit(note, diff) {
        note.hit = true;
        const isBig = (note.type === 'bigDon' || note.type === 'bigKa');

        let points = 0;
        let kanji = '';
        let eng = '';
        let color = '';

        // Combo scaling formula (Official Taiko curve):
        // 1-9: +300, 10-29: +400, 30-49: +500, 50-99: +600, 100+: +800
        let comboBonus = 0;
        if (this.combo >= 100) comboBonus = 500;
        else if (this.combo >= 50) comboBonus = 300;
        else if (this.combo >= 30) comboBonus = 200;
        else if (this.combo >= 10) comboBonus = 100;

        if (diff <= this.GOOD_WINDOW) {
            kanji = '良';
            eng = 'GOOD';
            color = '#ffcc00';
            points = 300 + comboBonus;
            if (isBig) points *= 2;
            if (note.isGogo) points = Math.floor(points * 1.2);

            this.goodCount++;
            this.combo++;
            this.gauge = Math.min(100, this.gauge + this.gaugeGain * (isBig ? 1.2 : 1.0));
            this._spawnGoodHitEffect(this.hitX, this.laneY, isBig);
            const now = performance.now();
            this.lastGoodHitTime = now;
            this.lastHitTime = now;

            // Vertical boost on every jump - strictly capped so crowd never jumps too high
            this.audienceVy = Math.min(11, Math.max(5, this.audienceVy + 5));
            this.audienceYOffset = Math.min(32, this.audienceYOffset + 6);

            this._spawnStageSparkler(now);
            this._spawnAudienceCheerBurst(now);
            this._spawnStageStarburst(now);

            this._spawnFlyingGaugeNote(this.hitX, this.laneY, note.type, isBig, now);

            // Don-chan says 50コンボ, 100コンボ, 200コンボ, etc.!
            if (this.combo === 50 || (this.combo >= 100 && this.combo % 100 === 0)) {
                this._triggerDonSpeech(this.combo, now);
            }

            // Flying dragon through the crowd on combo increases!
            if (this.combo > 0 && (this.combo % 15 === 0 || (this.combo >= 10 && now - this.lastDragonTime > 7500))) {
                this._spawnFestivalDragon(now);
            }

            // Large fat horn players popping into the crowd and making loud horn noises!
            if (this.combo > 0 && (this.combo % 30 === 0 || (this.combo >= 6 && now - this.lastHornPlayerTime > 10000))) {
                this._spawnHornPlayer(now);
            }
        } else if (diff <= this.OK_WINDOW) {
            kanji = '可';
            eng = 'OK';
            color = '#ffffff';
            points = Math.floor((300 + comboBonus) * 0.5);
            if (isBig) points *= 2;
            if (note.isGogo) points = Math.floor(points * 1.2);

            this.okCount++;
            this.combo++;
            const now = performance.now();
            this.lastHitTime = now;

            // Gentle boost on OK hit - strictly capped
            this.audienceVy = Math.min(7, Math.max(3, this.audienceVy + 3));
            this.audienceYOffset = Math.min(22, this.audienceYOffset + 3);

            this.gauge = Math.min(100, this.gauge + this.gaugeGain * 0.5);
            this._spawnOkHitEffect(this.hitX, this.laneY, isBig);
            this._spawnFlyingGaugeNote(this.hitX, this.laneY, note.type, isBig, now);

            // Don-chan combo check on OK as well
            if (this.combo === 50 || (this.combo >= 100 && this.combo % 100 === 0)) {
                this._triggerDonSpeech(this.combo, now);
            }

            // Flying dragon check on combo increase as well
            if (this.combo > 0 && (this.combo % 15 === 0 || (this.combo >= 10 && now - this.lastDragonTime > 7500))) {
                this._spawnFestivalDragon(now);
            }

            // Large fat horn player check on OK
            if (this.combo > 0 && (this.combo % 10 === 0 || (this.combo >= 8 && now - this.lastHornPlayerTime > 4200))) {
                this._spawnHornPlayer(now);
            }
        } else {
            kanji = '不可';
            eng = 'MISS';
            color = '#7070a0';
            points = 0;
            this.missCount++;
            this.combo = 0;
            this.donSpeech = null;
            this.audienceVy = -8; // Drop downwards slightly on miss
            this.gauge = Math.max(0, this.gauge - this.gaugeLoss);
        }

        this.score += points;
        this.maxCombo = Math.max(this.maxCombo, this.combo);
        note.result = eng;

        this.judgment = {
            kanji,
            eng,
            color,
            time: performance.now(),
            isBig
        };
        this.hitRingAnim = 1.0;

        // Spawn floating RED score increment popup
        if (points > 0) {
            this._spawnScorePopup(points);
        }
    }

    _spawnScorePopup(points) {
        // Red floating score increment
        this.scorePopups.push({
            text: `+${points}`,
            x: this.plateWidth - 30 + (Math.random() * 16 - 8),
            y: this.laneY + this.laneHeight * 0.28,
            vy: -45, // floats upward
            alpha: 1.0,
            birth: performance.now()
        });
    }

    _spawnGoodHitEffect(x, y, isBig) {
        const now = performance.now();
        this.hitEffects.push({
            type: 'good',
            time: now,
            isBig: isBig,
            x: x,
            y: y
        });

        // 14-18 fireworks and rotating star particles (capped for 144Hz smoothness)
        if (this.sparkles.length > 50) {
            this.sparkles.splice(0, this.sparkles.length - 50);
        }
        const count = isBig ? 18 : 14;
        const colors = ['#ffffff', '#fff275', '#ffd700', '#ffaa00', '#ff4757', '#ff6b81', '#70a1ff'];
        for (let i = 0; i < count; i++) {
            const angle = Math.random() * Math.PI * 2;
            const speed = 120 + Math.random() * 200;
            this.sparkles.push({
                x, y,
                vx: Math.cos(angle) * speed,
                vy: Math.sin(angle) * speed - 45,
                color: colors[Math.floor(Math.random() * colors.length)],
                size: 3.5 + Math.random() * 4.0,
                rot: Math.random() * Math.PI * 2,
                vrot: (Math.random() - 0.5) * 12,
                isStar: Math.random() > 0.4,
                birth: now,
                lifespan: 500 + Math.random() * 200
            });
        }
    }

    _spawnOkHitEffect(x, y, isBig) {
        const now = performance.now();
        this.hitEffects.push({
            type: 'ok',
            time: now,
            isBig: isBig,
            x: x,
            y: y
        });

        for (let i = 0; i < 12; i++) {
            const angle = Math.random() * Math.PI * 2;
            const speed = 70 + Math.random() * 120;
            this.sparkles.push({
                x, y,
                vx: Math.cos(angle) * speed,
                vy: Math.sin(angle) * speed,
                color: '#ffffff',
                size: 2.5 + Math.random() * 3,
                rot: 0,
                vrot: 0,
                isStar: false,
                birth: now,
                lifespan: 420
            });
        }
    }

    _spawnSparkles(x, y, count, color) {
        const now = performance.now();
        for (let i = 0; i < count; i++) {
            const angle = Math.random() * Math.PI * 2;
            const speed = 70 + Math.random() * 130;
            this.sparkles.push({
                x, y,
                vx: Math.cos(angle) * speed,
                vy: Math.sin(angle) * speed,
                color,
                size: 2 + Math.random() * 4,
                rot: 0,
                vrot: 0,
                isStar: false,
                birth: now,
                lifespan: 400
            });
        }
    }

    // ═══════════════════════════════════════════
    //  UPDATE
    // ═══════════════════════════════════════════

    _update() {
        const chartTime = this._chartTime();
        const now = performance.now();
        const dt = Math.min(0.05, (now - (this.lastUpdatePerf || now)) / 1000);
        this.lastUpdatePerf = now;

        // Audience physics: smooth vertical boost with natural gravity return
        if (this.audienceYOffset > 0 || this.audienceVy !== 0) {
            this.audienceYOffset += this.audienceVy * dt * 60;
            this.audienceVy -= 1.8 * dt * 60;
            if (this.audienceYOffset <= 0) {
                this.audienceYOffset = 0;
                this.audienceVy = 0;
            }
        }

        let inGogo = false;
        for (const note of this.notes) {
            if (note.time <= chartTime && note.isGogo) {
                inGogo = true;
                break;
            }
        }
        this.gogoActive = inGogo;
        this.gogoPhase += 0.05;

        // Smooth soul gauge interpolation (buttery smooth fluid movement!)
        this.smoothGauge += (this.gauge - this.smoothGauge) * 0.14;

        // Auto-miss notes that passed BAD_WINDOW
        for (const note of this.notes) {
            if (note.hit) continue;
            if (note.type === 'drumroll' || note.type === 'bigDrumroll') {
                const end = note.endTime || (note.time + 1.8);
                if (chartTime > end) note.hit = true;
                continue;
            }
            if (note.type === 'balloon') {
                const end = note.endTime || (note.time + 2.5);
                if (chartTime > end) {
                    note.hit = true;
                    note.popped = true;
                }
                continue;
            }

            if (chartTime - note.time > this.BAD_WINDOW) {
                note.hit = true;
                note.result = 'miss';
                this.missCount++;
                this.combo = 0;
                this.lastMissTime = performance.now();
                this.gauge = Math.max(0, this.gauge - this.gaugeLoss);
                this.judgment = {
                    kanji: '不可',
                    eng: 'MISS',
                    color: '#7070a0',
                    time: performance.now(),
                    isBig: (note.type === 'bigDon' || note.type === 'bigKa')
                };
            }
        }

        // Check if chart has genuinely finished (do NOT freeze midway through song!)
        const audioEnded = (this.audio && (this.audio.ended || (this.audio.duration > 0 && this.audio.currentTime >= this.audio.duration - 0.25)));
        const allDone = this.notes.every(n => n.hit);
        const lastNoteTime = this.notes.length > 0 ? this.notes[this.notes.length - 1].time : 0;

        if (audioEnded || (allDone && chartTime > lastNoteTime + 4.0)) {
            this._endGame();
        }
    }

    _endGame() {
        if (this.finished) return;
        this.finished = true;
        this.resultsActive = true;
        this.resultsStartTime = performance.now();

        // Notify callback without stopping the canvas render loop!
        this.onEnd({
            score: this.score,
            maxCombo: this.maxCombo,
            good: this.goodCount,
            ok: this.okCount,
            miss: this.missCount,
            isClear: this.smoothGauge >= this.clearThreshold,
            totalNotes: this.totalHittableNotes
        });
    }

    restart() {
        this.stop();
        // Reset notes and game stats cleanly
        this.notes = this.options.notes.map(n => ({
            ...n,
            hit: false,
            result: null,
            popped: false,
            rollCount: 0,
            hitsLeft: n.hitsRequired || 5
        }));
        this.score = 0;
        this.combo = 0;
        this.maxCombo = 0;
        this.goodCount = 0;
        this.okCount = 0;
        this.missCount = 0;
        this.totalDrumrollHits = 0;
        this.gauge = 0;
        this.smoothGauge = 0;
        this.lastMissTime = 0;
        this.judgment = null;
        this.hitRingAnim = 0;
        this.hitEffects = [];
        this.sparkles = [];
        this.scorePopups = [];
        this.stageSparklers = [];
        this.audienceBursts = [];
        this.stageStarbursts = [];
        this.lastGoodHitTime = 0;
        this.lastHitTime = 0;
        this.audienceYOffset = 0;
        this.audienceVy = 0;
        this.activeDragon = null;
        this.hornPlayers = [];
        this.flyingGaugeNotes = [];
        this.gaugeRipples = [];
        this.donSpeech = null;
        this.finished = false;
        this.resultsActive = false;
        this.start();
    }

    // ═══════════════════════════════════════════
    //  RENDERING - AUTHENTIC TAIKO UI
    // ═══════════════════════════════════════════

    _render() {
        const ctx = this.ctx;
        const w = this.canvas.width;
        const h = this.canvas.height;
        const chartTime = this._chartTime();
        const now = performance.now();

        const laneTop = this.laneY - this.laneHeight / 2;
        const laneBot = this.laneY + this.laneHeight / 2;

        // 1. TOP BANNER
        this._renderTopArea(w, laneTop, now);

        // 2. SOUL GAUGE
        this._renderSoulGauge(w, laneTop, now);

        // 3. BOTTOM FESTIVAL SCENE
        this._renderBottomArea(w, h, laneBot, now);

        // 3b. DRAMATIC BURSTY STAGE SPARKLERS, STARBURSTS & AUDIENCE CHEER BURSTS
        this._renderAudienceBursts(now);
        this._renderStageSparklers(now);
        this._renderStageStarbursts(now);

        // 3c. FESTIVAL DRAGON FLYING THROUGH THE CROWD DOING LOOPS
        this._renderFestivalDragon(now, w, h, laneBot);

        // 3d. LARGE FAT HORN PLAYERS POPPING INTO THE CROWD (LOUD HORN BLASTS!)
        this._renderHornPlayers(now, w, h, laneBot);

        // 4. HIGHWAY (SHIFTED RIGHT, LARGER)
        this._renderHighway(w, laneTop, laneBot);

        // 5. NOTES
        this._renderNotes(w, chartTime);

        // 6. HIT TARGET & SPARKLES
        this._renderHitTarget(laneTop, laneBot, now);

        // 7. LEFT PLAYER PLATE & 4-ZONE TAIKO DRUM (DF & JK)
        this._renderPlayerPlate(laneTop, laneBot, now);

        // 7b. DANCING DON-CHAN (Moved up and a bit to the left, twice as large!)
        const donX = this.drumX - 58;
        const donY = this.drumY - this.drumR - 152;
        this._renderDancingDon(donX, donY, now);
        this._renderDonSpeech(donX, donY, now);

        // 8. RED SCORE POPUPS (+300, +400, +800...)
        this._renderScorePopups(now);

        // 8b. FLYING HIT NOTES ARCS INTO SOUL GAUGE
        this._renderFlyingGaugeNotes(now, w, laneTop);

        // 9. JUDGMENT TEXT & COMBO
        this._renderJudgment(now);

        // 10. PRE-ROLL "READY... GO!" BANNER
        this._renderPreRoll(w, now);

        // 11. PAUSE OVERLAY (NOTES REMAIN RENDERED UNDERNEATH)
        if (this.isPaused) {
            this._renderPause(w, h);
        }

        // 12. RESULTS OVERLAY
        if (this.finished) {
            this._renderResults(w, h);
        }
    }

    _renderPreRoll(w, now) {
        const preRollElapsed = (now - this.preRollStartTime) / 1000;
        if (preRollElapsed >= this.preRollDuration) return;

        const ctx = this.ctx;
        ctx.save();
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        const cx = this.hitX + 180;
        const cy = this.laneY;

        if (preRollElapsed < 1.3) {
            ctx.font = '900 46px "Segoe UI", Impact, sans-serif';
            ctx.fillStyle = 'rgba(0, 0, 0, 0.75)';
            ctx.fillText('READY...', cx + 2, cy + 2);
            ctx.fillStyle = '#ffea00';
            ctx.shadowColor = 'rgba(255, 220, 0, 0.8)';
            ctx.shadowBlur = 12;
            ctx.fillText('READY...', cx, cy);
        } else {
            ctx.font = '900 56px "Segoe UI", Impact, sans-serif';
            ctx.fillStyle = 'rgba(0, 0, 0, 0.75)';
            ctx.fillText('GO!', cx + 2, cy + 2);
            ctx.fillStyle = '#ff3333';
            ctx.shadowColor = 'rgba(255, 50, 50, 0.9)';
            ctx.shadowBlur = 14;
            ctx.fillText('GO!', cx, cy);
        }
        ctx.restore();
    }

    _renderTopArea(w, laneTop, now) {
        const ctx = this.ctx;

        const grad = ctx.createLinearGradient(0, 0, 0, laneTop);
        grad.addColorStop(0, '#ff9ebb');
        grad.addColorStop(1, '#ff7096');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, w, laneTop);

        // Flower motifs
        ctx.fillStyle = 'rgba(255, 255, 255, 0.12)';
        for (let x = 30; x < w; x += 90) {
            for (let y = 20; y < laneTop; y += 70) {
                ctx.beginPath();
                ctx.arc(x, y, 18, 0, Math.PI * 2);
                ctx.fill();
            }
        }

        // Song title badge
        const bannerW = Math.min(420, w * 0.42);
        const bannerX = w - bannerW - 20;
        const bannerY = 12;

        ctx.fillStyle = 'rgba(0, 0, 0, 0.65)';
        this._roundRect(bannerX, bannerY, bannerW, 36, 18);
        ctx.fill();

        ctx.fillStyle = '#ffcc00';
        ctx.font = 'bold 12px "Segoe UI", sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText('★ TAIKO', bannerX + 14, bannerY + 23);

        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 14px "Segoe UI", sans-serif';
        const titleText = this.title.length > 26 ? this.title.slice(0, 24) + '...' : this.title;
        ctx.fillText(titleText, bannerX + 85, bannerY + 23);
    }

    _renderSoulGauge(w, laneTop, now = performance.now()) {
        const ctx = this.ctx;

        const gaugeX = this.plateWidth + 10;
        const gaugeW = w - gaugeX - 70;
        const gaugeH = 26;
        const gaugeY = laneTop - gaugeH - 8;

        if (gaugeW < 80) return;

        // Background track
        ctx.fillStyle = 'rgba(15, 15, 25, 0.92)';
        ctx.strokeStyle = '#2d2d44';
        ctx.lineWidth = 2.5;
        this._roundRect(gaugeX, gaugeY, gaugeW, gaugeH, 6);
        ctx.fill();
        ctx.stroke();

        const curGauge = Math.max(0, Math.min(100, this.smoothGauge || 0));
        const fillW = Math.max(0, (gaugeW - 4) * (curGauge / 100));
        const clearRatio = this.clearThreshold / 100;
        const clearX = gaugeX + 2 + (gaugeW - 4) * clearRatio;
        const isClear = (curGauge >= this.clearThreshold);

        // Smooth glowing continuous fluid bar
        if (fillW > 0) {
            ctx.save();
            ctx.beginPath();
            this._roundRect(gaugeX + 2, gaugeY + 2, fillW, gaugeH - 4, 4);
            ctx.clip();

            // Pure yellow vibrant radiant soul bar (authentic arcade Taiko style)
            const fillGrad = ctx.createLinearGradient(0, gaugeY + 2, 0, gaugeY + gaugeH - 2);
            fillGrad.addColorStop(0, '#fff666');  // Glowing radiant bright yellow top
            fillGrad.addColorStop(0.5, '#ffd200'); // Pure rich saturated yellow core
            fillGrad.addColorStop(1, '#ffb700');  // Warm deep golden yellow base

            ctx.fillStyle = fillGrad;
            ctx.fillRect(gaugeX + 2, gaugeY + 2, fillW, gaugeH - 4);

            // Shimmer highlight along top half of bar
            const topHighlight = ctx.createLinearGradient(0, gaugeY + 2, 0, gaugeY + gaugeH * 0.5);
            topHighlight.addColorStop(0, 'rgba(255, 255, 255, 0.65)');
            topHighlight.addColorStop(1, 'rgba(255, 255, 255, 0.0)');
            ctx.fillStyle = topHighlight;
            ctx.fillRect(gaugeX + 2, gaugeY + 2, fillW, (gaugeH - 4) * 0.5);

            // Glowing cursor tip at leading edge
            const tipX = gaugeX + 2 + fillW;
            ctx.fillStyle = '#ffffff';
            ctx.shadowColor = '#fff';
            ctx.shadowBlur = 8;
            ctx.fillRect(tipX - 2, gaugeY + 2, 2, gaugeH - 4);
            ctx.shadowBlur = 0;

            ctx.restore();
        }

        // Segment tick lines on top (subtle arcade LED look)
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.35)';
        ctx.lineWidth = 1.5;
        const numTicks = 40;
        const tickStep = (gaugeW - 4) / numTicks;
        for (let t = 1; t < numTicks; t++) {
            const tx = gaugeX + 2 + t * tickStep;
            ctx.beginPath();
            ctx.moveTo(tx, gaugeY + 2);
            ctx.lineTo(tx, gaugeY + gaugeH - 2);
            ctx.stroke();
        }

        // CLEAR Threshold Line
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(clearX, gaugeY - 4);
        ctx.lineTo(clearX, gaugeY + gaugeH + 4);
        ctx.stroke();

        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 11px "Segoe UI", Impact, sans-serif';
        ctx.textAlign = 'center';
        ctx.shadowColor = '#000';
        ctx.shadowBlur = 4;
        ctx.fillText('CLEAR', clearX, gaugeY - 7);
        ctx.shadowBlur = 0;

        // Soul Gauge Percentage Indicator (e.g. 78%)
        ctx.save();
        const pctText = `${Math.round(curGauge)}%`;
        ctx.font = 'bold 14px "Segoe UI", Impact, sans-serif';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'bottom';
        ctx.lineWidth = 3.5;
        ctx.strokeStyle = '#111122';
        ctx.strokeText(pctText, gaugeX + gaugeW, gaugeY - 4);
        ctx.fillStyle = isClear ? '#ffe033' : '#ffffff';
        ctx.fillText(pctText, gaugeX + gaugeW, gaugeY - 4);
        ctx.restore();

        // Soul Orb
        const soulX = gaugeX + gaugeW + 28;
        const soulY = gaugeY + gaugeH / 2;
        const soulR = 20;

        const isFullSoul = (curGauge >= 99.5);

        ctx.beginPath();
        ctx.arc(soulX, soulY, soulR, 0, Math.PI * 2);
        if (isFullSoul) {
            const flameGrad = ctx.createRadialGradient(soulX, soulY, 2, soulX, soulY, soulR);
            flameGrad.addColorStop(0, '#ffffaa');
            flameGrad.addColorStop(0.5, '#ff6600');
            flameGrad.addColorStop(1, '#cc0000');
            ctx.fillStyle = flameGrad;
            ctx.shadowColor = '#ff3300';
            ctx.shadowBlur = 15;
        } else if (isClear) {
            ctx.fillStyle = '#ffaa00';
            ctx.shadowColor = '#ffcc00';
            ctx.shadowBlur = 10;
        } else {
            ctx.fillStyle = '#2d2d44';
            ctx.shadowBlur = 0;
        }
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2.5;
        ctx.stroke();

        ctx.fillStyle = isClear ? '#ffffff' : 'rgba(255, 255, 255, 0.4)';
        ctx.font = 'bold 16px "Segoe UI", sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('魂', soulX, soulY);

        // Render Gauge Splash Ripples on note arrival
        if (this.gaugeRipples && this.gaugeRipples.length > 0) {
            for (let rIdx = this.gaugeRipples.length - 1; rIdx >= 0; rIdx--) {
                const rip = this.gaugeRipples[rIdx];
                const ripAge = (now - rip.birth) / rip.duration;
                if (ripAge >= 1.0) {
                    this.gaugeRipples.splice(rIdx, 1);
                    continue;
                }
                const alpha = 1 - ripAge;
                const rRadius = 4 + ripAge * 24;

                ctx.save();
                ctx.globalAlpha = alpha;
                ctx.strokeStyle = rip.color;
                ctx.lineWidth = 2.5 * (1 - ripAge * 0.5);
                ctx.beginPath();
                ctx.arc(rip.x, rip.y, rRadius, 0, Math.PI * 2);
                ctx.stroke();

                for (let s = 0; s < 5; s++) {
                    const sAngle = (s / 5) * Math.PI * 2 + ripAge * 3;
                    const sDist = rRadius * 1.1;
                    ctx.fillStyle = rip.color;
                    ctx.beginPath();
                    ctx.arc(rip.x + Math.cos(sAngle) * sDist, rip.y + Math.sin(sAngle) * sDist, 1.8 * (1 - ripAge), 0, Math.PI * 2);
                    ctx.fill();
                }
                ctx.restore();
            }
        }
    }

    _renderDancingDon(x, y, now) {
        const ctx = this.ctx;
        const bounce = Math.sin(now / 130) * 8;
        const isHyped = (this.combo >= 10 || this.gogoActive);
        const isMiss = (now - this.lastMissTime < 800);

        ctx.save();
        ctx.translate(x, y + (isHyped ? bounce * 1.5 : bounce));

        // Don-chan scaled up (twice as large: scale 4.6)
        const scale = 4.6;
        ctx.scale(scale, scale);

        // Little cute feet tapping at bottom
        const footW = 5;
        const footH = 4;
        ctx.fillStyle = '#ffffff';
        ctx.strokeStyle = '#222222';
        ctx.lineWidth = 1.5;

        const footOffset = Math.sin(now / 130) * 3;
        // Left foot
        ctx.beginPath();
        ctx.ellipse(-14, 22 + footOffset, footW, footH, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

        // Right foot
        ctx.beginPath();
        ctx.ellipse(6, 22 - footOffset, footW, footH, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

        // Big Red Drum Body
        ctx.fillStyle = '#e8425a';
        ctx.beginPath();
        ctx.ellipse(0, 0, 32, 24, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 3.5;
        ctx.stroke();
        ctx.strokeStyle = '#222222';
        ctx.lineWidth = 1.2;
        ctx.stroke();

        // White Face Plaque
        ctx.fillStyle = '#fff4e6';
        ctx.beginPath();
        ctx.ellipse(-6, 0, 20, 20, 0, 0, Math.PI * 2);
        ctx.fill();

        // Eyes & Mouth based on state
        if (isMiss) {
            // Dizzy spiral / startled eyes on MISS
            ctx.strokeStyle = '#222222';
            ctx.lineWidth = 1.8;
            ctx.beginPath();
            ctx.arc(-12, -4, 3.5, 0, Math.PI * 1.5);
            ctx.stroke();
            ctx.beginPath();
            ctx.arc(0, -4, 3.5, 0, Math.PI * 1.5);
            ctx.stroke();

            // Wavy sad mouth
            ctx.beginPath();
            ctx.moveTo(-9, 5);
            ctx.quadraticCurveTo(-6, 2, -3, 5);
            ctx.stroke();

            // Sweatdrop
            ctx.fillStyle = '#55ccff';
            ctx.beginPath();
            ctx.arc(12, -14, 3, 0, Math.PI * 2);
            ctx.fill();
        } else if (isHyped) {
            // Happy crescent smiling eyes on combo / hype!
            ctx.strokeStyle = '#222222';
            ctx.lineWidth = 2.2;
            ctx.beginPath();
            ctx.arc(-12, -2, 4, Math.PI * 1.1, Math.PI * 1.9);
            ctx.arc(0, -2, 4, Math.PI * 1.1, Math.PI * 1.9);
            ctx.stroke();

            // Wide open happy smile
            ctx.fillStyle = '#dd3344';
            ctx.beginPath();
            ctx.arc(-6, 4, 6, 0.1 * Math.PI, 0.9 * Math.PI);
            ctx.fill();
            ctx.strokeStyle = '#222222';
            ctx.lineWidth = 1.8;
            ctx.stroke();

            // Festive Hachimaki headband
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.moveTo(-24, -14);
            ctx.quadraticCurveTo(-6, -18, 12, -14);
            ctx.stroke();
        } else {
            // Normal cute eyes with shiny highlights
            ctx.fillStyle = '#222222';
            ctx.beginPath();
            ctx.arc(-12, -3, 3.2, 0, Math.PI * 2);
            ctx.arc(0, -3, 3.2, 0, Math.PI * 2);
            ctx.fill();

            ctx.fillStyle = '#ffffff';
            ctx.beginPath();
            ctx.arc(-13, -4, 1.2, 0, Math.PI * 2);
            ctx.arc(-1, -4, 1.2, 0, Math.PI * 2);
            ctx.fill();

            // Cute smile
            ctx.beginPath();
            ctx.arc(-6, 4, 5.5, 0.1 * Math.PI, 0.9 * Math.PI);
            ctx.lineWidth = 2.0;
            ctx.strokeStyle = '#222222';
            ctx.stroke();
        }

        // Rosy blushing cheeks
        ctx.fillStyle = 'rgba(255, 120, 140, 0.75)';
        ctx.beginPath();
        ctx.arc(-17, 3, 3.5, 0, Math.PI * 2);
        ctx.arc(5, 3, 3.5, 0, Math.PI * 2);
        ctx.fill();

        // Waving Drumsticks (Bachi)
        const bachiAngle = Math.sin(now / 130) * 0.4;
        ctx.strokeStyle = '#d4a373';
        ctx.lineWidth = 2.5;
        // Left bachi
        ctx.beginPath();
        ctx.moveTo(-24, 6);
        ctx.lineTo(-32 + Math.cos(bachiAngle) * 12, -6 + Math.sin(bachiAngle) * 12);
        ctx.stroke();

        // Right bachi
        ctx.beginPath();
        ctx.moveTo(18, 6);
        ctx.lineTo(26 - Math.cos(bachiAngle) * 12, -6 + Math.sin(bachiAngle) * 12);
        ctx.stroke();

        ctx.restore();
    }

    _renderHighway(w, laneTop, laneBot) {
        const ctx = this.ctx;

        const laneGrad = ctx.createLinearGradient(0, laneTop, 0, laneBot);
        laneGrad.addColorStop(0, '#262832');
        laneGrad.addColorStop(0.5, '#343644');
        laneGrad.addColorStop(1, '#22232e');

        ctx.fillStyle = laneGrad;
        ctx.fillRect(this.plateWidth, laneTop, w - this.plateWidth, this.laneHeight);

        // Flash Red on F and J press
        if (this.laneFlashRed > 0.01) {
            ctx.save();
            const redGrad = ctx.createLinearGradient(this.plateWidth, 0, w, 0);
            redGrad.addColorStop(0, `rgba(255, 50, 60, ${this.laneFlashRed * 0.6})`);
            redGrad.addColorStop(0.35, `rgba(255, 60, 70, ${this.laneFlashRed * 0.4})`);
            redGrad.addColorStop(1, `rgba(255, 40, 50, ${this.laneFlashRed * 0.08})`);
            ctx.fillStyle = redGrad;
            ctx.fillRect(this.plateWidth, laneTop, w - this.plateWidth, this.laneHeight);
            ctx.restore();
            this.laneFlashRed = Math.max(0, this.laneFlashRed - 0.07);
        }

        // Flash Blue on D and K press
        if (this.laneFlashBlue > 0.01) {
            ctx.save();
            const blueGrad = ctx.createLinearGradient(this.plateWidth, 0, w, 0);
            blueGrad.addColorStop(0, `rgba(45, 160, 255, ${this.laneFlashBlue * 0.6})`);
            blueGrad.addColorStop(0.35, `rgba(55, 170, 255, ${this.laneFlashBlue * 0.4})`);
            blueGrad.addColorStop(1, `rgba(35, 140, 255, ${this.laneFlashBlue * 0.08})`);
            ctx.fillStyle = blueGrad;
            ctx.fillRect(this.plateWidth, laneTop, w - this.plateWidth, this.laneHeight);
            ctx.restore();
            this.laneFlashBlue = Math.max(0, this.laneFlashBlue - 0.07);
        }

        ctx.strokeStyle = '#e6a15c';
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(this.plateWidth, laneTop);
        ctx.lineTo(w, laneTop);
        ctx.moveTo(this.plateWidth, laneBot);
        ctx.lineTo(w, laneBot);
        ctx.stroke();

        ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
        ctx.lineWidth = 1;
        ctx.setLineDash([8, 8]);
        ctx.beginPath();
        ctx.moveTo(this.hitX, this.laneY);
        ctx.lineTo(w, this.laneY);
        ctx.stroke();
        ctx.setLineDash([]);
    }

    _renderHitTarget(laneTop, laneBot, now) {
        const ctx = this.ctx;

        ctx.strokeStyle = 'rgba(255, 255, 255, 0.6)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(this.hitX, laneTop);
        ctx.lineTo(this.hitX, laneBot);
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(this.hitX, this.laneY, this.bigNoteRadius + 8, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
        ctx.lineWidth = 3;
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(this.hitX, this.laneY, this.noteRadius * 0.45, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255, 255, 255, 0.25)';
        ctx.fill();

        // Multi-ring shockwaves for Good and OK hits
        for (let i = this.hitEffects.length - 1; i >= 0; i--) {
            const fx = this.hitEffects[i];
            const maxDuration = (fx.type === 'good') ? 600 : 380;
            const elapsed = now - fx.time;
            if (elapsed >= maxDuration) {
                this.hitEffects.splice(i, 1);
                continue;
            }

            const progress = elapsed / maxDuration;
            const alpha = 1 - progress;
            const easeOut = 1 - Math.pow(1 - progress, 3);

            ctx.save();

            if (fx.type === 'good') {
                // 1. Golden central bloom
                const bloomR = (this.bigNoteRadius + 12) * (1 + easeOut * 0.45);
                const radial = ctx.createRadialGradient(this.hitX, this.laneY, 0, this.hitX, this.laneY, bloomR);
                radial.addColorStop(0, `rgba(255, 248, 190, ${alpha * 0.65})`);
                radial.addColorStop(0.45, `rgba(255, 205, 0, ${alpha * 0.4})`);
                radial.addColorStop(1, 'rgba(255, 120, 0, 0)');
                ctx.fillStyle = radial;
                ctx.beginPath();
                ctx.arc(this.hitX, this.laneY, bloomR, 0, Math.PI * 2);
                ctx.fill();

                // 2. Primary expanding fiery golden shockwave ring
                const outerR = (this.bigNoteRadius + 8) + easeOut * 70;

                // 2a. Golden outer glow shockwave ring
                ctx.beginPath();
                ctx.arc(this.hitX, this.laneY, outerR, 0, Math.PI * 2);
                ctx.strokeStyle = `rgba(255, 220, 60, ${alpha * 0.4})`;
                ctx.lineWidth = Math.max(2, 11 * (1 - progress));
                ctx.stroke();

                // 2b. Primary fiery golden shockwave ring
                ctx.beginPath();
                ctx.arc(this.hitX, this.laneY, outerR, 0, Math.PI * 2);
                ctx.strokeStyle = `rgba(255, 245, 120, ${alpha})`;
                ctx.lineWidth = Math.max(1, 5.0 * (1 - progress));
                ctx.stroke();

                // 3. Secondary fiery ripple ring
                const innerR = (this.noteRadius * 0.7) + easeOut * 45;
                ctx.beginPath();
                ctx.arc(this.hitX, this.laneY, innerR, 0, Math.PI * 2);
                ctx.strokeStyle = `rgba(255, 120, 30, ${alpha * 0.85})`;
                ctx.lineWidth = Math.max(1, 3.5 * (1 - progress));
                ctx.stroke();

                // 4. Hit sparkle cross rays
                if (progress < 0.45) {
                    const rayLen = 42 + (1 - progress / 0.45) * 35;
                    const rayAlpha = (1 - progress / 0.45) * 0.85;
                    ctx.strokeStyle = `rgba(255, 255, 255, ${rayAlpha})`;
                    ctx.lineWidth = 2.5;
                    ctx.beginPath();
                    ctx.moveTo(this.hitX - rayLen, this.laneY);
                    ctx.lineTo(this.hitX + rayLen, this.laneY);
                    ctx.moveTo(this.hitX, this.laneY - rayLen);
                    ctx.lineTo(this.hitX, this.laneY + rayLen);
                    ctx.stroke();
                }
            } else {
                // OK hit: clean white/silver expanding pulse
                const okR = (this.noteRadius + 6) + easeOut * 35;
                ctx.beginPath();
                ctx.arc(this.hitX, this.laneY, okR, 0, Math.PI * 2);
                ctx.strokeStyle = `rgba(255, 255, 255, ${alpha * 0.8})`;
                ctx.lineWidth = Math.max(1, 3 * (1 - progress));
                ctx.stroke();
            }

            ctx.restore();
        }

        // Render fireworks & rotating star particles (ultra-smooth 144Hz loop)
        for (let i = this.sparkles.length - 1; i >= 0; i--) {
            const sp = this.sparkles[i];
            const lifespan = sp.lifespan || 420;
            const age = (now - sp.birth) / lifespan;
            if (age >= 1) {
                this.sparkles.splice(i, 1);
                continue;
            }

            const alpha = 1 - age;
            const t = age * (lifespan / 1000);
            const currentX = sp.x + sp.vx * t;
            const currentY = sp.y + sp.vy * t + 80 * t * t; // gravity effect
            const size = sp.size * (1 - age * 0.6);

            if (sp.isStar) {
                ctx.save();
                ctx.globalAlpha = alpha;
                ctx.translate(currentX, currentY);
                ctx.rotate(sp.rot + (sp.vrot || 2) * age);
                ctx.fillStyle = sp.color;
                ctx.beginPath();
                ctx.moveTo(0, -size * 1.5);
                ctx.quadraticCurveTo(0, 0, size * 1.5, 0);
                ctx.quadraticCurveTo(0, 0, 0, size * 1.5);
                ctx.quadraticCurveTo(0, 0, -size * 1.5, 0);
                ctx.quadraticCurveTo(0, 0, 0, -size * 1.5);
                ctx.fill();
                ctx.restore();
            } else {
                ctx.globalAlpha = alpha;
                ctx.fillStyle = sp.color;
                ctx.beginPath();
                ctx.arc(currentX, currentY, Math.max(0.5, size), 0, Math.PI * 2);
                ctx.fill();
            }
        }
        ctx.globalAlpha = 1.0;
    }

    _renderNotes(w, chartTime) {
        const ctx = this.ctx;

        // 1. Render Drumroll bodies first (so note heads draw on top)
        for (let i = 0; i < this.notes.length; i++) {
            const note = this.notes[i];
            if (note.hit) continue;
            if (note.type === 'drumroll' || note.type === 'bigDrumroll') {
                const speed = this._getNoteSpeed(note);
                const end = note.endTime || (note.time + 1.8);
                let headX = this.hitX + (note.time - chartTime) * speed;
                let tailX = this.hitX + (end - chartTime) * speed;

                // When actively rolling, keep head cap anchored at hit line!
                if (chartTime >= note.time && chartTime <= end) {
                    headX = this.hitX;
                }

                if (tailX >= this.plateWidth && headX <= w + 100) {
                    this._drawDrumroll(headX, tailX, this.laneY, note);
                }
            }
        }

        // 2. Render normal Don, Ka, and approaching/docked Balloon notes
        const visible = [];
        for (let i = 0; i < this.notes.length; i++) {
            const note = this.notes[i];
            if (note.hit) continue;
            if (note.type === 'drumroll' || note.type === 'bigDrumroll') continue; // Already drawn

            if (note.type === 'balloon') {
                if (note.hit || note.popped) continue;
                const speed = this._getNoteSpeed(note);
                const end = note.endTime || (note.time + 2.5);
                let x = this.hitX + (note.time - chartTime) * speed;

                // PIN BALLOON AT HIT LINE while active until popped!
                if (chartTime >= note.time && chartTime <= end) {
                    x = this.hitX;
                }

                if (x >= this.hitX - 40 && x <= w + 70) {
                    visible.push({ note, x });
                }
            } else {
                const diff = note.time - chartTime;
                const speed = this._getNoteSpeed(note);
                const x = this.hitX + diff * speed;
                if (x >= this.hitX - 70 && x <= w + 70) {
                    visible.push({ note, x });
                }
            }
        }

        // Draw furthest first
        visible.sort((a, b) => b.x - a.x);

        for (const item of visible) {
            if (item.note.type === 'balloon') {
                this._drawBalloonHighway(item.x, this.laneY, item.note);
            } else {
                this._drawAuthenticNote(item.x, this.laneY, item.note);
            }
        }

        // 3. Render Active Drumroll Overlay (連打 counter)
        const activeRoll = this.notes.find(n =>
            (n.type === 'drumroll' || n.type === 'bigDrumroll') &&
            !n.hit &&
            chartTime >= (n.time - 0.15) && chartTime <= (n.endTime || (n.time + 1.8))
        );
        if (activeRoll) {
            this._renderActiveDrumrollOverlay(activeRoll);
        }

        // 4. Render Active Balloon Overlay (Big cartoon balloon popup)
        const activeBalloon = this.notes.find(n =>
            n.type === 'balloon' &&
            !n.hit && !n.popped &&
            chartTime >= (n.time - 0.15) && chartTime <= (n.endTime || (n.time + 2.5))
        );
        if (activeBalloon) {
            this._renderActiveBalloonOverlay(activeBalloon);
        }
    }

    _drawDrumroll(headX, tailX, y, note) {
        const ctx = this.ctx;
        const isBig = (note.type === 'bigDrumroll');
        const radius = isBig ? this.bigNoteRadius : this.noteRadius;
        const beamH = radius * 1.6;

        ctx.save();

        const drawHeadX = Math.max(this.plateWidth, headX);
        const beamW = Math.max(10, tailX - drawHeadX);

        // Beam gradient
        const grad = ctx.createLinearGradient(0, y - beamH / 2, 0, y + beamH / 2);
        grad.addColorStop(0, '#fff066');
        grad.addColorStop(0.5, '#ffcc00');
        grad.addColorStop(1, '#ff9900');

        ctx.fillStyle = grad;
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 3;

        // Draw rounded beam
        this._roundRect(drawHeadX, y - beamH / 2, beamW, beamH, Math.min(beamH / 2, beamW / 2));
        ctx.fill();
        ctx.stroke();

        // Big roll fiery glow
        if (isBig) {
            ctx.strokeStyle = 'rgba(255, 100, 0, 0.5)';
            ctx.lineWidth = 5;
            ctx.stroke();
        }

        // Head cap at drawHeadX
        ctx.beginPath();
        ctx.arc(drawHeadX, y, radius, 0, Math.PI * 2);
        ctx.fillStyle = '#ffbb00';
        ctx.fill();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 3;
        ctx.stroke();

        // Text "連打"
        ctx.fillStyle = '#ffffff';
        ctx.font = `bold ${Math.round(radius * 0.65)}px "Segoe UI", sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.shadowColor = 'rgba(0,0,0,0.6)';
        ctx.shadowBlur = 3;
        ctx.fillText('連打', headX, y);
        ctx.shadowBlur = 0;

        ctx.restore();
    }

    _drawBalloonHighway(headX, y, note) {
        if (!note || note.hit || note.popped) return;
        const ctx = this.ctx;
        try {
            const radius = Math.max(16, this.noteRadius || 38);

            ctx.save();

            // Balloon circle on highway
            ctx.beginPath();
            ctx.arc(headX, y, radius, 0, Math.PI * 2);
            const bGrad = ctx.createRadialGradient(headX - radius * 0.3, y - radius * 0.3, 2, headX, y, radius);
            bGrad.addColorStop(0, '#ff9955');
            bGrad.addColorStop(1, '#ff5522');
            ctx.fillStyle = bGrad;
            ctx.fill();
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 3;
            ctx.stroke();

            // Balloon knot at bottom
            ctx.beginPath();
            ctx.moveTo(headX - 4, y + radius);
            ctx.lineTo(headX + 4, y + radius);
            ctx.lineTo(headX, y + radius + 6);
            ctx.closePath();
            ctx.fillStyle = '#dd3311';
            ctx.fill();

            // Hits remaining number inside note
            const hits = (note.hitsLeft !== undefined && !isNaN(note.hitsLeft)) ? Math.max(0, note.hitsLeft) : 5;
            ctx.fillStyle = '#ffffff';
            ctx.font = `900 ${Math.round(radius * 0.85)}px "Segoe UI", Impact, sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(hits.toString(), headX, y);

            ctx.restore();
        } catch (err) {
            console.error('Error in _drawBalloonHighway:', err);
            try { ctx.restore(); } catch (_) {}
        }
    }

    _renderActiveBalloonOverlay(note) {
        if (!note || note.hit || note.popped) return;
        const ctx = this.ctx;
        try {
            const bx = this.plateWidth + 40;
            const by = this.laneY - this.laneHeight * 0.70;

            const hits = (note.hitsLeft !== undefined && !isNaN(note.hitsLeft)) ? Math.max(0, note.hitsLeft) : 5;
            const req = (note.hitsRequired !== undefined && !isNaN(note.hitsRequired) && note.hitsRequired > 0) ? note.hitsRequired : 5;
            const progress = Math.max(0, Math.min(1, 1 - hits / req));
            const bRadius = Math.max(25, Math.min(75, 40 + progress * 24));

            ctx.save();

            // Wobble when hit
            const shake = (performance.now() - (note.lastHitTime || 0) < 100) ? (Math.random() * 8 - 4) : 0;
            ctx.translate(bx + shake, by);

            // 3D Balloon body
            const bGrad = ctx.createRadialGradient(-bRadius * 0.3, -bRadius * 0.3, Math.max(1, bRadius * 0.1), 0, 0, bRadius);
            bGrad.addColorStop(0, '#ffaa66');
            bGrad.addColorStop(0.6, '#ff4422');
            bGrad.addColorStop(1, '#cc1100');

            ctx.beginPath();
            ctx.arc(0, 0, bRadius, 0, Math.PI * 2);
            ctx.fillStyle = bGrad;
            ctx.fill();
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 4;
            ctx.stroke();

            // Glossy reflection
            ctx.beginPath();
            ctx.arc(-bRadius * 0.35, -bRadius * 0.35, Math.max(2, bRadius * 0.28), 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
            ctx.fill();

            // Balloon bottom knot
            ctx.beginPath();
            ctx.moveTo(-6, bRadius);
            ctx.lineTo(6, bRadius);
            ctx.lineTo(0, bRadius + 10);
            ctx.closePath();
            ctx.fillStyle = '#bb1100';
            ctx.fill();

            // Hits remaining count (BIG bold white number)
            ctx.fillStyle = '#ffffff';
            ctx.font = `900 ${Math.round(bRadius * 0.95)}px "Segoe UI", Impact, sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.shadowColor = 'rgba(0, 0, 0, 0.8)';
            ctx.shadowBlur = 6;
            ctx.fillText(hits.toString(), 0, 0);
            ctx.shadowBlur = 0;

            // Instruction: F / J 連打!
            ctx.font = 'bold 13px "Segoe UI", sans-serif';
            ctx.fillStyle = '#ffea00';
            ctx.shadowColor = 'rgba(0, 0, 0, 0.8)';
            ctx.shadowBlur = 4;
            ctx.fillText('F / J 連打!', 0, bRadius + 22);
            ctx.shadowBlur = 0;

            ctx.restore();
        } catch (err) {
            console.error('Error in _renderActiveBalloonOverlay:', err);
            try { ctx.restore(); } catch (_) {}
        }
    }

    _renderActiveDrumrollOverlay(note) {
        const ctx = this.ctx;
        const rx = this.hitX;
        const ry = this.laneY - this.laneHeight * 0.48;
        const count = note.rollCount || 0;

        ctx.save();

        // Bounce scale on hit
        const bounce = (performance.now() - (note.lastHitTime || 0) < 100) ? 1.15 : 1.0;
        ctx.translate(rx, ry);
        ctx.scale(bounce, bounce);

        // Glowing pill badge
        ctx.fillStyle = 'rgba(0, 0, 0, 0.75)';
        ctx.strokeStyle = '#ffcc00';
        ctx.lineWidth = 3;
        this._roundRect(-60, -22, 120, 44, 14);
        ctx.fill();
        ctx.stroke();

        // Text: 連打 X
        ctx.font = '900 22px "Segoe UI", Impact, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#ffea00';
        ctx.shadowColor = 'rgba(255, 200, 0, 0.9)';
        ctx.shadowBlur = 8;
        ctx.fillText(`連打 ${count}`, 0, 0);
        ctx.shadowBlur = 0;

        ctx.restore();
    }

    _drawAuthenticNote(x, y, note) {
        const ctx = this.ctx;
        const isDon = (note.type === 'don' || note.type === 'bigDon');
        const isBig = (note.type === 'bigDon' || note.type === 'bigKa');
        const radius = isBig ? this.bigNoteRadius : this.noteRadius;

        const mainColor = isDon ? '#e8425a' : '#4a9bd9';

        ctx.save();

        if (isBig) {
            ctx.beginPath();
            ctx.arc(x, y, radius + 10, 0, Math.PI * 2);
            ctx.fillStyle = isDon ? 'rgba(255, 100, 50, 0.45)' : 'rgba(70, 180, 255, 0.45)';
            ctx.fill();
        }

        // Outer white border
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.lineWidth = Math.max(3, radius * 0.07);
        ctx.strokeStyle = '#1a1a1a';
        ctx.stroke();

        // Inner face disc
        ctx.beginPath();
        ctx.arc(x, y, radius * 0.82, 0, Math.PI * 2);
        ctx.fillStyle = mainColor;
        ctx.fill();

        // Authentic expressive face details
        const faceScale = radius / 36;
        const eyeOffset = 7.5 * faceScale;
        const eyeY = y - 2.5 * faceScale;
        const eyeR = 3.2 * faceScale;

        // Eye pupils
        ctx.fillStyle = '#1e1e1e';
        ctx.beginPath();
        ctx.arc(x - eyeOffset, eyeY, eyeR, 0, Math.PI * 2);
        ctx.arc(x + eyeOffset, eyeY, eyeR, 0, Math.PI * 2);
        ctx.fill();

        // Glossy white highlight reflection in eyes
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(x - eyeOffset - 0.9 * faceScale, eyeY - 1.0 * faceScale, 1.1 * faceScale, 0, Math.PI * 2);
        ctx.arc(x + eyeOffset - 0.9 * faceScale, eyeY - 1.0 * faceScale, 1.1 * faceScale, 0, Math.PI * 2);
        ctx.fill();

        // Distinct expressive mouths for Don and Ka
        if (isDon) {
            // Don: Big cheerful happy open smile with inner dark mouth & tongue!
            ctx.fillStyle = '#7a1020';
            ctx.beginPath();
            ctx.arc(x, y + 4 * faceScale, 5.5 * faceScale, 0.1 * Math.PI, 0.9 * Math.PI, false);
            ctx.closePath();
            ctx.fill();

            // Tongue highlight
            ctx.fillStyle = '#ff8899';
            ctx.beginPath();
            ctx.arc(x, y + 7.5 * faceScale, 3.2 * faceScale, 0.15 * Math.PI, 0.85 * Math.PI, false);
            ctx.fill();

            // Smile outline
            ctx.lineWidth = 2.0 * faceScale;
            ctx.strokeStyle = '#1e1e1e';
            ctx.beginPath();
            ctx.arc(x, y + 4 * faceScale, 5.5 * faceScale, 0.1 * Math.PI, 0.9 * Math.PI, false);
            ctx.stroke();
        } else {
            // Ka: Playful energetic smile
            ctx.fillStyle = '#103055';
            ctx.beginPath();
            ctx.arc(x, y + 4 * faceScale, 5.0 * faceScale, 0.05 * Math.PI, 0.95 * Math.PI, false);
            ctx.closePath();
            ctx.fill();

            // Tongue
            ctx.fillStyle = '#ff99aa';
            ctx.beginPath();
            ctx.arc(x, y + 7.0 * faceScale, 2.8 * faceScale, 0.15 * Math.PI, 0.85 * Math.PI, false);
            ctx.fill();

            // Smile outline
            ctx.lineWidth = 2.0 * faceScale;
            ctx.strokeStyle = '#1e1e1e';
            ctx.beginPath();
            ctx.arc(x, y + 4 * faceScale, 5.0 * faceScale, 0.05 * Math.PI, 0.95 * Math.PI, false);
            ctx.stroke();
        }

        // Rosy blushing cheeks
        ctx.fillStyle = isDon ? 'rgba(255, 160, 180, 0.85)' : 'rgba(180, 225, 255, 0.85)';
        ctx.beginPath();
        ctx.arc(x - 12 * faceScale, y + 3.5 * faceScale, 3.5 * faceScale, 0, Math.PI * 2);
        ctx.arc(x + 12 * faceScale, y + 3.5 * faceScale, 3.5 * faceScale, 0, Math.PI * 2);
        ctx.fill();

        // Bold "Don" / "Ka" text beneath the note
        const noteLabel = isDon ? 'DON' : 'KA';
        const labelY = y + radius + 4;
        ctx.font = `900 ${Math.round(14 * faceScale)}px "Segoe UI", Impact, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillStyle = '#000000';
        ctx.fillText(noteLabel, x + 1, labelY + 1.5);
        ctx.fillStyle = '#ffffff';
        ctx.fillText(noteLabel, x, labelY);

        ctx.restore();
    }

    // --- LEFT PLAYER PLATE & 4-ZONE TAIKO DRUM (DF & JK) ---
    _renderPlayerPlate(laneTop, laneBot, now) {
        const ctx = this.ctx;
        const pw = this.plateWidth;

        const plateGrad = ctx.createLinearGradient(0, laneTop, pw, laneBot);
        plateGrad.addColorStop(0, '#c73838');
        plateGrad.addColorStop(1, '#8e1b1b');
        ctx.fillStyle = plateGrad;
        ctx.fillRect(0, laneTop, pw, this.laneHeight);

        ctx.strokeStyle = '#e6a15c';
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(pw, laneTop);
        ctx.lineTo(pw, laneBot);
        ctx.stroke();

        // Player Name & Course
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 15px "Segoe UI", sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText('1P Taiko', 18, laneTop + 26);

        const courseColors = {
            easy: '#50fa7b',
            normal: '#f1fa8c',
            hard: '#ffb86c',
            oni: '#ff5555',
            edit: '#bd93f9'
        };
        ctx.fillStyle = courseColors[this.courseName.toLowerCase()] || '#ff5555';
        ctx.font = 'bold 13px "Segoe UI", sans-serif';
        ctx.fillText(`${this.courseName} ★${this.level}`, 18, laneTop + 45);

        // Render the 4-zone Interactive Taiko Drum (DF on left, JK on right)
        const drumR = this.drumR || Math.min(125, this.laneHeight * 0.28);
        const drumX = this.drumX || (pw - drumR - 40);
        const drumY = this.drumY || this.laneY;

        this._render4ZoneDrum(drumX, drumY, drumR, now);

        // Combo counter displayed to the left of the drum overlay
        this._renderComboLeftOfDrum(now);

        // Score readout
        ctx.fillStyle = '#ffcc00';
        ctx.font = 'bold 26px "Segoe UI", monospace';
        ctx.textAlign = 'left';
        ctx.shadowColor = 'rgba(0, 0, 0, 0.8)';
        ctx.shadowBlur = 6;
        ctx.fillText(this.score.toLocaleString(), 18, laneBot - 18);
        ctx.shadowBlur = 0;
    }

    /**
     * Renders authentic Taiko Drum split into 4 interactive zones:
     * - Left Rim: D
     * - Left Head: F
     * - Right Head: J
     * - Right Rim: K
     */
    _render4ZoneDrum(cx, cy, r, now) {
        const ctx = this.ctx;
        const hitDuration = 100;

        const leftKaActive  = (now - this.leftKaHit  < hitDuration);
        const leftDonActive = (now - this.leftDonHit < hitDuration);
        const rightDonActive= (now - this.rightDonHit< hitDuration);
        const rightKaActive = (now - this.rightKaHit < hitDuration);

        // --- 1. OUTER RIM (Ka Area) ---
        // Left Rim (D): semicircle from PI/2 to 3*PI/2
        ctx.beginPath();
        ctx.arc(cx, cy, r, Math.PI * 0.5, Math.PI * 1.5);
        ctx.fillStyle = leftKaActive ? '#33b5e5' : '#8b5a2b';
        ctx.fill();

        // Right Rim (K): semicircle from -PI/2 to PI/2
        ctx.beginPath();
        ctx.arc(cx, cy, r, -Math.PI * 0.5, Math.PI * 0.5);
        ctx.fillStyle = rightKaActive ? '#33b5e5' : '#8b5a2b';
        ctx.fill();

        // Outer rim border
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 3;
        ctx.stroke();

        // --- 2. INNER DRUM HEAD (Don Area) ---
        const innerR = r * 0.72;

        // Left Head (F): semicircle from PI/2 to 3*PI/2
        ctx.beginPath();
        ctx.arc(cx, cy, innerR, Math.PI * 0.5, Math.PI * 1.5);
        ctx.fillStyle = leftDonActive ? '#ff4444' : '#fff4e6';
        ctx.fill();

        // Right Head (J): semicircle from -PI/2 to PI/2
        ctx.beginPath();
        ctx.arc(cx, cy, innerR, -Math.PI * 0.5, Math.PI * 0.5);
        ctx.fillStyle = rightDonActive ? '#ff4444' : '#fff4e6';
        ctx.fill();

        // Inner head border
        ctx.beginPath();
        ctx.arc(cx, cy, innerR, 0, Math.PI * 2);
        ctx.strokeStyle = '#bb9977';
        ctx.lineWidth = 2;
        ctx.stroke();

        // Center vertical divider separating Left (DF) and Right (JK)
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.35)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(cx, cy - r);
        ctx.lineTo(cx, cy + r);
        ctx.stroke();

        // Subtle key labels: D, F on left; J, K on right
        ctx.font = 'bold 11px "Segoe UI", sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        // Rim keys (D & K)
        ctx.fillStyle = leftKaActive ? '#ffffff' : 'rgba(255, 255, 255, 0.7)';
        ctx.fillText('D', cx - r * 0.86, cy);

        ctx.fillStyle = rightKaActive ? '#ffffff' : 'rgba(255, 255, 255, 0.7)';
        ctx.fillText('K', cx + r * 0.86, cy);

        // Center face keys (F & J)
        ctx.fillStyle = leftDonActive ? '#ffffff' : '#886655';
        ctx.fillText('F', cx - innerR * 0.5, cy);

        ctx.fillStyle = rightDonActive ? '#ffffff' : '#886655';
        ctx.fillText('J', cx + innerR * 0.5, cy);
    }

    // --- FLOATING RED SCORE INCREMENT POPUPS ---
    _renderScorePopups(now) {
        const ctx = this.ctx;

        for (let i = this.scorePopups.length - 1; i >= 0; i--) {
            const p = this.scorePopups[i];
            const age = (now - p.birth) / 500; // 500ms lifespan
            if (age >= 1) {
                this.scorePopups.splice(i, 1);
                continue;
            }

            const y = p.y + p.vy * age;
            const alpha = 1 - age;

            ctx.save();
            ctx.globalAlpha = alpha;
            ctx.textAlign = 'right';
            ctx.textBaseline = 'middle';

            // Bold RED font with black shadow & white outline
            ctx.font = '900 22px "Segoe UI", Impact, monospace';

            // Shadow
            ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
            ctx.fillText(p.text, p.x + 2, y + 2);

            // Red text
            ctx.fillStyle = '#ff2222';
            ctx.fillText(p.text, p.x, y);

            ctx.restore();
        }
    }

    _renderBottomArea(w, h, laneBot, now) {
        const ctx = this.ctx;
        const bpm = this.songBpm || 150;
        const beatTime = (now / 1000) * (bpm / 60);
        const beatBounce = Math.abs(Math.sin(beatTime * Math.PI));

        const isExcited = (this.combo >= 20 || this.gogoActive || this.smoothGauge >= this.clearThreshold);
        const isStruggling = (now - this.lastMissTime < 1800);

        // 1. Stage background gradient
        const nightGrad = ctx.createLinearGradient(0, laneBot, 0, h);
        nightGrad.addColorStop(0, '#0d1124');
        nightGrad.addColorStop(0.5, '#181b3a');
        nightGrad.addColorStop(1, '#221935');
        ctx.fillStyle = nightGrad;
        ctx.fillRect(0, laneBot, w, h - laneBot);

        // 2. Japanese festival stalls (屋台) in background
        const stallY = laneBot + 25;
        const stallH = Math.max(30, h - laneBot - 70);

        if (stallH > 25) {
            // Stall 1 (Takoyaki)
            const s1W = Math.min(260, w * 0.26);
            ctx.fillStyle = '#b72a2a';
            ctx.fillRect(40, stallY, s1W, 26);
            ctx.fillStyle = '#ffffff';
            ctx.font = 'bold 12px "Yu Gothic", "Segoe UI", sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('たこ焼き ★ 祭', 40 + s1W / 2, stallY + 17);

            // Stall 2 (Taikodou)
            const s2X = Math.min(320, w * 0.32);
            const s2W = Math.min(240, w * 0.24);
            ctx.fillStyle = '#df8931';
            ctx.fillRect(s2X, stallY, s2W, 26);
            ctx.fillStyle = '#ffffff';
            ctx.fillText('太鼓道場', s2X + s2W / 2, stallY + 17);

            // Festoon lanterns (提灯) strung across with warm sway - TWICE AS LARGE!
            const lanternColors = ['#ff3b3b', '#ffb700', '#ff3b3b', '#ffb700', '#ff3b3b'];
            const lanternGlows = ['rgba(255, 59, 59, 0.35)', 'rgba(255, 183, 0, 0.35)', 'rgba(255, 59, 59, 0.35)', 'rgba(255, 183, 0, 0.35)', 'rgba(255, 59, 59, 0.35)'];
            const numLanterns = Math.min(12, Math.max(5, Math.floor((w - 80) / 110)));
            for (let i = 0; i < numLanterns; i++) {
                const lx = 60 + i * ((w - 120) / Math.max(1, numLanterns - 1));
                const swing = Math.sin(now / 400 + i * 0.8) * 4;

                // Lantern string
                ctx.strokeStyle = '#555566';
                ctx.lineWidth = 1.5;
                ctx.beginPath();
                ctx.moveTo(lx, stallY - 18);
                ctx.lineTo(lx + swing, stallY - 6);
                ctx.stroke();

                // Glowing lantern (Twice as large: rx=18, ry=26)
                ctx.save();
                ctx.translate(lx + swing, stallY + 16);

                // Ambient outer glow halo (fast GPU fill, replaces slow shadowBlur)
                const haloR = isExcited ? 7 : 4;
                ctx.fillStyle = lanternGlows[i % lanternGlows.length];
                ctx.beginPath();
                ctx.ellipse(0, 0, 18 + haloR, 26 + haloR, 0, 0, Math.PI * 2);
                ctx.fill();

                // Main lantern body
                ctx.fillStyle = lanternColors[i % lanternColors.length];
                ctx.beginPath();
                ctx.ellipse(0, 0, 18, 26, 0, 0, Math.PI * 2);
                ctx.fill();

                // Inner bright warmth
                ctx.fillStyle = 'rgba(255, 255, 240, 0.5)';
                ctx.beginPath();
                ctx.ellipse(0, 0, 8, 14, 0, 0, Math.PI * 2);
                ctx.fill();

                // Lantern black caps (twice as large: w=28, h=6)
                ctx.fillStyle = '#1a1a1a';
                ctx.fillRect(-14, -28, 28, 6);
                ctx.fillRect(-14, 22, 28, 6);

                // Authentic kanji "祭" (Festival) on each lantern
                ctx.fillStyle = '#1a1a1a';
                ctx.font = '900 13px "Yu Gothic", sans-serif';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText('祭', 0, 1);

                ctx.restore();
            }
        }

        // 2b. Additive Vertical Boost from continuous physics (capped strictly so crowd never jumps too high)
        const maxBoost = Math.min(32, (h - laneBot) * 0.14);
        const boost = Math.min(maxBoost, Math.max(0, this.audienceYOffset || 0));

        // 3. Kat-chan (かっちゃん - Don-chan's blue drum twin) cheering on the stage!
        const stagePlatformY = laneBot + (h - laneBot) * 0.38 - boost * 0.55;
        const katY = stagePlatformY - (isExcited ? beatBounce * 16 : beatBounce * 8);
        this._renderKatchan(Math.min(130, w * 0.12), katY, beatBounce, isExcited, isStruggling, now);

        // 4. Dynamic Chibi Festival Dancers (踊り子) - Much larger population (32 dancers) moved downwards!
        const dancerJump = isExcited ? beatBounce * 18 : (isStruggling ? beatBounce * 4 : beatBounce * 10);
        const dancerY = stagePlatformY - dancerJump;

        // Back Row: 14 dancers (staggered, slightly higher)
        const backKimonoColors = ['#9b5de5', '#f15bb5', '#fee440', '#00bbf9', '#00f5d4', '#fb5607', '#ff006e', '#8338ec', '#ff70a6', '#70d6ff', '#ffd670', '#e9ff70', '#ff9770', '#c77dff'];
        for (let i = 0; i < 14; i++) {
            const xRatio = 0.08 + (i / 13) * 0.84;
            const dx = w * xRatio;
            if (dx < w - 20) {
                const individualOffset = Math.sin(now / 150 + i * 1.4) * 3;
                ctx.save();
                ctx.scale(0.85, 0.85);
                this._renderFestivalDancer(dx / 0.85, (dancerY - 24 + individualOffset) / 0.85, backKimonoColors[i % backKimonoColors.length], (i % 2 === 1), isExcited, isStruggling, now);
                ctx.restore();
            }
        }

        // Front Row: 18 dancers (vibrant, enthusiastic, moved downwards)
        const frontKimonoColors = ['#e63946', '#ff7b00', '#ffd000', '#00b4d8', '#52b788', '#f77f00', '#7209b7', '#2a9d8f', '#e76f51', '#d90429', '#ff007f', '#39ff14', '#00f0ff', '#ffff00', '#ff6600', '#bd93f9', '#ff3366', '#06d6a0'];
        for (let i = 0; i < 18; i++) {
            const xRatio = 0.05 + (i / 17) * 0.90;
            const dx = w * xRatio;
            if (dx < w - 15) {
                const individualOffset = Math.sin(now / 150 + i * 2) * 3;
                this._renderFestivalDancer(dx, dancerY + 8 + individualOffset, frontKimonoColors[i % frontKimonoColors.length], (i % 2 === 0), isExcited, isStruggling, now);
            }
        }

        // 5. CROWD TAKES UP HALF OF THE BOTTOM AREA - MUCH BIGGER AUDIENCE MEMBERS (3 DEEP TIERS)!
        const bottomAreaH = h - laneBot;
        const crowdTotalH = bottomAreaH * 0.50;
        const crowdTopY = h - crowdTotalH;

        const stickColors = ['#ff007f', '#00f0ff', '#39ff14', '#ffff00', '#ff4500', '#bf00ff'];
        const stickGlows = [
            'rgba(255, 0, 127, 0.45)',
            'rgba(0, 240, 255, 0.45)',
            'rgba(57, 255, 20, 0.45)',
            'rgba(255, 255, 0, 0.45)',
            'rgba(255, 69, 0, 0.45)',
            'rgba(191, 0, 255, 0.45)'
        ];

        ctx.lineCap = 'round';

        // --- TIER 1: BACK ROW OF CROWD (Depth, 22px heads, 58px penlights - BATCHED RENDERING) ---
        const numTier1 = Math.min(30, Math.floor(w / 50));
        const tier1Heads = [];
        const tier1LinesByColor = [[], [], [], [], [], []];
        const tier1BaseY = crowdTopY + crowdTotalH * 0.22 - boost * 0.85;

        for (let i = 0; i < numTier1; i++) {
            const sx = 20 + i * ((w - 40) / Math.max(1, numTier1 - 1));
            const wave = Math.sin(now / 190 + i * 1.3) * 0.45;
            const colIdx = (i * 2) % stickColors.length;
            const tipX = sx - Math.sin(wave) * 58;
            const tipY = tier1BaseY - Math.cos(wave) * 58;

            tier1LinesByColor[colIdx].push([sx, tier1BaseY, tipX, tipY]);
            tier1Heads.push({ x: sx, y: tier1BaseY });
        }

        // Fast batched glow & core strokes for Tier 1 penlights
        for (let c = 0; c < 6; c++) {
            const lines = tier1LinesByColor[c];
            if (lines.length === 0) continue;
            // Outer glow
            ctx.strokeStyle = stickGlows[c];
            ctx.lineWidth = isExcited ? 10 : 7;
            ctx.beginPath();
            for (let k = 0; k < lines.length; k++) {
                ctx.moveTo(lines[k][0], lines[k][1]);
                ctx.lineTo(lines[k][2], lines[k][3]);
            }
            ctx.stroke();

            // Core
            ctx.strokeStyle = stickColors[c];
            ctx.lineWidth = 4.2;
            ctx.beginPath();
            for (let k = 0; k < lines.length; k++) {
                ctx.moveTo(lines[k][0], lines[k][1]);
                ctx.lineTo(lines[k][2], lines[k][3]);
            }
            ctx.stroke();
        }

        // Draw Tier 1 bodies and heads batched
        ctx.fillStyle = '#06070e';
        ctx.beginPath();
        for (let i = 0; i < tier1Heads.length; i++) {
            const head = tier1Heads[i];
            ctx.moveTo(head.x + 26, head.y + 22);
            ctx.ellipse(head.x, head.y + 22, 26, 18, 0, 0, Math.PI * 2);
            ctx.moveTo(head.x + 22, head.y);
            ctx.arc(head.x, head.y, 22, 0, Math.PI * 2);
        }
        ctx.fill();

        // --- TIER 2: MIDDLE ROW OF CROWD (28px heads, 72px penlights - BATCHED RENDERING) ---
        const numTier2 = Math.min(34, Math.floor(w / 44));
        const tier2Heads = [];
        const tier2LinesByColor = [[], [], [], [], [], []];
        const tier2BaseY = crowdTopY + crowdTotalH * 0.55 - boost * 0.92;

        for (let i = 0; i < numTier2; i++) {
            const step = (w - 32) / Math.max(1, numTier2 - 1);
            const sx = 16 + i * step + (step * 0.35 * ((i % 2 === 0) ? 1 : -1));
            const wave = Math.sin(now / 210 + i * 1.2 + 0.8) * 0.42;
            const colIdx = (i + 3) % stickColors.length;
            const tipX = sx - Math.sin(wave) * 72;
            const tipY = tier2BaseY - Math.cos(wave) * 72;

            tier2LinesByColor[colIdx].push([sx, tier2BaseY, tipX, tipY]);
            tier2Heads.push({ x: sx, y: tier2BaseY });
        }

        // Fast batched glow & core strokes for Tier 2 penlights
        for (let c = 0; c < 6; c++) {
            const lines = tier2LinesByColor[c];
            if (lines.length === 0) continue;
            ctx.strokeStyle = stickGlows[c];
            ctx.lineWidth = isExcited ? 12 : 8;
            ctx.beginPath();
            for (let k = 0; k < lines.length; k++) {
                ctx.moveTo(lines[k][0], lines[k][1]);
                ctx.lineTo(lines[k][2], lines[k][3]);
            }
            ctx.stroke();

            ctx.strokeStyle = stickColors[c];
            ctx.lineWidth = 5.0;
            ctx.beginPath();
            for (let k = 0; k < lines.length; k++) {
                ctx.moveTo(lines[k][0], lines[k][1]);
                ctx.lineTo(lines[k][2], lines[k][3]);
            }
            ctx.stroke();
        }

        // Draw Tier 2 bodies and heads batched
        ctx.fillStyle = '#090a14';
        ctx.beginPath();
        for (let i = 0; i < tier2Heads.length; i++) {
            const head = tier2Heads[i];
            ctx.moveTo(head.x + 34, head.y + 26);
            ctx.ellipse(head.x, head.y + 26, 34, 24, 0, 0, Math.PI * 2);
            ctx.moveTo(head.x + 28, head.y);
            ctx.arc(head.x, head.y, 28, 0, Math.PI * 2);
        }
        ctx.fill();

        // --- TIER 3: FRONT ROW OF CROWD (HUGE 36px heads, 92px penlights - BATCHED RENDERING) ---
        const numTier3 = Math.min(38, Math.floor(w / 38));
        const tier3Heads = [];
        const tier3LinesByColor = [[], [], [], [], [], []];
        const tier3BaseY = crowdTopY + crowdTotalH * 0.88 - boost * 1.0;

        for (let i = 0; i < numTier3; i++) {
            const sx = 14 + i * ((w - 28) / Math.max(1, numTier3 - 1));
            const wave = Math.sin(now / 230 + i * 1.1 + 1.4) * 0.38;
            const colIdx = i % stickColors.length;
            const tipX = sx - Math.sin(wave) * 92;
            const tipY = tier3BaseY - Math.cos(wave) * 92;

            tier3LinesByColor[colIdx].push([sx, tier3BaseY, tipX, tipY]);
            tier3Heads.push({ x: sx, y: tier3BaseY });
        }

        // Fast batched glow & core strokes for Tier 3 penlights
        for (let c = 0; c < 6; c++) {
            const lines = tier3LinesByColor[c];
            if (lines.length === 0) continue;
            ctx.strokeStyle = stickGlows[c];
            ctx.lineWidth = isExcited ? 14 : 10;
            ctx.beginPath();
            for (let k = 0; k < lines.length; k++) {
                ctx.moveTo(lines[k][0], lines[k][1]);
                ctx.lineTo(lines[k][2], lines[k][3]);
            }
            ctx.stroke();

            ctx.strokeStyle = stickColors[c];
            ctx.lineWidth = 6.4;
            ctx.beginPath();
            for (let k = 0; k < lines.length; k++) {
                ctx.moveTo(lines[k][0], lines[k][1]);
                ctx.lineTo(lines[k][2], lines[k][3]);
            }
            ctx.stroke();
        }

        // Draw Tier 3 bodies and heads batched
        ctx.fillStyle = '#0d0e1a';
        ctx.beginPath();
        for (let i = 0; i < tier3Heads.length; i++) {
            const head = tier3Heads[i];
            ctx.moveTo(head.x + 46, head.y + 32);
            ctx.ellipse(head.x, head.y + 32, 46, 30, 0, 0, Math.PI * 2);
            ctx.moveTo(head.x + 36, head.y);
            ctx.arc(head.x, head.y, 36, 0, Math.PI * 2);
        }
        ctx.fill();

        // 6. Red & white festival curtain banner at bottom edge (紅白幕)
        const stripeH = 22;
        const stripeW = 24;
        const numStripes = Math.ceil(w / stripeW);
        for (let i = 0; i < numStripes; i++) {
            ctx.fillStyle = (i % 2 === 0) ? '#cc2222' : '#ffffff';
            ctx.fillRect(i * stripeW, h - stripeH, stripeW, stripeH);
        }
    }

    _renderKatchan(x, y, bounce, isExcited, isStruggling, now) {
        const ctx = this.ctx;
        ctx.save();
        ctx.translate(x, y);

        // Body (Sky Blue cylinder for Kat-chan)
        const bodyW = 54;
        const bodyH = 46;

        ctx.fillStyle = '#1e75b8'; // Outer rim shadow
        ctx.beginPath();
        ctx.roundRect(-bodyW / 2 - 2, -bodyH / 2 - 2, bodyW + 4, bodyH + 4, 14);
        ctx.fill();

        ctx.fillStyle = '#3ca9f5'; // Vibrant sky blue body
        ctx.beginPath();
        ctx.roundRect(-bodyW / 2, -bodyH / 2, bodyW, bodyH, 12);
        ctx.fill();

        // Red face ring border
        ctx.fillStyle = '#e63946';
        ctx.beginPath();
        ctx.ellipse(0, 0, 20, 19, 0, 0, Math.PI * 2);
        ctx.fill();

        // White drum face
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.ellipse(0, 0, 16, 15, 0, 0, Math.PI * 2);
        ctx.fill();

        // Facial expression
        if (isStruggling) {
            // Worried eyes
            ctx.fillStyle = '#222222';
            ctx.beginPath();
            ctx.arc(-6, -2, 2.5, 0, Math.PI * 2);
            ctx.arc(6, -2, 2.5, 0, Math.PI * 2);
            ctx.fill();

            // Sweat drop
            ctx.fillStyle = '#00c3ff';
            ctx.beginPath();
            ctx.arc(14, -14, 3.5, 0, Math.PI * 2);
            ctx.fill();
        } else {
            // Cheerful happy eyes (^ ^)
            ctx.strokeStyle = '#222222';
            ctx.lineWidth = 2.2;
            ctx.beginPath();
            ctx.arc(-6, -2, 4, Math.PI, Math.PI * 2);
            ctx.stroke();
            ctx.beginPath();
            ctx.arc(6, -2, 4, Math.PI, Math.PI * 2);
            ctx.stroke();

            // Open smiling mouth
            ctx.fillStyle = '#e63946';
            ctx.beginPath();
            ctx.arc(0, 3, 4, 0, Math.PI);
            ctx.fill();

            // Blushing pink cheeks
            ctx.fillStyle = 'rgba(255, 105, 180, 0.7)';
            ctx.beginPath();
            ctx.ellipse(-10, 2, 4, 2.5, 0, 0, Math.PI * 2);
            ctx.ellipse(10, 2, 4, 2.5, 0, 0, Math.PI * 2);
            ctx.fill();
        }

        // Kat-chan holding small bachi drumsticks
        const stickAngle = isExcited ? Math.sin(now / 80) * 0.6 : Math.sin(now / 150) * 0.3;
        ctx.strokeStyle = '#c48f52';
        ctx.lineWidth = 3;
        ctx.lineCap = 'round';
        ctx.save();
        ctx.translate(-24, 0);
        ctx.rotate(-0.5 + stickAngle);
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(-6, -18);
        ctx.stroke();
        ctx.restore();

        ctx.save();
        ctx.translate(24, 0);
        ctx.rotate(0.5 - stickAngle);
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(6, -18);
        ctx.stroke();
        ctx.restore();

        ctx.restore();
    }

    _renderFestivalDancer(x, y, color, hasFan, isExcited, isStruggling, now) {
        const ctx = this.ctx;
        ctx.save();
        ctx.translate(x, y);

        // Chibi head
        ctx.fillStyle = '#ffe2cd';
        ctx.beginPath();
        ctx.arc(0, -18, 11, 0, Math.PI * 2);
        ctx.fill();

        // White Hachimaki headband
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(-11, -25, 22, 5);
        ctx.fillStyle = '#e63946';
        ctx.beginPath();
        ctx.arc(0, -22.5, 2, 0, Math.PI * 2);
        ctx.fill();

        // Facial features
        if (isStruggling) {
            // Sweat drop
            ctx.fillStyle = '#00c3ff';
            ctx.beginPath();
            ctx.arc(9, -24, 3, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = '#333333';
            ctx.fillRect(-6, -18, 4, 2);
            ctx.fillRect(2, -18, 4, 2);
        } else {
            // Happy closed eyes
            ctx.strokeStyle = '#333333';
            ctx.lineWidth = 1.8;
            ctx.beginPath();
            ctx.arc(-5, -17, 3, Math.PI, 0);
            ctx.stroke();
            ctx.beginPath();
            ctx.arc(5, -17, 3, Math.PI, 0);
            ctx.stroke();

            // Rosy cheeks
            ctx.fillStyle = 'rgba(255, 90, 110, 0.6)';
            ctx.beginPath();
            ctx.arc(-8, -13, 2.5, 0, Math.PI * 2);
            ctx.arc(8, -13, 2.5, 0, Math.PI * 2);
            ctx.fill();
        }

        // Kimono / Happi coat
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.moveTo(-13, -7);
        ctx.lineTo(13, -7);
        ctx.lineTo(17, 15);
        ctx.lineTo(-17, 15);
        ctx.closePath();
        ctx.fill();

        // White obi belt
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(-14, 2, 28, 4);

        // Props: Uchiwa Fan or Lightstick
        if (hasFan) {
            const fanSway = Math.sin(now / 120) * 0.4;
            ctx.save();
            ctx.translate(14, -6);
            ctx.rotate(fanSway);
            ctx.fillStyle = '#c48f52';
            ctx.fillRect(-2, 0, 4, 16);
            ctx.fillStyle = '#ff4444';
            ctx.beginPath();
            ctx.ellipse(0, -6, 9, 8, 0, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = '#ffffff';
            ctx.font = 'bold 8px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('祭', 0, -3);
            ctx.restore();
        } else if (isExcited) {
            // Glowing dual lightsticks
            const wave = Math.sin(now / 90) * 0.5;
            ctx.strokeStyle = '#00f0ff';
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.moveTo(14, -4);
            ctx.lineTo(18 + wave * 8, -20);
            ctx.stroke();
        }

        ctx.restore();
    }

    // --- COMBO DISPLAY (Positioned to the left of the 4-zone drum overlay) ---
    _renderComboLeftOfDrum(now) {
        if (this.combo < 1) return;
        const ctx = this.ctx;
        ctx.save();

        const drumX = this.drumX || (this.plateWidth - this.drumR - 30);
        const drumR = this.drumR || 74;
        const comboX = Math.max(70, (drumX - drumR) * 0.52);
        const comboY = this.laneY;

        // Punchy bounce on hit
        const hitAge = now - (this.lastHitTime || 0);
        const bounce = (hitAge < 160) ? (1.0 + (1 - hitAge / 160) * 0.32) : 1.0;

        ctx.translate(comboX, comboY);
        ctx.scale(bounce, bounce);

        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        // Combo number
        const comboStr = this.combo.toString();
        const numSize = this.combo >= 100 ? 46 : (this.combo >= 50 ? 42 : 36);
        ctx.font = `900 ${numSize}px "Segoe UI", Impact, sans-serif`;

        // Black outline / shadow
        ctx.fillStyle = '#000000';
        ctx.fillText(comboStr, 2, 2.5);

        // Vibrant gradient: Gold / Orange / Fire
        const grad = ctx.createLinearGradient(0, -numSize / 2, 0, numSize / 2);
        if (this.combo >= 100) {
            grad.addColorStop(0, '#ffffff');
            grad.addColorStop(0.3, '#fff275');
            grad.addColorStop(0.7, '#ffaa00');
            grad.addColorStop(1, '#ff3b00');
        } else if (this.combo >= 50) {
            grad.addColorStop(0, '#ffffff');
            grad.addColorStop(0.5, '#ffdd44');
            grad.addColorStop(1, '#ff8800');
        } else {
            grad.addColorStop(0, '#ffffff');
            grad.addColorStop(1, '#ffcc00');
        }
        ctx.fillStyle = grad;
        ctx.fillText(comboStr, 0, 0);

        // Subtitle "COMBO"
        ctx.font = '900 12px "Segoe UI", Impact, sans-serif';
        ctx.fillStyle = '#000000';
        ctx.fillText('COMBO', 1, numSize * 0.50 + 2);
        ctx.fillStyle = '#ffffff';
        ctx.fillText('COMBO', 0, numSize * 0.50 + 1);

        ctx.restore();
    }

    // --- DRAMATIC BURSTY STAGE SPARKLERS & AUDIENCE CHEER BURSTS ---
    _spawnStageSparkler(now) {
        const w = this.canvas.width;
        const h = this.canvas.height;

        if (this.stageSparklers.length >= 6) {
            this.stageSparklers.shift();
        }

        const fromLeft = (Math.random() < 0.65);
        const startX = fromLeft ? (w * (0.04 + Math.random() * 0.22)) : (w * (0.75 + Math.random() * 0.20));
        const startY = h - 60;

        // Destination across the stage
        const targetX = fromLeft ? (startX + w * (0.35 + Math.random() * 0.45)) : (startX - w * (0.35 + Math.random() * 0.45));
        const flightTime = 720 + Math.random() * 260; // ms

        const vx = (targetX - startX) / (flightTime / 1000);
        // Upward fling arc across the stage
        const targetPeakY = Math.max(90, this.laneY + (this.laneHeight * 0.15) + Math.random() * 60);
        const g = 1300;
        const dy = startY - targetPeakY;
        const vy = -Math.sqrt(Math.max(200, 2 * g * dy));

        const colors = ['#ffea00', '#ff9900', '#ff3366', '#00f0ff', '#ffffff', '#39ff14'];
        const sparkler = {
            startX,
            startY,
            x: startX,
            y: startY,
            vx,
            vy,
            g,
            birth: now,
            duration: flightTime,
            color: colors[Math.floor(Math.random() * colors.length)],
            rot: Math.random() * Math.PI * 2,
            vrot: (Math.random() - 0.5) * 16,
            trail: []
        };

        this.stageSparklers.push(sparkler);
    }

    _renderStageSparklers(now) {
        const ctx = this.ctx;
        if (!this.stageSparklers || this.stageSparklers.length === 0) return;

        for (let sIdx = this.stageSparklers.length - 1; sIdx >= 0; sIdx--) {
            const sp = this.stageSparklers[sIdx];
            const elapsed = now - sp.birth;
            const t = elapsed / 1000;
            const progress = elapsed / sp.duration;

            if (progress >= 1) {
                // Finale ground/air burst of 18 sparks!
                for (let k = 0; k < 18; k++) {
                    const angle = Math.random() * Math.PI * 2;
                    const spd = 60 + Math.random() * 160;
                    this.sparkles.push({
                        x: sp.x,
                        y: sp.y,
                        vx: Math.cos(angle) * spd,
                        vy: Math.sin(angle) * spd - 40,
                        birth: now,
                        lifespan: 450 + Math.random() * 250,
                        size: 3 + Math.random() * 3,
                        color: sp.color,
                        isStar: Math.random() < 0.5,
                        rot: Math.random() * Math.PI,
                        vrot: (Math.random() - 0.5) * 8
                    });
                }
                this.stageSparklers.splice(sIdx, 1);
                continue;
            }

            // Current projectile physics
            sp.x = sp.startX + sp.vx * t;
            sp.y = sp.startY + sp.vy * t + 0.5 * sp.g * t * t;
            const curRot = sp.rot + sp.vrot * t;

            // Sparkler burning tip location
            const rodLen = 36;
            const tipX = sp.x + Math.cos(curRot) * (rodLen * 0.5);
            const tipY = sp.y + Math.sin(curRot) * (rodLen * 0.5);

            // Emit trailing sparks
            const sparkCount = 4 + Math.floor(Math.random() * 3);
            for (let i = 0; i < sparkCount; i++) {
                const spreadAngle = curRot + Math.PI + (Math.random() - 0.5) * 1.5;
                const spd = 30 + Math.random() * 90;
                sp.trail.push({
                    x: tipX,
                    y: tipY,
                    vx: Math.cos(spreadAngle) * spd - sp.vx * 0.15,
                    vy: Math.sin(spreadAngle) * spd - sp.vy * 0.15,
                    birth: now,
                    lifespan: 220 + Math.random() * 180,
                    size: 1.5 + Math.random() * 2.5,
                    color: Math.random() < 0.6 ? '#ffffff' : sp.color
                });
            }

            // Render and update trail sparks
            for (let i = sp.trail.length - 1; i >= 0; i--) {
                const tr = sp.trail[i];
                const trAge = (now - tr.birth) / tr.lifespan;
                if (trAge >= 1) {
                    sp.trail.splice(i, 1);
                    continue;
                }
                const trT = (now - tr.birth) / 1000;
                const tx = tr.x + tr.vx * trT;
                const ty = tr.y + tr.vy * trT + 300 * trT * trT; // subtle gravity on sparks
                const trAlpha = 1 - trAge;

                ctx.save();
                ctx.globalAlpha = trAlpha;
                ctx.fillStyle = tr.color;
                ctx.beginPath();
                ctx.arc(tx, ty, Math.max(0.5, tr.size * (1 - trAge * 0.5)), 0, Math.PI * 2);
                ctx.fill();
                ctx.restore();
            }

            // Draw spinning sparkler rod
            ctx.save();
            ctx.translate(sp.x, sp.y);
            ctx.rotate(curRot);

            // Handle (bamboo/metallic stick)
            ctx.strokeStyle = '#c5c7d0';
            ctx.lineWidth = 2.5;
            ctx.lineCap = 'round';
            ctx.beginPath();
            ctx.moveTo(-rodLen * 0.5, 0);
            ctx.lineTo(rodLen * 0.5, 0);
            ctx.stroke();

            // Incandescent burning coating
            ctx.strokeStyle = '#6e7078';
            ctx.lineWidth = 3.5;
            ctx.beginPath();
            ctx.moveTo(-rodLen * 0.1, 0);
            ctx.lineTo(rodLen * 0.5, 0);
            ctx.stroke();

            // Blazing burning tip flare (star spikes & bright halo)
            ctx.translate(rodLen * 0.5, 0);

            // Outer radiant aura
            ctx.fillStyle = sp.color;
            ctx.globalAlpha = 0.5;
            ctx.beginPath();
            ctx.arc(0, 0, 9 + Math.sin(now / 20) * 3, 0, Math.PI * 2);
            ctx.fill();

            // Core hot white incandescent center
            ctx.fillStyle = '#ffffff';
            ctx.globalAlpha = 0.95;
            ctx.beginPath();
            ctx.arc(0, 0, 4.5, 0, Math.PI * 2);
            ctx.fill();

            // Sizzling cross flare spikes
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 2;
            const spikeR = 12 + Math.random() * 6;
            ctx.beginPath();
            ctx.moveTo(-spikeR, 0); ctx.lineTo(spikeR, 0);
            ctx.moveTo(0, -spikeR); ctx.lineTo(0, spikeR);
            ctx.stroke();

            ctx.restore();
        }
    }

    _spawnAudienceCheerBurst(now) {
        const w = this.canvas.width;
        const h = this.canvas.height;
        const count = 18;
        const colors = ['#ff007f', '#00f0ff', '#39ff14', '#ffff00', '#ff6600', '#bd93f9', '#ffffff'];

        for (let i = 0; i < count; i++) {
            const rx = w * (0.05 + Math.random() * 0.90);
            const ry = h - 30 - Math.random() * 40;
            const spd = 120 + Math.random() * 180;
            const angle = -Math.PI * 0.5 + (Math.random() - 0.5) * 1.2;

            this.audienceBursts.push({
                x: rx,
                y: ry,
                vx: Math.cos(angle) * spd,
                vy: Math.sin(angle) * spd,
                g: 380,
                color: colors[Math.floor(Math.random() * colors.length)],
                birth: now,
                duration: 550 + Math.random() * 350,
                w: 6 + Math.random() * 6,
                h: 4 + Math.random() * 4,
                rot: Math.random() * Math.PI,
                vrot: (Math.random() - 0.5) * 14
            });
        }
    }

    _renderAudienceBursts(now) {
        const ctx = this.ctx;
        if (!this.audienceBursts || this.audienceBursts.length === 0) return;

        for (let i = this.audienceBursts.length - 1; i >= 0; i--) {
            const b = this.audienceBursts[i];
            const age = (now - b.birth) / b.duration;
            if (age >= 1) {
                this.audienceBursts.splice(i, 1);
                continue;
            }

            const t = (now - b.birth) / 1000;
            const curX = b.x + b.vx * t;
            const curY = b.y + b.vy * t + 0.5 * b.g * t * t;
            const curRot = b.rot + b.vrot * t;
            const alpha = 1 - Math.pow(age, 2);

            ctx.save();
            ctx.globalAlpha = alpha;
            ctx.translate(curX, curY);
            ctx.rotate(curRot);

            ctx.fillStyle = b.color;
            ctx.fillRect(-b.w / 2, -b.h / 2, b.w, b.h);

            ctx.restore();
        }
    }

    // --- DRAMATIC STAGE STARBURSTS & PYROTECHNICS ---
    _spawnStageStarburst(now) {
        const w = this.canvas.width;
        const h = this.canvas.height;
        const laneBot = this.laneY + this.laneHeight / 2;
        const bottomH = h - laneBot;

        if (!this.stageStarbursts) this.stageStarbursts = [];
        if (this.stageStarbursts.length >= 12) {
            this.stageStarbursts.shift();
        }

        // Cannon origin positions: Left flank, center stage, or right flank
        const flank = Math.random();
        let ox, oy;
        if (flank < 0.35) {
            ox = w * (0.08 + Math.random() * 0.16);
            oy = laneBot + bottomH * (0.26 + Math.random() * 0.22);
        } else if (flank < 0.70) {
            ox = w * (0.42 + Math.random() * 0.16);
            oy = laneBot + bottomH * (0.18 + Math.random() * 0.22);
        } else {
            ox = w * (0.76 + Math.random() * 0.18);
            oy = laneBot + bottomH * (0.26 + Math.random() * 0.22);
        }

        const palettes = [
            ['#ffe600', '#ff0055', '#ff9900', '#ffffff'], // Gold-Ruby
            ['#00f0ff', '#39ff14', '#0077ff', '#ffffff'], // Cyber-Emerald
            ['#ff007f', '#b388ff', '#ffea00', '#ffffff'], // Neon Festival
            ['#ff3300', '#ffcc00', '#ffffff', '#ff00aa']  // Sunset Fire
        ];
        const colors = palettes[Math.floor(Math.random() * palettes.length)];

        // Generate radial starburst rays and diamond flares
        const numRays = 18 + Math.floor(Math.random() * 8);
        const rays = [];
        const baseSpeed = 160 + Math.random() * 140;
        for (let i = 0; i < numRays; i++) {
            const angle = (i / numRays) * Math.PI * 2 + (Math.random() - 0.5) * 0.25;
            const speed = baseSpeed * (0.65 + Math.random() * 0.7);
            rays.push({
                vx: Math.cos(angle) * speed,
                vy: Math.sin(angle) * speed,
                color: colors[i % colors.length],
                len: 12 + Math.random() * 16,
                isStar: (i % 2 === 0),
                size: 2.5 + Math.random() * 2.5
            });
        }

        this.stageStarbursts.push({
            x: ox,
            y: oy,
            birth: now,
            duration: 650 + Math.random() * 200,
            rays,
            primaryColor: colors[0],
            secondaryColor: colors[1],
            flareSize: 42 + Math.random() * 24
        });
    }

    _renderStageStarbursts(now) {
        const ctx = this.ctx;
        if (!this.stageStarbursts || this.stageStarbursts.length === 0) return;

        for (let idx = this.stageStarbursts.length - 1; idx >= 0; idx--) {
            const sb = this.stageStarbursts[idx];
            const elapsed = now - sb.birth;
            const progress = elapsed / sb.duration;
            if (progress >= 1.0) {
                this.stageStarbursts.splice(idx, 1);
                continue;
            }

            const alpha = Math.max(0, 1 - Math.pow(progress, 1.8));
            const t = elapsed / 1000;

            ctx.save();
            ctx.globalAlpha = alpha;

            // 1. Central radiant flash & diamond core
            if (progress < 0.45) {
                const flashAlpha = (1 - progress / 0.45) * 0.85;
                ctx.save();
                ctx.globalAlpha = flashAlpha;
                ctx.translate(sb.x, sb.y);
                const fSize = sb.flareSize * (1 + progress * 1.5);
                ctx.strokeStyle = '#ffffff';
                ctx.lineWidth = 4;
                ctx.beginPath();
                ctx.moveTo(-fSize, 0); ctx.lineTo(fSize, 0);
                ctx.moveTo(0, -fSize); ctx.lineTo(0, fSize);
                ctx.stroke();

                ctx.strokeStyle = sb.primaryColor;
                ctx.lineWidth = 2.5;
                const diagSize = fSize * 0.65;
                ctx.beginPath();
                ctx.moveTo(-diagSize, -diagSize); ctx.lineTo(diagSize, diagSize);
                ctx.moveTo(diagSize, -diagSize); ctx.lineTo(-diagSize, diagSize);
                ctx.stroke();

                ctx.fillStyle = '#ffffff';
                ctx.beginPath();
                ctx.arc(0, 0, 7 * (1 - progress), 0, Math.PI * 2);
                ctx.fill();
                ctx.restore();
            }

            // 2. Radial explosive spark rays & flying diamond stars
            ctx.save();
            ctx.translate(sb.x, sb.y);
            const gravity = 220;
            for (let i = 0; i < sb.rays.length; i++) {
                const r = sb.rays[i];
                const rx = r.vx * t;
                const ry = r.vy * t + 0.5 * gravity * t * t;

                if (r.isStar) {
                    ctx.save();
                    ctx.translate(rx, ry);
                    ctx.rotate(progress * 12 + i);
                    ctx.fillStyle = r.color;
                    ctx.beginPath();
                    const s = r.size * (1 - progress * 0.5);
                    ctx.moveTo(0, -s * 2.2);
                    ctx.lineTo(s * 0.8, -s * 0.8);
                    ctx.lineTo(s * 2.2, 0);
                    ctx.lineTo(s * 0.8, s * 0.8);
                    ctx.lineTo(0, s * 2.2);
                    ctx.lineTo(-s * 0.8, s * 0.8);
                    ctx.lineTo(-s * 2.2, 0);
                    ctx.lineTo(-s * 0.8, -s * 0.8);
                    ctx.closePath();
                    ctx.fill();
                    ctx.restore();
                } else {
                    const tailX = rx - (r.vx * 0.04);
                    const tailY = ry - (r.vy * 0.04);
                    ctx.strokeStyle = r.color;
                    ctx.lineWidth = r.size;
                    ctx.beginPath();
                    ctx.moveTo(tailX, tailY);
                    ctx.lineTo(rx, ry);
                    ctx.stroke();

                    ctx.fillStyle = '#ffffff';
                    ctx.beginPath();
                    ctx.arc(rx, ry, r.size * 0.8, 0, Math.PI * 2);
                    ctx.fill();
                }
            }
            ctx.restore();

            ctx.restore();
        }
    }

    // --- COOL FESTIVAL DRAGON (RYŪ) FLYING THROUGH CROWD DOING LOOPS ---
    _spawnFestivalDragon(now) {
        if (this.activeDragon && (now - this.activeDragon.birth) < this.activeDragon.duration) {
            return;
        }

        const fromLeft = (Math.random() < 0.5);
        this.lastDragonTime = now;
        this.activeDragon = {
            birth: now,
            duration: 4200,
            fromLeft,
            loopProgressStart: 0.30,
            loopProgressEnd: 0.68,
            loopRx: 145,
            loopRy: 95,
            wisps: []
        };
    }

    _renderFestivalDragon(now, w, h, laneBot) {
        const ctx = this.ctx;
        if (!this.activeDragon) return;

        const d = this.activeDragon;
        const elapsed = now - d.birth;
        const progress = elapsed / d.duration;

        if (progress >= 1.06) {
            this.activeDragon = null;
            return;
        }

        const bottomAreaH = h - laneBot;
        const crowdMidY = laneBot + bottomAreaH * 0.54;

        // Parametric trajectory function for dragon head & trailing body segments
        const getDragonPos = (p) => {
            const clampedP = Math.max(0, Math.min(1, p));
            const startX = d.fromLeft ? -130 : (w + 130);
            const endX = d.fromLeft ? (w + 150) : -150;
            const linearX = startX + (endX - startX) * clampedP;

            // Sinuous undulating baseline
            const undulateY = Math.sin(clampedP * 14 + now * 0.005) * 20;
            let finalX = linearX;
            let finalY = crowdMidY + undulateY;

            // 360-degree loop through the crowd!
            if (clampedP >= d.loopProgressStart && clampedP <= d.loopProgressEnd) {
                const loopP = (clampedP - d.loopProgressStart) / (d.loopProgressEnd - d.loopProgressStart);
                const angle = loopP * Math.PI * 2;
                const dir = d.fromLeft ? 1 : -1;
                finalX = linearX - dir * Math.sin(angle) * d.loopRx;
                finalY = crowdMidY - (1 - Math.cos(angle)) * d.loopRy;
            }

            return [finalX, finalY];
        };

        // Fire/sparkle wisps emitted by the dragon (capped strictly to 20 for silky-smooth performance)
        if (progress <= 1.0 && d.wisps.length < 20 && Math.random() < 0.65) {
            const [hx, hy] = getDragonPos(progress);
            d.wisps.push({
                x: hx + (Math.random() - 0.5) * 25,
                y: hy + (Math.random() - 0.5) * 25,
                vx: (Math.random() - 0.5) * 50,
                vy: (Math.random() - 0.5) * 50 - 25,
                birth: now,
                duration: 350 + Math.random() * 200,
                color: (Math.random() < 0.5) ? '#ffea00' : '#ff0055',
                size: 4 + Math.random() * 5
            });
        }

        // Render wisps efficiently
        for (let i = d.wisps.length - 1; i >= 0; i--) {
            const wisp = d.wisps[i];
            const wAge = (now - wisp.birth) / wisp.duration;
            if (wAge >= 1) {
                d.wisps.splice(i, 1);
                continue;
            }
            const wt = (now - wisp.birth) / 1000;
            const wx = wisp.x + wisp.vx * wt;
            const wy = wisp.y + wisp.vy * wt;
            ctx.save();
            ctx.globalAlpha = (1 - wAge) * 0.85;
            ctx.fillStyle = wisp.color;
            ctx.beginPath();
            ctx.arc(wx, wy, wisp.size * (1 - wAge * 0.5), 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
        }

        // 26 dragon body segments - MUCH BIGGER (38px radius) AND FLASHIER!
        const numSegments = 26;
        const segmentSpacing = 0.009;

        ctx.save();
        for (let k = numSegments - 1; k >= 0; k--) {
            const segP = progress - k * segmentSpacing;
            if (segP < 0 || segP > 1) continue;

            const [sx, sy] = getDragonPos(segP);
            const [nextX, nextY] = getDragonPos(segP + 0.005);
            const ang = Math.atan2(nextY - sy, nextX - sx);

            const taper = 1 - (k / numSegments) * 0.55;
            const r = 38 * taper; // BIGGER DRAGON BODY!

            ctx.save();
            ctx.translate(sx, sy);
            ctx.rotate(ang);

            if (k === numSegments - 1) {
                // Giant tri-forked blazing festival flame tail!
                ctx.fillStyle = '#ffbe0b';
                ctx.beginPath();
                ctx.moveTo(-12, 0);
                ctx.lineTo(-54, -22);
                ctx.lineTo(-38, -6);
                ctx.lineTo(-64, 0);
                ctx.lineTo(-38, 6);
                ctx.lineTo(-54, 22);
                ctx.closePath();
                ctx.fill();

                ctx.fillStyle = '#ff0054';
                ctx.beginPath();
                ctx.moveTo(-10, 0);
                ctx.lineTo(-36, -12);
                ctx.lineTo(-26, -3);
                ctx.lineTo(-44, 0);
                ctx.lineTo(-26, 3);
                ctx.lineTo(-36, 12);
                ctx.closePath();
                ctx.fill();
            } else {
                // Radiant outer aura glow
                ctx.fillStyle = (k % 2 === 0) ? 'rgba(255, 230, 0, 0.45)' : 'rgba(0, 240, 255, 0.45)';
                ctx.beginPath();
                ctx.ellipse(0, 0, r * 1.35, r * 1.18, 0, 0, Math.PI * 2);
                ctx.fill();

                // Glowing golden scale rim
                ctx.fillStyle = '#ffbe0b';
                ctx.beginPath();
                ctx.ellipse(0, 0, r * 1.12, r * 0.98, 0, 0, Math.PI * 2);
                ctx.fill();

                // Crimson imperial scale with flashing variety
                ctx.fillStyle = (k % 3 === 0) ? '#ff0054' : ((k % 2 === 0) ? '#d90429' : '#ef233c');
                ctx.beginPath();
                ctx.ellipse(0, 0, r, r * 0.85, 0, 0, Math.PI * 2);
                ctx.fill();

                // Electric dorsal spine crest
                ctx.fillStyle = '#ffee32';
                ctx.beginPath();
                ctx.moveTo(-4, -r * 0.84);
                ctx.lineTo(0, -r * 1.85);
                ctx.lineTo(5, -r * 0.84);
                ctx.closePath();
                ctx.fill();

                // Cream white belly plate (腹甲)
                ctx.fillStyle = '#fff4cc';
                ctx.beginPath();
                ctx.ellipse(0, r * 0.42, r * 0.68, r * 0.38, 0, 0, Math.PI * 2);
                ctx.fill();
            }

            ctx.restore();
        }
        ctx.restore();

        // Giant Dragon Head (at segment 0) - FLASHIER & MUCH BIGGER!
        if (progress >= 0 && progress <= 1) {
            const [hx, hy] = getDragonPos(progress);
            const [frontX, frontY] = getDragonPos(progress + 0.005);
            const headAng = Math.atan2(frontY - hy, frontX - hx);

            ctx.save();
            ctx.translate(hx, hy);
            ctx.rotate(headAng);

            // Giant Flaming Pearl of Wisdom (宝珠 - Hōju) floating ahead of snout!
            const pearlX = 64;
            const pearlY = Math.sin(now * 0.012) * 8;
            ctx.save();
            ctx.translate(pearlX, pearlY);
            ctx.rotate(now * 0.006);

            // Pearl flame aura & solar corona petals
            ctx.fillStyle = 'rgba(255, 190, 11, 0.45)';
            ctx.beginPath();
            ctx.arc(0, 0, 24, 0, Math.PI * 2);
            ctx.fill();

            // Swirling flame ribbons around pearl
            ctx.strokeStyle = '#ffee32';
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.arc(0, 0, 18, 0, Math.PI * 1.4);
            ctx.stroke();

            // Glowing cyan & white celestial core
            ctx.fillStyle = '#00f0ff';
            ctx.beginPath();
            ctx.arc(0, 0, 14, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = '#ffffff';
            ctx.beginPath();
            ctx.arc(-3, -3, 6, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();

            // Giant Dragon Flame Mane (Flamboyant golden & ruby ribbons)
            ctx.fillStyle = '#ffbe0b';
            ctx.beginPath();
            ctx.moveTo(-16, -26);
            ctx.lineTo(-42, -38);
            ctx.lineTo(-26, -12);
            ctx.lineTo(-48, -6);
            ctx.lineTo(-26, 4);
            ctx.lineTo(-44, 18);
            ctx.lineTo(-24, 20);
            ctx.lineTo(-36, 34);
            ctx.lineTo(-12, 24);
            ctx.closePath();
            ctx.fill();

            // Giant Dragon Golden Antlers / Horns (角)
            ctx.fillStyle = '#ffeaa7';
            ctx.strokeStyle = '#d63031';
            ctx.lineWidth = 2.2;

            // Left horn
            ctx.beginPath();
            ctx.moveTo(-10, -20);
            ctx.quadraticCurveTo(-26, -46, -48, -44);
            ctx.quadraticCurveTo(-30, -34, -18, -24);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();

            // Right horn
            ctx.beginPath();
            ctx.moveTo(4, -20);
            ctx.quadraticCurveTo(-12, -50, -34, -50);
            ctx.quadraticCurveTo(-16, -38, -6, -24);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();

            // Big Dragon Head Base (Snout & Brow - 36px x 26px)
            ctx.fillStyle = '#d90429';
            ctx.beginPath();
            ctx.ellipse(8, 0, 34, 24, 0, 0, Math.PI * 2);
            ctx.fill();

            // Jade / Emerald Snout Bridge
            ctx.fillStyle = '#06d6a0';
            ctx.beginPath();
            ctx.ellipse(22, 0, 18, 15, 0, 0, Math.PI * 2);
            ctx.fill();

            // Nostrils
            ctx.fillStyle = '#2b2d42';
            ctx.beginPath();
            ctx.arc(32, -6, 3.5, 0, Math.PI * 2);
            ctx.arc(32, 6, 3.5, 0, Math.PI * 2);
            ctx.fill();

            // Sharp White Dragon Fangs
            ctx.fillStyle = '#ffffff';
            ctx.beginPath();
            ctx.moveTo(18, -12); ctx.lineTo(24, -6); ctx.lineTo(28, -12);
            ctx.moveTo(18, 12); ctx.lineTo(24, 6); ctx.lineTo(28, 12);
            ctx.fill();

            // Piercing Glowing Golden Dragon Eyes
            ctx.fillStyle = '#ffee32';
            ctx.beginPath();
            ctx.ellipse(4, -12, 9, 6.5, -0.2, 0, Math.PI * 2);
            ctx.ellipse(4, 12, 9, 6.5, 0.2, 0, Math.PI * 2);
            ctx.fill();

            // Glowing Pupils
            ctx.fillStyle = '#000000';
            ctx.beginPath();
            ctx.ellipse(5, -12, 3.5, 5, 0, 0, Math.PI * 2);
            ctx.ellipse(5, 12, 3.5, 5, 0, 0, Math.PI * 2);
            ctx.fill();

            // Long Undulating Imperial Whiskers (85px length)
            const whiskerWave1 = Math.sin(now * 0.01) * 9;
            const whiskerWave2 = Math.cos(now * 0.01) * 9;
            ctx.strokeStyle = '#ffee32';
            ctx.lineWidth = 4;
            ctx.lineCap = 'round';

            // Upper whisker
            ctx.beginPath();
            ctx.moveTo(26, -6);
            ctx.bezierCurveTo(42, -22, 58, -10 + whiskerWave1, 78, -26 + whiskerWave2);
            ctx.stroke();

            // Lower whisker
            ctx.beginPath();
            ctx.moveTo(26, 6);
            ctx.bezierCurveTo(42, 22, 58, 10 - whiskerWave1, 78, 26 - whiskerWave2);
            ctx.stroke();

            ctx.restore();
        }
    }

    // --- LARGE FAT HORN PLAYERS POPPING INTO CROWD (LOUD HORN NOISES!) ---
    // --- LARGE FAT HORN PLAYERS RUNNING THROUGH CROWD & DOING A LARGE LEAP (REAL HORN!) ---
    _spawnHornPlayer(now) {
        if (!this.hornPlayers) this.hornPlayers = [];
        if (this.hornPlayers.length >= 2) return; // limit concurrent runners

        const w = this.canvas.width;
        this.lastHornPlayerTime = now;
        const fromLeft = (Math.random() < 0.5);
        const variant = Math.floor(Math.random() * 4);

        this.hornPlayers.push({
            fromLeft,
            startX: fromLeft ? -110 : (w + 110),
            endX: fromLeft ? (w + 130) : -130,
            birth: now,
            duration: 2500, // 2.5s run across crowd
            leapStart: 0.30,
            leapEnd: 0.70,
            variant,
            blasted: false,
            shockwaves: [],
            notes: []
        });
    }

    _renderHornPlayers(now, w, h, laneBot) {
        const ctx = this.ctx;
        if (!this.hornPlayers || this.hornPlayers.length === 0) return;

        const bottomAreaH = h - laneBot;
        const crowdGroundY = h - bottomAreaH * 0.18; // Ground level in front crowd

        for (let idx = this.hornPlayers.length - 1; idx >= 0; idx--) {
            const hp = this.hornPlayers[idx];
            const elapsed = now - hp.birth;
            const p = elapsed / hp.duration;

            if (p >= 1.0) {
                this.hornPlayers.splice(idx, 1);
                continue;
            }

            // 1. Horizontal traversal across crowd
            const curX = hp.startX + (hp.endX - hp.startX) * p;

            // 2. Vertical position: Running on ground vs LARGE LEAP IN THE AIR!
            let curY = crowdGroundY;
            let isLeaping = false;
            let leapU = 0;

            if (p < hp.leapStart || p > hp.leapEnd) {
                // Running waddle bounce
                const runBob = Math.abs(Math.sin(elapsed / 55)) * 14;
                curY = crowdGroundY - runBob;
            } else {
                // LARGE LEAP IN THE AIR!
                isLeaping = true;
                leapU = (p - hp.leapStart) / (hp.leapEnd - hp.leapStart);
                const leapH = Math.sin(leapU * Math.PI) * 140; // Huge 140px leap!
                curY = crowdGroundY - leapH;
            }

            // 3. Trigger authentic horn sound at apex of the leap (quieter, volume 0.45)
            if (isLeaping && leapU >= 0.45 && !hp.blasted) {
                hp.blasted = true;
                if (window.soundManager) {
                    window.soundManager.playHorn(hp.variant, 0.45);
                }
                for (let k = 0; k < 4; k++) {
                    hp.shockwaves.push({ birth: now + k * 70, duration: 460 });
                }
                const noteSymbols = ['♪', '♫', '♩', '♬', '🎺'];
                const noteColors = ['#ff0055', '#ffea00', '#00f0ff', '#39ff14', '#ffffff', '#ff7700'];
                for (let k = 0; k < 6; k++) {
                    hp.notes.push({
                        symbol: noteSymbols[k % noteSymbols.length],
                        color: noteColors[Math.floor(Math.random() * noteColors.length)],
                        birth: now + k * 50,
                        duration: 800,
                        vx: 40 + Math.random() * 55,
                        vy: -(65 + Math.random() * 70)
                    });
                }
            }

            ctx.save();
            ctx.translate(curX, curY);
            // Flip runner so they face forward in their running direction
            if (!hp.fromLeft) {
                ctx.scale(-1, 1);
            }

            const cheekPuff = isLeaping ? (1.3 + Math.sin(now / 50) * 0.25) : 0.6;

            // --- RUNNING / LEAPING LEGS ---
            ctx.fillStyle = '#0a0d1a';
            if (isLeaping) {
                // Mid-air leap pose: trailing back leg and tucked front knee
                ctx.beginPath();
                ctx.ellipse(-24, 30, 16, 10, 0.4, 0, Math.PI * 2); // trailing leg
                ctx.ellipse(18, 28, 14, 11, -0.5, 0, Math.PI * 2); // front tucked knee
                ctx.fill();
                // Little white festival tabi socks
                ctx.fillStyle = '#ffffff';
                ctx.beginPath();
                ctx.ellipse(-34, 34, 9, 6, 0.3, 0, Math.PI * 2);
                ctx.ellipse(28, 32, 9, 6, -0.4, 0, Math.PI * 2);
                ctx.fill();
            } else {
                // Running alternating legs
                const legSwing = Math.sin(elapsed / 55) * 16;
                ctx.beginPath();
                ctx.ellipse(-14, 34 + legSwing, 12, 10, 0, 0, Math.PI * 2);
                ctx.ellipse(14, 34 - legSwing, 12, 10, 0, 0, Math.PI * 2);
                ctx.fill();
                // Tabi socks
                ctx.fillStyle = '#ffffff';
                ctx.beginPath();
                ctx.ellipse(-16, 42 + legSwing, 8, 5, 0, 0, Math.PI * 2);
                ctx.ellipse(16, 42 - legSwing, 8, 5, 0, 0, Math.PI * 2);
                ctx.fill();
            }

            // --- LARGE CHUBBY BODY & JIGGLY BELLY ---
            const tummyWobble = isLeaping ? 0 : Math.sin(elapsed / 45) * 3;

            // Dark under-tunic / body silhouette
            ctx.fillStyle = '#080a14';
            ctx.beginPath();
            ctx.ellipse(0, 18, 44, 35, 0, 0, Math.PI * 2);
            ctx.fill();

            // Open festival Happi coat (法被) fluttering
            ctx.fillStyle = '#1e3a8a';
            ctx.beginPath();
            ctx.ellipse(-18, 16, 26, 32, -0.3, 0, Math.PI * 2);
            ctx.ellipse(18, 16, 26, 32, 0.3, 0, Math.PI * 2);
            ctx.fill();

            // Big chubby round bare belly in the middle!
            ctx.fillStyle = '#ffd8b3';
            ctx.beginPath();
            ctx.ellipse(4, 20 + tummyWobble, 24, 23, 0, 0, Math.PI * 2);
            ctx.fill();
            // Navel
            ctx.fillStyle = '#d49b70';
            ctx.beginPath();
            ctx.arc(4, 25 + tummyWobble, 2.5, 0, Math.PI * 2);
            ctx.fill();

            // Chubby arms holding brass horn forward
            ctx.fillStyle = '#ffd8b3';
            ctx.beginPath();
            ctx.ellipse(-18, 4, 15, 11, -0.5, 0, Math.PI * 2);
            ctx.ellipse(22, -2, 18, 12, 0.4, 0, Math.PI * 2);
            ctx.fill();

            // --- LARGE CHUBBY HEAD & PUFFED BALLOON CHEEKS ---
            ctx.fillStyle = '#ffd8b3';
            ctx.beginPath();
            ctx.arc(4, -18, 25, 0, Math.PI * 2);
            ctx.fill();

            // Puffed-out cheeks
            ctx.fillStyle = '#ffb3a7';
            ctx.beginPath();
            ctx.ellipse(-16 * (cheekPuff * 0.8), -14, 15 * cheekPuff, 12 * cheekPuff, -0.2, 0, Math.PI * 2);
            ctx.ellipse(22 * (cheekPuff * 0.8), -14, 15 * cheekPuff, 12 * cheekPuff, 0.2, 0, Math.PI * 2);
            ctx.fill();

            // Festival Hachimaki (鉢巻) with flowing tails fluttering backwards
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 5.5;
            ctx.beginPath();
            ctx.moveTo(-20, -32);
            ctx.quadraticCurveTo(4, -38, 28, -32);
            ctx.stroke();

            ctx.strokeStyle = '#e63946';
            ctx.lineWidth = 2.8;
            ctx.setLineDash([6, 6]);
            ctx.beginPath();
            ctx.moveTo(-20, -32);
            ctx.quadraticCurveTo(4, -38, 28, -32);
            ctx.stroke();
            ctx.setLineDash([]);

            // Headband knot & fluttering tail trailing behind runner
            ctx.fillStyle = '#ffffff';
            ctx.beginPath();
            ctx.ellipse(-26, -34, 6, 8, -0.4, 0, Math.PI * 2);
            ctx.fill();
            const tailFlutter = Math.sin(now / 40) * 8;
            ctx.beginPath();
            ctx.moveTo(-26, -34);
            ctx.quadraticCurveTo(-46, -42 + tailFlutter, -58, -36 + tailFlutter);
            ctx.lineWidth = 4;
            ctx.strokeStyle = '#ffffff';
            ctx.stroke();

            // Squeezed joyous eyes
            ctx.strokeStyle = '#331a00';
            ctx.lineWidth = 3.2;
            ctx.lineCap = 'round';
            if (isLeaping) {
                // >< Squeezed energetic leap eyes
                ctx.beginPath();
                ctx.moveTo(-10, -22); ctx.lineTo(-4, -19); ctx.lineTo(-10, -16);
                ctx.moveTo(14, -19); ctx.lineTo(20, -22);
                ctx.moveTo(14, -19); ctx.lineTo(20, -16);
                ctx.stroke();
            } else {
                // ^^ Smiling running eyes
                ctx.beginPath();
                ctx.arc(-6, -21, 5, Math.PI * 1.1, Math.PI * 1.9);
                ctx.arc(14, -21, 5, Math.PI * 1.1, Math.PI * 1.9);
                ctx.stroke();
            }

            // --- GOLDEN BRASS HORN / TRUMPET ---
            const hornBellX = 56;
            const hornBellY = -42;

            ctx.save();
            ctx.translate(12, -14); // mouth position
            ctx.rotate(-0.52);     // pointed upward & forward

            // Conical brass tubing
            ctx.strokeStyle = '#ffb703';
            ctx.lineWidth = 7;
            ctx.beginPath();
            ctx.moveTo(0, 0);
            ctx.lineTo(52, 0);
            ctx.stroke();

            // Golden valves
            ctx.fillStyle = '#ffd166';
            ctx.fillRect(20, -11, 4, 11);
            ctx.fillRect(28, -11, 4, 11);
            ctx.fillRect(36, -11, 4, 11);

            // Flared golden horn bell
            ctx.fillStyle = '#ffbe0b';
            ctx.beginPath();
            ctx.moveTo(46, -4);
            ctx.lineTo(66, -18);
            ctx.lineTo(66, 18);
            ctx.lineTo(46, 4);
            ctx.closePath();
            ctx.fill();

            // Inner bell depth
            ctx.fillStyle = '#d48b00';
            ctx.beginPath();
            ctx.ellipse(66, 0, 4.5, 18, 0, 0, Math.PI * 2);
            ctx.fill();

            // Gleaming rim highlight
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 2.5;
            ctx.beginPath();
            ctx.arc(66, 0, 16, -Math.PI * 0.45, Math.PI * 0.15);
            ctx.stroke();

            ctx.restore();

            // --- EXPANDING SOUND SHOCKWAVES AT APEX OF LEAP ---
            for (let sIdx = hp.shockwaves.length - 1; sIdx >= 0; sIdx--) {
                const sw = hp.shockwaves[sIdx];
                if (now < sw.birth) continue;
                const swAge = (now - sw.birth) / sw.duration;
                if (swAge >= 1.0) {
                    hp.shockwaves.splice(sIdx, 1);
                    continue;
                }
                const swR = 16 + swAge * 75;
                const swAlpha = (1 - swAge) * 0.85;

                ctx.save();
                ctx.globalAlpha = swAlpha;
                ctx.strokeStyle = (hp.variant % 2 === 0) ? '#ffea00' : '#00f0ff';
                ctx.lineWidth = 4.5 * (1 - swAge * 0.5);
                ctx.beginPath();
                ctx.arc(hornBellX, hornBellY, swR, -Math.PI * 0.65, Math.PI * 0.35);
                ctx.stroke();
                ctx.restore();
            }

            // --- FLOATING MUSICAL NOTES IN AIR ---
            for (let nIdx = hp.notes.length - 1; nIdx >= 0; nIdx--) {
                const note = hp.notes[nIdx];
                if (now < note.birth) continue;
                const nAge = (now - note.birth) / note.duration;
                if (nAge >= 1.0) {
                    hp.notes.splice(nIdx, 1);
                    continue;
                }
                const nt = (now - note.birth) / 1000;
                const nx = hornBellX + note.vx * nt + Math.sin(nt * 8) * 10;
                const ny = hornBellY + note.vy * nt;

                ctx.save();
                ctx.globalAlpha = 1 - nAge;
                ctx.fillStyle = note.color;
                ctx.font = 'bold 26px sans-serif';
                ctx.fillText(note.symbol, nx, ny);
                ctx.restore();
            }

            ctx.restore();
        }
    }

    _spawnFlyingGaugeNote(x, y, noteType, isBig, now) {
        if (!this.flyingGaugeNotes) this.flyingGaugeNotes = [];
        if (this.flyingGaugeNotes.length > 40) {
            this.flyingGaugeNotes.shift();
        }

        const isDon = (noteType === 'don' || noteType === 'bigDon' || noteType === 1 || noteType === 3);
        const actualType = isBig ? (isDon ? 'bigDon' : 'bigKa') : (isDon ? 'don' : 'ka');

        this.flyingGaugeNotes.push({
            startX: x,
            startY: y,
            noteType: actualType,
            isDon,
            isBig: !!isBig,
            birth: now,
            duration: 560, // 560ms majestic leaping arc
            spinDir: (Math.random() > 0.5 ? 1 : -1),
            ctrlOffset: (Math.random() - 0.5) * 30
        });
    }

    _renderFlyingGaugeNotes(now, w, laneTop) {
        if (!this.flyingGaugeNotes || this.flyingGaugeNotes.length === 0) return;
        const ctx = this.ctx;

        const gaugeX = this.plateWidth + 10;
        const gaugeW = w - gaugeX - 70;
        const gaugeH = 26;
        const gaugeY = laneTop - gaugeH - 8;

        const curGauge = Math.max(0, Math.min(100, this.smoothGauge || 0));
        const fillW = Math.max(0, (gaugeW - 4) * (curGauge / 100));
        const targetX = Math.min(gaugeX + gaugeW - 8, Math.max(gaugeX + 12, gaugeX + 2 + fillW));
        const targetY = gaugeY + gaugeH / 2;

        for (let i = this.flyingGaugeNotes.length - 1; i >= 0; i--) {
            const fn = this.flyingGaugeNotes[i];
            const elapsed = now - fn.birth;
            const t = elapsed / fn.duration;

            if (t >= 1.0) {
                // Arrived at soul gauge! Trigger splash ripple
                if (!this.gaugeRipples) this.gaugeRipples = [];
                this.gaugeRipples.push({
                    x: targetX,
                    y: targetY,
                    color: fn.isDon ? '#ffd000' : '#40c4ff',
                    birth: now,
                    duration: 450
                });
                this.flyingGaugeNotes.splice(i, 1);
                continue;
            }

            // High majestic quadratic Bezier arc leaping from drum up towards soul gauge
            const ctrlX = (fn.startX + targetX) * 0.5 + fn.ctrlOffset;
            const ctrlY = Math.min(fn.startY, targetY) - 100;

            const invT = 1 - t;
            const curX = invT * invT * fn.startX + 2 * invT * t * ctrlX + t * t * targetX;
            const curY = invT * invT * fn.startY + 2 * invT * t * ctrlY + t * t * targetY;

            // Scale: Full note size during the leap, then gracefully scales into the gauge
            let scale = 1.0;
            if (t < 0.6) {
                // Initial jump pop
                scale = 1.0 + Math.sin(t / 0.6 * Math.PI) * 0.15;
            } else {
                // Absorbed into gauge
                const absorbP = (t - 0.6) / 0.4;
                scale = 1.0 - absorbP * 0.65; // down to 0.35
            }

            const rot = (t < 0.7 ? Math.sin(t * Math.PI * 1.5) * (fn.spinDir * 0.35) : (fn.spinDir * (t - 0.7) * 4));

            ctx.save();
            ctx.translate(curX, curY);
            ctx.scale(scale, scale);
            ctx.rotate(rot);

            // Glow flare
            ctx.shadowColor = fn.isDon ? '#ff3366' : '#00b4d8';
            ctx.shadowBlur = 14;

            // DRAW THE ACTUAL AUTHENTIC DON / KA NOTE ITSELF!
            this._drawAuthenticNote(0, 0, { type: fn.noteType });

            ctx.restore();

            // Sparkle trailing comet particles
            for (let tr = 1; tr <= 3; tr++) {
                const trT = Math.max(0, t - tr * 0.04);
                const trInv = 1 - trT;
                const trX = trInv * trInv * fn.startX + 2 * trInv * trT * ctrlX + trT * trT * targetX;
                const trY = trInv * trInv * fn.startY + 2 * trInv * trT * ctrlY + trT * trT * targetY;
                ctx.save();
                ctx.globalAlpha = (1 - t) * (0.65 / tr);
                ctx.fillStyle = fn.isDon ? '#ffe066' : '#80d8ff';
                ctx.beginPath();
                ctx.arc(trX + (Math.sin(elapsed / 25 + tr) * 3), trY + (Math.cos(elapsed / 25 + tr) * 3), Math.max(1.5, 4 - tr), 0, Math.PI * 2);
                ctx.fill();
                ctx.restore();
            }
        }
    }

    _triggerDonSpeech(combo, now) {
        const text = `${combo}コンボ！`;
        this.donSpeech = {
            text,
            combo,
            birth: now,
            duration: 2600
        };

        // Voice speech synthesis via Web Speech API (High cute anime voice) with custom Gain Boost
        if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
            try {
                window.speechSynthesis.cancel();
                
                // 1. Initialize Web Audio Context if not already done
                const AudioContext = window.AudioContext || window.webkitAudioContext;
                const audioCtx = new AudioContext();
                
                // 2. Create the Gain node to boost volume past 1.0
                const gainNode = audioCtx.createGain();
                gainNode.gain.value = 6; // 2.5 = 250% volume booster (Adjust as needed)
                
                // 3. Set up the standard Utterance properties
                const utterance = new SpeechSynthesisUtterance(`${combo}コンボ`);
                utterance.lang = 'ja-JP';
                utterance.pitch = 1.75;
                utterance.volume = 1; // Keep native engine at max, gainNode handles the over-amplification
                utterance.rate = 1;

                const voices = window.speechSynthesis.getVoices();
                if (voices && voices.length > 0) {
                    const jaVoice = voices.find(v => v.lang && (v.lang === 'ja-JP' || v.lang === 'ja_JP' || v.lang.startsWith('ja')));
                    if (jaVoice) utterance.voice = jaVoice;
                }

                // 4. Capture browser speech stream into Web Audio API destination
                // Note: Modern browsers require a user gesture (like a click) to resume the AudioContext
                if (audioCtx.state === 'suspended') {
                    audioCtx.resume();
                }

                // Create a media stream destination to route the synthesis into the audio node graph
                const destination = audioCtx.createMediaStreamDestination();
                gainNode.connect(audioCtx.destination);
                
                // fallback system connection while routing is active
                // If your browser version does not support routing speech directly via media streams,
                // it will play back via standard hardware channels at max system volume.
                window.speechSynthesis.speak(utterance);
                
            } catch (e) {
                // Speech synthesis failure non-fatal
            }
        }
    }

    _renderDonSpeech(donX, donY, now) {
        if (!this.donSpeech) return;
        const elapsed = now - this.donSpeech.birth;
        if (elapsed > this.donSpeech.duration) {
            this.donSpeech = null;
            return;
        }

        const ctx = this.ctx;
        const bubbleW = 158;
        const bubbleH = 46;
        const bubbleX = donX + 18;
        const bubbleY = donY - 165;

        // Entrance bounce pop and exit fade
        let scale = 1.0;
        let alpha = 1.0;
        if (elapsed < 200) {
            const p = elapsed / 200;
            scale = 0.5 + 0.5 * Math.sin(p * Math.PI * 0.5) + Math.sin(p * Math.PI) * 0.25;
        } else if (elapsed > this.donSpeech.duration - 300) {
            alpha = (this.donSpeech.duration - elapsed) / 300;
        }

        ctx.save();
        ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
        ctx.translate(bubbleX, bubbleY);
        ctx.scale(scale, scale);

        // Speech bubble body (rounded rectangle)
        const bx = -bubbleW / 2;
        const by = -bubbleH / 2;

        ctx.shadowColor = 'rgba(255, 60, 100, 0.6)';
        ctx.shadowBlur = 12;

        // Bubble fill
        ctx.fillStyle = '#fffdf7';
        ctx.strokeStyle = '#e63946';
        ctx.lineWidth = 3.5;

        ctx.beginPath();
        this._roundRect(bx, by, bubbleW, bubbleH, 12);
        ctx.fill();
        ctx.stroke();

        // Little speech pointer towards Don-chan's mouth
        ctx.beginPath();
        ctx.moveTo(-15, by + bubbleH - 1);
        ctx.lineTo(-28, by + bubbleH + 16);
        ctx.lineTo(-4, by + bubbleH - 1);
        ctx.fillStyle = '#fffdf7';
        ctx.fill();

        ctx.beginPath();
        ctx.moveTo(-15, by + bubbleH);
        ctx.lineTo(-28, by + bubbleH + 16);
        ctx.lineTo(-4, by + bubbleH);
        ctx.strokeStyle = '#e63946';
        ctx.lineWidth = 3.5;
        ctx.lineJoin = 'round';
        ctx.stroke();

        // Bubble inner gold accent border
        ctx.strokeStyle = '#ffb703';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        this._roundRect(bx + 3, by + 3, bubbleW - 6, bubbleH - 6, 9);
        ctx.stroke();

        ctx.shadowBlur = 0;

        // Festive text with subtle vibration
        const vib = Math.sin(now / 70) * 1.2;
        ctx.font = '900 21px "Segoe UI", "Hiragino Kaku Gothic Pro", "Yu Gothic", sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        // Red/Orange glowing text
        ctx.fillStyle = '#d90429';
        ctx.fillText(`★ ${this.donSpeech.text}`, 0, vib);

        ctx.restore();
    }

    _renderJudgment(now) {
        const ctx = this.ctx;

        // Judgment popup
        const judgmentDuration = (this.judgment && this.judgment.kanji === '良') ? 700 : 550;
        if (this.judgment && now - this.judgment.time < judgmentDuration) {
            const age = (now - this.judgment.time) / judgmentDuration;
            const alpha = Math.max(0, 1 - Math.pow(age, 1.5));
            const lift = -age * 30;

            ctx.save();
            ctx.globalAlpha = alpha;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';

            const jx = this.hitX;
            const jy = this.laneY - this.laneHeight / 2 - 36 + lift;

            // Punch scale effect on hit (starts at 1.35x and pops into place)
            const punchAge = Math.min(1, (now - this.judgment.time) / 120);
            const scale = (this.judgment.kanji === '良') ? (1.35 - 0.35 * punchAge) : 1.0;

            ctx.translate(jx, jy);
            ctx.scale(scale, scale);

            // Glowing flare aura for GOOD (良)
            if (this.judgment.kanji === '良') {
                ctx.shadowColor = '#ffd700';
                ctx.shadowBlur = 18;
            }

            const fontSize = this.judgment.isBig ? 50 : 42;
            ctx.font = `900 ${fontSize}px "Segoe UI", "Hiragino Kaku Gothic Pro", "Yu Gothic", sans-serif`;

            ctx.fillStyle = 'rgba(0, 0, 0, 0.75)';
            ctx.fillText(this.judgment.kanji, 2, 2);

            ctx.fillStyle = this.judgment.color;
            ctx.fillText(this.judgment.kanji, 0, 0);

            ctx.shadowBlur = 0;
            ctx.font = 'bold 12px "Segoe UI", sans-serif';
            ctx.fillStyle = '#ffffff';
            ctx.fillText(this.judgment.eng, 0, 26);

            ctx.restore();
        }
    }

    _renderResults(w, h) {
        const ctx = this.ctx;
        const now = performance.now();
        const elapsed = (now - (this.resultsStartTime || now)) / 1000;

        // 1. Semi-transparent frosted backdrop
        ctx.fillStyle = 'rgba(9, 11, 25, 0.90)';
        ctx.fillRect(0, 0, w, h);

        const cx = w / 2;
        const cy = h / 2;
        const isClear = (this.smoothGauge >= this.clearThreshold);
        const isFullCombo = (this.missCount === 0 && this.goodCount + this.okCount > 0);

        // 2. Animated floating sakura celebration petals or gold sparkles
        for (let i = 0; i < 20; i++) {
            const px = ((i * 137 + now * 0.05) % w);
            const py = ((i * 89 + now * (0.04 + (i % 3) * 0.02)) % h);
            ctx.fillStyle = isClear ? 'rgba(255, 215, 0, 0.45)' : 'rgba(255, 120, 120, 0.25)';
            ctx.beginPath();
            ctx.arc(px, py, 3 + (i % 4), 0, Math.PI * 2);
            ctx.fill();
        }

        // 3. Header Banner Card
        const cardW = Math.min(680, w * 0.88);
        const cardH = Math.min(480, h * 0.82);
        const cardX = cx - cardW / 2;
        const cardY = cy - cardH / 2 - 10;

        ctx.fillStyle = 'rgba(20, 24, 46, 0.85)';
        ctx.strokeStyle = isClear ? '#ffcc00' : '#444466';
        ctx.lineWidth = 3;
        this._roundRect(cardX, cardY, cardW, cardH, 18);
        ctx.fill();
        ctx.stroke();

        // 4. Results Title Header
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        let titleText = 'CLEAR!';
        let subtitleText = 'クリア成功！';
        let headerColor = '#ffcc00';

        if (isFullCombo) {
            titleText = 'FULL COMBO!!';
            subtitleText = '★ 全良達成 ★';
            headerColor = '#00f0ff';
        } else if (!isClear) {
            titleText = 'FAILED...';
            subtitleText = 'クリア失敗';
            headerColor = '#ff5555';
        }

        ctx.save();
        ctx.font = '900 40px "Segoe UI", Impact, sans-serif';
        ctx.fillStyle = headerColor;
        ctx.shadowColor = headerColor;
        ctx.shadowBlur = 15;
        ctx.fillText(titleText, cx, cardY + 45);

        ctx.font = 'bold 16px "Yu Gothic", "Segoe UI", sans-serif';
        ctx.fillStyle = '#ffffff';
        ctx.shadowBlur = 0;
        ctx.fillText(subtitleText, cx, cardY + 80);
        ctx.restore();

        // Song title badge
        ctx.font = 'bold 16px "Segoe UI", sans-serif';
        ctx.fillStyle = '#cccccc';
        const displayTitle = this.title.length > 36 ? this.title.slice(0, 34) + '...' : this.title;
        ctx.fillText(`${displayTitle}  [${this.courseName}]`, cx, cardY + 110);

        // 5. Score Display
        ctx.font = '900 36px "Segoe UI", monospace';
        ctx.fillStyle = '#ffea00';
        ctx.shadowColor = 'rgba(255, 234, 0, 0.6)';
        ctx.shadowBlur = 8;
        ctx.fillText(this.score.toLocaleString(), cx, cardY + 155);
        ctx.shadowBlur = 0;

        // 6. Stats Breakdown Grid
        const statRows = [
            { label: '良 (GOOD)', val: this.goodCount, color: '#ffea00' },
            { label: '可 (OK)', val: this.okCount, color: '#ffffff' },
            { label: '不可 (MISS)', val: this.missCount, color: '#ff5555' },
            { label: 'MAX COMBO', val: `${this.maxCombo}x`, color: '#bd93f9' },
            { label: '連打 (ROLLS)', val: this.totalDrumrollHits, color: '#ff9900' },
            { label: 'SOUL GAUGE', val: `${Math.round(this.smoothGauge)}%`, color: isClear ? '#50fa7b' : '#ff5555' }
        ];

        const gridY = cardY + 200;
        const colW = cardW * 0.44;
        statRows.forEach((stat, i) => {
            const col = i % 2;
            const row = Math.floor(i / 2);
            const rowX = (col === 0) ? (cx - colW + 20) : (cx + 30);
            const rowY = gridY + row * 36;

            ctx.textAlign = 'left';
            ctx.font = 'bold 15px "Segoe UI", sans-serif';
            ctx.fillStyle = '#aaaaaa';
            ctx.fillText(stat.label, rowX, rowY);

            ctx.textAlign = 'right';
            ctx.font = 'bold 18px "Segoe UI", monospace';
            ctx.fillStyle = stat.color;
            ctx.fillText(stat.val.toString(), rowX + colW - 40, rowY);
        });

        // 7. Interactive Action Buttons: RETRY and SONG SELECT
        const btnW = Math.min(220, (cardW - 60) / 2);
        const btnH = 50;
        const btnY = cardY + cardH - 75;

        // Button 1: RETRY (Left)
        const retryX = cx - btnW - 15;
        this.retryBtnRect = { x: retryX, y: btnY, w: btnW, h: btnH };

        const retryGrad = ctx.createLinearGradient(retryX, btnY, retryX, btnY + btnH);
        retryGrad.addColorStop(0, '#e63946');
        retryGrad.addColorStop(1, '#a61c27');
        ctx.fillStyle = retryGrad;
        this._roundRect(retryX, btnY, btnW, btnH, 12);
        ctx.fill();
        ctx.strokeStyle = '#ff7b88';
        ctx.lineWidth = 2;
        ctx.stroke();

        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = 'bold 18px "Segoe UI", sans-serif';
        ctx.fillStyle = '#ffffff';
        ctx.fillText('RETRY (再挑戦)', retryX + btnW / 2, btnY + 18);
        ctx.font = '12px "Segoe UI", sans-serif';
        ctx.fillStyle = '#ffcccc';
        ctx.fillText('Press F / J / Enter', retryX + btnW / 2, btnY + 36);

        // Button 2: SONG SELECT (Right)
        const backX = cx + 15;
        this.backBtnRect = { x: backX, y: btnY, w: btnW, h: btnH };

        const backGrad = ctx.createLinearGradient(backX, btnY, backX, btnY + btnH);
        backGrad.addColorStop(0, '#2b5876');
        backGrad.addColorStop(1, '#1a324b');
        ctx.fillStyle = backGrad;
        this._roundRect(backX, btnY, btnW, btnH, 12);
        ctx.fill();
        ctx.strokeStyle = '#4e92c2';
        ctx.lineWidth = 2;
        ctx.stroke();

        ctx.font = 'bold 18px "Segoe UI", sans-serif';
        ctx.fillStyle = '#ffffff';
        ctx.fillText('SONG SELECT (曲選択)', backX + btnW / 2, btnY + 18);
        ctx.font = '12px "Segoe UI", sans-serif';
        ctx.fillStyle = '#cce6ff';
        ctx.fillText('Press ESC', backX + btnW / 2, btnY + 36);
    }

    _renderPause(w, h) {
        const ctx = this.ctx;
        ctx.save();

        // 1. Semi-transparent dark overlay (keep notes & highway visible underneath)
        ctx.fillStyle = 'rgba(10, 12, 22, 0.72)';
        ctx.fillRect(0, 0, w, h);

        const cardW = Math.min(480, w * 0.85);
        const cardH = 340;
        const cardX = (w - cardW) / 2;
        const cardY = (h - cardH) / 2;

        // Card outer shadow
        ctx.shadowColor = 'rgba(0, 0, 0, 0.85)';
        ctx.shadowBlur = 24;

        // Card background: deep Japanese lacquer gradient
        const cardGrad = ctx.createLinearGradient(cardX, cardY, cardX, cardY + cardH);
        cardGrad.addColorStop(0, '#242738');
        cardGrad.addColorStop(1, '#151722');
        ctx.fillStyle = cardGrad;
        this._roundRect(cardX, cardY, cardW, cardH, 18);
        ctx.fill();

        // Card border (gold lacquer)
        ctx.strokeStyle = '#f1c40f';
        ctx.lineWidth = 3.5;
        ctx.stroke();
        ctx.shadowBlur = 0;

        // Japanese festival corner accent marks
        ctx.strokeStyle = 'rgba(241, 196, 15, 0.4)';
        ctx.lineWidth = 1.5;
        this._roundRect(cardX + 8, cardY + 8, cardW - 16, cardH - 16, 12);
        ctx.stroke();

        // Pause Title
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#ffdd55';
        ctx.font = '900 36px "Segoe UI", Impact, sans-serif';
        ctx.shadowColor = 'rgba(255, 200, 0, 0.5)';
        ctx.shadowBlur = 10;
        ctx.fillText('PAUSED', w / 2, cardY + 48);
        ctx.shadowBlur = 0;

        ctx.fillStyle = '#a0a5ba';
        ctx.font = 'bold 14px "Yu Gothic", "Segoe UI", sans-serif';
        ctx.fillText('一時停止中', w / 2, cardY + 76);

        // Gold divider line
        ctx.strokeStyle = 'rgba(241, 196, 15, 0.35)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(cardX + 30, cardY + 98);
        ctx.lineTo(cardX + cardW - 30, cardY + 98);
        ctx.stroke();

        // 3 Action Buttons: RESUME, RETRY, EXIT
        const btnW = cardW - 70;
        const btnH = 54;
        const btnX = (w - btnW) / 2;

        const b1Y = cardY + 118; // RESUME
        const b2Y = cardY + 186; // RETRY
        const b3Y = cardY + 254; // EXIT

        this.pauseButtons = {
            resumeBtn: { x: btnX, y: b1Y, w: btnW, h: btnH },
            continueBtn: { x: btnX, y: b1Y, w: btnW, h: btnH },
            retryBtn: { x: btnX, y: b2Y, w: btnW, h: btnH },
            exitBtn: { x: btnX, y: b3Y, w: btnW, h: btnH },
            quitBtn: { x: btnX, y: b3Y, w: btnW, h: btnH }
        };

        // Button 1: RESUME (再開) - Emerald Green
        const b1Grad = ctx.createLinearGradient(btnX, b1Y, btnX, b1Y + btnH);
        b1Grad.addColorStop(0, '#2ecc71');
        b1Grad.addColorStop(1, '#27ae60');
        ctx.fillStyle = b1Grad;
        this._roundRect(btnX, b1Y, btnW, btnH, 12);
        ctx.fill();
        ctx.strokeStyle = '#a3e4d7';
        ctx.lineWidth = 2;
        ctx.stroke();

        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 18px "Segoe UI", sans-serif';
        ctx.fillText('▶  RESUME (再開)', w / 2, b1Y + 20);
        ctx.font = '12px "Segoe UI", sans-serif';
        ctx.fillStyle = '#d4efdf';
        ctx.fillText('Press ESC, Enter, or Space', w / 2, b1Y + 38);

        // Button 2: RETRY (やり直し) - Radiant Orange
        const b2Grad = ctx.createLinearGradient(btnX, b2Y, btnX, b2Y + btnH);
        b2Grad.addColorStop(0, '#e67e22');
        b2Grad.addColorStop(1, '#d35400');
        ctx.fillStyle = b2Grad;
        this._roundRect(btnX, b2Y, btnW, btnH, 12);
        ctx.fill();
        ctx.strokeStyle = '#f5cba7';
        ctx.lineWidth = 2;
        ctx.stroke();

        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 18px "Segoe UI", sans-serif';
        ctx.fillText('🔄  RETRY (やり直し)', w / 2, b2Y + 20);
        ctx.font = '12px "Segoe UI", sans-serif';
        ctx.fillStyle = '#fae5d3';
        ctx.fillText('Press R', w / 2, b2Y + 38);

        // Button 3: EXIT (終了) - Ruby Red
        const b3Grad = ctx.createLinearGradient(btnX, b3Y, btnX, b3Y + btnH);
        b3Grad.addColorStop(0, '#e74c3c');
        b3Grad.addColorStop(1, '#c0392b');
        ctx.fillStyle = b3Grad;
        this._roundRect(btnX, b3Y, btnW, btnH, 12);
        ctx.fill();
        ctx.strokeStyle = '#f5b7b1';
        ctx.lineWidth = 2;
        ctx.stroke();

        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 18px "Segoe UI", sans-serif';
        ctx.fillText('✖  EXIT (終了)', w / 2, b3Y + 20);
        ctx.font = '12px "Segoe UI", sans-serif';
        ctx.fillStyle = '#fadbd8';
        ctx.fillText('Press Q or Back', w / 2, b3Y + 38);

        ctx.restore();
    }

    _roundRect(x, y, w, h, r) {
        const ctx = this.ctx;
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.lineTo(x + w - r, y);
        ctx.quadraticCurveTo(x + w, y, x + w, y + r);
        ctx.lineTo(x + w, y + h - r);
        ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
        ctx.lineTo(x + r, y + h);
        ctx.quadraticCurveTo(x, y + h, x, y + h - r);
        ctx.lineTo(x, y + r);
        ctx.quadraticCurveTo(x, y, x + r, y);
        ctx.closePath();
    }

    _gameLoop() {
        if (!this.running) return;
        try {
            if (!this.isPaused) {
                this._update();
            }
            this._render();
        } catch (err) {
            console.error('Error in game loop:', err);
        }
        this.animFrameId = requestAnimationFrame(() => this._gameLoop());
    }
}
