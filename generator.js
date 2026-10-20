/* 소리마당 생성기: 원본 목록, 타임라인 편집, 재생, WAV·MP3 저장. */
(async () => {
    'use strict';
    const root = document.getElementById('sound-generator');
    if (!root) return;
    root.innerHTML = '<header class="generator-header"><button id="generator-back" type="button">뒤로가기</button></header><p role="status">소리마당을 불러오는 중…</p>';
    let userStorageError = '';
    let userSounds = [];
    try { userSounds = await window.SoriUserSounds.load(); }
    catch (error) { userStorageError = error.message; }
    const library = [...(Array.isArray(window.soundLibrary) ? window.soundLibrary : []), ...userSounds];
    const byId = new Map(library.map(sound => [String(sound.id), sound]));
    const MIN_CLIP = 0.05;
    const CACHE_LIMIT = 64 * 1024 * 1024;
    const SOURCE_LIMIT = 12;
    const SOURCE_SECONDS_LIMIT = 600;
    const SAVE_KEY = 'sorimadang-project-v1';
    let activeDecodes = 0;
    const decodeQueue = [];
    let context;
    let clips = [];
    let trackCount = 4;
    let tracks = Array.from({length: 4}, () => ({mute:false, solo:false, locked:false, volume:1}));
    let volumeEdit = null;
    let grid = {bpm: 120, beats: 4, bars: 16};
    let storageWarningShown = false;
    let selectedId = null;
    let selectedIds = new Set();
    let cursor = 0;
    let pixelsPerSecond = 12;
    let activeTrack = 0;
    let activeTool = 'select';
    let waveScale = 1;
    let rulerDrag = null;
    let exportRange = null; // null이면 전체 길이를 자동으로 따라간다.
    let rangeDrag = null;
    let timelineExtra = 0;
    let cutPointer = null;
    let initialGridFit = false;
    const {fades, envelope, fadePoints, mixClipBlock, wavHeader, wavBlock, createMp3Stream} = window.SoriAudio;
    let nextId = 1;
    let playing = false;
    let playEpoch = 0;
    let playStartTime = 0;
    let playStartCursor = 0;
    let playFrame = 0;
    let playTimer = 0;
    let exporting = false;
    let exportCancelled = false;
    let savedAudioUrl = null;
    let previewId = null;
    let previewEpoch = 0;
    let dragState = null;
    let copiedClips = []; // 이 생성기 안에서 복사한 클립. 원본 파일은 복제하지 않는다.
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

    const icon = name => {
        const paths = {
            undo:'<path d="M7 6h6a7 7 0 1 1-7 7"/><path d="M7 2 2 6l5 4Z" fill="currentColor" stroke="none"/>',
            zoom:'<path d="M3 12h18M7 8l-4 4 4 4M17 8l4 4-4 4"/>',
            height:'<path d="M12 3v18M8 7l4-4 4 4M8 17l4 4 4-4"/>',
            trash:'<path d="M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7"/>',
            wave:'<path d="M3 10v4M7 6v12M12 2v20M17 7v10M21 10v4"/>'
        };
        return `<svg class="control-icon${name === 'redo' ? ' icon-redo' : ''}" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">${paths[name === 'redo' ? 'undo' : name]}</svg>`;
    };

    root.innerHTML = `
        <header class="generator-header">
            <button id="generator-back" type="button">뒤로가기</button>
            <div class="export-controls">
                <div class="save-options"><button id="save-button" type="button" aria-expanded="false" aria-controls="save-menu" disabled>저장</button>
                    <div id="save-menu" hidden><button id="export-wav" type="button">.wav 저장</button><button id="export-mp3" type="button">.mp3 저장</button></div>
                </div>
                <button id="export-cancel" type="button" hidden>저장 취소</button><a id="download-audio" hidden>파일 다운로드</a>
            </div>
        </header>
        <div id="library-split">
        <section id="original-library" class="sound-library" aria-labelledby="sound-library-title">
            <div class="generator-heading"><h2 id="sound-library-title">소리마당 <span id="sound-count"></span></h2><span id="library-preview-name" aria-live="polite"></span></div>
            <div class="library-filters"><input id="sound-search" type="search" aria-label="소리 찾기" placeholder="파일 이름, 참여자, 날짜 검색"><label><select id="sound-person" aria-label="참여자로 분류"><option value="">모두</option></select></label><button id="preview-stop" type="button" disabled>미리듣기 정지</button></div>
            <div id="sound-list" class="sound-list" aria-label="원본 음원 목록"></div>
        </section>
        <div id="library-divider" role="separator" tabindex="0" aria-label="소리마당과 소리마당+ 너비 조절" aria-controls="original-library user-library" aria-orientation="vertical" aria-valuemin="20" aria-valuemax="80" aria-valuenow="50" title="좌우로 끌어 너비 조절 · 두 번 클릭하면 반씩 나누기"></div>
        ${window.SoriUserSounds.markup}
        </div>
        <section class="sound-editor" aria-label="소리 편집">
            <div class="editor-toolbar">
                <button id="timeline-play" type="button" aria-label="재생" title="재생" disabled>▶</button><button id="timeline-stop" type="button" aria-label="처음으로" title="처음으로">⏮</button><output id="timeline-time">00:00.0 / 00:00.0</output>
                <button id="edit-undo" type="button" aria-label="되돌리기" disabled>${icon('undo')}</button><button id="edit-redo" type="button" aria-label="다시 실행" disabled>${icon('redo')}</button>
                <div class="editor-tools" role="toolbar" aria-label="편집 도구">
                    <button type="button" data-tool="select" aria-label="선택" aria-pressed="true" title="선택·이동 (1)">↖</button>
                    <button type="button" data-tool="cut" aria-label="자르기" aria-pressed="false" title="자르기 (2)">✂</button>
                    <button type="button" data-tool="fade" aria-label="페이드" aria-pressed="false" title="페이드인·페이드아웃 (3)">◿</button>
                </div>
                <label>박자<select id="grid-meter"><option value="3">3/4</option><option value="4" selected>4/4</option></select></label>
                <label for="grid-bpm">BPM</label><div class="number-control"><input id="grid-bpm" type="number" min="20" max="300" step="1" value="120"><span class="number-buttons"><button type="button" data-number="grid-bpm" data-step="1" aria-label="BPM 증가">▴</button><button type="button" data-number="grid-bpm" data-step="-1" aria-label="BPM 감소">▾</button></span></div>
                <label for="grid-bars">마디</label><div class="number-control"><input id="grid-bars" type="number" min="4" max="128" step="1" value="16"><span class="number-buttons"><button type="button" data-number="grid-bars" data-step="1" aria-label="마디 증가">▴</button><button type="button" data-number="grid-bars" data-step="-1" aria-label="마디 감소">▾</button></span></div>
                <label class="snap-option"><input id="timeline-snap" type="checkbox" checked> 스냅</label>
                <label title="확대">${icon('zoom')}<input aria-label="확대" id="timeline-zoom" type="range" min="4" max="120" value="12" step="any"></label>
                <label title="파형">${icon('wave')}<input aria-label="파형" id="wave-zoom" type="range" min="1" max="12" value="1" step="0.25"></label>
                <label title="트랙 높이">${icon('height')}<input aria-label="트랙 높이" id="track-height" type="range" min="36" max="280" value="104" step="4"></label>
            </div>
            <div class="timeline-layout"><div id="track-sidebar" aria-label="트랙 조작"></div>
            <div class="timeline-scroll" id="timeline-scroll" tabindex="0" aria-label="타임라인. 가로로 스크롤할 수 있다.">
                <div id="timeline" class="timeline"><div id="export-range-lane"><div id="export-range" title="양 끝을 끌어 저장 범위 조절 · 가운데를 끌어 이동 · 두 번 클릭하면 전체 선택" aria-label="저장 범위"><button id="export-range-start" type="button" data-range="start" aria-label="저장 범위 시작 조절"></button><button id="export-range-end" type="button" data-range="end" aria-label="저장 범위 끝 조절"></button></div></div><div id="timeline-ruler" class="timeline-ruler" role="slider" tabindex="0" aria-label="재생 위치" aria-valuemin="0" aria-valuemax="60" aria-valuenow="0"></div><div id="timeline-tracks"></div><div id="selection-box" hidden aria-hidden="true"></div><div id="timeline-cursor" class="timeline-cursor" aria-hidden="true"></div><div id="cut-cursor" hidden aria-hidden="true"><span id="cut-time"></span></div></div>
            </div>
            </div>
            <button id="add-track" type="button" aria-label="트랙 추가" title="트랙 추가">＋</button>
            <progress id="export-progress" max="100" value="0" hidden aria-label="파일 저장 진행률"></progress>
            <p id="generator-status" class="generator-status" role="status" aria-live="polite" hidden></p>
        </section>
        <div id="clip-color-menu" role="menu" aria-label="클립 색상" hidden>
            <span class="color-menu-title">클립 색상</span>
            ${clipColors.map(color => `<button type="button" role="menuitemradio" aria-checked="false" data-color="${color.value}"><span class="color-swatch" style="background:${color.value || '#242424'}" aria-hidden="true"></span>${color.name}</button>`).join('')}
        </div>`;

    const $ = id => root.querySelector(`#${id}`);
    // 기본 검색 X 대신 모든 브라우저에서 같은 흰색 지우기 버튼을 쓴다.
    ['sound-search', 'user-sound-search'].forEach(id => {
        const input = $(id);
        const box = document.createElement('div');
        box.className = 'search-box';
        input.before(box); box.append(input);
        const clear = document.createElement('button');
        clear.type = 'button'; clear.className = 'search-clear';
        clear.setAttribute('aria-label', '검색어 지우기');
        clear.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true" focusable="false"><path d="M5 5l10 10M15 5 5 15"/></svg>';
        box.append(clear);
        const sync = () => { clear.hidden = !input.value; };
        input.addEventListener('input', sync);
        clear.addEventListener('click', () => {
            input.value = ''; input.dispatchEvent(new Event('input', {bubbles: true})); input.focus();
        });
        sync();
    });
    const status = (message = '', error = false) => {
        $('generator-status').textContent = message;
        $('generator-status').classList.toggle('is-error', error);
        $('generator-status').hidden = !message;
    };
    [...new Set(library.filter(sound => !sound.isUser).map(sound => sound.person).filter(Boolean))].forEach(person => {
        const option = document.createElement('option');
        option.value = person;
        option.textContent = person;
        $('sound-person').append(option);
    });

    function soundCard(sound) {
        const id = String(sound.id), duration = durations.get(id);
        const date = sound.isUser ? (sound.recordedDate || sound.registeredDate) : '';
        return `<article class="sound-card${previewId === id ? ' is-previewing' : ''}" draggable="false" data-sound-id="${escape(id)}"><span class="sound-drag-handle" title="타임라인으로 끌어서 추가" aria-hidden="true">⠿</span><div class="sound-card-info"><span class="sound-person-name">${escape(sound.person)}${sound.day ? ` · ${escape(sound.day)}일` : ''}</span><span class="sound-name" title="${escape(sound.name)}">${escape(sound.name)}</span>${sound.isUser && window.SoriUserSounds.sharing ? `<span class="sound-visibility">${sound.isPublic ? '공유된 소리' : '이 브라우저'}</span>` : ''}${date ? `<span class="sound-date">${sound.recordedDate ? '녹음' : '등록'} · ${escape(date)}</span>` : ''}<span class="sound-duration">${duration ? formatTime(duration) : '원본 녹음'}</span></div><div class="sound-card-buttons"><button type="button" data-action="preview" aria-label="${escape(sound.name)} ${previewId === id ? '미리듣기 정지' : '미리듣기'}">${previewId === id ? '■' : '▶'}</button><button type="button" data-action="add" aria-label="${escape(sound.name)} 타임라인에 추가"${exporting || pendingAdds.has(id) ? ' disabled' : ''}>${pendingAdds.has(id) ? '…' : '＋'}</button>${sound.isUser && !sound.isPublic && window.SoriUserSounds.sharing ? '<button type="button" data-action="publish">공유</button>' : ''}</div></article>`;
    }
    function renderLibrary() {
        const query = $('sound-search').value.trim().toLocaleLowerCase();
        const person = $('sound-person').value;
        const originals = library.filter(sound => !sound.isUser);
        const filtered = originals.filter(sound => (!person || sound.person === person) && (!query || `${sound.name} ${sound.person} ${sound.day ?? ''}`.toLocaleLowerCase().includes(query)));
        $('sound-count').textContent = `(${filtered.length} / ${originals.length})`;
        $('sound-list').innerHTML = filtered.map(soundCard).join('') || '<p class="empty-library">검색 결과가 없다.</p>';
        const userQuery = $('user-sound-search').value.trim().toLocaleLowerCase();
        const added = library.filter(sound => sound.isUser);
        const userFiltered = added.filter(sound => `${sound.name} ${sound.person} ${sound.recordedDate || sound.registeredDate}`.toLocaleLowerCase().includes(userQuery));
        $('user-sound-count').textContent = `(${userFiltered.length} / ${added.length})`;
        $('user-sound-list').innerHTML = userFiltered.map(soundCard).join('') || `<p class="empty-library">${userQuery ? '검색 결과가 없다.' : '이 공간에서 녹음해보거나 가지고 있는 음원 파일을 추가해 재료가 될 소리를 남겨보자.'}</p>`;
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

    function normalizeTracks(saved, count) {
        return Array.from({length:count}, (_, index) => {
            const track = saved?.[index];
            return {mute:!!track?.mute, solo:!!track?.solo, locked:!!track?.locked, volume:Number.isFinite(track?.volume) ? clamp(track.volume,0,1) : 1};
        });
    }
    function trackLocked(index) { return !!tracks[index]?.locked; }
    function trackLevel(index) {
        const track = tracks[index];
        if (!track) return 1;
        if (track.mute || (tracks.some(item => item.solo) && !track.solo)) return 0;
        return track.volume;
    }
    function updateTrackMix() {
        if (!context) return;
        nodes.forEach(node => {
            node.output.gain.cancelScheduledValues(context.currentTime);
            node.output.gain.setTargetAtTime(trackLevel(node.track), context.currentTime, .01);
        });
    }
    function renderTrackSidebar() {
        $('track-sidebar').innerHTML = '<div class="track-sidebar-top" aria-hidden="true"></div>' + tracks.map((track,index) => `
            <div class="track-strip" data-track="${index}" aria-label="트랙 ${index+1} 조작">
                <span class="track-number">${index+1}</span>
                <button type="button" class="track-delete" data-track-action="delete" aria-label="트랙 ${index+1} 삭제" title="트랙 삭제 · 되돌리기로 복구">${icon('trash')}</button>
                <button type="button" class="track-mute" data-track-action="mute" aria-pressed="${track.mute}" aria-label="트랙 ${index+1} 묵음" title="Mute">M</button>
                <button type="button" class="track-solo" data-track-action="solo" aria-pressed="${track.solo}" aria-label="트랙 ${index+1} 단독 재생" title="Solo">S</button>
                <button type="button" class="track-lock" data-track-action="locked" aria-pressed="${track.locked}" aria-label="트랙 ${index+1} 잠금" title="Lock">L</button>
                <input class="track-volume" type="range" min="0" max="100" step="1" value="${Math.round(track.volume*100)}" aria-label="트랙 ${index+1} 음량" title="음량 ${Math.round(track.volume*100)}%" style="--track-volume-fill:${track.volume*100}%">
            </div>`).join('');
        // renderTimeline은 드래그 중에도 호출될 수 있으므로 현재 잠금 상태를 즉시 반영한다.
        $('track-sidebar').querySelectorAll('button, input').forEach(control => { control.disabled = exporting || (control.dataset.trackAction === 'delete' && (pendingAdds.size > 0 || trackLocked(Number(control.closest('[data-track]').dataset.track)))); });
    }
    function finishVolumeEdit() {
        if (!volumeEdit) return;
        const edit = volumeEdit; volumeEdit = null;
        if (edit.history.tracks[edit.track]?.volume !== tracks[edit.track]?.volume) {
            undoStack.push(edit.history); if (undoStack.length > 50) undoStack.shift(); redoStack.length=0;
        }
        saveProject(); updateControls();
    }
    function deleteTrack(index) {
        if (exporting || pendingAdds.size || trackLocked(index) || !tracks[index]) return;
        finishVolumeEdit(); pauseTimeline(); recordChange();
        clips = clips.filter(clip => clip.track !== index);
        clips.forEach(clip => { if (clip.track > index) clip.track--; });
        tracks.splice(index,1); trackCount--;
        selectedIds = new Set([...selectedIds].filter(id => clips.some(clip => clip.id === id)));
        if (!selectedIds.has(selectedId)) selectedId = [...selectedIds][0] ?? null;
        activeTrack = Math.max(0,Math.min(activeTrack > index ? activeTrack-1 : activeTrack,trackCount-1));
        cursor=Math.min(cursor,endTime()); renderEditor();
    }
    $('track-sidebar').addEventListener('click', event => {
        const button=event.target.closest('[data-track-action]');
        if (!button || exporting) return;
        const index=Number(button.closest('[data-track]').dataset.track), action=button.dataset.trackAction;
        if (action==='delete') { deleteTrack(index); return; }
        finishVolumeEdit(); recordChange(); tracks[index][action]=!tracks[index][action];
        updateTrackMix(); renderEditor();
        $('track-sidebar').querySelector(`[data-track="${index}"] [data-track-action="${action}"]`)?.focus({preventScroll:true});
    });
    $('track-sidebar').addEventListener('input', event => {
        if (!event.target.matches('.track-volume') || exporting) return;
        const index=Number(event.target.closest('[data-track]').dataset.track);
        if (!volumeEdit) volumeEdit={track:index,history:snapshot()};
        tracks[index].volume=clamp(Number(event.target.value)/100,0,1);
        event.target.style.setProperty('--track-volume-fill',`${tracks[index].volume*100}%`);
        event.target.title=`음량 ${Math.round(tracks[index].volume*100)}%`;
        updateTrackMix(); saveProject();
    });
    $('track-sidebar').addEventListener('change', finishVolumeEdit);
    $('track-sidebar').addEventListener('focusout', finishVolumeEdit);

    function snapshot() { return { clips: clips.map(clip => ({...clip})), trackCount, tracks: tracks.map(track => ({...track})), grid: {...grid}, selectedId, selectedIds: [...selectedIds], exportRange: exportRange ? {...exportRange} : null }; }
    function saveProject() {
        // 로컬·공용 음원 로딩이 실패하면 기존 프로젝트의 음원 참조를 덮어쓰지 않는다.
        if (userStorageError || window.SoriUserSounds.hasLoadError()) return;
        try {
            const sources = {};
            clips.forEach(clip => { sources[clip.soundId] = durations.get(clip.soundId); });
            localStorage.setItem(SAVE_KEY, JSON.stringify({...snapshot(), sources, version: 1}));
        } catch (_) {
            if (!storageWarningShown) {
                storageWarningShown = true;
                status('편집 내용을 자동 저장할 수 없다. 페이지를 닫기 전에 파일로 내려받아달라.', true);
            }
        }
    }
    function restoreProject() {
        try {
            const saved = JSON.parse(localStorage.getItem(SAVE_KEY) || 'null');
            if (!saved || saved.version !== 1 || !Array.isArray(saved.clips)) return;
            trackCount = Math.max(0, Math.min(1000, Math.floor(Number(saved.trackCount ?? 4))));
            tracks = normalizeTracks(saved.tracks, trackCount);
            grid = validGrid(saved.grid);
            const ids = new Set();
            const restored = [];
            for (const raw of saved.clips.slice(0, 80)) {
                const soundId = String(raw.soundId);
                if (!byId.has(soundId) || !['start', 'in', 'out', 'gain', 'track'].every(key => Number.isFinite(raw[key]))) continue;
                const maximum = durations.get(soundId) || Number(saved.sources?.[soundId]);
                const out = Math.min(raw.out, maximum);
                if (!maximum || raw.in < 0 || raw.out > maximum + 0.1 || out - raw.in < MIN_CLIP || raw.start < 0) continue;
                durations.set(soundId, maximum);
                if (sourceBudget([...ids, soundId])) continue;
                ids.add(soundId);
                restored.push({ id: nextId++, soundId, track: clamp(Math.floor(raw.track), 0, trackCount - 1), start: raw.start, in: raw.in, out, gain: clamp(raw.gain, 0, 2), color: safeClipColor(raw.color), fadeIn: Math.max(0, Number(raw.fadeIn) || 0), fadeOut: Math.max(0, Number(raw.fadeOut) || 0) });
            }
            clips = restored;
            exportRange = saved.exportRange && Number.isFinite(saved.exportRange.start) && Number.isFinite(saved.exportRange.end)
                && saved.exportRange.start >= 0 && saved.exportRange.end > saved.exportRange.start ? {...saved.exportRange} : null;
            selectOnly(clips[0]?.id ?? null);
        } catch (_) { /* 저장 정보가 없거나 읽을 수 없으면 빈 작업으로 시작한다. */ }
    }
    function recordChange() {
        undoStack.push(snapshot());
        if (undoStack.length > 50) undoStack.shift();
        redoStack.length = 0;
    }
    function restore(state) {
        pauseTimeline();
        trackCount = Math.max(0, state.trackCount ?? 4);
        tracks = normalizeTracks(state.tracks, trackCount);
        grid = validGrid(state.grid);
        clips = state.clips.map(clip => ({...clip}));
        activeTrack = Math.max(0, Math.min(activeTrack, trackCount - 1));
        selectedIds = new Set((state.selectedIds || [state.selectedId]).filter(id => clips.some(clip => clip.id === id)));
        selectedId = selectedIds.has(state.selectedId) ? state.selectedId : [...selectedIds][0] ?? null;
        exportRange = state.exportRange ? {...state.exportRange} : null;
        timelineExtra = 0;
        cursor = Math.min(cursor, endTime());
        renderEditor();
    }

    function viewDuration() {
        return Math.max(.05, timelineExtra, clips.length ? endTime() : grid.bars * barSeconds());
    }
    function updateZoomBounds() {
        const slider = $('timeline-zoom'), width = $('timeline-scroll').clientWidth;
        if (!width) return;
        // 가장 멀리 놓인 클립 끝이 화면 오른쪽에 닿는 배율이 축소 한계다.
        const minimum = width / viewDuration();
        slider.min = String(minimum);
        slider.max = String(Math.max(120, minimum * 4));
        if (!dragState && !libraryDrag && !panState && !rulerDrag && !rangeDrag) pixelsPerSecond = clamp(pixelsPerSecond, minimum, Number(slider.max));
        slider.value = String(pixelsPerSecond);
    }
    function selectOnly(id) {
        selectedId = id;
        selectedIds = new Set(id == null ? [] : [id]);
    }
    function selectedClips() { return clips.filter(clip => selectedIds.has(clip.id)); }
    function paintSelection() {
        root.querySelectorAll('.sound-clip').forEach(element => {
            const chosen = selectedIds.has(Number(element.dataset.clipId));
            element.classList.toggle('is-selected', chosen);
            element.setAttribute('aria-pressed', String(chosen));
        });
        drawWaves();
    }

    function renderEditor() {
        renderTimeline();
        syncGridControls();
        updateControls();
        saveProject();
    }

    function renderTimeline() {
        tracks = normalizeTracks(tracks, trackCount);
        renderTrackSidebar();
        updateTimelineSize();
        $('timeline-tracks').innerHTML = Array.from({length: trackCount}, (_, track) => `<div class="timeline-track${trackLocked(track) ? ' is-locked' : ''}" data-track="${track}" aria-label="트랙 ${track + 1}"><span class="track-name">트랙 ${track + 1}</span>${clips.filter(clip => clip.track === track).map(clip => {
            const sound = byId.get(clip.soundId);
            return `<div class="sound-clip${selectedIds.has(clip.id) ? ' is-selected' : ''}" data-clip-id="${clip.id}" tabindex="0" role="button" aria-label="${escape(sound.name)}, 트랙 ${track + 1}, 시작 ${clip.start.toFixed(2)}초, 길이 ${length(clip).toFixed(2)}초. 양 끝을 끌어 자르기, 더블 클릭 또는 S 키로 나누기, Delete 키로 삭제." aria-pressed="${selectedIds.has(clip.id)}" style="${safeClipColor(clip.color) ? `--clip-color:${safeClipColor(clip.color)};` : ''}left:${clip.start * pixelsPerSecond}px;width:${Math.max(2, length(clip) * pixelsPerSecond)}px"><canvas class="clip-wave" aria-hidden="true"></canvas><svg class="clip-fade" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><path></path></svg><button class="fade-handle fade-handle-in" data-fade="in" type="button" aria-label="페이드인 길이 조절" title="좌우 드래그 또는 방향키로 페이드인 조절"></button><button class="fade-handle fade-handle-out" data-fade="out" type="button" aria-label="페이드아웃 길이 조절" title="좌우 드래그 또는 방향키로 페이드아웃 조절"></button><span class="clip-name">${escape(sound.name)}</span><span class="clip-duration">${formatTime(length(clip))}</span><span class="clip-handle clip-handle-left" data-handle="left" title="시작 부분 자르기"></span><span class="clip-handle clip-handle-right" data-handle="right" title="끝 부분 자르기"></span></div>`;
        }).join('')}</div>`).join('');
        renderGrid();
        drawWaves();
        updateCursor();
        renderExportRange();
        updateCutCursor();
    }

    function updateTimelineSize() {
        updateZoomBounds();
        $('timeline').style.width = `${Math.max(1, viewDuration() * pixelsPerSecond)}px`;
        $('timeline-ruler').setAttribute('aria-valuemax', viewDuration());
        renderRuler();
        renderGrid();
    }
    function renderRuler() {
        const box = $('timeline-scroll');
        const bar = barSeconds();
        const interval = Math.max(1, Math.ceil(80 / (bar * pixelsPerSecond))) * bar;
        // 긴 작업에서도 화면 주변의 눈금만 만들어 DOM 크기를 일정하게 유지한다.
        const first = Math.max(0, Math.floor((box.scrollLeft - box.clientWidth) / pixelsPerSecond / interval));
        const last = Math.min(Math.floor(viewDuration() / interval), Math.ceil((box.scrollLeft + box.clientWidth * 2) / pixelsPerSecond / interval));
        $('timeline-ruler').innerHTML = Array.from({length: Math.max(0, last - first + 1)}, (_, i) => {
            const time = (first + i) * interval;
            return `<span class="time-mark" style="left:${time * pixelsPerSecond}px"> ${Math.round(time / bar) + 1} · ${formatTime(time).split('.')[0]}</span>`;
        }).join('');
    }
    function extendTimelineAtRight(clientX) {
        const box = $('timeline-scroll'), bounds = box.getBoundingClientRect();
        if (clientX > bounds.right - 28 && box.scrollLeft + box.clientWidth >= box.scrollWidth - 60) {
            timelineExtra = viewDuration() + 30;
            updateTimelineSize();
        }
    }

    function drawWaves() {
        root.querySelectorAll('.sound-clip').forEach(element => {
            const clip = clips.find(item => item.id === Number(element.dataset.clipId));
            if (!clip) return;
            const values = peaks.get(clip.soundId);
            const fullDuration = durations.get(clip.soundId);
            const canvas = element.querySelector('canvas');
            const width = Math.max(1, Math.round(length(clip) * pixelsPerSecond));
            const height = Math.max(1, element.clientHeight || 82);
            canvas.width = Math.min(4000, width * (window.devicePixelRatio || 1));
            canvas.height = height * (window.devicePixelRatio || 1);
            const ctx = canvas.getContext('2d');
            ctx.scale(canvas.width / width, canvas.height / height);
            ctx.strokeStyle = safeClipColor(clip.color) ? '#dddddd' : selectedIds.has(clip.id) ? '#999' : '#626262';
            ctx.lineWidth = 1;
            ctx.beginPath();
            for (let x = 0; x < width; x += 2) {
                const fraction = (clip.in + x / width * length(clip)) / fullDuration;
                const peak = values ? values[Math.min(values.length - 1, Math.floor(fraction * values.length))] || 0 : 0.02;
                const amplitude = Math.min(height / 2 - 2, Math.max(1, peak * (height / 2 - 4) * waveScale));
                ctx.moveTo(x, height / 2 - amplitude);
                ctx.lineTo(x, height / 2 + amplitude);
            }
            ctx.stroke();
            drawFade(element, clip);
        });
    }

    function drawFade(element, clip) {
        const {duration, fadeIn, fadeOut} = fades(clip);
        const left = duration ? fadeIn / duration * 100 : 0;
        const right = duration ? (1 - fadeOut / duration) * 100 : 100;
        element.querySelector('.clip-fade path').setAttribute('d', `M 0 ${fadeIn ? 100 : 0} L ${left} 0 L ${right} 0 L 100 ${fadeOut ? 100 : 0}`);
        element.querySelector('.fade-handle-in').style.left = `clamp(0px, ${left}%, calc(100% - 12px))`;
        element.querySelector('.fade-handle-out').style.left = `max(12px, ${right}%)`;
        element.querySelector('.fade-handle-in').setAttribute('aria-label', `페이드인 ${fadeIn.toFixed(1)}초, 방향키로 조절`);
        element.querySelector('.fade-handle-out').setAttribute('aria-label', `페이드아웃 ${fadeOut.toFixed(1)}초, 방향키로 조절`);
    }

    function updateControls() {
        $('timeline-play').disabled = !clips.length || exporting;
        $('timeline-play').textContent = playing ? 'Ⅱ' : '▶';
        $('timeline-play').setAttribute('aria-label', playing ? '일시정지' : '재생');
        $('timeline-play').title = playing ? '일시정지' : '재생';
        $('timeline-stop').disabled = exporting;
        $('add-track').disabled = exporting;
        root.querySelectorAll('#track-sidebar button, #track-sidebar input').forEach(control => { control.disabled = exporting || (control.dataset.trackAction === 'delete' && (trackLocked(Number(control.closest('[data-track]').dataset.track)) || pendingAdds.size > 0)); });
        root.querySelectorAll('[data-number]').forEach(button => { button.disabled = exporting; });
        ['export-range-start', 'export-range-end', 'grid-meter', 'grid-bpm', 'grid-bars'].forEach(id => { $(id).disabled = exporting || (id.startsWith('export-') && !clips.length); });
        $('edit-undo').disabled = !undoStack.length || exporting;
        $('edit-redo').disabled = !redoStack.length || exporting;
        ['save-button', 'export-wav', 'export-mp3'].forEach(id => { $(id).disabled = !clips.length || exporting || pendingAdds.size > 0; });
        root.querySelectorAll('[data-tool]').forEach(button => { button.disabled = exporting; });
        $('export-cancel').hidden = !exporting;
        root.classList.toggle('is-exporting', exporting);
    }

    async function addSound(id, track = activeTrack, start = null) {
        if (exporting || pendingAdds.has(id)) return;
        if (trackLocked(track)) { status('잠금을 해제한 트랙에 소리를 놓아달라.', true); return; }
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
            if (exporting || trackLocked(track)) return;
            if (clips.length >= 80) throw new Error('클립은 최대 80개까지 사용할 수 있다. 사용하지 않는 클립을 삭제해달라.');
            const actualBudgetError = sourceBudget([...clips.map(clip => clip.soundId), ...pendingAdds.keys()]);
            if (actualBudgetError) throw new Error(actualBudgetError);
            pauseTimeline();
            const targetTrack = Math.max(0, Math.min(track, trackCount - 1));
            let position = start === null ? clips.filter(clip => clip.track === targetTrack).reduce((end, clip) => Math.max(end, clip.start + length(clip)), 0) : Math.max(0, start);
            position = snapTime(position);
            recordChange();
            if (!trackCount) { trackCount = 1; tracks = normalizeTracks([], 1); }
            const clip = { id: nextId++, soundId: id, track: targetTrack, start: position, in: 0, out: buffer.duration, gain: 1 };
            clips.push(clip);
            selectOnly(clip.id);
            renderEditor();
            status();
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
        $('timeline-ruler').setAttribute('aria-valuenow', time.toFixed(1));
        $('timeline-ruler').setAttribute('aria-valuetext', formatTime(time));
        $('timeline-time').textContent = `${formatTime(time)} / ${formatTime(endTime())}`;
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
        nodes.forEach(node => { try { node.source.stop(); } catch (_) {} node.source.disconnect(); node.gain.disconnect(); node.output.disconnect(); });
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
            const output = context.createGain();
            output.gain.value = trackLevel(clip.track);
            source.connect(gain).connect(output).connect(context.destination);
            const when = Math.max(context.currentTime, playStartTime + clip.start + skip - playStartCursor);
            const offset = clip.in + skip;
            // 같은 페이드 곡선을 미리듣기와 파일 저장에 적용한다.
            const ramp = Math.min(.004, remaining / 3);
            gain.gain.setValueAtTime(0, when);
            gain.gain.linearRampToValueAtTime(clip.gain * envelope(clip, skip + ramp), when + ramp);
            fadePoints(clip).filter(time => time > skip + ramp).forEach(time => {
                gain.gain.linearRampToValueAtTime(clip.gain * envelope(clip, time), when + time - skip);
            });
            nodes.set(clip.id, { source, gain, output, track:clip.track, soundId: clip.soundId });
            source.onended = () => { source.disconnect(); gain.disconnect(); output.disconnect(); if (nodes.get(clip.id)?.source === source) nodes.delete(clip.id); };
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

    function validGrid(value) {
        return {bpm: clamp(Number(value?.bpm) || 120, 20, 300), beats: Number(value?.beats) === 3 ? 3 : 4, bars: clamp(Math.round(Number(value?.bars) || 16), 4, 128)};
    }
    function beatSeconds() { return 60 / grid.bpm; }
    function barSeconds() { return beatSeconds() * grid.beats; }
    // 박 선은 확대했을 때만 보인다. 화면에 표시되는 가장 작은 선에 스냅한다.
    function gridStep() { return beatSeconds() * pixelsPerSecond >= 10 ? beatSeconds() : barSeconds(); }
    function snapTime(time) {
        const value = Math.max(0, time);
        return $('timeline-snap').checked ? Math.max(0, Math.round(value / gridStep()) * gridStep()) : value;
    }
    function snapStart(value) { return snapTime(value); }
    function syncGridControls() {
        $('grid-meter').value = String(grid.beats); $('grid-bpm').value = grid.bpm; $('grid-bars').value = grid.bars;
    }
    function fitGrid() {
        const width = $('timeline-scroll').clientWidth;
        if (!width) return;
        pixelsPerSecond = clamp(width / (grid.bars * barSeconds()), Number($('timeline-zoom').min), Number($('timeline-zoom').max));
        $('timeline-zoom').value = pixelsPerSecond;
        renderTimeline();
    }
    function renderGrid() {
        const bar = barSeconds() * pixelsPerSecond, beat = beatSeconds() * pixelsPerSecond;
        $('timeline').style.setProperty('--bar-width', `${bar}px`);
        $('timeline').style.setProperty('--beat-width', `${beat}px`);
        $('timeline').classList.toggle('show-beats', beat >= 10);
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
        const main = document.getElementById('generator-page');
        if (main) {
            const bounds = main.getBoundingClientRect();
            if (event.clientY > bounds.bottom - 36) main.scrollTop += 16;
            else if (event.clientY < bounds.top + 36) main.scrollTop -= 16;
        }
        if (row) {
            const box = $('timeline-scroll');
            const bounds = box.getBoundingClientRect();
            extendTimelineAtRight(event.clientX);
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
        if (!state.ghost || event.type === 'pointercancel') { timelineExtra = 0; renderTimeline(); return; }
        const row = libraryDropTarget(event);
        if (!row) { timelineExtra = 0; renderTimeline(); return; }
        const track = Number(row.dataset.track);
        let position = Math.max(0, (event.clientX - row.getBoundingClientRect().left) / pixelsPerSecond);
        position = snapTime(position);
        timelineExtra = 0;
        addSound(state.id, track, position);
    }

    function beginDrag(event) {
        if (exporting || event.button !== 0) return;
        const element = event.target.closest('.sound-clip');
        if (!element) return;
        event.preventDefault();
        const clip = clips.find(item => item.id === Number(element.dataset.clipId));
        pauseTimeline();
        activeTrack = clip.track;
        if (activeTool === 'select' && event.shiftKey && !event.target.dataset.handle) {
            if (selectedIds.has(clip.id)) selectedIds.delete(clip.id); else selectedIds.add(clip.id);
            selectedId = selectedIds.has(clip.id) ? clip.id : [...selectedIds][0] ?? null;
            paintSelection(); element.focus({preventScroll: true}); return;
        }
        const handle = event.target.dataset.handle, fadeSide = event.target.dataset.fade;
        if (!selectedIds.has(clip.id) || activeTool !== 'select' || handle) selectOnly(clip.id);
        else selectedId = clip.id;
        paintSelection(); element.focus({preventScroll: true});
        if (activeTool === 'cut' && trackLocked(clip.track)) return;
        if (activeTool === 'cut') {
            cursor = snapTime(clip.start + (event.clientX - element.getBoundingClientRect().left) / pixelsPerSecond);
            editClip('split'); focusSelectedClip(); return;
        }
        if (activeTool === 'fade' && !fadeSide) return;
        if (trackLocked(clip.track)) { status('이 트랙의 잠금을 먼저 해제해달라.', true); return; }
        const group = (handle || fadeSide ? [clip] : selectedClips()).map(item => ({...item}));
        if (group.some(item => trackLocked(item.track))) { status('선택에 잠긴 트랙의 소리가 포함되어 있다.', true); return; }
        const duplicate = event.altKey && activeTool === 'select' && !handle;
        if (duplicate && clips.length + pendingAdds.size + group.length > 80) { status('클립은 최대 80개까지 사용할 수 있다.', true); return; }
        dragState = {clip, element, handle, fadeSide, duplicate, group, moving: group.map(item => item.id), x:event.clientX, y:event.clientY, original:{...clip}, history:snapshot(), changed:false, pointerId:event.pointerId, scroll:$('timeline-scroll').scrollLeft};
        element.setPointerCapture(event.pointerId);
    }
    function moveDrag(event) {
        if (!dragState || dragState.pointerId !== event.pointerId) return;
        const state = dragState, {original, element, handle, fadeSide} = state;
        const box = $('timeline-scroll'), rect = box.getBoundingClientRect();
        extendTimelineAtRight(event.clientX);
        if (event.clientX > rect.right - 28) box.scrollLeft += 12;
        else if (event.clientX < rect.left + 28) box.scrollLeft -= 12;
        const difference = (event.clientX - state.x + box.scrollLeft - state.scroll) / pixelsPerSecond;
        if (Math.hypot(difference * pixelsPerSecond, event.clientY - state.y) < 2 && !state.changed) return;
        const rows = [...root.querySelectorAll('.timeline-track')];
        const hoverTrack = rows.findIndex(row => { const r=row.getBoundingClientRect(); return event.clientY >= r.top && event.clientY <= r.bottom; });
        if (!handle && !fadeSide && hoverTrack >= 0) {
            const delta = clamp(hoverTrack-original.track, -Math.min(...state.group.map(item => item.track)), trackCount-1-Math.max(...state.group.map(item => item.track)));
            if (state.group.some(item => trackLocked(item.track+delta))) return;
        }
        if (state.duplicate && !state.changed) {
            state.moving = state.group.map(item => {
                const originalElement = root.querySelector(`[data-clip-id="${item.id}"]`);
                const copy = {...item, id:nextId++}; clips.push(copy);
                const stationary = originalElement.cloneNode(true);
                stationary.classList.remove('is-selected'); stationary.setAttribute('aria-pressed','false');
                originalElement.parentElement.insertBefore(stationary, originalElement);
                originalElement.dataset.clipId = String(copy.id);
                if (item.id === original.id) { state.clip = copy; selectedId = copy.id; }
                return copy.id;
            });
            selectedIds = new Set(state.moving);
        }
        const clip = state.clip;
        if (fadeSide) {
            const current = fades(original);
            if (fadeSide === 'in') clip.fadeIn = clamp(current.fadeIn + difference, 0, length(clip) - current.fadeOut);
            else clip.fadeOut = clamp(current.fadeOut - difference, 0, length(clip) - current.fadeIn);
        } else if (handle === 'left') {
            const change = clamp(snapTime(original.start + difference) - original.start, -Math.min(original.in, original.start), length(original) - MIN_CLIP);
            clip.in = original.in + change; clip.start = original.start + change;
        } else if (handle === 'right') {
            clip.out = clamp(snapTime(original.start + length(original) + difference) - original.start + original.in, original.in + MIN_CLIP, durations.get(clip.soundId));
        } else {
            const rows = [...root.querySelectorAll('.timeline-track')];
            const target = rows.findIndex(row => { const r = row.getBoundingClientRect(); return event.clientY >= r.top && event.clientY <= r.bottom; });
            const firstTrack = Math.min(...state.group.map(item => item.track)), lastTrack = Math.max(...state.group.map(item => item.track));
            const trackDelta = clamp((target < 0 ? original.track : target) - original.track, -firstTrack, trackCount - 1 - lastTrack);
            const timeDelta = Math.max(-Math.min(...state.group.map(item => item.start)), snapTime(original.start + difference) - original.start);
            state.group.forEach((item, index) => {
                const moving = clips.find(c => c.id === state.moving[index]);
                moving.start = item.start + timeDelta; moving.track = item.track + trackDelta;
                const node = root.querySelector(`[data-clip-id="${moving.id}"]`);
                if (node.parentElement !== rows[moving.track]) rows[moving.track].append(node);
                node.style.left = `${moving.start * pixelsPerSecond}px`;
            });
        }
        state.changed = true;
        element.style.left = `${clip.start * pixelsPerSecond}px`; element.style.width = `${length(clip) * pixelsPerSecond}px`;
        element.querySelector('.clip-duration').textContent = formatTime(length(clip));
        updateTimelineSize(); renderExportRange(); drawWaves(); updateCursor();
    }
    function endDrag(event) {
        if (!dragState || (event.pointerId !== undefined && dragState.pointerId !== event.pointerId)) return;
        const state = dragState; dragState = null;
        if (state.element.hasPointerCapture?.(state.pointerId)) state.element.releasePointerCapture(state.pointerId);
        if (event.type === 'pointercancel' && state.changed) { restore(state.history); return; }
        if (state.changed) {
            undoStack.push(state.history); if (undoStack.length > 50) undoStack.shift(); redoStack.length = 0;
        }
        activeTrack = selected()?.track ?? activeTrack; timelineExtra = 0;
        renderEditor(); focusSelectedClip();
    }

    function editClip(action) {
        if (exporting) return;
        const clip = selected();
        if (!clip) return;
        if ((action === 'delete' ? selectedClips() : [clip]).some(item => trackLocked(item.track))) { status('잠긴 트랙의 소리는 편집할 수 없다.', true); return; }
        pauseTimeline();
        if (action === 'split') {
            const offset = cursor - clip.start;
            if (offset < MIN_CLIP || offset > length(clip) - MIN_CLIP) { status('자를 위치를 선택한 소리의 안쪽에 놓아달라.', true); return; }
            if (clips.length >= 80) { status('클립은 최대 80개까지 사용할 수 있다.', true); return; }
            recordChange();
            const currentFades = fades(clip);
            const right = {...clip, id: nextId++, start: cursor, in: clip.in + offset, fadeIn: 0, fadeOut: Math.min(currentFades.fadeOut, length(clip) - offset)};
            clip.out = right.in;
            clip.fadeIn = Math.min(currentFades.fadeIn, offset);
            clip.fadeOut = 0;
            clips.push(right);
            selectOnly(right.id);
            status();
        } else if (action === 'delete') {
            recordChange();
            clips = clips.filter(item => !selectedIds.has(item.id));
            selectOnly(null);
            status();
        }
        renderEditor();
    }

    function focusSelectedClip() {
        root.querySelector(`[data-clip-id="${selectedId}"]`)?.focus({preventScroll: true});
    }

    function copySelection() { copiedClips = selectedClips().map(clip => ({...clip})); }
    function pasteClip() {
        if (!copiedClips.length || exporting || dragState) return;
        if (clips.length + pendingAdds.size + copiedClips.length > 80) { status('클립은 최대 80개까지 사용할 수 있다.', true); return; }
        const error = sourceBudget([...clips.map(clip => clip.soundId), ...pendingAdds.keys(), ...copiedClips.map(clip => clip.soundId)]);
        if (error) { status(error, true); return; }
        pauseTimeline();
        const firstTime = Math.min(...copiedClips.map(clip => clip.start)), firstTrack = Math.min(...copiedClips.map(clip => clip.track));
        const start = snapTime(cursor);
        const added = copiedClips.map(clip => ({...clip, id:nextId++, start:start + clip.start - firstTime, track:activeTrack + clip.track - firstTrack}));
        if (added.some(clip => trackLocked(clip.track))) { status('잠금을 해제한 트랙에 붙여넣어달라.', true); return; }
        recordChange();
        trackCount = Math.max(trackCount, ...added.map(clip => clip.track + 1));
        clips.push(...added); selectedIds = new Set(added.map(clip => clip.id)); selectedId = added[0].id;
        cursor = Math.max(...added.map(clip => clip.start + length(clip)));
        renderEditor(); focusSelectedClip(); status();
        added.forEach(clip => getBuffer(clip.soundId).catch(error => status(error.message, true)));
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
        if (!selectedIds.has(clip.id)) selectOnly(clip.id); else selectedId = clip.id;
        activeTrack = clip.track;
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

    // 선택 도구에서는 빈 공간 드래그로 영역 선택, 가운데 마우스로 가로 이동한다.
    function beginPan(event) {
        if (exporting || !event.target.closest('#timeline') || ![0,1].includes(event.button)) return;
        if (event.target.closest('#export-range-lane') || (event.button === 0 && event.target.closest('.sound-clip, #timeline-ruler'))) return;
        event.preventDefault(); skipTimelineClick = false;
        const box = $('timeline-scroll'), bounds = $('timeline').getBoundingClientRect();
        box.focus({preventScroll:true});
        panState = {pointerId:event.pointerId, x:event.clientX, y:event.clientY, startX:event.clientX-bounds.left, startY:event.clientY-bounds.top, scroll:box.scrollLeft, moved:false, button:event.button, track:event.target.closest('.timeline-track')?.dataset.track, selecting:activeTool === 'select' && event.button === 0, additive:event.shiftKey, original:[...selectedIds], primary:selectedId};
        box.setPointerCapture(event.pointerId);
    }
    function movePan(event) {
        if (!panState || event.pointerId !== panState.pointerId) return;
        const state = panState, box = $('timeline-scroll');
        if (Math.hypot(event.clientX-state.x, event.clientY-state.y) > 3) state.moved = true;
        if (!state.moved) return;
        if (!state.selecting) { box.classList.add('is-panning'); box.scrollLeft = state.scroll - (event.clientX-state.x); return; }
        const bounds = box.getBoundingClientRect();
        if (event.clientX > bounds.right-24) box.scrollLeft += 12;
        else if (event.clientX < bounds.left+24) box.scrollLeft -= 12;
        const page = document.getElementById('generator-page'), screen = page.getBoundingClientRect();
        if (event.clientY > screen.bottom-24) page.scrollTop += 12;
        else if (event.clientY < screen.top+70) page.scrollTop -= 12;
        const origin = $('timeline').getBoundingClientRect();
        const x = clamp(event.clientX-origin.left,0,$('timeline').offsetWidth), y = clamp(event.clientY-origin.top,0,$('timeline').offsetHeight);
        const left = Math.min(state.startX,x), top = Math.min(state.startY,y), right = Math.max(state.startX,x), bottom = Math.max(state.startY,y);
        const selection = $('selection-box'); selection.hidden = false;
        Object.assign(selection.style,{left:`${left}px`,top:`${top}px`,width:`${right-left}px`,height:`${bottom-top}px`});
        selectedIds = new Set(state.additive ? state.original : []);
        root.querySelectorAll('.sound-clip').forEach(node => {
            const r=node.getBoundingClientRect();
            if (r.right-origin.left >= left && r.left-origin.left <= right && r.bottom-origin.top >= top && r.top-origin.top <= bottom) selectedIds.add(Number(node.dataset.clipId));
        });
        selectedId = [...selectedIds][0] ?? null; paintSelection();
    }
    function endPan(event) {
        if (!panState || event.pointerId !== panState.pointerId) return;
        const state = panState; panState = null; skipTimelineClick = true;
        $('selection-box').hidden = true; $('timeline-scroll').classList.remove('is-panning');
        if ($('timeline-scroll').hasPointerCapture(event.pointerId)) $('timeline-scroll').releasePointerCapture(event.pointerId);
        if (event.type === 'pointercancel') { selectedIds = new Set(state.original); selectedId = state.primary; paintSelection(); return; }
        if (!state.moved && state.button === 0) {
            if (state.track !== undefined) activeTrack = Number(state.track);
            if (!state.additive) { selectOnly(null); paintSelection(); }
            seekTo((event.clientX-$('timeline').getBoundingClientRect().left)/pixelsPerSecond);
        } else if (state.selecting) focusSelectedClip();
        saveProject();
    }

    async function renderExportBlock(project, blockStart, frames, sampleRate, cancelled) {
        const left = new Float32Array(frames), right = new Float32Array(frames);
        const blockEnd = blockStart + frames / sampleRate;
        for (const clip of project) {
            if (clip.start >= blockEnd || clip.start + length(clip) <= blockStart) continue;
            cancelled();
            const buffer = await getBuffer(clip.soundId);
            mixClipBlock(clip, buffer, blockStart, sampleRate, left, right);
            await pauseTick();
            cancelled();
        }
        return {left, right};
    }

    async function exportAudio(format = 'wav') {
        if (exporting || !clips.length || pendingAdds.size) return;
        const range = getExportRange();
        if (range.end - range.start < MIN_CLIP) { status('저장할 범위를 먼저 선택해달라.', true); return; }
        closeSaveMenu(); pauseTimeline(); stopPreview();
        exporting = true; exportCancelled = false;
        updateControls(); renderLibrary();
        $('export-progress').hidden = false; $('export-progress').value = 0;
        const sampleRate = 44100;
        const frameCount = Math.ceil((range.end - range.start) * sampleRate);
        // 최대 약 2.5초의 PCM만 한 번에 처리한다. 작업 길이와 무관하게 버퍼가 커지지 않는다.
        const blockFrames = 1152 * 96;
        const project = clips.filter(clip => clip.start < range.end && clip.start + length(clip) > range.start).map(clip => ({...clip, gain:clip.gain * trackLevel(clip.track)}));
        const cancelled = () => { if (exportCancelled) throw new Error('저장을 취소했다. 편집 내용은 그대로 남아 있다.'); };
        try {
            const parts = format === 'wav' ? [wavHeader(frameCount, sampleRate)] : [];
            const mp3 = format === 'mp3' ? createMp3Stream(sampleRate) : null;
            let peak = 0;
            // 전체 선택 구간의 최대 음량을 먼저 구해 블록 사이 음량이 달라지지 않게 한다.
            for (let start = 0; start < frameCount; start += blockFrames) {
                cancelled();
                const count = Math.min(blockFrames, frameCount - start);
                const {left, right} = await renderExportBlock(project, range.start + start / sampleRate, count, sampleRate, cancelled);
                for (let i = 0; i < count; i++) peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
                $('export-progress').value = (start + count) / frameCount * 45;
                status(`저장 범위 확인 중 · ${Math.round((start + count) / frameCount * 100)}%`);
                await pauseTick();
            }
            const scale = peak > 1 ? .98 / peak : 1;
            for (let start = 0; start < frameCount; start += blockFrames) {
                cancelled();
                const count = Math.min(blockFrames, frameCount - start);
                const {left, right} = await renderExportBlock(project, range.start + start / sampleRate, count, sampleRate, cancelled);
                if (mp3) parts.push(...await mp3.encode(left, right, scale, cancelled));
                else parts.push(wavBlock(left, right, scale));
                $('export-progress').value = 45 + (start + count) / frameCount * 55;
                status(`${format.toUpperCase()} 저장 중 · ${Math.round((start + count) / frameCount * 100)}%`);
                await pauseTick();
            }
            if (mp3) parts.push(mp3.finish());
            cancelled();
            const blob = new Blob(parts, {type: format === 'mp3' ? 'audio/mpeg' : 'audio/wav'});
            const now = new Date(), pad = value => String(value).padStart(2, '0');
            const fileName = `소리마당_${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
            const url = URL.createObjectURL(blob);
            if (savedAudioUrl) URL.revokeObjectURL(savedAudioUrl);
            savedAudioUrl = url;
            const link = $('download-audio');
            link.href = url; link.download = `${fileName}.${format}`;
            link.textContent = `${format.toUpperCase()} 파일 다운로드`; link.hidden = false; link.click(); status();
        } catch (error) { status(error.message || '파일을 저장하지 못했다. 저장 범위를 줄여 다시 시도해달라.', !exportCancelled); }
        finally { exporting = false; $('export-progress').hidden = true; updateControls(); renderLibrary(); }
    }

    $('sound-search').addEventListener('input', renderLibrary);
    $('sound-person').addEventListener('change', renderLibrary);
    $('user-sound-search').addEventListener('input', renderLibrary);
    ['sound-list', 'user-sound-list'].forEach(listId => {
    $(listId).addEventListener('click', event => {
        const button = event.target.closest('button');
        const card = event.target.closest('[data-sound-id]');
        if (!button || !card) return;
        if (button.dataset.action === 'preview') previewSound(card.dataset.soundId);
        if (button.dataset.action === 'add') addSound(card.dataset.soundId);
    });
    $(listId).addEventListener('dragstart', event => event.preventDefault());
    $(listId).addEventListener('pointerdown', beginLibraryDrag);
    });
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
        position = snapTime(position);
        addSound(id, track, position);
    });
    $('preview-stop').addEventListener('click', stopPreview);
    preview.addEventListener('ended', stopPreview);
    preview.addEventListener('error', () => { if (previewId) { stopPreview(); status('이 음원을 미리 들을 수 없다. 파일 또는 브라우저 지원 여부를 확인해달라.', true); } });
    preview.addEventListener('loadedmetadata', () => { if (previewId && Number.isFinite(preview.duration)) { durations.set(previewId, preview.duration); renderLibrary(); } });
    $('timeline-play').addEventListener('click', playTimeline);
    $('timeline-stop').addEventListener('click', () => { pauseTimeline(true); stopPreview(); });
    $('timeline-tracks').addEventListener('click', event => {
        if (!event.target.closest('.sound-clip') && !exporting) {
            const row = event.target.closest('.timeline-track');
            if (row) activeTrack = Number(row.dataset.track);
            seekTo((event.clientX - $('timeline-tracks').getBoundingClientRect().left) / pixelsPerSecond);
        }
    });
    $('timeline-tracks').addEventListener('dblclick', event => {
        const element = event.target.closest('.sound-clip');
        if (!element || activeTool !== 'select' || event.target.closest('.clip-handle, .fade-handle') || exporting) return;
        event.preventDefault();
        pauseTimeline();
        if (!selectedIds.has(Number(element.dataset.clipId))) selectOnly(Number(element.dataset.clipId));
        else selectedId = Number(element.dataset.clipId);
        cursor = snapTime((event.clientX - $('timeline-tracks').getBoundingClientRect().left) / pixelsPerSecond);
        editClip('split');
        root.querySelector(`[data-clip-id="${selectedId}"]`)?.focus({preventScroll: true});
    });
    $('timeline-tracks').addEventListener('pointerdown', beginDrag);
    window.addEventListener('pointermove', moveDrag);
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);
    // 타임라인에서 Enter: 재생 위치와 가로 스크롤을 처음으로 돌린다.
    // 재생 중이면 처음부터 이어서 재생하며, 입력란과 버튼의 Enter는 가로채지 않는다.
    $('timeline-scroll').addEventListener('keydown', event => {
        if (event.key !== 'Enter' || event.isComposing || event.repeat || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey
            || exporting || dragState || libraryDrag || panState || rulerDrag || rangeDrag
            || event.target.closest('input, textarea, select, button, a, [contenteditable]')) return;
        event.preventDefault(); event.stopPropagation();
        seekTo(0);
        $('timeline-scroll').scrollLeft = 0;
    }, {capture: true});
    $('timeline-tracks').addEventListener('keydown', event => {
        const element = event.target.closest('.sound-clip');
        if (!element || exporting || event.target.closest('.fade-handle')) return;
        if (!['Enter',' ','Delete','Backspace','ArrowLeft','ArrowRight'].includes(event.key) && event.key.toLowerCase() !== 's') return;
        if (!selectedIds.has(Number(element.dataset.clipId))) selectOnly(Number(element.dataset.clipId));
        else selectedId = Number(element.dataset.clipId);
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
            event.preventDefault();
            if (selectedClips().some(item => trackLocked(item.track))) return;
            pauseTimeline(); recordChange();
            const clip = selected();
            const step = $('timeline-snap').checked ? gridStep() * (event.shiftKey ? grid.beats : 1) : (event.shiftKey ? 1 : .1);
            const group = selectedClips();
            const delta = Math.max(-Math.min(...group.map(item => item.start)), snapTime(clip.start + (event.key === 'ArrowLeft' ? -1 : 1) * step) - clip.start);
            group.forEach(item => { item.start += delta; });
            renderEditor(); root.querySelector(`[data-clip-id="${clip.id}"]`)?.focus({preventScroll: true});
        }
    });
    // 복사/붙여넣기는 생성기 안에서만 동작하며 검색창의 텍스트 편집은 건드리지 않는다.
    root.addEventListener('keydown', event => {
        if (exporting || event.altKey || !(event.ctrlKey || event.metaKey) || event.target.closest('input, textarea, select, [contenteditable="true"]')) return;
        const key = event.key.toLowerCase();
        if (key === 'c' && selected()) {
            event.preventDefault();
            copySelection();
        } else if (key === 'v' && copiedClips.length) {
            event.preventDefault();
            pasteClip();
        }
    });
    // 브라우저의 편집 메뉴에서 실행하는 복사/붙여넣기도 지원한다.
    root.addEventListener('copy', event => {
        if (exporting || !selected() || event.target.closest('input, textarea, select')) return;
        copySelection();
        event.clipboardData?.setData('text/plain', `소리마당 클립: ${copiedClips.map(clip => byId.get(clip.soundId).name).join(', ')}`);
        event.preventDefault();
    });
    root.addEventListener('paste', event => {
        if (!copiedClips.length || exporting || event.target.closest('input, textarea, select, [contenteditable="true"]')) return;
        event.preventDefault();
        pasteClip();
    });
    $('timeline-tracks').addEventListener('contextmenu', openColorMenu);
    $('clip-color-menu').addEventListener('click', event => {
        const button = event.target.closest('button[data-color]');
        const clip = clips.find(item => item.id === colorMenuClipId);
        if (!button || !clip || exporting || selectedClips().some(item => trackLocked(item.track))) return;
        if (selectedClips().some(item => safeClipColor(item.color) !== button.dataset.color)) {
            recordChange();
            selectedClips().forEach(item => { item.color = safeClipColor(button.dataset.color); });
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
    // 트랙패드 핀치는 브라우저마다 wheel 또는 Safari gesture 이벤트로 전달된다.
    let pendingZoom = null;
    let zoomFrame = 0;
    let pinchGesture = null;
    let ignorePinchWheelUntil = 0;
    const zoomLocked = () => exporting || dragState || libraryDrag || panState || rulerDrag || rangeDrag;

    function setTimelineZoom(value, clientX) {
        if (zoomLocked()) { $('timeline-zoom').value = String(pixelsPerSecond); return; }
        const box = $('timeline-scroll');
        const slider = $('timeline-zoom');
        updateZoomBounds();
        const next = clamp(value, Number(slider.min), Number(slider.max));
        if (!Number.isFinite(next) || next === pixelsPerSecond) return;
        const bounds = box.getBoundingClientRect();
        const anchor = Number.isFinite(clientX) ? clamp(clientX - bounds.left - box.clientLeft, 0, box.clientWidth) : box.clientWidth / 2;
        const time = (box.scrollLeft + anchor) / pixelsPerSecond;
        const focused = document.activeElement;
        pixelsPerSecond = next;
        slider.value = String(next);
        renderTimeline();
        box.scrollLeft = Math.max(0, time * next - anchor);
        if (focused && !focused.isConnected) focusSelectedClip();
    }

    function queueTimelineZoom(value, clientX) {
        if (zoomLocked()) return;
        const slider = $('timeline-zoom');
        pendingZoom = {value: clamp(value, Number(slider.min), Number(slider.max)), clientX};
        if (zoomFrame) return;
        // 한 화면 프레임에 한 번만 파형을 다시 그린다.
        zoomFrame = requestAnimationFrame(() => {
            zoomFrame = 0;
            const pending = pendingZoom;
            pendingZoom = null;
            if (pending && !document.getElementById('generator-page').hidden) setTimelineZoom(pending.value, pending.clientX);
        });
    }

    $('timeline-scroll').addEventListener('wheel', event => {
        const box = $('timeline-scroll');
        if (event.ctrlKey) {
            event.preventDefault();
            if (zoomLocked() || pinchGesture || performance.now() < ignorePinchWheelUntil) return;
            const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? box.clientHeight : 1;
            const delta = clamp(event.deltaY * unit, -100, 100);
            queueTimelineZoom((pendingZoom?.value ?? pixelsPerSecond) * Math.exp(-delta * 0.01), event.clientX);
            return;
        }
        // 보통의 두 손가락 좌우 스크롤은 그대로 가로 이동에 사용한다.
        if (event.metaKey || (!event.shiftKey && !event.deltaX)) return;
        const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? box.clientWidth : 1;
        const delta = (event.shiftKey ? (event.deltaY || event.deltaX) : event.deltaX) * unit;
        if (box.scrollWidth <= box.clientWidth) return;
        event.preventDefault();
        box.scrollLeft += delta;
    }, {passive: false});

    $('timeline-scroll').addEventListener('gesturestart', event => {
        event.preventDefault();
        if (zoomLocked()) return;
        pinchGesture = {zoom: pendingZoom?.value ?? pixelsPerSecond, clientX: event.clientX};
    }, {passive: false});
    document.addEventListener('gesturechange', event => {
        if (!pinchGesture) return;
        event.preventDefault();
        if (Number.isFinite(event.clientX)) pinchGesture.clientX = event.clientX;
        if (Number.isFinite(event.scale) && event.scale > 0) {
            queueTimelineZoom(pinchGesture.zoom * event.scale, pinchGesture.clientX);
        }
    }, {passive: false});
    document.addEventListener('gestureend', event => {
        if (!pinchGesture) return;
        event.preventDefault();
        if (Number.isFinite(event.scale) && event.scale > 0) queueTimelineZoom(pinchGesture.zoom * event.scale, pinchGesture.clientX);
        pinchGesture = null;
        // Safari가 같은 제스처의 wheel도 보내면 중복 확대를 피한다.
        ignorePinchWheelUntil = performance.now() + 100;
    }, {passive: false});
    function cancelTimelineZoom() {
        cancelAnimationFrame(zoomFrame);
        zoomFrame = 0;
        pendingZoom = null;
        pinchGesture = null;
        ignorePinchWheelUntil = 0;
    }
    window.addEventListener('blur', cancelTimelineZoom);
    window.addEventListener('pagehide', cancelTimelineZoom);
    window.addEventListener('generator-visibility', event => { if (!event.detail.open) cancelTimelineZoom(); });
    $('timeline-zoom').addEventListener('input', event => {
        cancelTimelineZoom();
        setTimelineZoom(Number(event.target.value));
    });
    // 버튼과 단축키가 같은 편집 기록을 사용한다.
    function changeHistory(redo = false) {
        finishVolumeEdit();
        if (exporting || dragState || libraryDrag || panState || rulerDrag || rangeDrag) return;
        const from = redo ? redoStack : undoStack;
        const to = redo ? undoStack : redoStack;
        if (!from.length) return;
        const focused = document.activeElement;
        to.push(snapshot());
        restore(from.pop());
        closeColorMenu();
        status();
        activeTrack = selected()?.track ?? activeTrack;
        // 삭제·자르기 후에도 단축키를 연속해서 누를 수 있도록 초점을 복원한다.
        if (!focused?.isConnected || document.activeElement === document.body) {
            (root.querySelector(`[data-clip-id="${selectedId}"]`) || $('timeline-scroll')).focus({preventScroll: true});
        }
    }
    $('edit-undo').addEventListener('click', () => changeHistory());
    $('edit-redo').addEventListener('click', () => changeHistory(true));
    $('edit-undo').title = '되돌리기 · Ctrl+Z / ⌘Z';
    $('edit-redo').title = '다시 실행 · Ctrl+Shift+Z / ⌘⇧Z / Ctrl+Y';
    function handleHistoryShortcut(event) {
        if (event.defaultPrevented || event.isComposing || event.altKey || !(event.ctrlKey || event.metaKey)) return;
        if (!document.getElementById('generator-page').classList.contains('is-open') || root.closest('[inert]')) return;
        // 검색창 등에서는 브라우저의 글자 편집 기록을 사용한다.
        if (event.target.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return;
        const key = event.key.toLowerCase();
        if (key === 'z' || (key === 'y' && event.ctrlKey && !event.metaKey && !event.shiftKey)) {
            event.preventDefault();
            changeHistory(key === 'y' || event.shiftKey);
        }
    }
    document.addEventListener('keydown', handleHistoryShortcut);
    $('export-wav').addEventListener('click', () => exportAudio('wav'));
    $('export-mp3').addEventListener('click', () => exportAudio('mp3'));
    $('export-cancel').addEventListener('click', () => { exportCancelled = true; status('저장을 취소하는 중…'); });
    window.addEventListener('sound-start', event => { if (event.detail?.owner !== 'generator') { pauseTimeline(); stopPreview(); } });
    window.addEventListener('generator-visibility', event => { if (!event.detail.open) { pauseTimeline(); stopPreview(); closeColorMenu(); closeSaveMenu(); cutPointer = null; updateCutCursor(); } else { requestAnimationFrame(() => { if (!initialGridFit && !clips.length) fitGrid(); initialGridFit = true; renderTimeline(); }); clips.forEach(clip => getBuffer(clip.soundId).catch(error => status(error.message, true))); } });
    window.addEventListener('pagehide', event => { pauseTimeline(); stopPreview(); if (!event.persisted && savedAudioUrl) URL.revokeObjectURL(savedAudioUrl); });
    function setTool(tool) {
        activeTool = tool;
        root.dataset.tool = tool;
        updateCutCursor();
        root.querySelectorAll('[data-tool]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.tool === tool)));
    }
    root.querySelectorAll('button[data-tool]').forEach(button => button.addEventListener('click', () => setTool(button.dataset.tool)));
    $('add-track').addEventListener('click', () => {
        if (exporting) return;
        recordChange(); trackCount++; activeTrack = trackCount - 1; renderEditor();
        $('timeline-tracks').lastElementChild.scrollIntoView({block: 'nearest'});
    });
    root.querySelectorAll('[data-number]').forEach(button => button.addEventListener('click', () => {
        if (exporting) return;
        const input = $(button.dataset.number);
        const next = clamp((Number(input.value) || Number(input.min)) + Number(button.dataset.step), Number(input.min), Number(input.max));
        if (next === Number(input.value)) return;
        input.value = String(next); input.dispatchEvent(new Event('change', {bubbles:true}));
    }));
    ['grid-meter', 'grid-bpm', 'grid-bars'].forEach(id => {
        $(id).addEventListener('change', () => {
            if (exporting) return;
            const next = validGrid({beats: $('grid-meter').value, bpm: $('grid-bpm').value, bars: $('grid-bars').value});
            if (JSON.stringify(next) === JSON.stringify(grid)) { syncGridControls(); return; }
            recordChange(); grid = next; timelineExtra = 0; if (id === 'grid-bars') fitGrid(); renderEditor();
        });
    });
    $('wave-zoom').addEventListener('input', event => { waveScale = Number(event.target.value); drawWaves(); });
    $('track-height').addEventListener('input', event => {
        document.getElementById('generator-page').style.setProperty('--track-height', `${event.target.value}px`);
        root.classList.toggle('compact-tracks', Number(event.target.value) < 60);
        drawWaves();
    });
    // 초기 행 높이를 슬라이더와 일치시킨다.
    document.getElementById('generator-page').style.setProperty('--track-height', `${$('track-height').value}px`);
    if ('ResizeObserver' in window) new ResizeObserver(() => { if (!document.getElementById('generator-page').hidden) renderTimeline(); }).observe($('timeline-scroll'));

    // 눈금을 누른 채 움직이는 동안 재생선도 실시간으로 움직인다.
    function moveRuler(event) {
        if (!rulerDrag || rulerDrag.pointerId !== event.pointerId) return;
        const box = $('timeline-scroll');
        const bounds = box.getBoundingClientRect();
        if (event.clientX > bounds.right - 24) box.scrollLeft += 16;
        else if (event.clientX < bounds.left + 24) box.scrollLeft -= 16;
        cursor = clamp(snapTime((event.clientX - $('timeline-ruler').getBoundingClientRect().left) / pixelsPerSecond), 0, viewDuration());
        updateCursor();
    }
    $('timeline-ruler').addEventListener('pointerdown', event => {
        if (event.button !== 0 || exporting) return;
        event.preventDefault(); event.stopPropagation();
        rulerDrag = {pointerId: event.pointerId, resume: playing};
        pauseTimeline();
        $('timeline-ruler').focus({preventScroll: true});
        $('timeline-ruler').setPointerCapture(event.pointerId);
        moveRuler(event);
    });
    window.addEventListener('pointermove', moveRuler);
    function endRuler(event) {
        if (!rulerDrag || rulerDrag.pointerId !== event.pointerId) return;
        const resume = rulerDrag.resume;
        if (event.type === 'pointerup') moveRuler(event);
        rulerDrag = null;
        if ($('timeline-ruler').hasPointerCapture(event.pointerId)) $('timeline-ruler').releasePointerCapture(event.pointerId);
        if (resume && event.type === 'pointerup' && cursor < endTime()) playTimeline();
    }
    window.addEventListener('pointerup', endRuler);
    window.addEventListener('pointercancel', endRuler);
    $('timeline-ruler').addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const time = event.key === 'Home' ? 0 : event.key === 'End' ? endTime() : cursor + (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 5 : .1);
        seekTo(time);
    });
    // 페이드 손잡이는 방향키로도 조절할 수 있다.
    root.addEventListener('keydown', event => {
        const handle = event.target.closest('.fade-handle');
        if (handle && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) && !exporting) {
            event.preventDefault();
            const clip = clips.find(item => item.id === Number(handle.closest('.sound-clip').dataset.clipId));
            if (trackLocked(clip.track)) return;
            const side = handle.dataset.fade;
            const property = side === 'in' ? 'fadeIn' : 'fadeOut';
            const f = fades(clip), maximum = length(clip) - (side === 'in' ? f.fadeOut : f.fadeIn);
            const delta = (event.key === 'ArrowRight' ? 1 : -1) * (side === 'in' ? 1 : -1) * (event.shiftKey ? 1 : .1);
            pauseTimeline(); recordChange();
            clip[property] = event.key === 'Home' ? 0 : event.key === 'End' ? maximum : clamp(f[property] + delta, 0, maximum);
            drawWaves(); updateControls(); saveProject(); return;
        }
        if (exporting || event.target.closest('input, textarea, select, button') || event.ctrlKey || event.metaKey || event.altKey) return;
        if (['1', '2', '3'].includes(event.key)) { event.preventDefault(); setTool({'1':'select','2':'cut','3':'fade'}[event.key]); }
        else if (event.key === ' ' && !event.target.closest('.sound-clip')) { event.preventDefault(); playTimeline(); }
    });
    function closeSaveMenu(focus = false) {
        $('save-menu').hidden = true;
        $('save-button').setAttribute('aria-expanded', 'false');
        if (focus) $('save-button').focus();
    }
    $('save-button').addEventListener('click', () => {
        const open = $('save-menu').hidden;
        $('save-menu').hidden = !open;
        $('save-button').setAttribute('aria-expanded', String(open));
        if (open) $('export-wav').focus();
    });
    $('save-menu').addEventListener('keydown', event => {
        if (event.key === 'Escape') { event.preventDefault(); closeSaveMenu(true); }
        else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault(); (document.activeElement === $('export-wav') ? $('export-mp3') : $('export-wav')).focus();
        }
    });
    document.addEventListener('pointerdown', event => { if (!event.target.closest('.save-options')) closeSaveMenu(); });
    root.addEventListener('focusin', event => { if (!event.target.closest('.save-options')) closeSaveMenu(); });
    function getExportRange() {
        const total = endTime();
        if (!total) return {start: 0, end: 0};
        if (!exportRange) return {start: 0, end: total};
        const start = clamp(exportRange.start, 0, Math.max(0, total - MIN_CLIP));
        return {start, end: clamp(exportRange.end, start + MIN_CLIP, total)};
    }
    function renderExportRange() {
        const range = getExportRange();
        const bar = $('export-range');
        bar.title = `${formatTime(range.start)} – ${formatTime(range.end)} · 양 끝을 끌어 조절 · 두 번 클릭하면 전체 선택`;
        bar.hidden = !clips.length;
        bar.style.left = `${range.start * pixelsPerSecond}px`;
        bar.style.width = `${(range.end - range.start) * pixelsPerSecond}px`;
        $('export-range-start').setAttribute('aria-label', `저장 시작 ${formatTime(range.start)}, 방향키로 조절`);
        $('export-range-end').setAttribute('aria-label', `저장 끝 ${formatTime(range.end)}, 방향키로 조절`);
    }
    function setExportRange(start, end) {
        const total = endTime();
        start = clamp(start, 0, Math.max(0, total - MIN_CLIP));
        exportRange = {start, end: clamp(end, start + MIN_CLIP, total)};
        renderExportRange();
    }
    ['start', 'end'].forEach(side => {
        $(`export-range-${side}`).addEventListener('keydown', event => {
            if (exporting || !clips.length || !['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
            event.preventDefault();
            const range = getExportRange();
            let value = range[side] + (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 1 : .1);
            if (event.key === 'Home') value = side === 'start' ? 0 : range.start + MIN_CLIP;
            if (event.key === 'End') value = side === 'start' ? range.end - MIN_CLIP : endTime();
            recordChange();
            setExportRange(side === 'start' ? clamp(value, 0, range.end - MIN_CLIP) : range.start, side === 'end' ? value : range.end);
            saveProject(); updateControls();
        });
    });
    $('export-range-lane').addEventListener('dblclick', () => {
        if (exporting || !exportRange) return;
        recordChange(); exportRange = null; renderExportRange(); saveProject(); updateControls();
    });
    $('export-range-lane').addEventListener('pointerdown', event => {
        if (exporting || !clips.length || event.button !== 0) return;
        event.preventDefault(); event.stopPropagation();
        const time = clamp(snapTime((event.clientX - $('timeline').getBoundingClientRect().left) / pixelsPerSecond), 0, endTime());
        rangeDrag = {pointerId: event.pointerId, mode: event.target.dataset.range || (event.target.closest('#export-range') ? 'move' : 'new'), time, range: getExportRange(), original: exportRange ? {...exportRange} : null, history: snapshot()};
        $('export-range-lane').setPointerCapture(event.pointerId);
        pauseTimeline();
    });
    function moveExportRange(event) {
        if (!rangeDrag || rangeDrag.pointerId !== event.pointerId) return;
        const box = $('timeline-scroll'), bounds = box.getBoundingClientRect();
        if (event.clientX > bounds.right - 24) box.scrollLeft += 12;
        else if (event.clientX < bounds.left + 24) box.scrollLeft -= 12;
        const time = clamp(snapTime((event.clientX - $('timeline').getBoundingClientRect().left) / pixelsPerSecond), 0, endTime());
        const {range, mode} = rangeDrag;
        if (mode === 'start') setExportRange(Math.min(time, range.end - MIN_CLIP), range.end);
        else if (mode === 'end') setExportRange(range.start, time);
        else if (mode === 'new') setExportRange(Math.min(time, rangeDrag.time), Math.max(time, rangeDrag.time));
        else {
            const duration = range.end - range.start;
            const start = clamp(range.start + time - rangeDrag.time, 0, Math.max(0, endTime() - duration));
            setExportRange(start, start + duration);
        }
    }
    window.addEventListener('pointermove', moveExportRange);
    function endExportRange(event) {
        if (!rangeDrag || rangeDrag.pointerId !== event.pointerId) return;
        const state = rangeDrag;
        rangeDrag = null;
        if ($('export-range-lane').hasPointerCapture(event.pointerId)) $('export-range-lane').releasePointerCapture(event.pointerId);
        if (event.type === 'pointercancel') exportRange = state.original;
        else if (JSON.stringify(exportRange) !== JSON.stringify(state.original)) {
            undoStack.push(state.history); if (undoStack.length > 50) undoStack.shift(); redoStack.length = 0;
        }
        renderExportRange(); saveProject(); updateControls();
    }
    window.addEventListener('pointerup', endExportRange);
    window.addEventListener('pointercancel', endExportRange);

    function updateCutCursor() {
        const line = $('cut-cursor');
        if (activeTool !== 'cut' || !cutPointer || exporting) { line.hidden = true; return; }
        const box = $('timeline-scroll').getBoundingClientRect();
        const ruler = $('timeline-ruler').getBoundingClientRect();
        if (cutPointer.x < box.left || cutPointer.x > box.right || cutPointer.y < ruler.top || cutPointer.y > box.bottom) { line.hidden = true; return; }
        const x = snapTime((cutPointer.x - $('timeline').getBoundingClientRect().left) / pixelsPerSecond) * pixelsPerSecond;
        line.style.left = `${x}px`; line.hidden = false;
        $('cut-time').textContent = formatTime(x / pixelsPerSecond);
    }
    $('timeline-scroll').addEventListener('pointermove', event => { cutPointer = {x:event.clientX,y:event.clientY}; updateCutCursor(); });
    $('timeline-scroll').addEventListener('pointerleave', () => { cutPointer = null; updateCutCursor(); });
    let rulerFrame = 0;
    $('timeline-scroll').addEventListener('scroll', () => {
        updateCutCursor();
        if (!rulerFrame) rulerFrame = requestAnimationFrame(() => { rulerFrame = 0; renderRuler(); });
    }, {passive:true});
    window.SoriUserSounds.mount({root, storageError: userStorageError,
        onAdd(sound) {
            for (const item of (Array.isArray(sound) ? sound : [sound])) {
                const index = library.findIndex(entry => entry.id === item.id);
                if (index < 0) library.push(item); else library[index] = item;
                byId.set(item.id, item); durations.set(item.id, item.duration);
            }
            renderLibrary();
        },
        beforeListen() {
            pauseTimeline(); stopPreview();
            window.dispatchEvent(new CustomEvent('sound-start', {detail: {owner: 'user-draft'}}));
        }
    });
    window.SoriUserSounds.mountDivider(root);
    if (!document.getElementById('generator-page').inert && !window.isSoriMobile?.()) $('generator-back').focus({preventScroll: true});
    setTool('select');
    restoreProject();
    renderLibrary();
    renderEditor();
    if (!library.length) status('불러온 음원이 없다. 음원 목록 파일을 확인해달라.', true);
})();
