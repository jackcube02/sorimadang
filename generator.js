/* 소리마당 생성기: 원본 목록, 타임라인 편집, 재생, WAV 저장. */
(() => {
    'use strict';
    const root = document.getElementById('sound-generator');
    if (!root) return;
    const library = Array.isArray(window.soundLibrary) ? window.soundLibrary : [];
    const byId = new Map(library.map(sound => [String(sound.id), sound]));
    const LIMIT = 300; // 완성물의 최대 길이(초). 메모리 사용량을 고려해 5분으로 설정했다.
    const MIN_CLIP = 0.05;
    const CACHE_LIMIT = 64 * 1024 * 1024;
    const SOURCE_LIMIT = 12;
    const SOURCE_SECONDS_LIMIT = 600;
    const SAVE_KEY = 'sorimadang-project-v1';
    let activeDecodes = 0;
    const decodeQueue = [];
    let context;
    let clips = [];
    const trackCount = 4;
    let storageWarningShown = false;
    let selectedId = null;
    let cursor = 0;
    let pixelsPerSecond = 12;
    let nextId = 1;
    let playing = false;
    let playEpoch = 0;
    let playStartTime = 0;
    let playStartCursor = 0;
    let playFrame = 0;
    let playTimer = 0;
    let exporting = false;
    let exportCancelled = false;
    let savedWavUrl = null;
    let previewId = null;
    let previewEpoch = 0;
    let dragState = null;
    let copiedClip = null; // 이 생성기 안에서 복사한 클립. 원본 파일은 복제하지 않는다.
    let panState = null;
    let skipTimelineClick = false;
    let colorMenuClipId = null;
    // 우클릭 메뉴의 이름과 색상. 밝은 글자가 잘 보이도록 어두운 색을 사용한다.
    const clipColors = [
        {name: '기본', value: ''}, {name: '빨강', value: '#713e3e'},
        {name: '주황', value: '#75502f'}, {name: '초록', value: '#355d45'},
        {name: '파랑', value: '#345873'}, {name: '보라', value: '#604771'}
    ];
    const safeClipColor = color => clipColors.some(item => item.value === color) ? color : '';
    let libraryDrag = null;
    const pendingAdds = new Map();
    const buffers = new Map();
    const decoding = new Map();
    const durations = new Map();
    const peaks = new Map();
    const nodes = new Map();
    const playbackBuffers = new Map();
    const scheduled = new Set();
    const undoStack = [];
    const redoStack = [];
    const preview = new Audio();
    preview.preload = 'none';
    library.forEach(sound => { if (Number(sound.duration) > 0) durations.set(String(sound.id), Number(sound.duration)); });
    const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[char]));
    const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
    const length = clip => clip.out - clip.in;
    const endTime = () => clips.reduce((end, clip) => Math.max(end, clip.start + length(clip)), 0);
    const selected = () => clips.find(clip => clip.id === selectedId);
    const formatTime = seconds => {
        const tenths = Math.round(Math.max(0, Number(seconds) || 0) * 10);
        return `${String(Math.floor(tenths / 600)).padStart(2, '0')}:${((tenths % 600) / 10).toFixed(1).padStart(4, '0')}`;
    };
    const pauseTick = () => new Promise(resolve => setTimeout(resolve, 0));

    root.innerHTML = `
        <section class="sound-library" aria-labelledby="sound-library-title">
            <div class="generator-heading"><h2 id="sound-library-title">소리 <span id="sound-count"></span></h2><span id="library-preview-name" aria-live="polite"></span></div>
            <div class="library-filters"><input id="sound-search" type="search" aria-label="소리 찾기" placeholder="파일 이름, 참여자, 날짜 검색"><label>참여자<select id="sound-person"><option value="">모두</option></select></label><button id="preview-stop" type="button" disabled>미리듣기 정지</button></div>
            <div id="sound-list" class="sound-list" aria-label="원본 음원 목록"></div>
        </section>
        <section class="sound-editor" aria-label="소리 편집">
            <div class="editor-controls">
                <button id="timeline-play" type="button" disabled>▶ 재생</button><button id="timeline-stop" type="button">■ 처음으로</button><output id="timeline-time">00:00.0 / 00:00.0</output>
                <button id="edit-undo" type="button" disabled>되돌리기</button><button id="edit-redo" type="button" disabled>다시 실행</button>
            </div>
            <div class="editor-options"><label>추가할 트랙<select id="add-track-select"></select></label><label class="snap-option"><input id="timeline-snap" type="checkbox" checked> 끝점 맞추기</label><label class="zoom-option">확대<input id="timeline-zoom" type="range" min="4" max="40" value="12" step="1"></label></div>
            <div class="timeline-scroll" id="timeline-scroll" tabindex="0" aria-label="타임라인. 가로로 스크롤할 수 있다.">
                <div id="timeline" class="timeline"><div id="timeline-ruler" class="timeline-ruler" aria-label="재생 위치 선택"></div><div id="timeline-tracks"></div><div id="timeline-cursor" class="timeline-cursor" aria-hidden="true"></div></div>
            </div>
            <label class="playhead-control">재생 위치<input id="timeline-seek" type="range" min="0" max="60" value="0" step="0.1"><output id="playhead-time">00:00.0</output></label>
            <div class="export-controls"><button id="export-wav" type="button" disabled>↓ WAV 저장</button><button id="export-cancel" type="button" hidden>저장 취소</button><a id="download-wav" hidden>WAV 파일 다운로드</a></div>
            <progress id="export-progress" max="100" value="0" hidden aria-label="WAV 저장 진행률"></progress>
            <p id="generator-status" class="generator-status" role="status" aria-live="polite" hidden></p>
        </section>
        <div id="clip-color-menu" role="menu" aria-label="클립 색상" hidden>
            <span class="color-menu-title">클립 색상</span>
            ${clipColors.map(color => `<button type="button" role="menuitemradio" aria-checked="false" data-color="${color.value}"><span class="color-swatch" style="background:${color.value || '#242424'}" aria-hidden="true"></span>${color.name}</button>`).join('')}
        </div>`;

    const $ = id => root.querySelector(`#${id}`);
    const status = (message = '', error = false) => {
        $('generator-status').textContent = message;
        $('generator-status').classList.toggle('is-error', error);
        $('generator-status').hidden = !message;
    };
    [...new Set(library.map(sound => sound.person).filter(Boolean))].forEach(person => {
        const option = document.createElement('option');
        option.value = person;
        option.textContent = person;
        $('sound-person').append(option);
    });

    function renderLibrary() {
        const query = $('sound-search').value.trim().toLocaleLowerCase();
        const person = $('sound-person').value;
        const filtered = library.filter(sound => (!person || sound.person === person) && (!query || `${sound.name} ${sound.person} ${sound.day ?? ''}`.toLocaleLowerCase().includes(query)));
        $('sound-count').textContent = `(${filtered.length} / ${library.length})`;
        $('sound-list').innerHTML = filtered.map(sound => {
            const id = String(sound.id);
            const duration = durations.get(id);
            return `<article class="sound-card${previewId === id ? ' is-previewing' : ''}" draggable="false" data-sound-id="${escape(id)}"><span class="sound-drag-handle" title="타임라인으로 끌어서 추가" aria-hidden="true">⠿</span><div class="sound-card-info"><span class="sound-person-name">${escape(sound.person)}${sound.day ? ` · ${escape(sound.day)}일` : ''}</span><span class="sound-name" title="${escape(sound.name)}">${escape(sound.name)}</span><span class="sound-duration">${duration ? formatTime(duration) : '원본 녹음'}</span></div><div class="sound-card-buttons"><button type="button" data-action="preview" aria-label="${escape(sound.name)} ${previewId === id ? '미리듣기 정지' : '미리듣기'}">${previewId === id ? '■' : '▶'}</button><button type="button" data-action="add" aria-label="${escape(sound.name)} 타임라인에 추가"${exporting || pendingAdds.has(id) ? ' disabled' : ''}>${pendingAdds.has(id) ? '…' : '＋'}</button></div></article>`;
        }).join('') || '<p class="empty-library">검색 결과가 없다.</p>';
    }

    function getContext() {
        if (!context) {
            const AudioContext = window.AudioContext || window.webkitAudioContext;
            if (!AudioContext) throw new Error('이 브라우저는 오디오 편집을 지원하지 않는다. 최신 Safari, Chrome 또는 Firefox에서 열어달라.');
            context = new AudioContext();
            context.addEventListener('statechange', () => {
                if (playing && context.state !== 'running') {
                    pauseTimeline();
                    status('오디오 재생이 중단되었다. 재생 버튼을 눌러 이어서 들어보자.');
                }
            });
        }
        return context;
    }

    function shrinkCache() {
        let size = [...buffers.values()].reduce((sum, entry) => sum + entry.bytes, 0);
        while (size > CACHE_LIMIT && buffers.size > 1) {
            const id = buffers.keys().next().value;
            size -= buffers.get(id).bytes;
            buffers.delete(id);
        }
    }

    async function decodeSlot() {
        if (activeDecodes >= 2) await new Promise(resolve => decodeQueue.push(resolve));
        else activeDecodes++;
    }
    function releaseDecodeSlot() {
        if (decodeQueue.length) decodeQueue.shift()();
        else activeDecodes--;
    }

    function sourceBudget(ids) {
        const unique = new Set(ids);
        if (unique.size > SOURCE_LIMIT) return '한 작업에는 서로 다른 원본을 최대 12개까지 사용할 수 있다. 기존 원본의 클립을 삭제한 뒤 추가해달라.';
        const seconds = [...unique].reduce((sum, id) => sum + (durations.get(id) || 0), 0);
        if (seconds > SOURCE_SECONDS_LIMIT + 0.1) return '안정적인 재생을 위해 사용 중인 원본 길이의 합은 10분까지 지원한다. 기존 원본의 클립을 삭제한 뒤 추가해달라.';
        return '';
    }

    async function getBuffer(id) {
        id = String(id);
        if (playbackBuffers.has(id)) return playbackBuffers.get(id);
        if (buffers.has(id)) {
            const entry = buffers.get(id);
            buffers.delete(id);
            buffers.set(id, entry);
            return entry.buffer;
        }
        // 재생 중인 원본은 같은 AudioBuffer를 재사용해 중복 디코딩을 막는다.
        for (const node of nodes.values()) if (node.soundId === id && node.source.buffer) return node.source.buffer;
        if (decoding.has(id)) return decoding.get(id);
        const sound = byId.get(id);
        if (!sound) throw new Error('원본 음원을 찾을 수 없다.');
        const job = (async () => {
            await decodeSlot();
            try {
            const response = await fetch(sound.url);
            if (!response.ok) throw new Error(`${sound.name} 파일을 불러오지 못했다 (${response.status}).`);
            const bytes = await response.arrayBuffer();
            const buffer = await getContext().decodeAudioData(bytes);
            if (!buffer.length || !Number.isFinite(buffer.duration)) throw new Error('읽을 수 없는 음원이다.');
            durations.set(id, buffer.duration);
            const data = buffer.getChannelData(0);
            const samples = 500;
            const values = new Float32Array(samples);
            for (let part = 0; part < samples; part++) {
                const begin = Math.floor(part * data.length / samples);
                const finish = Math.floor((part + 1) * data.length / samples);
                const step = Math.max(1, Math.floor((finish - begin) / 100));
                let peak = 0;
                for (let frame = begin; frame < finish; frame += step) peak = Math.max(peak, Math.abs(data[frame]));
                values[part] = peak;
            }
            peaks.set(id, values);
            requestAnimationFrame(drawWaves);
            buffers.set(id, { buffer, bytes: buffer.length * buffer.numberOfChannels * 4 });
            shrinkCache();
            return buffer;
            } finally { releaseDecodeSlot(); }
        })();
        decoding.set(id, job);
        try { return await job; }
        catch (error) {
            if (location.protocol === 'file:') throw new Error('편집하려면 웹 서버 주소로 열어야 한다. 로컬 미리보기 서버나 게시한 웹사이트에서 다시 열어달라.');
            if (error.name === 'EncodingError' || error.name === 'NotSupportedError') throw new Error(`${sound.name}의 오디오 형식을 읽을 수 없다. 다른 최신 브라우저에서 시도해달라.`);
            throw error;
        } finally { decoding.delete(id); }
    }

    function snapshot() { return { clips: clips.map(clip => ({...clip})), trackCount, selectedId }; }
    function saveProject() {
        try {
            const sources = {};
            clips.forEach(clip => { sources[clip.soundId] = durations.get(clip.soundId); });
            localStorage.setItem(SAVE_KEY, JSON.stringify({...snapshot(), sources, version: 1}));
        } catch (_) {
            if (!storageWarningShown) {
                storageWarningShown = true;
                status('편집 내용을 자동 저장할 수 없다. 페이지를 닫기 전에 WAV로 내려받아달라.', true);
            }
        }
    }
    function restoreProject() {
        try {
            const saved = JSON.parse(localStorage.getItem(SAVE_KEY) || 'null');
            if (!saved || saved.version !== 1 || !Array.isArray(saved.clips)) return;
            const ids = new Set();
            const restored = [];
            for (const raw of saved.clips.slice(0, 80)) {
                const soundId = String(raw.soundId);
                if (!byId.has(soundId) || !['start', 'in', 'out', 'gain', 'track'].every(key => Number.isFinite(raw[key]))) continue;
                const maximum = durations.get(soundId) || Number(saved.sources?.[soundId]);
                const out = Math.min(raw.out, maximum);
                if (!maximum || raw.in < 0 || raw.out > maximum + 0.1 || out - raw.in < MIN_CLIP || raw.start < 0 || raw.start + out - raw.in > LIMIT + 0.01) continue;
                durations.set(soundId, maximum);
                if (sourceBudget([...ids, soundId])) continue;
                ids.add(soundId);
                restored.push({ id: nextId++, soundId, track: clamp(Math.floor(raw.track), 0, trackCount - 1), start: raw.start, in: raw.in, out, gain: clamp(raw.gain, 0, 2), color: safeClipColor(raw.color) });
            }
            clips = restored;
            selectedId = clips[0]?.id ?? null;
        } catch (_) { /* 저장 정보가 없거나 읽을 수 없으면 빈 작업으로 시작한다. */ }
    }
    function recordChange() {
        undoStack.push(snapshot());
        if (undoStack.length > 50) undoStack.shift();
        redoStack.length = 0;
    }
    function restore(state) {
        pauseTimeline();
        clips = state.clips.map(clip => ({...clip}));
        selectedId = state.selectedId;
        cursor = Math.min(cursor, endTime());
        renderEditor();
    }

    function renderTrackOptions() {
        const oldValue = $('add-track-select').value;
        $('add-track-select').innerHTML = Array.from({length: trackCount}, (_, index) => `<option value="${index}">트랙 ${index + 1}</option>`).join('');
        $('add-track-select').value = Math.min(Number(oldValue) || 0, trackCount - 1);
    }

    function viewDuration() {
        return Math.min(LIMIT, Math.max(60, Math.ceil((endTime() + 15) / 30) * 30));
    }

    function renderEditor() {
        renderTrackOptions();
        renderTimeline();
        updateControls();
        saveProject();
    }

    function renderTimeline() {
        const duration = viewDuration();
        const width = Math.max(1, duration * pixelsPerSecond);
        $('timeline').style.width = `${width}px`;
        const interval = pixelsPerSecond < 8 ? 10 : pixelsPerSecond < 20 ? 5 : 2;
        $('timeline-ruler').innerHTML = Array.from({length: Math.floor(duration / interval) + 1}, (_, index) => `<span class="time-mark" style="left:${index * interval * pixelsPerSecond}px">${formatTime(index * interval).split('.')[0]}</span>`).join('');
        $('timeline-tracks').innerHTML = Array.from({length: trackCount}, (_, track) => `<div class="timeline-track" data-track="${track}" aria-label="트랙 ${track + 1}"><span class="track-name">트랙 ${track + 1}</span>${clips.filter(clip => clip.track === track).map(clip => {
            const sound = byId.get(clip.soundId);
            return `<div class="sound-clip${clip.id === selectedId ? ' is-selected' : ''}" data-clip-id="${clip.id}" tabindex="0" role="button" aria-label="${escape(sound.name)}, 트랙 ${track + 1}, 시작 ${clip.start.toFixed(2)}초, 길이 ${length(clip).toFixed(2)}초. 양 끝을 끌어 자르기, 더블 클릭 또는 S 키로 나누기, Delete 키로 삭제." aria-pressed="${clip.id === selectedId}" style="${safeClipColor(clip.color) ? `--clip-color:${safeClipColor(clip.color)};` : ''}left:${clip.start * pixelsPerSecond}px;width:${Math.max(2, length(clip) * pixelsPerSecond)}px"><canvas class="clip-wave" aria-hidden="true"></canvas><span class="clip-name">${escape(sound.name)}</span><span class="clip-duration">${formatTime(length(clip))}</span><span class="clip-handle clip-handle-left" data-handle="left" title="시작 부분 자르기"></span><span class="clip-handle clip-handle-right" data-handle="right" title="끝 부분 자르기"></span></div>`;
        }).join('')}</div>`).join('');
        $('timeline-seek').max = String(duration);
        drawWaves();
        updateCursor();
    }

    function drawWaves() {
        root.querySelectorAll('.sound-clip').forEach(element => {
            const clip = clips.find(item => item.id === Number(element.dataset.clipId));
            if (!clip) return;
            const values = peaks.get(clip.soundId);
            const fullDuration = durations.get(clip.soundId);
            const canvas = element.querySelector('canvas');
            const width = Math.max(1, Math.round(length(clip) * pixelsPerSecond));
            const height = 82;
            canvas.width = Math.min(4000, width * (window.devicePixelRatio || 1));
            canvas.height = height * (window.devicePixelRatio || 1);
            const ctx = canvas.getContext('2d');
            ctx.scale(canvas.width / width, canvas.height / height);
            ctx.strokeStyle = safeClipColor(clip.color) ? '#dddddd' : clip.id === selectedId ? '#999' : '#626262';
            ctx.lineWidth = 1;
            ctx.beginPath();
            for (let x = 0; x < width; x += 2) {
                const fraction = (clip.in + x / width * length(clip)) / fullDuration;
                const peak = values ? values[Math.min(values.length - 1, Math.floor(fraction * values.length))] || 0 : 0.02;
                const amplitude = Math.max(1, peak * 26);
                ctx.moveTo(x, height / 2 - amplitude);
                ctx.lineTo(x, height / 2 + amplitude);
            }
            ctx.stroke();
        });
    }

    function updateControls() {
        $('timeline-play').disabled = !clips.length || exporting;
        $('timeline-play').textContent = playing ? 'Ⅱ 일시정지' : '▶ 재생';
        $('timeline-stop').disabled = exporting;
        $('edit-undo').disabled = !undoStack.length || exporting;
        $('edit-redo').disabled = !redoStack.length || exporting;
        $('export-wav').disabled = !clips.length || exporting || pendingAdds.size > 0;
        $('export-cancel').hidden = !exporting;
        $('timeline-seek').disabled = exporting;
        root.classList.toggle('is-exporting', exporting);
    }

    async function addSound(id, track = Number($('add-track-select').value), start = null) {
        if (exporting || pendingAdds.has(id)) return;
        if (clips.length + pendingAdds.size >= 80) { status('최대 80개의 클립을 추가할 수 있다. 사용하지 않는 소리를 삭제해달라.', true); return; }
        const budgetError = sourceBudget([...clips.map(clip => clip.soundId), ...pendingAdds.keys(), id]);
        if (budgetError) { status(budgetError, true); return; }
        const token = {};
        pendingAdds.set(id, token);
        renderLibrary();
        updateControls();
        const sound = byId.get(id);
        status(`${sound.name}을 불러오는 중…`);
        try {
            const buffer = await getBuffer(id);
            if (exporting) return;
            if (clips.length >= 80) throw new Error('클립은 최대 80개까지 사용할 수 있다. 사용하지 않는 클립을 삭제해달라.');
            const actualBudgetError = sourceBudget([...clips.map(clip => clip.soundId), ...pendingAdds.keys()]);
            if (actualBudgetError) throw new Error(actualBudgetError);
            pauseTimeline();
            const targetTrack = Math.min(track, trackCount - 1);
            let position = start === null ? clips.filter(clip => clip.track === targetTrack).reduce((end, clip) => Math.max(end, clip.start + length(clip)), 0) : clamp(start, 0, LIMIT);
            const available = LIMIT - position;
            if (available < MIN_CLIP) throw new Error('타임라인의 최대 길이는 5분이다. 앞쪽에 추가하거나 기존 소리를 줄여달라.');
            recordChange();
            const clip = { id: nextId++, soundId: id, track: targetTrack, start: position, in: 0, out: Math.min(buffer.duration, available), gain: 1 };
            clips.push(clip);
            selectedId = clip.id;
            renderEditor();
            status(clip.out < buffer.duration ? '5분 한도에 맞춰 끝부분을 잘랐다.' : '');
        } catch (error) { status(error.message || '음원을 불러오지 못했다.', true); }
        finally { pendingAdds.delete(id); renderLibrary(); updateControls(); }
    }

    function stopPreview() {
        previewEpoch++;
        preview.pause();
        preview.removeAttribute('src');
        preview.load();
        previewId = null;
        $('preview-stop').disabled = true;
        $('library-preview-name').textContent = '';
        renderLibrary();
    }

    async function previewSound(id) {
        if (exporting) return;
        if (previewId === id) { stopPreview(); return; }
        stopPreview();
        pauseTimeline();
        const sound = byId.get(id);
        const epoch = ++previewEpoch;
        window.dispatchEvent(new CustomEvent('sound-start', { detail: { owner: 'generator' } }));
        previewId = id;
        preview.src = sound.url;
        $('preview-stop').disabled = false;
        $('library-preview-name').textContent = `미리듣기 · ${sound.name}`;
        renderLibrary();
        try {
            await preview.play();
            if (epoch !== previewEpoch) return;
        } catch (error) {
            if (epoch !== previewEpoch) return;
            stopPreview();
            status('미리듣기를 시작하지 못했다. 음원 파일이나 브라우저 지원 여부를 확인해달라.', true);
        }
    }

    function currentTime() {
        return playing ? clamp(playStartCursor + Math.max(0, context.currentTime - playStartTime), 0, endTime()) : cursor;
    }

    function updateCursor() {
        const time = currentTime();
        $('timeline-cursor').style.left = `${time * pixelsPerSecond}px`;
        $('timeline-seek').value = String(time);
        $('timeline-time').textContent = `${formatTime(time)} / ${formatTime(endTime())}`;
        $('playhead-time').textContent = formatTime(time);
        if (playing) {
            const box = $('timeline-scroll');
            const x = time * pixelsPerSecond;
            if (x > box.scrollLeft + box.clientWidth - 36) box.scrollLeft = Math.max(0, x - box.clientWidth + 72);
        }
    }

    function pauseTimeline(reset = false) {
        if (playing) cursor = currentTime();
        playing = false;
        playEpoch++;
        cancelAnimationFrame(playFrame);
        clearInterval(playTimer);
        nodes.forEach(node => { try { node.source.stop(); } catch (_) {} node.source.disconnect(); node.gain.disconnect(); });
        nodes.clear();
        playbackBuffers.clear();
        scheduled.clear();
        if (reset) cursor = 0;
        updateCursor();
        updateControls();
    }

    async function scheduleClip(clip, epoch) {
        if (scheduled.has(clip.id)) return;
        scheduled.add(clip.id);
        try {
            const buffer = await getBuffer(clip.soundId);
            if (!playing || epoch !== playEpoch) return;
            playbackBuffers.set(clip.soundId, buffer);
            const time = currentTime();
            const skip = Math.max(0, time - clip.start);
            const remaining = length(clip) - skip;
            if (remaining <= 0) return;
            const source = context.createBufferSource();
            const gain = context.createGain();
            source.buffer = buffer;
            gain.gain.value = clip.gain;
            source.connect(gain).connect(context.destination);
            const when = Math.max(context.currentTime, playStartTime + clip.start + skip - playStartCursor);
            const offset = clip.in + skip;
            // 짧은 페이드는 잘라 붙인 경계의 클릭음을 줄인다.
            const fade = Math.min(0.004, remaining / 3);
            gain.gain.setValueAtTime(0, when);
            gain.gain.linearRampToValueAtTime(clip.gain, when + fade);
            gain.gain.setValueAtTime(clip.gain, when + remaining - fade);
            gain.gain.linearRampToValueAtTime(0, when + remaining);
            nodes.set(clip.id, { source, gain, soundId: clip.soundId });
            source.onended = () => { source.disconnect(); gain.disconnect(); if (nodes.get(clip.id)?.source === source) nodes.delete(clip.id); };
            source.start(when, offset, remaining);
        } catch (error) {
            if (epoch === playEpoch) { pauseTimeline(); status(error.message || '재생할 음원을 불러오지 못했다.', true); }
        }
    }

    function scheduleAhead(epoch) {
        if (!playing || epoch !== playEpoch) return;
        const time = currentTime();
        clips.filter(clip => clip.start <= time + 3 && clip.start + length(clip) > time).forEach(clip => scheduleClip(clip, epoch));
    }

    async function playTimeline() {
        if (exporting || !clips.length) return;
        if (playing) { pauseTimeline(); return; }
        stopPreview();
        window.dispatchEvent(new CustomEvent('sound-start', {detail: {owner: 'generator'}}));
        if (cursor >= endTime() - 0.01) cursor = 0;
        const epoch = ++playEpoch;
        try {
            const ctx = getContext();
            await ctx.resume();
            status('재생할 소리를 준비하는 중…');
            const immediate = clips.filter(clip => clip.start <= cursor + 3 && clip.start + length(clip) > cursor);
            const ready = await Promise.all([...new Set(immediate.map(clip => clip.soundId))].map(async id => [id, await getBuffer(id)]));
            if (epoch !== playEpoch || exporting) return;
            ready.forEach(([id, buffer]) => playbackBuffers.set(id, buffer));
            playing = true;
            playStartCursor = cursor;
            playStartTime = ctx.currentTime + 0.06;
            scheduleAhead(epoch);
            playTimer = setInterval(() => scheduleAhead(epoch), 150);
            const animate = () => {
                if (!playing || epoch !== playEpoch) return;
                updateCursor();
                if (currentTime() >= endTime()) { pauseTimeline(); cursor = endTime(); updateCursor(); return; }
                playFrame = requestAnimationFrame(animate);
            };
            playFrame = requestAnimationFrame(animate);
            updateControls();
            status();
        } catch (error) { if (epoch === playEpoch) { pauseTimeline(); status(error.message || '재생하지 못했다.', true); } }
    }

    function seekTo(time) {
        if (exporting) return;
        const wasPlaying = playing;
        pauseTimeline();
        cursor = clamp(time, 0, viewDuration());
        updateCursor();
        if (wasPlaying && cursor < endTime()) playTimeline();
    }

    function snapStart(value, clip, track) {
        let result = clamp(value, 0, LIMIT - length(clip));
        if (!$('timeline-snap').checked) return result;
        const threshold = 9 / pixelsPerSecond;
        const candidates = [0, cursor];
        clips.filter(other => other.id !== clip.id && other.track === track).forEach(other => candidates.push(other.start, other.start + length(other)));
        let distance = threshold;
        candidates.forEach(point => {
            [point, point - length(clip)].forEach(start => {
                if (start >= 0 && start + length(clip) <= LIMIT && Math.abs(start - value) < distance) { distance = Math.abs(start - value); result = start; }
            });
        });
        return result;
    }

    function libraryDropTarget(event) {
        const row = document.elementFromPoint(event.clientX, event.clientY)?.closest('.timeline-track');
        return row && root.contains(row) ? row : null;
    }

    function beginLibraryDrag(event) {
        const card = event.target.closest('[data-sound-id]');
        if (!card || event.target.closest('button') || exporting || event.button !== 0) return;
        // 휴대폰에서는 손잡이로 드래그하고, 카드의 다른 부분에서는 목록을 스크롤한다.
        if (event.pointerType === 'touch' && !event.target.closest('.sound-drag-handle')) return;
        if (event.pointerType !== 'touch') event.preventDefault();
        libraryDrag = { id: card.dataset.soundId, pointerId: event.pointerId, x: event.clientX, y: event.clientY, ghost: null };
        card.setPointerCapture(event.pointerId);
    }

    function moveLibraryDrag(event) {
        if (!libraryDrag || event.pointerId !== libraryDrag.pointerId) return;
        if (!libraryDrag.ghost && Math.hypot(event.clientX - libraryDrag.x, event.clientY - libraryDrag.y) < 6) return;
        if (event.cancelable) event.preventDefault();
        if (!libraryDrag.ghost) {
            const ghost = document.createElement('div');
            ghost.className = 'sound-drag-ghost';
            ghost.textContent = byId.get(libraryDrag.id).name;
            document.body.append(ghost);
            libraryDrag.ghost = ghost;
        }
        libraryDrag.ghost.style.left = `${Math.min(event.clientX + 12, window.innerWidth - 200)}px`;
        libraryDrag.ghost.style.top = `${event.clientY + 14}px`;
        const row = libraryDropTarget(event);
        root.querySelectorAll('.timeline-track').forEach(item => item.classList.toggle('is-drop-target', item === row));
        const main = document.getElementById('content-main');
        if (main) {
            const bounds = main.getBoundingClientRect();
            if (event.clientY > bounds.bottom - 36) main.scrollTop += 16;
            else if (event.clientY < bounds.top + 36) main.scrollTop -= 16;
        }
        if (row) {
            const box = $('timeline-scroll');
            const bounds = box.getBoundingClientRect();
            if (event.clientX > bounds.right - 24) box.scrollLeft += 12;
            else if (event.clientX < bounds.left + 24) box.scrollLeft -= 12;
        }
    }

    function endLibraryDrag(event) {
        if (!libraryDrag || event.pointerId !== libraryDrag.pointerId) return;
        const state = libraryDrag;
        libraryDrag = null;
        state.ghost?.remove();
        root.querySelectorAll('.is-drop-target').forEach(item => item.classList.remove('is-drop-target'));
        if (!state.ghost || event.type === 'pointercancel') return;
        const row = libraryDropTarget(event);
        if (!row) return;
        const track = Number(row.dataset.track);
        let position = Math.max(0, (event.clientX - row.getBoundingClientRect().left) / pixelsPerSecond);
        if ($('timeline-snap').checked) {
            const ends = [0, ...clips.filter(clip => clip.track === track).map(clip => clip.start + length(clip))];
            const nearby = ends.find(end => Math.abs(end - position) < 12 / pixelsPerSecond);
            if (nearby !== undefined) position = nearby;
        }
        addSound(state.id, track, position);
    }

    function beginDrag(event) {
        if (exporting || event.button !== 0) return;
        const element = event.target.closest('.sound-clip');
        if (!element) return;
        event.preventDefault();
        const clip = clips.find(item => item.id === Number(element.dataset.clipId));
        pauseTimeline();
        selectedId = clip.id;
        $('add-track-select').value = String(clip.track);
        root.querySelectorAll('.sound-clip').forEach(item => { item.classList.toggle('is-selected', item === element); item.setAttribute('aria-pressed', String(item === element)); });
        drawWaves();
        element.focus({preventScroll: true});
        dragState = { clip, element, handle: event.target.dataset.handle, x: event.clientX, original: {...clip}, history: snapshot(), changed: false, pointerId: event.pointerId, scroll: $('timeline-scroll').scrollLeft };
        element.setPointerCapture(event.pointerId);
    }

    function moveDrag(event) {
        if (!dragState || dragState.pointerId !== event.pointerId) return;
        const { clip, original, element, handle } = dragState;
        const box = $('timeline-scroll');
        const rect = box.getBoundingClientRect();
        if (event.clientX > rect.right - 28) box.scrollLeft += 12;
        else if (event.clientX < rect.left + 28) box.scrollLeft -= 12;
        const difference = (event.clientX - dragState.x + box.scrollLeft - dragState.scroll) / pixelsPerSecond;
        if (Math.abs(difference * pixelsPerSecond) < 2 && !dragState.changed) return;
        if (handle === 'left') {
            const change = clamp(difference, -Math.min(original.in, original.start), length(original) - MIN_CLIP);
            clip.in = original.in + change;
            clip.start = original.start + change;
        } else if (handle === 'right') {
            clip.out = clamp(original.out + difference, original.in + MIN_CLIP, Math.min(durations.get(clip.soundId), original.in + LIMIT - original.start));
        } else {
            const rows = [...root.querySelectorAll('.timeline-track')];
            const track = rows.findIndex(row => { const bounds = row.getBoundingClientRect(); return event.clientY >= bounds.top && event.clientY <= bounds.bottom; });
            clip.track = track < 0 ? clip.track : track;
            clip.start = snapStart(original.start + difference, original, clip.track);
            if (element.parentElement !== rows[clip.track]) rows[clip.track].append(element);
        }
        dragState.changed = true;
        element.style.left = `${clip.start * pixelsPerSecond}px`;
        element.style.width = `${length(clip) * pixelsPerSecond}px`;
        element.querySelector('.clip-duration').textContent = formatTime(length(clip));
        updateCursor();
    }

    function endDrag(event) {
        if (!dragState || (event.pointerId !== undefined && dragState.pointerId !== event.pointerId)) return;
        const state = dragState;
        dragState = null;
        if (!state.changed) {
            updateControls();
            saveProject();
            return;
        }
        if (event.type === 'pointercancel') Object.assign(state.clip, state.original);
        else if (state.changed) {
            undoStack.push(state.history);
            if (undoStack.length > 50) undoStack.shift();
            redoStack.length = 0;
        }
        renderEditor();
    }

    function editClip(action) {
        if (exporting) return;
        const clip = selected();
        if (!clip) return;
        pauseTimeline();
        if (action === 'split') {
            const offset = cursor - clip.start;
            if (offset < MIN_CLIP || offset > length(clip) - MIN_CLIP) { status('자를 위치를 선택한 소리의 안쪽에 놓아달라.', true); return; }
            if (clips.length >= 80) { status('클립은 최대 80개까지 사용할 수 있다.', true); return; }
            recordChange();
            const right = {...clip, id: nextId++, start: cursor, in: clip.in + offset};
            clip.out = right.in;
            clips.push(right);
            selectedId = right.id;
            status();
        } else if (action === 'delete') {
            recordChange();
            clips = clips.filter(item => item.id !== clip.id);
            selectedId = null;
            status();
        }
        renderEditor();
    }

    function focusSelectedClip() {
        root.querySelector(`[data-clip-id="${selectedId}"]`)?.focus({preventScroll: true});
    }

    function pasteClip() {
        if (!copiedClip || exporting || dragState) return;
        if (clips.length + pendingAdds.size >= 80) { status('클립은 최대 80개까지 사용할 수 있다.', true); return; }
        const error = sourceBudget([...clips.map(clip => clip.soundId), ...pendingAdds.keys(), copiedClip.soundId]);
        if (error) { status(error, true); return; }
        if (cursor + length(copiedClip) > LIMIT) { status('붙여넣을 공간이 부족하다. 5분 안쪽의 위치를 선택해달라.', true); return; }
        pauseTimeline();
        recordChange();
        const clip = {...copiedClip, id: nextId++, start: cursor, track: Number($('add-track-select').value)};
        clips.push(clip);
        selectedId = clip.id;
        cursor = clip.start + length(clip); // 연속 붙여넣기는 앞 클립 바로 뒤에 이어진다.
        renderEditor();
        focusSelectedClip();
        status();
        getBuffer(clip.soundId).catch(error => status(error.message, true));
    }

    function closeColorMenu(returnFocus = false) {
        $('clip-color-menu').hidden = true;
        colorMenuClipId = null;
        if (returnFocus) focusSelectedClip();
    }

    function openColorMenu(event) {
        const element = event.target.closest('.sound-clip');
        if (!element || exporting) return;
        event.preventDefault();
        const clip = clips.find(item => item.id === Number(element.dataset.clipId));
        if (!clip) return;
        selectedId = clip.id;
        $('add-track-select').value = String(clip.track);
        renderEditor();
        colorMenuClipId = clip.id;
        const menu = $('clip-color-menu');
        menu.querySelectorAll('button').forEach(button => button.setAttribute('aria-checked', String(button.dataset.color === safeClipColor(clip.color))));
        menu.hidden = false;
        const bounds = menu.getBoundingClientRect();
        const clipBounds = root.querySelector(`[data-clip-id="${clip.id}"]`).getBoundingClientRect();
        const x = event.clientX || clipBounds.left;
        const y = event.clientY || clipBounds.top;
        menu.style.left = `${clamp(x + 8, 8, Math.max(8, window.innerWidth - bounds.width - 8))}px`;
        menu.style.top = `${clamp(y + 8, 8, Math.max(8, window.innerHeight - bounds.height - 8))}px`;
        menu.querySelector('[aria-checked="true"]').focus({preventScroll: true});
    }

    // 빈 공간을 끌면 화면만 이동한다. 짧은 클릭은 기존처럼 재생 위치를 바꾼다.
    function beginPan(event) {
        if (exporting || !event.target.closest('#timeline') || (event.button !== 0 && event.button !== 1)) return;
        if (event.button === 0 && event.target.closest('.sound-clip')) return;
        event.preventDefault();
        skipTimelineClick = false;
        const box = $('timeline-scroll');
        box.focus({preventScroll: true});
        panState = {pointerId: event.pointerId, x: event.clientX, scroll: box.scrollLeft, moved: false, button: event.button, track: event.target.closest('.timeline-track')?.dataset.track};
        box.setPointerCapture(event.pointerId);
    }
    function movePan(event) {
        if (!panState || event.pointerId !== panState.pointerId) return;
        const delta = event.clientX - panState.x;
        if (Math.abs(delta) > 3) panState.moved = true;
        if (!panState.moved) return;
        $('timeline-scroll').classList.add('is-panning');
        $('timeline-scroll').scrollLeft = panState.scroll - delta;
    }
    function endPan(event) {
        if (!panState || event.pointerId !== panState.pointerId) return;
        skipTimelineClick = true;
        if (!panState.moved && event.type === 'pointerup' && panState.button === 0) {
            if (panState.track !== undefined) $('add-track-select').value = panState.track;
            seekTo((event.clientX - $('timeline').getBoundingClientRect().left) / pixelsPerSecond);
        }
        panState = null;
        $('timeline-scroll').classList.remove('is-panning');
        // 위치 선택은 위에서 처리했다. 이어지는 click은 중복 처리하지 않는다.
        if ($('timeline-scroll').hasPointerCapture(event.pointerId)) $('timeline-scroll').releasePointerCapture(event.pointerId);
    }

    async function exportWav() {
        if (exporting || !clips.length || pendingAdds.size) return;
        pauseTimeline();
        stopPreview();
        exporting = true;
        exportCancelled = false;
        updateControls();
        renderLibrary();
        $('export-progress').hidden = false;
        $('export-progress').value = 0;
        const sampleRate = 44100;
        const frameCount = Math.ceil(endTime() * sampleRate);
        const project = clips.map(clip => ({...clip}));
        const cancelled = () => { if (exportCancelled) throw new Error('저장을 취소했다. 편집 내용은 그대로 남아 있다.'); };
        try {
            const left = new Float32Array(frameCount);
            const right = new Float32Array(frameCount);
            for (let index = 0; index < project.length; index++) {
                cancelled();
                const clip = project[index];
                status(`WAV 만들기 · 소리 ${index + 1} / ${project.length}`);
                const buffer = await getBuffer(clip.soundId);
                cancelled();
                const channels = [buffer.getChannelData(0), buffer.getChannelData(Math.min(1, buffer.numberOfChannels - 1))];
                const start = Math.round(clip.start * sampleRate);
                const frames = Math.min(Math.floor(length(clip) * sampleRate), frameCount - start);
                const fadeFrames = Math.min(Math.round(0.004 * sampleRate), Math.floor(frames / 3));
                const ratio = buffer.sampleRate / sampleRate;
                const offset = clip.in * buffer.sampleRate;
                for (let chunk = 0; chunk < frames; chunk += 131072) {
                    const last = Math.min(frames, chunk + 131072);
                    for (let frame = chunk; frame < last; frame++) {
                        const position = offset + frame * ratio;
                        const low = Math.min(buffer.length - 1, Math.floor(position));
                        const high = Math.min(buffer.length - 1, low + 1);
                        const mix = position - low;
                        const fade = fadeFrames ? Math.min(1, frame / fadeFrames, (frames - 1 - frame) / fadeFrames) : 1;
                        const gain = clip.gain * fade;
                        left[start + frame] += (channels[0][low] * (1 - mix) + channels[0][high] * mix) * gain;
                        right[start + frame] += (channels[1][low] * (1 - mix) + channels[1][high] * mix) * gain;
                    }
                    await pauseTick();
                    cancelled();
                }
                $('export-progress').value = (index + 1) / project.length * 80;
            }
            status('WAV 파일을 준비하는 중…');
            let peak = 0;
            for (let chunk = 0; chunk < frameCount; chunk += 262144) {
                const last = Math.min(frameCount, chunk + 262144);
                for (let frame = chunk; frame < last; frame++) peak = Math.max(peak, Math.abs(left[frame]), Math.abs(right[frame]));
                await pauseTick();
                cancelled();
            }
            // 겹친 소리가 최대 음량을 넘을 때만 전체 음량을 내려 왜곡을 막는다.
            const scale = peak > 1 ? 0.98 / peak : 1;
            const data = new ArrayBuffer(44 + frameCount * 4);
            const view = new DataView(data);
            const text = (offset, value) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
            text(0, 'RIFF'); view.setUint32(4, 36 + frameCount * 4, true); text(8, 'WAVE'); text(12, 'fmt ');
            view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 2, true); view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 4, true); view.setUint16(32, 4, true); view.setUint16(34, 16, true); text(36, 'data'); view.setUint32(40, frameCount * 4, true);
            for (let chunk = 0; chunk < frameCount; chunk += 262144) {
                const last = Math.min(frameCount, chunk + 262144);
                for (let frame = chunk; frame < last; frame++) {
                    const l = clamp(left[frame] * scale, -1, 1);
                    const r = clamp(right[frame] * scale, -1, 1);
                    view.setInt16(44 + frame * 4, Math.round(l * (l < 0 ? 32768 : 32767)), true);
                    view.setInt16(46 + frame * 4, Math.round(r * (r < 0 ? 32768 : 32767)), true);
                }
                $('export-progress').value = 80 + last / frameCount * 20;
                await pauseTick();
                cancelled();
            }
            const now = new Date();
            const pad = value => String(value).padStart(2, '0');
            const fileName = `소리마당_${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
            const blob = new Blob([data], {type: 'audio/wav'});
            const url = URL.createObjectURL(blob);
            if (savedWavUrl) URL.revokeObjectURL(savedWavUrl);
            savedWavUrl = url;
            const link = $('download-wav');
            link.href = url;
            link.download = `${fileName}.wav`;
            link.hidden = false;
            link.click();
            status();
        } catch (error) { status(error.message || '파일을 저장하지 못했다. 클립 수나 길이를 줄여 다시 시도해달라.', !exportCancelled); }
        finally { exporting = false; $('export-progress').hidden = true; updateControls(); renderLibrary(); }
    }

    $('sound-search').addEventListener('input', renderLibrary);
    $('sound-person').addEventListener('change', renderLibrary);
    $('sound-list').addEventListener('click', event => {
        const button = event.target.closest('button');
        const card = event.target.closest('[data-sound-id]');
        if (!button || !card) return;
        if (button.dataset.action === 'preview') previewSound(card.dataset.soundId);
        if (button.dataset.action === 'add') addSound(card.dataset.soundId);
    });
    $('sound-list').addEventListener('dragstart', event => event.preventDefault());
    $('sound-list').addEventListener('pointerdown', beginLibraryDrag);
    window.addEventListener('pointermove', moveLibraryDrag, {passive: false});
    window.addEventListener('pointerup', endLibraryDrag);
    window.addEventListener('pointercancel', endLibraryDrag);
    $('timeline-tracks').addEventListener('dragover', event => {
        if (exporting || !Array.from(event.dataTransfer.types).includes('application/x-sound-id')) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
        const row = event.target.closest('.timeline-track');
        root.querySelectorAll('.timeline-track').forEach(item => item.classList.toggle('is-drop-target', item === row));
    });
    $('timeline-tracks').addEventListener('dragleave', event => {
        if (!$('timeline-tracks').contains(event.relatedTarget)) root.querySelectorAll('.is-drop-target').forEach(item => item.classList.remove('is-drop-target'));
    });
    $('timeline-tracks').addEventListener('drop', event => {
        event.preventDefault();
        root.querySelectorAll('.is-drop-target').forEach(item => item.classList.remove('is-drop-target'));
        if (exporting) return;
        const id = event.dataTransfer.getData('application/x-sound-id');
        const row = event.target.closest('.timeline-track');
        if (!byId.has(id) || !row) return;
        const track = Number(row.dataset.track);
        let position = Math.max(0, (event.clientX - row.getBoundingClientRect().left) / pixelsPerSecond);
        if ($('timeline-snap').checked) {
            const ends = clips.filter(clip => clip.track === track).map(clip => clip.start + length(clip));
            const nearby = ends.find(end => Math.abs(end - position) < 12 / pixelsPerSecond);
            if (nearby !== undefined) position = nearby;
        }
        addSound(id, track, position);
    });
    $('preview-stop').addEventListener('click', stopPreview);
    preview.addEventListener('ended', stopPreview);
    preview.addEventListener('error', () => { if (previewId) { stopPreview(); status('이 음원을 미리 들을 수 없다. 파일 또는 브라우저 지원 여부를 확인해달라.', true); } });
    preview.addEventListener('loadedmetadata', () => { if (previewId && Number.isFinite(preview.duration)) { durations.set(previewId, preview.duration); renderLibrary(); } });
    $('timeline-play').addEventListener('click', playTimeline);
    $('timeline-stop').addEventListener('click', () => { pauseTimeline(true); stopPreview(); });
    $('timeline-seek').addEventListener('input', event => seekTo(Number(event.target.value)));
    $('timeline-ruler').addEventListener('click', event => seekTo((event.clientX - $('timeline-ruler').getBoundingClientRect().left) / pixelsPerSecond));
    $('timeline-tracks').addEventListener('click', event => {
        if (!event.target.closest('.sound-clip') && !exporting) {
            const row = event.target.closest('.timeline-track');
            if (row) $('add-track-select').value = row.dataset.track;
            seekTo((event.clientX - $('timeline-tracks').getBoundingClientRect().left) / pixelsPerSecond);
        }
    });
    $('timeline-tracks').addEventListener('dblclick', event => {
        const element = event.target.closest('.sound-clip');
        if (!element || event.target.closest('.clip-handle') || exporting) return;
        event.preventDefault();
        pauseTimeline();
        selectedId = Number(element.dataset.clipId);
        cursor = (event.clientX - $('timeline-tracks').getBoundingClientRect().left) / pixelsPerSecond;
        editClip('split');
        root.querySelector(`[data-clip-id="${selectedId}"]`)?.focus({preventScroll: true});
    });
    $('timeline-tracks').addEventListener('pointerdown', beginDrag);
    window.addEventListener('pointermove', moveDrag);
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);
    $('timeline-tracks').addEventListener('keydown', event => {
        const element = event.target.closest('.sound-clip');
        if (!element || exporting) return;
        selectedId = Number(element.dataset.clipId);
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            renderEditor();
            root.querySelector(`[data-clip-id="${selectedId}"]`)?.focus({preventScroll: true});
        }
        else if (event.key.toLowerCase() === 's' && !event.metaKey && !event.ctrlKey && !event.altKey) {
            event.preventDefault();
            editClip('split');
            root.querySelector(`[data-clip-id="${selectedId}"]`)?.focus({preventScroll: true});
        }
        else if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); editClip('delete'); }
        else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            event.preventDefault(); pauseTimeline(); recordChange();
            const clip = selected();
            clip.start = clamp(clip.start + (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 1 : 0.1), 0, LIMIT - length(clip));
            renderEditor(); root.querySelector(`[data-clip-id="${clip.id}"]`)?.focus({preventScroll: true});
        }
    });
    // 복사/붙여넣기는 생성기 안에서만 동작하며 검색창의 텍스트 편집은 건드리지 않는다.
    root.addEventListener('keydown', event => {
        if (exporting || event.altKey || !(event.ctrlKey || event.metaKey) || event.target.closest('input, textarea, select, [contenteditable="true"]')) return;
        const key = event.key.toLowerCase();
        if (key === 'c' && event.target.closest('.sound-clip') && selected()) {
            event.preventDefault();
            copiedClip = {...selected()};
        } else if (key === 'v' && copiedClip && event.target.closest('.sound-editor')) {
            event.preventDefault();
            pasteClip();
        }
    });
    // 브라우저의 편집 메뉴에서 실행하는 복사/붙여넣기도 지원한다.
    root.addEventListener('copy', event => {
        if (exporting || !event.target.closest('.sound-clip') || !selected()) return;
        copiedClip = {...selected()};
        event.clipboardData?.setData('text/plain', `소리마당 클립: ${byId.get(copiedClip.soundId).name}`);
        event.preventDefault();
    });
    root.addEventListener('paste', event => {
        if (!copiedClip || exporting || !event.target.closest('.sound-editor') || event.target.closest('input, textarea, select, [contenteditable="true"]')) return;
        event.preventDefault();
        pasteClip();
    });
    $('timeline-tracks').addEventListener('contextmenu', openColorMenu);
    $('clip-color-menu').addEventListener('click', event => {
        const button = event.target.closest('button[data-color]');
        const clip = clips.find(item => item.id === colorMenuClipId);
        if (!button || !clip || exporting) return;
        if (safeClipColor(clip.color) !== button.dataset.color) {
            recordChange();
            clip.color = safeClipColor(button.dataset.color);
            renderEditor();
        }
        closeColorMenu(true);
    });
    $('clip-color-menu').addEventListener('keydown', event => {
        if (event.key === 'Escape') { event.preventDefault(); closeColorMenu(true); }
        else if (event.key === 'Tab') closeColorMenu();
        else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
            event.preventDefault();
            const buttons = [...$('clip-color-menu').querySelectorAll('button')];
            const index = buttons.indexOf(document.activeElement);
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
            buttons[next].focus();
        }
    });
    document.addEventListener('pointerdown', event => { if (!event.target.closest('#clip-color-menu')) closeColorMenu(); });
    document.addEventListener('scroll', () => closeColorMenu(), true);
    window.addEventListener('resize', () => closeColorMenu());
    window.addEventListener('hashchange', () => closeColorMenu());
    $('timeline-scroll').addEventListener('pointerdown', beginPan);
    window.addEventListener('pointermove', movePan);
    window.addEventListener('pointerup', endPan);
    window.addEventListener('pointercancel', endPan);
    $('timeline-scroll').addEventListener('click', event => {
        if (skipTimelineClick) { event.preventDefault(); event.stopPropagation(); skipTimelineClick = false; }
    }, true);
    $('timeline-scroll').addEventListener('wheel', event => {
        if (event.ctrlKey || event.metaKey || (!event.shiftKey && !event.deltaX)) return;
        const box = $('timeline-scroll');
        const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? box.clientWidth : 1;
        const delta = (event.shiftKey ? (event.deltaY || event.deltaX) : event.deltaX) * unit;
        if (box.scrollWidth <= box.clientWidth) return;
        event.preventDefault();
        box.scrollLeft += delta;
    }, {passive: false});
    $('timeline-zoom').addEventListener('input', event => { pixelsPerSecond = Number(event.target.value); renderTimeline(); });
    $('edit-undo').addEventListener('click', () => { if (!undoStack.length || exporting) return; redoStack.push(snapshot()); restore(undoStack.pop()); status(); });
    $('edit-redo').addEventListener('click', () => { if (!redoStack.length || exporting) return; undoStack.push(snapshot()); restore(redoStack.pop()); status(); });
    $('export-wav').addEventListener('click', exportWav);
    $('export-cancel').addEventListener('click', () => { exportCancelled = true; status('저장을 취소하는 중…'); });
    window.addEventListener('sound-start', event => { if (event.detail?.owner !== 'generator') { pauseTimeline(); stopPreview(); } });
    window.addEventListener('pagehide', event => { pauseTimeline(); stopPreview(); if (!event.persisted && savedWavUrl) URL.revokeObjectURL(savedWavUrl); });
    restoreProject();
    renderLibrary();
    renderEditor();
    if (!library.length) status('불러온 음원이 없다. 음원 목록 파일을 확인해달라.', true);
})();
