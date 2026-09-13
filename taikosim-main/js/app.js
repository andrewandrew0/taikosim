/**
 * TJA Player — Application Controller
 * Features:
 * - Vertical song bars carousel navigable with D and K, selectable with F or J
 * - Interactive Difficulty Choice Modal navigable with D and K, chosen with F or J
 * - Pre-roll support for the game engine
 * - Fallback for both local Python server and static GitHub Pages (songs.json)
 * - Custom folder picker for local user TJA files
 */

class App {
    constructor() {
        this.songs = [];
        this.selectedSongIndex = 0;
        this.selectedDifficultyIndex = 0;
        this.mode = 'song_select'; // 'song_select' or 'difficulty_select'
        this.game = null;
        this.isStatic = false;

        // DOM elements
        this.menuScreen = document.getElementById('menu-screen');
        this.gameScreen = document.getElementById('game-screen');
        this.canvas = document.getElementById('game-canvas');
        this.loadingOverlay = document.getElementById('loading-overlay');

        // Carousel & Hero elements
        this.carousel = document.getElementById('song-carousel');
        this.heroTitle = document.getElementById('hero-title');
        this.heroSubtitle = document.getElementById('hero-subtitle');
        this.heroBpm = document.getElementById('hero-bpm');
        this.heroCourses = document.getElementById('hero-courses');
        this.btnPrev = document.getElementById('btn-prev');
        this.btnNext = document.getElementById('btn-next');

        // Difficulty Modal elements
        this.difficultyModal = document.getElementById('difficulty-modal');
        this.dialogSongTitle = document.getElementById('dialog-song-title');
        this.dialogSongSubtitle = document.getElementById('dialog-song-subtitle');
        this.diffCardsContainer = document.getElementById('difficulty-cards-container');

        this.parser = new TJAParser();

        this._resizeCanvas();
        window.addEventListener('resize', () => this._resizeCanvas());

        // Keyboard navigation for menu
        document.addEventListener('keydown', (e) => this._onKeyDown(e));

        // Arrow button clicks
        if (this.btnPrev) this.btnPrev.addEventListener('click', () => this._changeSongSelection(-1));
        if (this.btnNext) this.btnNext.addEventListener('click', () => this._changeSongSelection(1));

        // Refresh songs button
        const btnRefresh = document.getElementById('btn-refresh');
        if (btnRefresh) btnRefresh.addEventListener('click', () => this.refreshSongs());
    }

    async init() {
        this._showLoading('Loading songs...');
        this.isStatic = false;

        // GitHub Pages is a static host, so it cannot list the contents of
        // /songs/ like a normal server. Use the GitHub repository tree API
        // to discover every TJA/audio pair instead of relying on songs.json.
        if (this._isGitHubPages()) {
            try {
                this.songs = await this._loadGitHubSongs();
                this.isStatic = true;
                this._bindFolderInput();
                this._renderCarousel();
                this._hideLoading();
                return;
            } catch (err) {
                console.error('Failed to scan songs from GitHub:', err);
                // Fall back to songs.json if the GitHub API is unavailable.
                try {
                    const staticResp = await fetch('songs.json', { cache: 'no-store' });
                    if (!staticResp.ok) throw new Error('songs.json not found');
                    this.songs = await staticResp.json();
                    this.isStatic = true;
                    this._bindFolderInput();
                    this._renderCarousel();
                    this._hideLoading();
                    return;
                } catch (staticErr) {
                    console.error('Fallback songs.json also failed:', staticErr);
                }
            }
        }

        // Local Python server mode.
        try {
            const resp = await fetch('/api/songs');
            if (!resp.ok) throw new Error('API not available');
            this.songs = await resp.json();
        } catch (err) {
            // Last fallback for other static hosting.
            try {
                const staticResp = await fetch('songs.json', { cache: 'no-store' });
                if (!staticResp.ok) throw new Error('Static songs.json not found');
                this.songs = await staticResp.json();
                this.isStatic = true;
            } catch (staticErr) {
                console.error('Failed to load songs from API and static JSON:', err, staticErr);
                this.carousel.innerHTML = `
                    <div class="error-msg">
                        <p>No songs found or server not connected.</p>
                        <p style="font-size: 0.9rem; margin-top: 10px; color: #a0a0c0;">You can open any song folder directly from your computer:</p>
                        <label class="btn-folder" style="margin-top: 14px;">
                            📁 Open Local Song Folder
                            <input type="file" id="folder-input" webkitdirectory directory multiple style="display:none;">
                        </label>
                    </div>
                `;
                this._bindFolderInput();
                this._hideLoading();
                return;
            }
        }

        this._bindFolderInput();
        this._renderCarousel();
        this._hideLoading();
    }

