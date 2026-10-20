/* 소리마당+: 미연결 시 IndexedDB, 연결 후에는 Supabase 공용 저장소를 사용한다.
   기존 로컬 소리는 공유 버튼으로 직접 등록하기 전까지 공개하지 않는다.
   비밀키를 이 파일이나 공개 저장소에 넣지 않는다. */
(() => {
    'use strict';
    const MAX_BYTES = 50 * 1024 * 1024;
    const MAX_SECONDS = 60;
    const cloud = window.SoriCloud;
    const sharing = Boolean(cloud?.enabled);
    let nextPage = null;
    let loadError = false;
    const DB_NAME = 'sorimadang-user-sounds';
    let dbPromise;
    const urls = new Map();
    const localDate = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

    function openDatabase() {
        if (dbPromise) return dbPromise;
        dbPromise = new Promise((resolve, reject) => {
            if (!window.indexedDB) return reject(new Error('이 브라우저에서는 소리를 보관할 수 없다.'));
            const request = indexedDB.open(DB_NAME, 1);
            let finished = false;
            const timer = setTimeout(() => fail(), 5000);
            function fail() {
                if (finished) return;
                finished = true; clearTimeout(timer);
                reject(new Error('브라우저 저장소를 열 수 없다. 다른 탭을 닫거나 저장소 사용 설정을 확인해달라.'));
            }
            request.onupgradeneeded = () => {
                if (!request.result.objectStoreNames.contains('sounds')) request.result.createObjectStore('sounds', {keyPath: 'id'});
            };
            request.onerror = fail;
            request.onblocked = fail;
            request.onsuccess = () => {
                if (finished) { request.result.close(); return; }
                finished = true; clearTimeout(timer);
                const db = request.result;
                db.onversionchange = () => { db.close(); dbPromise = null; };
                resolve(db);
            };
        });
        return dbPromise;
    }
    async function loadRecords() {
        const db = await openDatabase();
        return new Promise((resolve, reject) => {
            const tx = db.transaction('sounds', 'readonly');
            const request = tx.objectStore('sounds').getAll();
            tx.oncomplete = () => resolve(request.result || []);
            tx.onabort = tx.onerror = () => reject(new Error('저장한 소리를 읽을 수 없다. 새로고침해달라.'));
        });
    }
    async function saveRecord(record) {
        const db = await openDatabase();
        return new Promise((resolve, reject) => {
            const tx = db.transaction('sounds', 'readwrite');
            tx.objectStore('sounds').add(record);
            // 요청 성공이 아니라 트랜잭션 완료 후에만 목록에 등록한다.
            tx.oncomplete = () => resolve(record);
            tx.onabort = tx.onerror = () => reject(new Error('저장 공간이 부족하거나 저장이 차단되었다. 음원을 내려받아 보관해달라.'));
        });
    }
    function asSound(record) {
        if (!urls.has(record.id)) urls.set(record.id, URL.createObjectURL(record.blob));
        return {id: record.id, person: record.author, name: record.title, duration: record.duration,
            url: urls.get(record.id), isUser: true, recordedDate: record.recordedDate,
            isPublic: false, createdAt: record.createdAt, registeredDate: localDate(new Date(record.createdAt)), source: record.source};
    }
    async function load() {
        const local = (await loadRecords()).filter(record => record.blob instanceof Blob && record.duration > 0)
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(asSound);
        if (!sharing) return local;
        try {
            const page = await cloud.list(); nextPage = page.next;
            const all = new Map(local.map(sound => [sound.id, sound]));
            page.sounds.forEach(sound => all.set(sound.id, sound));
            // 첫 200개 목록 밖의 음원도 이전 타임라인을 복원할 수 있게 불러온다.
            let saved;
            try { saved = JSON.parse(localStorage.getItem('sorimadang-project-v1') || 'null'); } catch (_) {}
            const ids = [...new Set((saved?.clips || []).map(clip => clip.soundId))].filter(id => /^user-/.test(id) && !all.get(id)?.isPublic);
            await Promise.all(ids.slice(0, 12).map(async id => { const sound = await cloud.get(id); if (sound) all.set(id, sound); }));
            loadError = false;
            return [...all.values()];
        } catch (error) { loadError = true; throw error; }
    }

    // 확장자만 바꾼 MP4도 통과하지 않도록 실제 파일 머리말을 함께 확인한다.
    function isAllowedFile(bytes, filename) {
        const data = new Uint8Array(bytes);
        const text = (start, count) => String.fromCharCode(...data.subarray(start, start + count));
        if (/\.wav$/i.test(filename)) return data.length >= 12 && ['RIFF', 'RF64'].includes(text(0, 4)) && text(8, 4) === 'WAVE';
        if (!/\.mp3$/i.test(filename)) return false;
        let offset = 0;
        if (text(0, 3) === 'ID3') {
            if (data.length < 10 || data.subarray(6, 10).some(value => value > 127)) return false;
            offset = 10 + (data[6] * 2097152 + data[7] * 16384 + data[8] * 128 + data[9]);
            if (data[3] === 4 && (data[5] & 16)) offset += 10;
        }
        // ID3 뒤의 0 패딩을 지나 MPEG Layer III 프레임을 확인한다.
        while (offset < data.length && data[offset] === 0) offset++;
        return offset + 4 <= data.length && data[offset] === 255 && (data[offset + 1] & 224) === 224
            && ((data[offset + 1] >> 3) & 3) !== 1 && ((data[offset + 1] >> 1) & 3) === 1
            && (data[offset + 2] >> 4) !== 15 && ((data[offset + 2] >> 2) & 3) !== 3;
    }

    const markup = `
        <section id="user-library" class="sound-library" aria-labelledby="user-library-title">
            <div class="generator-heading"><h2 id="user-library-title">소리마당+ <span id="user-sound-count"></span></h2></div>
            <p class="user-storage-note">음원 한 개당 최대 1분까지 등록 가능하며, ${sharing ? '등록한 소리는 모든 방문자가 듣고 소리마당 제작에 사용할 수 있다. 등록된 후 삭제는 불가능하다.' : '현재는 이 브라우저에만 저장되며 다른 방문자에게 공개되지 않는다. 브라우저 데이터를 지우면 소리도 사라진다.'}</p>
            <div class="user-sound-actions">
                <button id="choose-audio" type="button">파일 추가</button><input id="user-audio-file" type="file" accept=".mp3,.wav,audio/mpeg,audio/wav" hidden>
                <button id="record-audio" type="button">● 녹음</button><button id="stop-recording" type="button" hidden>■ 녹음 끝내기</button><output id="recording-time" aria-label="녹음 시간" hidden>00:00</output>
            </div>
            <p id="user-sound-message" role="status" aria-live="polite" hidden></p>
            <form id="user-sound-form" hidden>
                <audio id="user-audio-preview" controls preload="metadata" aria-label="등록 전 미리 듣기"></audio>
                <div class="user-sound-fields">
                    <label>닉네임<input id="user-author" name="author" maxlength="30" autocomplete="nickname" required></label>
                    <label>녹음 제목<input id="user-title" name="title" maxlength="80" required></label>
                    <label>녹음일 (선택)<input id="user-recorded-date" name="recorded-date" type="date"></label>
                </div>
                <div id="upload-challenge" ${sharing ? '' : 'hidden'}></div>
                <div class="user-sound-actions"><button id="register-sound" type="submit">등록</button><button id="cancel-user-sound" type="button">취소</button><a id="download-user-sound">저장</a></div>
            </form>
            <div class="library-filters"><input id="user-sound-search" type="search" aria-label="소리마당+ 검색" placeholder="닉네임, 녹음 제목, 날짜 검색"></div>
            <div id="user-sound-list" class="sound-list" aria-label="사용자가 추가한 소리 목록"></div>
            <div class="user-sound-actions" ${sharing ? '' : 'hidden'}><button id="refresh-user-sounds" type="button">새로고침</button><button id="more-user-sounds" type="button" hidden>더 보기</button></div>
        </section>`;

    function mount({root, onAdd, beforeListen, storageError}) {
        const $ = id => root.querySelector(`#${id}`);
        const audio = $('user-audio-preview');
        let draft = null, draftUrl = null, recorder = null, stream = null;
        let timer = 0, started = 0, chunks = [], bytes = 0;
        let busy = false, capturing = false, captureToken = 0;
        const message = text => { $('user-sound-message').textContent = text; $('user-sound-message').hidden = !text; };
        function sync() {
            $('choose-audio').disabled = busy || capturing;
            $('record-audio').disabled = busy || capturing || !navigator.mediaDevices?.getUserMedia || !window.MediaRecorder;
            $('record-audio').hidden = capturing;
            $('stop-recording').hidden = !capturing;
            $('stop-recording').disabled = busy;
            $('recording-time').hidden = !capturing;
            $('register-sound').disabled = busy || capturing || !draft || Boolean(storageError);
            $('cancel-user-sound').disabled = busy;
            ['user-author', 'user-title', 'user-recorded-date'].forEach(id => { $(id).disabled = busy; });
        }
        function clearDraft() {
            if (sharing) cloud.resetChallenge();
            audio.pause(); audio.removeAttribute('src'); audio.load();
            if (draftUrl) URL.revokeObjectURL(draftUrl);
            draftUrl = null; draft = null;
            $('user-sound-form').hidden = true;
            $('user-audio-file').value = '';
            $('download-user-sound').removeAttribute('href');
            sync();
        }
        function stopTracks() { stream?.getTracks().forEach(track => track.stop()); stream = null; }
        async function prepare(blob, info) {
            busy = true; sync(); message('소리를 확인하는 중…');
            let ctx;
            try {
                if (!blob.size) throw new Error('녹음된 소리가 없다. 다시 녹음해달라.');
                if (blob.size > MAX_BYTES) throw new Error('파일은 50MB 이하로 추가해달라.');
                if (info.source === 'file' && !/\.(mp3|wav)$/i.test(info.filename)) throw new Error('MP3 또는 WAV 파일만 추가할 수 있다.');
                const bytes = await blob.arrayBuffer();
                if (info.source === 'file' && !isAllowedFile(bytes, info.filename)) throw new Error('파일 형식이 MP3 또는 WAV가 아니다. 확장자가 아닌 실제 음원 형식을 확인해달라.');
                const Context = window.AudioContext || window.webkitAudioContext;
                ctx = new Context();
                const buffer = await ctx.decodeAudioData(bytes);
                if (!Number.isFinite(buffer.duration) || buffer.duration < .05 || info.source === 'file' && buffer.duration > MAX_SECONDS + .1)
                    throw new Error('0.05초 이상, 1분 이하의 음원을 추가해달라.');
                if (info.source === 'recording' && (sharing || buffer.duration > MAX_SECONDS)) {
                    blob = await cloud.recordingWav(buffer, MAX_SECONDS);
                    // 긴 기존 녹음에서 만든 1분 사본은 새 ID로 등록해 원본 타임라인 참조를 보존한다.
                    info = {...info, ...(buffer.duration > MAX_SECONDS ? {id: undefined} : {}), filename: `소리마당-${info.recordedDate}.wav`};
                }
                clearDraft();
                draft = {...info, blob, duration: info.source === 'recording' ? Math.min(buffer.duration, MAX_SECONDS) : buffer.duration};
                draftUrl = URL.createObjectURL(blob); audio.src = draftUrl;
                $('user-title').value = info.title;
                if (info.author) $('user-author').value = info.author;
                $('user-recorded-date').value = info.recordedDate;
                $('user-recorded-date').readOnly = info.source === 'recording';
                $('user-sound-form').hidden = false;
                $('download-user-sound').href = draftUrl;
                const extension = /mp4|m4a/.test(blob.type) ? 'm4a' : /ogg/.test(blob.type) ? 'ogg' : 'webm';
                $('download-user-sound').download = info.filename || `소리마당-${info.recordedDate}.${extension}`;
                if (sharing) await cloud.showChallenge($('upload-challenge'));
                message(storageError || (info.source === 'recording' && buffer.duration > MAX_SECONDS ? '앞 1분까지 담았다. 닉네임과 제목을 적고 등록해달라.' : '닉네임과 제목을 적고 등록해달라.'));
            } catch (error) { message(error.name === 'EncodingError' ? '이 파일은 읽을 수 없는 음원이다. MP3 또는 WAV 파일로 다시 추가해달라.' : error.message); }
            finally { if (ctx) await ctx.close().catch(() => {}); busy = false; sync(); }
        }
        function stopRecording() {
            if (!capturing) return;
            clearInterval(timer); timer = 0;
            busy = true; sync();
            if (recorder?.state !== 'inactive') recorder.stop();
            stopTracks();
        }
        async function startRecording() {
            if (busy || capturing) return;
            busy = true; sync(); message('마이크 사용을 허용해달라.');
            const token = ++captureToken;
            try {
                const input = await navigator.mediaDevices.getUserMedia({audio: true});
                if (token !== captureToken || document.getElementById('generator-page').inert) {
                    input.getTracks().forEach(track => track.stop()); message('녹음을 시작하지 않았다.'); return;
                }
                stream = input;
                const mime = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus'].find(type => MediaRecorder.isTypeSupported(type));
                recorder = new MediaRecorder(stream, mime ? {mimeType: mime} : undefined);
                chunks = []; bytes = 0; started = Date.now();
                const recordedDate = localDate(new Date(started));
                recorder.addEventListener('dataavailable', event => {
                    if (event.data.size) { chunks.push(event.data); bytes += event.data.size; }
                    if (bytes >= MAX_BYTES) stopRecording();
                });
                let recordingError = false;
                recorder.addEventListener('error', () => { recordingError = true; stopRecording(); message('녹음이 중단되었다. 다시 시도해달라.'); });
                recorder.addEventListener('stop', async () => {
                    clearInterval(timer); timer = 0; stopTracks(); capturing = false;
                    const blob = new Blob(chunks, {type: recorder.mimeType || chunks[0]?.type || 'audio/webm'});
                    chunks = []; recorder = null;
                    if (recordingError) { busy = false; sync(); return; }
                    await prepare(blob, {source: 'recording', recordedDate, recordedAt: new Date(started).toISOString(), title: ''});
                }, {once: true});
                beforeListen(); audio.pause();
                recorder.start(1000); capturing = true;
                $('recording-time').textContent = '00:00';
                timer = setInterval(() => {
                    const seconds = Math.min(MAX_SECONDS, Math.floor((Date.now() - started) / 1000));
                    $('recording-time').textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
                    if (seconds >= MAX_SECONDS) stopRecording();
                }, 250);
                message('녹음 중 · 최대 1분');
            } catch (error) {
                stopTracks();
                message(error.name === 'NotAllowedError' ? '마이크 권한이 필요하다. 브라우저의 사이트 권한에서 허용해달라.' : '마이크를 사용할 수 없다. 연결 상태와 HTTPS 주소인지 확인해달라.');
            } finally { busy = false; sync(); }
        }
        $('choose-audio').addEventListener('click', () => $('user-audio-file').click());
        $('user-audio-file').addEventListener('change', () => {
            const file = $('user-audio-file').files[0];
            if (file) prepare(file, {source: 'file', filename: file.name, title: file.name.replace(/\.[^.]+$/, '').slice(0, 80), recordedDate: ''});
        });
        $('record-audio').addEventListener('click', startRecording);
        $('stop-recording').addEventListener('click', stopRecording);
        $('cancel-user-sound').addEventListener('click', () => { clearDraft(); message(''); });
        audio.addEventListener('play', beforeListen);
        $('user-sound-form').addEventListener('submit', async event => {
            event.preventDefault();
            if (busy || capturing || !draft || storageError || !$('user-sound-form').reportValidity()) return;
            const author = $('user-author').value.trim(), title = $('user-title').value.trim();
            if (!author || !title) { message('공백 대신 닉네임과 녹음 제목을 입력해달라.'); return; }
            busy = true; audio.pause(); sync(); message('저장하는 중…');
            try {
                draft.id ||= `user-${crypto.randomUUID()}`;
                const record = {...draft, author: author.slice(0, 30), title: title.slice(0, 80),
                    recordedDate: $('user-recorded-date').value, createdAt: new Date().toISOString()};
                if (sharing) onAdd(await cloud.publish(record));
                else { await saveRecord(record); onAdd(asSound(record)); }
                clearDraft(); message(sharing ? '모두에게 공개했다. 타임라인으로 끌어와 사용할 수 있다.' : '이 브라우저에 등록했다. 타임라인으로 끌어와 사용할 수 있다.');
            } catch (error) { message(error.message || '소리를 저장하지 못했다.'); }
            finally { busy = false; sync(); }
        });
        if (sharing) {
            let refreshing = false, searchTimer = 0, queryVersion = 0, lastQuery = '';
            $('more-user-sounds').hidden = !nextPage;
            async function refresh(more = false, quiet = false) {
                if (refreshing || storageError) return;
                refreshing = true;
                const query = $('user-sound-search').value.trim(), version = queryVersion;
                $('refresh-user-sounds').disabled = true; $('more-user-sounds').disabled = true;
                try {
                    const page = await cloud.list(query, more ? nextPage : '');
                    if (version !== queryVersion) return;
                    onAdd(page.sounds);
                    if (more || !quiet || query !== lastQuery || !nextPage) nextPage = page.next;
                    lastQuery = query;
                    $('more-user-sounds').hidden = !nextPage;
                    if (!quiet) message('공용 목록을 불러왔다.');
                } catch (error) { if (!quiet) message(error.message); }
                finally {
                    refreshing = false; $('refresh-user-sounds').disabled = false; $('more-user-sounds').disabled = false;
                    if (version !== queryVersion) void refresh(false, true);
                }
            }
            $('refresh-user-sounds').addEventListener('click', () => { if (storageError) { message('연결을 다시 시도하려면 페이지를 새로고침해달라. 기존 편집 정보는 보존되어 있다.'); return; } void refresh(); });
            $('more-user-sounds').addEventListener('click', () => void refresh(true));
            $('user-sound-search').addEventListener('input', () => { queryVersion++; clearTimeout(searchTimer); searchTimer = setTimeout(() => void refresh(false, true), 350); });
            const poll = setInterval(() => { if (!document.hidden && !document.getElementById('generator-page').inert && !window.isSoriMobile?.()) void refresh(false, true); }, 30000);
            window.addEventListener('generator-visibility', event => { if (event.detail.open) void refresh(false, true); });
            window.addEventListener('pagehide', event => { if (!event.persisted) clearInterval(poll); });
            // 예전 로컬 소리는 사용자가 공유 버튼을 눌러 확인한 뒤 공개한다.
            $('user-sound-list').addEventListener('click', async event => {
                const button = event.target.closest('[data-action="publish"]');
                if (!button || busy || capturing) return;
                const id = button.closest('[data-sound-id]').dataset.soundId;
                try {
                    const record = (await loadRecords()).find(item => item.id === id);
                    if (!record) throw new Error('이 브라우저에 저장된 원본을 찾을 수 없다.');
                    await prepare(record.blob, record);
                    $('user-sound-form').scrollIntoView({block:'nearest'});
                } catch (error) { message(error.message); }
            });
        }
        window.addEventListener('sound-start', event => {
            if (event.detail?.owner !== 'user-draft') { audio.pause(); if (capturing) stopRecording(); }
        });
        window.addEventListener('generator-visibility', event => {
            if (!event.detail.open) { captureToken++; audio.pause(); if (capturing) stopRecording(); }
        });
        window.addEventListener('pagehide', () => { captureToken++; audio.pause(); if (capturing) stopRecording(); stopTracks(); });
        sync();
        if (storageError) message(storageError);
        else if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) message('이 환경에서는 직접 녹음할 수 없다. HTTPS 주소에서 열거나 파일 추가를 사용해달라.');
    }

    function mountDivider(root) {
        const split = root.querySelector('#library-split');
        const divider = root.querySelector('#library-divider');
        let ratio = 50, drag = null;
        try { const saved = Number(localStorage.getItem('sorimadang-library-width')); if (saved >= 20 && saved <= 80) ratio = saved; } catch (_) {}
        function set(value, save = false) {
            ratio = Math.max(20, Math.min(80, value));
            split.style.setProperty('--library-left-width', `${ratio}%`);
            divider.setAttribute('aria-valuenow', String(Math.round(ratio)));
            if (save) try { localStorage.setItem('sorimadang-library-width', String(ratio)); } catch (_) {}
        }
        function move(event) {
            if (!drag || event.pointerId !== drag.id) return;
            const bounds = split.getBoundingClientRect();
            set((event.clientX - bounds.left) / bounds.width * 100);
        }
        divider.addEventListener('pointerdown', event => {
            if (event.button !== 0) return;
            event.preventDefault(); divider.focus(); drag = {id: event.pointerId, original: ratio};
            divider.setPointerCapture(event.pointerId); split.classList.add('is-resizing');
        });
        divider.addEventListener('pointermove', move);
        function end(event) {
            if (!drag || event.pointerId !== drag.id) return;
            if (event.type === 'pointercancel') set(drag.original); else { move(event); set(ratio, true); }
            drag = null; split.classList.remove('is-resizing');
            if (divider.hasPointerCapture(event.pointerId)) divider.releasePointerCapture(event.pointerId);
        }
        divider.addEventListener('pointerup', end);
        divider.addEventListener('pointercancel', end);
        divider.addEventListener('lostpointercapture', () => { drag = null; split.classList.remove('is-resizing'); });
        divider.addEventListener('dblclick', () => set(50, true));
        divider.addEventListener('keydown', event => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault(); event.stopPropagation();
            set(event.key === 'Home' ? 20 : event.key === 'End' ? 80 : ratio + (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 10 : 2), true);
        });
        set(ratio);
    }
    window.SoriUserSounds = {load, markup, mount, mountDivider, sharing, hasLoadError: () => loadError};
})();
