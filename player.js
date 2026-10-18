(function () {
    'use strict';

    function startPlayer() {
        const mount = document.getElementById('sound-player');
        const tracks = Array.isArray(window.collageTracks) ? window.collageTracks : [];
        if (!mount || !tracks.length) return;

        mount.innerHTML = `
            <div class="player-heading"><h2 id="player-title"></h2><span id="player-count"></span></div>
            <div class="player-wave-area">
                <canvas id="player-wave" tabindex="0" role="slider" aria-label="재생 위치" aria-orientation="horizontal" aria-valuemin="0" aria-valuemax="1" aria-valuenow="0" title="파형을 누르거나 좌우 방향키로 재생 위치를 바꾼다."></canvas>
            </div>
            <div class="player-time"><span id="player-elapsed">00:00</span><span id="player-duration">00:00</span></div>
            <div class="player-buttons">
                <button id="player-previous" type="button" aria-label="이전 트랙">이전</button>
                <button id="player-play" type="button" aria-label="재생">재생</button>
                <button id="player-next" type="button" aria-label="다음 트랙">다음</button>
            </div>
            <div class="player-volume"><input id="player-volume" type="range" min="0" max="1" step="0.01" value="0.8" aria-label="음량" aria-orientation="vertical" aria-valuetext="80%" title="음량"></div>
            <p id="player-message" role="status" aria-live="polite"></p>
        `;

        const audio = new Audio();
        audio.preload = 'metadata';
        audio.volume = 0.8;
        const title = document.getElementById('player-title');
        const count = document.getElementById('player-count');
        const playButton = document.getElementById('player-play');
        const elapsed = document.getElementById('player-elapsed');
        const duration = document.getElementById('player-duration');
        const message = document.getElementById('player-message');
        const canvas = document.getElementById('player-wave');
        const context = canvas.getContext('2d');
        const playlistList = document.getElementById('playlist-list');
        const playlistButtons = [];
        let currentIndex = 0;
        let playRequest = 0;
        let animation = 0;
        let pendingSeek = null;
        let waveformDrag = false;
        let autoplayRetryAllowed = true;
        let autoplayRetryPending = false;

        function cancelAutoplayRetry() {
            autoplayRetryAllowed = false;
            autoplayRetryPending = false;
            document.removeEventListener('pointerup', retryAutoplay);
            document.removeEventListener('keydown', retryAutoplay);
        }

        function retryAutoplay(event) {
            if (!autoplayRetryPending || !event.isTrusted) return;
            if (event.type === 'pointerup' && event.button !== 0) return;
            if (event.type === 'keydown' && (event.repeat || event.isComposing || event.ctrlKey || event.metaKey || event.altKey || ['Shift', 'Control', 'Alt', 'Meta', 'Escape'].includes(event.key))) return;

            // 재생 조작이나 생성기 사용은 해당 화면의 동작을 따른다.
            // 탐색 메뉴나 배경의 첫 실제 클릭/키 입력에서만 자동 재생을 다시 시도한다.
            const explicitControl = event.target && typeof event.target.closest === 'function'
                && event.target.closest('#sound-player, #playlist-list, #generator-page');
            cancelAutoplayRetry();
            if (explicitControl || currentIndex !== 0 || !audio.paused) return;
            void playCurrent();
        }

        function waitForAutoplayGesture() {
            if (!autoplayRetryAllowed || autoplayRetryPending) return;
            autoplayRetryPending = true;
            document.addEventListener('pointerup', retryAutoplay);
            document.addEventListener('keydown', retryAutoplay);
        }

        function trackName(track) {
            return track.name || track.person || '소리마당';
        }

        function timeText(seconds) {
            const safe = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
            return `${Math.floor(safe / 60).toString().padStart(2, '0')}:${(safe % 60).toString().padStart(2, '0')}`;
        }

        function trackDuration() {
            return Number.isFinite(audio.duration) && audio.duration > 0
                ? audio.duration
                : Number(tracks[currentIndex].duration) || 0;
        }

        function updateButtons() {
            const playing = !audio.paused && !audio.ended;
            playButton.textContent = playing ? '일시 정지' : '재생';
            playButton.setAttribute('aria-label', playing ? '일시 정지' : '재생');
            playlistButtons.forEach((button, index) => {
                const selected = index === currentIndex;
                button.classList.toggle('is-current', selected);
                button.setAttribute('aria-pressed', String(selected));
                button.querySelector('.playlist-state').textContent = selected ? (playing ? '재생 중' : '선택됨') : '';
            });
        }

        function drawWave() {
            if (!context) return;
            const box = canvas.getBoundingClientRect();
            if (!box.width || !box.height) return;
            const ratio = window.devicePixelRatio || 1;
            const width = Math.round(box.width * ratio);
            const height = Math.round(box.height * ratio);
            if (canvas.width !== width || canvas.height !== height) {
                canvas.width = width;
                canvas.height = height;
            }
            context.clearRect(0, 0, width, height);
            const total = trackDuration();
            const played = total ? Math.min(1, audio.currentTime / total) : 0;
            const peaks = tracks[currentIndex].peaks || [];
            const middle = height / 2;
            if (peaks.length) {
                const bars = Math.min(peaks.length, Math.max(1, Math.floor(box.width / 3)));
                const spacing = width / bars;
                for (let i = 0; i < bars; i += 1) {
                    const from = Math.floor(i * peaks.length / bars);
                    const to = Math.max(from + 1, Math.floor((i + 1) * peaks.length / bars));
                    let peak = 0;
                    for (let j = from; j < to; j += 1) peak = Math.max(peak, Math.abs(Number(peaks[j]) || 0));
                    const barHeight = Math.max(ratio, Math.min(1, peak) * (height - 10 * ratio));
                    context.fillStyle = i / bars <= played ? '#ebebeb' : '#626262';
                    context.fillRect(i * spacing, middle - barHeight / 2, Math.max(ratio, spacing - ratio), barHeight);
                }
            } else {
                context.fillStyle = '#626262';
                context.fillRect(0, middle, width, ratio);
            }
            context.fillStyle = '#ffffff';
            context.fillRect(Math.min(width - ratio, played * width), 0, ratio, height);
        }

        function updateProgress() {
            const total = trackDuration();
            const position = Math.max(0, audio.currentTime || 0);
            canvas.setAttribute('aria-valuemax', String(total || 1));
            canvas.setAttribute('aria-valuenow', String(position));
            canvas.setAttribute('aria-valuetext', `${timeText(position)} / ${timeText(total)}`);
            elapsed.textContent = timeText(position);
            duration.textContent = timeText(total);
            drawWave();
        }

        function animate() {
            updateProgress();
            animation = audio.paused ? 0 : requestAnimationFrame(animate);
        }

        function startAnimation() {
            if (!animation) animation = requestAnimationFrame(animate);
        }

        function stopAnimation() {
            if (animation) cancelAnimationFrame(animation);
            animation = 0;
            updateProgress();
        }

        async function playCurrent(isAutoplay = false) {
            if (!isAutoplay) cancelAutoplayRetry();
            const request = ++playRequest;
            window.dispatchEvent(new CustomEvent('sound-start', { detail: { owner: 'playlist' } }));
            message.textContent = '음원을 불러오는 중…';
            try {
                await audio.play();
                if (request !== playRequest) return;
                message.textContent = '';
                updateButtons();
                startAnimation();
            } catch (error) {
                if (request !== playRequest) return;
                if (error.name === 'NotAllowedError') {
                    message.textContent = isAutoplay
                        ? '자동 재생이 제한되었습니다. 화면을 누르거나 재생을 선택해 주세요.'
                        : '재생 버튼을 눌러 다시 시작해 주세요.';
                    if (isAutoplay) waitForAutoplayGesture();
                } else if (error.name !== 'AbortError') {
                    message.textContent = '음원을 재생할 수 없습니다. 재생을 다시 누르거나 다음 트랙을 선택해 주세요.';
                }
                updateButtons();
            }
        }

        function pauseCurrent() {
            cancelAutoplayRetry();
            playRequest += 1;
            audio.pause();
            message.textContent = '';
            updateButtons();
            stopAnimation();
        }

        function selectTrack(index, shouldPlay = true, isAutoplay = false) {
            if (!isAutoplay) cancelAutoplayRetry();
            playRequest += 1;
            audio.pause();
            currentIndex = (index % tracks.length + tracks.length) % tracks.length;
            pendingSeek = null;
            const track = tracks[currentIndex];
            title.textContent = trackName(track);
            count.textContent = `${String(currentIndex + 1).padStart(2, '0')} / ${String(tracks.length).padStart(2, '0')}`;
            audio.src = track.url;
            audio.load();
            message.textContent = '';
            updateButtons();
            updateProgress();
            if (shouldPlay) void playCurrent(isAutoplay);
        }

        function seekTo(seconds) {
            const target = Math.max(0, Math.min(trackDuration(), Number(seconds) || 0));
            if (audio.readyState < 1) {
                pendingSeek = target;
                return;
            }
            audio.currentTime = target;
            updateProgress();
        }

        function seekFromPointer(event) {
            const box = canvas.getBoundingClientRect();
            if (!box.width) return;
            const fraction = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width));
            seekTo(fraction * trackDuration());
        }

        playButton.addEventListener('click', () => {
            if (audio.paused) void playCurrent();
            else pauseCurrent();
        });
        document.getElementById('player-previous').addEventListener('click', () => selectTrack(currentIndex - 1));
        document.getElementById('player-next').addEventListener('click', () => selectTrack(currentIndex + 1));
        document.getElementById('player-volume').addEventListener('input', (event) => {
            audio.volume = Number(event.target.value);
            event.target.setAttribute('aria-valuetext', `${Math.round(audio.volume * 100)}%`);
            event.target.style.setProperty('--volume-fill', `${audio.volume * 100}%`);
        });
        canvas.addEventListener('keydown', (event) => {
            if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const step = event.shiftKey ? 30 : 5;
            if (event.key === 'Home') seekTo(0);
            else if (event.key === 'End') seekTo(trackDuration());
            else seekTo(audio.currentTime + (['ArrowLeft', 'ArrowDown'].includes(event.key) ? -step : step));
        });
        canvas.addEventListener('pointerdown', (event) => {
            if (event.button !== 0) return;
            canvas.focus({preventScroll: true});
            waveformDrag = true;
            canvas.setPointerCapture(event.pointerId);
            seekFromPointer(event);
        });
        canvas.addEventListener('pointermove', (event) => {
            if (waveformDrag) seekFromPointer(event);
        });
        canvas.addEventListener('pointerup', () => { waveformDrag = false; });
        canvas.addEventListener('pointercancel', () => { waveformDrag = false; });
        canvas.addEventListener('lostpointercapture', () => { waveformDrag = false; });

        audio.addEventListener('loadedmetadata', () => {
            if (pendingSeek !== null) {
                const target = pendingSeek;
                pendingSeek = null;
                seekTo(target);
            }
            updateProgress();
        });
        audio.addEventListener('durationchange', updateProgress);
        audio.addEventListener('timeupdate', updateProgress);
        audio.addEventListener('playing', () => {
            cancelAutoplayRetry();
            message.textContent = '';
            updateButtons();
            startAnimation();
        });
        audio.addEventListener('pause', () => {
            updateButtons();
            stopAnimation();
        });
        audio.addEventListener('ended', () => selectTrack(currentIndex + 1));
        audio.addEventListener('waiting', () => {
            if (!audio.paused) message.textContent = '음원을 불러오는 중…';
        });
        audio.addEventListener('error', () => {
            cancelAutoplayRetry();
            message.textContent = '음원을 불러올 수 없습니다. 파일 경로를 확인하거나 다음 트랙을 선택해 주세요.';
            updateButtons();
            stopAnimation();
        });
        window.addEventListener('sound-start', (event) => {
            if (event.detail && event.detail.owner !== 'playlist') pauseCurrent();
        });

        if (playlistList) {
            playlistList.replaceChildren();
            tracks.forEach((track, index) => {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'playlist-track';
                button.innerHTML = '<span class="playlist-number"></span><span class="playlist-name"></span><span class="playlist-state"></span><span class="playlist-duration"></span>';
                button.querySelector('.playlist-number').textContent = String(index + 1).padStart(2, '0');
                button.querySelector('.playlist-name').textContent = trackName(track);
                button.querySelector('.playlist-duration').textContent = timeText(Number(track.duration));
                button.setAttribute('aria-label', `${trackName(track)} 재생`);
                button.addEventListener('click', () => selectTrack(index));
                playlistList.append(button);
                playlistButtons.push(button);
            });
        }

        if ('ResizeObserver' in window) new ResizeObserver(drawWave).observe(canvas);
        else window.addEventListener('resize', drawWave);
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) stopAnimation();
            else if (!audio.paused) startAnimation();
        });

        // 다른 화면에서도 필요한 경우 이 기능들을 호출할 수 있다.
        window.soriPlayer = {
            play: () => playCurrent(),
            pause: pauseCurrent,
            next: () => selectTrack(currentIndex + 1),
            selectTrack: (index) => {
                if (Number.isInteger(index)) selectTrack(index);
            },
            getState: () => ({ index: currentIndex, playing: !audio.paused, currentTime: audio.currentTime, duration: trackDuration() })
        };

        selectTrack(0, true, true);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startPlayer, { once: true });
    else startPlayer();
}());