    _isGitHubPages() {
        return window.location.hostname === 'andrewandrew0.github.io' ||
               window.location.hostname.endsWith('.github.io');
    }

    async _loadGitHubSongs() {
        const owner = 'andrewandrew0';
        const repo = 'taikosim';
        const branch = 'main';
        const treeUrl = `https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`;

        const response = await fetch(treeUrl, { cache: 'no-store' });
        if (!response.ok) {
            throw new Error(`GitHub API returned ${response.status}`);
        }

        const data = await response.json();
        if (!data.tree || data.truncated) {
            throw new Error('GitHub repository tree could not be read completely');
        }

        // Find every .tja directly inside a songs/<folder>/ directory.
        const tjaFiles = data.tree.filter(item => {
            if (item.type !== 'blob') return false;
            const parts = item.path.split('/');
            return parts.length === 3 &&
                   parts[0] === 'songs' &&
                   parts[2].toLowerCase().endsWith('.tja');
        });

        const songs = [];

        for (const tja of tjaFiles) {
            try {
                // raw.githubusercontent.com handles spaces, Unicode, etc. in paths.
                const chartUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${tja.path.split('/').map(encodeURIComponent).join('/')}`;
                const chartResp = await fetch(chartUrl, { cache: 'no-store' });
                if (!chartResp.ok) throw new Error(`Could not fetch ${tja.path}`);

                const chartText = await chartResp.text();
                const parsed = this.parser.parse(chartText);
                const folder = tja.path.split('/')[1];
                const tjaFile = tja.path.split('/')[2];

                // Use the WAVE value from the TJA and verify that the file exists
                // in the GitHub tree. If it doesn't, try a matching audio file.
                const waveName = parsed.header.wave || '';
                const folderFiles = data.tree.filter(item =>
                    item.type === 'blob' &&
                    item.path.startsWith(`songs/${folder}/`)
                );

                let audioPath = folderFiles.find(item =>
                    item.path.split('/').pop().toLowerCase() === waveName.toLowerCase()
                )?.path;

                if (!audioPath) {
                    audioPath = folderFiles.find(item => {
                        const name = item.path.split('/').pop().toLowerCase();
                        return name.endsWith('.mp3') || name.endsWith('.ogg') || name.endsWith('.wav');
                    })?.path;
                }

                if (!audioPath) {
                    console.warn(`No audio file found for ${tja.path}`);
                    continue;
                }

                const wave = audioPath.split('/').pop();

                songs.push({
                    title: parsed.header.title || tjaFile.replace(/\.[^.]+$/, ''),
                    subtitle: parsed.header.subtitle || '',
                    wave: wave,
                    bpm: parsed.header.bpm || 120,
                    offset: parsed.header.offset || 0,
                    demostart: parsed.header.demostart || 0,
                    courses: parsed.courses.map(c => ({ name: c.name, level: c.level })),
                    folder: folder,
                    tjaFile: tjaFile,
                    chartText: chartText
                });
            } catch (err) {
                console.warn(`Skipping ${tja.path}:`, err);
            }
        }

        // Keep song order stable/alphabetical.
        songs.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));

        if (songs.length === 0) {
            throw new Error('No TJA songs were found in the GitHub songs/ directory');
        }

        return songs;
    }

    async refreshSongs() {
        this._showLoading('Scanning GitHub songs directory...');
        try {
            if (this._isGitHubPages()) {
                // Re-read the GitHub tree, bypassing the browser cache.
                this.songs = await this._loadGitHubSongs();
                this.isStatic = true;
            } else {
                if (this.isStatic) {
                    this._hideLoading();
                    return;
                }
                const resp = await fetch('/api/refresh');
                if (!resp.ok) throw new Error('Refresh failed');
                this.songs = await resp.json();
            }

            this.selectedSongIndex = Math.max(0, Math.min(this.selectedSongIndex, this.songs.length - 1));
            this._renderCarousel();
        } catch (err) {
            console.error('Failed to refresh songs:', err);
            alert(`Failed to refresh songs: ${err.message}`);
        }
        this._hideLoading();
    }

    // ═══════════════════════════════════════════
    //  KEYBOARD NAVIGATION (D/K & F/J)
    // ═══════════════════════════════════════════

    _onKeyDown(e) {
        // Only handle keys when in menu screen
        if (!this.gameScreen.classList.contains('hidden')) return;

        const key = e.key.toLowerCase();

        // Hitsounds for menu: D & K play normal-hitclap (Ka), F & J play normal-hitnormal (Don)
        if (key === 'd' || key === 'k') {
            if (window.soundManager) window.soundManager.playKa();
        } else if (key === 'f' || key === 'j') {
            if (window.soundManager) window.soundManager.playDon();
        }

        if (this.mode === 'song_select') {
            // Cycle songs with D or K (or arrows)
            if (key === 'd' || key === 'arrowleft') {
                e.preventDefault();
                this._changeSongSelection(-1);
            } else if (key === 'k' || key === 'arrowright') {
                e.preventDefault();
                this._changeSongSelection(1);
            }
            // Select song with F or J (or Enter)
            else if (key === 'f' || key === 'j' || key === 'enter' || key === ' ') {
                e.preventDefault();
                this._openDifficultyModal();
            }
        } else if (this.mode === 'difficulty_select') {
            // Cycle difficulties with D or K (or arrows)
            if (key === 'd' || key === 'arrowleft') {
                e.preventDefault();
                this._changeDifficultySelection(-1);
            } else if (key === 'k' || key === 'arrowright') {
                e.preventDefault();
                this._changeDifficultySelection(1);
            }
            // Confirm difficulty with F or J (or Enter)
            else if (key === 'f' || key === 'j' || key === 'enter' || key === ' ') {
                e.preventDefault();
                this._confirmStartGame();
            }
            // Cancel difficulty modal with Escape
            else if (key === 'escape') {
                e.preventDefault();
                this._closeDifficultyModal();
            }
        }
    }

    // ═══════════════════════════════════════════
    //  VERTICAL SONG BARS CAROUSEL
    // ═══════════════════════════════════════════

    _renderCarousel() {
        this.carousel.innerHTML = '';
        if (this.songs.length === 0) return;

        this.selectedSongIndex = Math.min(this.selectedSongIndex, this.songs.length - 1);

        const genreColors = ['#ff4757', '#2ed573', '#1e90ff', '#ffa502', '#9b59b6', '#2bcbba'];
        const courseOrder = ['Easy', 'Normal', 'Hard', 'Oni', 'Edit'];

        this.songs.forEach((song, idx) => {
            const slat = document.createElement('div');
            slat.className = `vertical-song-bar ${idx === this.selectedSongIndex ? 'active' : ''}`;
            slat.dataset.index = idx;

            // Top genre tag
            const tag = document.createElement('div');
            tag.className = 'slat-header-tag';
            tag.style.background = genreColors[idx % genreColors.length];
            tag.textContent = 'TAIKO';
            slat.appendChild(tag);

            // Vertical title text
            const titleWrap = document.createElement('div');
            titleWrap.className = 'slat-title-wrap';

            const title = document.createElement('div');
            title.className = 'slat-title' + (song.title.length > 18 ? ' title-compact' : '');
            title.textContent = song.title;
            titleWrap.appendChild(title);
            slat.appendChild(titleWrap);

            // Footer with difficulty preview dots
            const footer = document.createElement('div');
            footer.className = 'slat-footer';

            const diffIcons = document.createElement('div');
            diffIcons.className = 'slat-diff-icons';

            // Find highest level
            let maxLvl = 0;
            const diffColors = { easy: '#50fa7b', normal: '#f1fa8c', hard: '#ffb86c', oni: '#ff5555', edit: '#bd93f9' };

            const sortedCourses = [...song.courses].sort((a, b) => {
                const ai = courseOrder.indexOf(a.name);
                const bi = courseOrder.indexOf(b.name);
                return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
            });

            sortedCourses.forEach(c => {
                maxLvl = Math.max(maxLvl, c.level);
                const dot = document.createElement('div');
                dot.className = 'diff-dot';
                dot.style.background = diffColors[c.name.toLowerCase()] || '#ff5555';
                dot.title = `${c.name} ★${c.level}`;
                diffIcons.appendChild(dot);
            });

            footer.appendChild(diffIcons);

            const levelText = document.createElement('div');
            levelText.className = 'slat-level-text';
            levelText.textContent = `★ ${maxLvl}`;
            footer.appendChild(levelText);

            slat.appendChild(footer);

            // Click interaction
            slat.addEventListener('click', () => {
                if (this.selectedSongIndex === idx) {
                    this._openDifficultyModal();
                } else {
                    this.selectedSongIndex = idx;
                    this._updateCarouselSelection();
                }
            });

            this.carousel.appendChild(slat);
        });

        this._updateHero(this.songs[this.selectedSongIndex]);
        this._scrollToActiveSlat();
    }

    _changeSongSelection(delta) {
        if (this.songs.length === 0) return;
        this.selectedSongIndex = (this.selectedSongIndex + delta + this.songs.length) % this.songs.length;
        this._updateCarouselSelection();
    }

    _updateCarouselSelection() {
        const slats = this.carousel.querySelectorAll('.vertical-song-bar');
        slats.forEach((s, i) => {
            if (i === this.selectedSongIndex) {
                s.classList.add('active');
            } else {
                s.classList.remove('active');
            }
        });

        const song = this.songs[this.selectedSongIndex];
        if (song) {
            this._updateHero(song);
        }
        this._scrollToActiveSlat();
    }

    _scrollToActiveSlat() {
        const activeSlat = this.carousel.querySelector('.vertical-song-bar.active');
        if (activeSlat) {
            activeSlat.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
        }
    }

    _updateHero(song) {
        if (!song) return;
        this.heroTitle.textContent = song.title;
        this.heroSubtitle.textContent = song.subtitle || 'Taiko Original';
        this.heroBpm.textContent = `${song.bpm} BPM`;

        // Courses preview badges
        this.heroCourses.innerHTML = '';
        const courseOrder = ['Easy', 'Normal', 'Hard', 'Oni', 'Edit'];
        const sorted = [...song.courses].sort((a, b) => {
            const ai = courseOrder.indexOf(a.name);
            const bi = courseOrder.indexOf(b.name);
            return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
        });

        sorted.forEach(c => {
            const b = document.createElement('span');
            b.className = `preview-badge badge-${c.name.toLowerCase()}`;
            b.textContent = `${c.name} ★${c.level}`;
            this.heroCourses.appendChild(b);
        });
    }

    // ═══════════════════════════════════════════
    //  DIFFICULTY CHOICE MODAL (D/K & F/J)
    // ═══════════════════════════════════════════

    _openDifficultyModal() {
        const song = this.songs[this.selectedSongIndex];
        if (!song || song.courses.length === 0) return;

        this.mode = 'difficulty_select';
        this.selectedDifficultyIndex = 0;

        this.dialogSongTitle.textContent = song.title;
        this.dialogSongSubtitle.textContent = song.subtitle || '';
        this.diffCardsContainer.innerHTML = '';

        const courseOrder = ['Easy', 'Normal', 'Hard', 'Oni', 'Edit'];
        const sorted = [...song.courses].sort((a, b) => {
            const ai = courseOrder.indexOf(a.name);
            const bi = courseOrder.indexOf(b.name);
            return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
        });

        this.currentSortedCourses = sorted;

        // Default to Oni if available, otherwise highest difficulty
        const oniIndex = sorted.findIndex(c => c.name.toLowerCase() === 'oni');
        if (oniIndex >= 0) {
            this.selectedDifficultyIndex = oniIndex;
        } else {
            this.selectedDifficultyIndex = sorted.length - 1;
        }

        const jpNames = {
            easy: 'かんたん',
            normal: 'ふつう',
            hard: 'むずかしい',
            oni: 'おに',
            edit: 'うら'
        };

        const icons = {
            easy: '🌸',
            normal: '🎋',
            hard: '🌲',
            oni: '👹',
            edit: '⭐'
        };

        sorted.forEach((c, idx) => {
            const cNameLower = c.name.toLowerCase();
            const card = document.createElement('div');
            card.className = `diff-card card-${cNameLower} ${idx === this.selectedDifficultyIndex ? 'active' : ''}`;
            card.dataset.index = idx;

            // Japanese Name
            const jp = document.createElement('div');
            jp.className = 'diff-card-jp';
            jp.textContent = jpNames[cNameLower] || c.name;
            card.appendChild(jp);

            // Icon
            const icon = document.createElement('div');
            icon.className = 'diff-card-icon';
            icon.textContent = icons[cNameLower] || '🥁';
            card.appendChild(icon);

            // English Name & Stars
            const levelDiv = document.createElement('div');
            levelDiv.className = 'diff-card-level';

            const en = document.createElement('div');
            en.className = 'diff-card-en';
            en.textContent = c.name.toUpperCase();
            levelDiv.appendChild(en);

            const stars = document.createElement('div');
            stars.className = 'diff-card-stars';
            stars.innerHTML = this._renderStars(c.level);
            levelDiv.appendChild(stars);

            card.appendChild(levelDiv);

            // Click selection
            card.addEventListener('click', () => {
                this.selectedDifficultyIndex = idx;
                this._confirmStartGame();
            });

            this.diffCardsContainer.appendChild(card);
        });

        this.difficultyModal.classList.remove('hidden');
    }

    _closeDifficultyModal() {
        this.mode = 'song_select';
        this.difficultyModal.classList.add('hidden');
    }

    _changeDifficultySelection(delta) {
        if (!this.currentSortedCourses || this.currentSortedCourses.length === 0) return;
        const total = this.currentSortedCourses.length;
        this.selectedDifficultyIndex = (this.selectedDifficultyIndex + delta + total) % total;

        const cards = this.diffCardsContainer.querySelectorAll('.diff-card');
        cards.forEach((card, i) => {
            if (i === this.selectedDifficultyIndex) {
                card.classList.add('active');
            } else {
                card.classList.remove('active');
            }
        });
    }

    _confirmStartGame() {
        const song = this.songs[this.selectedSongIndex];
        const course = this.currentSortedCourses[this.selectedDifficultyIndex];
        if (!song || !course) return;

        this._closeDifficultyModal();
        this._startGame(song, course);
    }

    /**
     * Render star rating string with filled ★ and empty ☆
     */
    _renderStars(level) {
        const maxStars = 10;
        let html = '';
        for (let i = 1; i <= maxStars; i++) {
            if (i <= level) {
                html += '<span class="star filled">★</span>';
            } else {
                html += '<span class="star empty">☆</span>';
            }
        }
        return html;
    }

    // ═══════════════════════════════════════════
    //  GAMEPLAY ENGINE HOOKS
    // ═══════════════════════════════════════════

    async _startGame(song, course) {
        this._showLoading(`Loading ${song.title} — ${course.name}...`);

        try {
            let chartText = '';
            let audioUrl = '';

            if (song.isLocalUpload) {
                chartText = await song.tjaFileObj.text();
                audioUrl = URL.createObjectURL(song.audioFileObj);
            } else if (song.chartText) {
                // Direct preloaded chart text (instant loading on file:/// & web)
                chartText = song.chartText;
                audioUrl = `songs/${encodeURIComponent(song.folder)}/${encodeURIComponent(song.wave)}`;
            } else if (this.isStatic) {
                const tjaFileName = song.tjaFile || `${song.folder}.tja`;
                const chartResp = await fetch(`songs/${encodeURIComponent(song.folder)}/${encodeURIComponent(tjaFileName)}`);
                if (!chartResp.ok) throw new Error(`Could not load chart: ${chartResp.statusText}`);
                chartText = await chartResp.text();
                audioUrl = `songs/${encodeURIComponent(song.folder)}/${encodeURIComponent(song.wave)}`;
            } else {
                const chartResp = await fetch(`/api/song/${encodeURIComponent(song.folder)}/chart`);
                if (!chartResp.ok) throw new Error(`Could not load chart: ${chartResp.statusText}`);
                chartText = await chartResp.text();
                audioUrl = `/audio/${encodeURIComponent(song.folder)}/${encodeURIComponent(song.wave)}`;
            }

            // Parse chart
            const parsed = this.parser.parse(chartText);
            const parsedCourse = parsed.courses.find(c => c.name.toLowerCase() === course.name.toLowerCase());
            if (!parsedCourse) {
                throw new Error(`Course "${course.name}" not found in chart data`);
            }

            // Switch to game screen
            this.menuScreen.classList.add('hidden');
            this.gameScreen.classList.remove('hidden');
            this._resizeCanvas();

            // Create and start game
            this.game = new Game(this.canvas, {
                notes: parsedCourse.notes,
                audioUrl: audioUrl,
                offset: parsed.header.offset,
                bpm: parsed.header.bpm || song.bpm || 150,
                title: song.title,
                courseName: course.name,
                level: course.level,
                onEnd: (results) => this._onGameEnd(results),
                onBack: () => this._returnToMenu(),
            });

            this._hideLoading();
            await this.game.start();

        } catch (err) {
            console.error('Failed to start game:', err);
            this._hideLoading();
            alert(`Failed to load song: ${err.message}`);
            this._returnToMenu();
        }
    }

    _onGameEnd(results) {
        console.log('Game ended:', results);
    }

    _returnToMenu() {
        if (this.game) {
            this.game.stop();
            this.game = null;
        }
        this.gameScreen.classList.add('hidden');
        this.menuScreen.classList.remove('hidden');
        this.mode = 'song_select';
        this._updateCarouselSelection();
    }

    _resizeCanvas() {
        if (this.canvas && this.gameScreen && !this.gameScreen.classList.contains('hidden')) {
            this.canvas.width = window.innerWidth;
            this.canvas.height = window.innerHeight;
        }
    }

    _showLoading(text) {
        if (this.loadingOverlay) {
            this.loadingOverlay.querySelector('.loading-text').textContent = text || 'Loading...';
            this.loadingOverlay.classList.remove('hidden');
        }
    }

    _hideLoading() {
        if (this.loadingOverlay) {
            this.loadingOverlay.classList.add('hidden');
        }
    }

    _bindFolderInput() {
        const input = document.getElementById('folder-input');
        if (!input) return;

        input.addEventListener('change', async (e) => {
            const files = Array.from(e.target.files);
            if (!files || files.length === 0) return;

            this._showLoading('Parsing selected folder...');
            try {
                const tjaFiles = files.filter(f => f.name.toLowerCase().endsWith('.tja'));
                if (tjaFiles.length === 0) {
                    alert('No .tja chart files found in the selected folder!');
                    this._hideLoading();
                    return;
                }

                const newSongs = [];
                for (const tFile of tjaFiles) {
                    const text = await tFile.text();
                    const parsed = this.parser.parse(text);
                    const folderPath = tFile.webkitRelativePath ? tFile.webkitRelativePath.split('/')[0] : 'local';

                    const audioName = parsed.header.wave.toLowerCase();
                    const audioFile = files.find(f => f.name.toLowerCase() === audioName) ||
                                     files.find(f => f.name.toLowerCase().endsWith('.mp3') || f.name.toLowerCase().endsWith('.ogg') || f.name.toLowerCase().endsWith('.wav'));

                    if (!audioFile) {
                        console.warn(`No audio file found matching "${parsed.header.wave}" for chart ${tFile.name}`);
                        continue;
                    }

                    newSongs.push({
                        title: parsed.header.title || tFile.name.replace(/\.[^.]+$/, ''),
                        subtitle: parsed.header.subtitle || '',
                        wave: audioFile.name,
                        bpm: parsed.header.bpm || 120,
                        offset: parsed.header.offset || 0,
                        courses: parsed.courses.map(c => ({ name: c.name, level: c.level })),
                        folder: folderPath,
                        isLocalUpload: true,
                        tjaFileObj: tFile,
                        audioFileObj: audioFile
                    });
                }

                if (newSongs.length > 0) {
                    this.songs = newSongs;
                    this.selectedSongIndex = 0;
                    this._renderCarousel();
                } else {
                    alert('Found .tja files, but could not find matching audio files (.mp3, .ogg) in the folder.');
                }
            } catch (err) {
                console.error('Error reading local folder:', err);
                alert('Error reading folder: ' + err.message);
            }
            this._hideLoading();
        });
    }
}

// Boot
document.addEventListener('DOMContentLoaded', () => {
    const app = new App();
    app.init();
});
