/**
 * TJA Parser
 * Parses TJA (Taiko no Tatsujin chart) files into structured note data.
 *
 * Note types in TJA:
 *   0 = empty
 *   1 = don (red, small)
 *   2 = ka (blue, small)
 *   3 = don (red, big)
 *   4 = ka (blue, big)
 *   5 = drumroll start
 *   6 = big drumroll start
 *   7 = balloon start
 *   8 = end of drumroll/balloon
 *   9 = kusudama/special balloon
 */

class TJAParser {
    /**
     * Parse a full TJA file text into header + courses with timed notes.
     * @param {string} text - Raw TJA file content
     * @returns {{ header: Object, courses: Array }}
     */
    parse(text) {
        const lines = text.split('\n').map(l => l.replace(/\r/g, ''));
        const header = this._parseHeader(lines);
        const courses = this._parseCourses(lines, header);
        return { header, courses };
    }

    /**
     * Parse global header metadata (before any COURSE block).
     */
    _parseHeader(lines) {
        const header = {
            title: '',
            subtitle: '',
            wave: '',
            bpm: 120,
            offset: 0,
            demostart: 0,
        };

        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('TITLE:')) header.title = trimmed.slice(6);
            else if (trimmed.startsWith('SUBTITLE:')) {
                let sub = trimmed.slice(9);
                if (sub.startsWith('--') || sub.startsWith('++')) sub = sub.slice(2).trim();
                header.subtitle = sub;
            }
            else if (trimmed.startsWith('WAVE:')) header.wave = trimmed.slice(5);
            else if (trimmed.startsWith('BPM:')) header.bpm = parseFloat(trimmed.slice(4)) || 120;
            else if (trimmed.startsWith('OFFSET:')) header.offset = parseFloat(trimmed.slice(7)) || 0;
            else if (trimmed.startsWith('DEMOSTART:')) header.demostart = parseFloat(trimmed.slice(10)) || 0;
            // Stop at the first COURSE or #START since those belong to course blocks
            if (trimmed.startsWith('COURSE:') || trimmed === '#START') break;
        }

        return header;
    }

    /**
     * Parse all COURSE blocks in the file.
     */
    _parseCourses(lines, header) {
        const courses = [];
        let i = 0;

        while (i < lines.length) {
            const trimmed = lines[i].trim();

            if (trimmed.startsWith('COURSE:')) {
                let courseName = trimmed.slice(7).trim();
                // Normalize numeric course names
                const courseMap = { '0': 'Easy', '1': 'Normal', '2': 'Hard', '3': 'Oni', '4': 'Edit' };
                courseName = courseMap[courseName] || courseName;

                let level = 0;
                let balloon = [];
                i++;

                // Parse course-level headers until #START
                while (i < lines.length) {
                    const cLine = lines[i].trim();
                    if (cLine.startsWith('LEVEL:')) {
                        level = parseInt(cLine.slice(6)) || 0;
                    } else if (cLine.startsWith('BALLOON:')) {
                        const bStr = cLine.slice(8).trim();
                        if (bStr) {
                            balloon = bStr.split(',').map(s => parseInt(s.trim()) || 0);
                        }
                    } else if (cLine === '#START' || cLine.startsWith('#START ')) {
                        break;
                    }
                    i++;
                }

                // Parse notes from #START to #END
                if (i < lines.length && lines[i].trim().startsWith('#START')) {
                    i++; // skip #START line
                    const result = this._parseNoteBlock(lines, i, header, balloon);
                    courses.push({
                        name: courseName,
                        level: level,
                        balloon: balloon,
                        notes: result.notes,
                    });
                    i = result.endIndex + 1;
                }
            } else {
                i++;
            }
        }

        return courses;
    }

    /**
     * Parse note data from a COURSE block (#START to #END).
     * Handles #BPMCHANGE, #MEASURE, #SCROLL, #GOGOSTART/END, #DELAY,
     * and mid-measure commands.
     *
     * Returns { notes: Array<NoteObject>, endIndex: number }
     */
    _parseNoteBlock(lines, startIndex, header, balloon = []) {
        const notes = [];
        let currentTime = 0;       // seconds from chart start
        let bpm = header.bpm;
        let measureNum = 4;
        let measureDen = 4;
        let scroll = 1.0;
        let isGogo = false;
        let i = startIndex;

        // Buffer for accumulating note chars within a measure.
        // Each entry stores the char + the scroll/gogo state at that point.
        let measureBuffer = [];

        while (i < lines.length) {
            const rawLine = lines[i];
            const trimmed = rawLine.trim();

            // End of this course
            if (trimmed === '#END') {
                break;
            }

            // === Commands ===
            if (trimmed.startsWith('#BPMCHANGE ')) {
                bpm = parseFloat(trimmed.slice(11)) || bpm;
                i++;
                continue;
            }
            if (trimmed.startsWith('#MEASURE ')) {
                const parts = trimmed.slice(9).split('/');
                if (parts.length === 2) {
                    measureNum = parseInt(parts[0]) || 4;
                    measureDen = parseInt(parts[1]) || 4;
                }
                i++;
                continue;
            }
            if (trimmed.startsWith('#SCROLL ')) {
                scroll = parseFloat(trimmed.slice(8)) || 1.0;
                i++;
                continue;
            }
            if (trimmed === '#GOGOSTART') {
                isGogo = true;
                i++;
                continue;
            }
            if (trimmed === '#GOGOEND') {
                isGogo = false;
                i++;
                continue;
            }
            if (trimmed.startsWith('#DELAY ')) {
                currentTime += parseFloat(trimmed.slice(7)) || 0;
                i++;
                continue;
            }
            // Skip other commands and comments
            if (trimmed.startsWith('#') || trimmed.startsWith('//') || trimmed === '') {
                i++;
                continue;
            }

            // === Note data ===
            // Characters 0-9 are note data. A comma terminates a measure.
            for (let ci = 0; ci < trimmed.length; ci++) {
                const ch = trimmed[ci];

                if (ch === ',') {
                    // End of measure — process the buffer
                    this._processMeasure(measureBuffer, currentTime, bpm, measureNum, measureDen, notes);
                    // Advance time by this measure's duration
                    currentTime += this._measureDuration(bpm, measureNum, measureDen);
                    measureBuffer = [];
                } else if (ch >= '0' && ch <= '9') {
                    measureBuffer.push({
                        char: ch,
                        scroll: scroll,
                        isGogo: isGogo,
                        bpm: bpm,
                    });
                }
                // Ignore any other characters
            }

            i++;
        }

        // Post-process hold notes (drumroll, bigDrumroll, balloon) with endHold (8)
        let balloonIdx = 0;
        for (let idx = 0; idx < notes.length; idx++) {
            const n = notes[idx];
            if (n.type === 'drumroll' || n.type === 'bigDrumroll' || n.type === 'balloon' || n.type === 'kusudama') {
                // Find next unused endHold
                let endHold = null;
                for (let k = idx + 1; k < notes.length; k++) {
                    if (notes[k].type === 'endHold' && !notes[k].used) {
                        endHold = notes[k];
                        notes[k].used = true;
                        break;
                    }
                }
                const fallbackEnd = n.time + 1.5;
                n.endTime = (endHold && endHold.time > n.time) ? endHold.time : fallbackEnd;

                if (n.type === 'balloon' || n.type === 'kusudama') {
                    n.type = 'balloon'; // Normalize kusudama to balloon
                    const req = (balloon && balloon.length > balloonIdx) ? balloon[balloonIdx++] : 5;
                    n.hitsRequired = req || 5;
                    n.hitsLeft = n.hitsRequired;
                    n.popped = false;
                } else {
                    n.rollCount = 0;
                }
            }
        }

        // Filter out endHold marker objects so only active notes remain
        const finalNotes = notes.filter(n => n.type !== 'endHold');

        // If we reach here without #END, still return what we have
        return { notes: finalNotes, endIndex: i };
    }

    /**
     * Calculate the duration of one measure in seconds.
     * measure = (measureNum / measureDen) whole notes
     * One whole note = 4 beats = 4 * (60/BPM) seconds
     * So duration = measureNum * 4 * 60 / (measureDen * BPM)
     *            = 240 * measureNum / (measureDen * BPM)
     */
    _measureDuration(bpm, num, den) {
        return (240 * num) / (den * bpm);
    }

    /**
     * Process a completed measure's note buffer into timed note objects.
     */
    _processMeasure(buffer, startTime, bpm, measureNum, measureDen, notes) {
        const numSlots = buffer.length;
        if (numSlots === 0) return;

        const duration = this._measureDuration(bpm, measureNum, measureDen);
        const slotDuration = duration / numSlots;

        for (let j = 0; j < numSlots; j++) {
            const entry = buffer[j];
            const noteType = this._getNoteType(entry.char);
            if (noteType) {
                notes.push({
                    time: startTime + j * slotDuration,
                    type: noteType,
                    scroll: entry.scroll,
                    bpm: entry.bpm || bpm,
                    isGogo: entry.isGogo,
                    hit: false,       // will be set by game engine
                    result: null,     // 'good', 'ok', 'bad', 'miss'
                });
            }
        }
    }

    /**
     * Map a TJA note character to a note type string.
     */
    _getNoteType(ch) {
        switch (ch) {
            case '1': return 'don';
            case '2': return 'ka';
            case '3': return 'bigDon';
            case '4': return 'bigKa';
            case '5': return 'drumroll';
            case '6': return 'bigDrumroll';
            case '7': return 'balloon';
            case '8': return 'endHold';
            case '9': return 'kusudama';
            default: return null;  // '0' and anything else = no note
        }
    }
}
