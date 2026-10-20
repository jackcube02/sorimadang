/* 숫자는 초 단위다. 첫 화면은 고정 시간이 아니라 영상의 끝을 기다린다. */
const screenSettings = {
    idleSeconds: 180,       // 3분 동안 조작이 없으면 반복 재생
    fadeInSeconds: 0.5,
    fadeOutSeconds: 0.5,
    loadTimeoutSeconds: 15 // 영상이 멈추거나 로드되지 않아도 사이트에 진입할 수 있게 한다.
};
document.documentElement.classList.add('has-title-screen');
window.soriIntroFinished = false;

document.addEventListener('DOMContentLoaded', () => {
    const screen = document.getElementById('title-screen');
    const video = document.getElementById('screen-video');
    // 첫 진입은 HTML의 샘플 1, 화면보호기는 시작할 때마다 둘 중 하나를 고른다.
    const screenVideos = [video?.getAttribute('src'), video?.dataset.idleVideo].filter(Boolean);
    const main = document.getElementById('main');
    const retry = document.getElementById('screen-play');
    const skip = document.getElementById('screen-skip');
    function finishIntro() {
        if (window.soriIntroFinished) return;
        window.soriIntroFinished = true;
        window.dispatchEvent(new CustomEvent('intro-finished'));
    }
    if (!screen || !main || !video) {
        document.documentElement.classList.remove('has-title-screen');
        finishIntro(); return;
    }
    const seconds = (value, fallback) => Number.isFinite(value) && value >= 0 ? value : fallback;
    const idleDelay = Math.max(.1, seconds(screenSettings.idleSeconds, 180)) * 1000;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const fadeIn = reducedMotion ? 0 : seconds(screenSettings.fadeInSeconds, .5) * 1000;
    const fadeOut = reducedMotion ? 0 : seconds(screenSettings.fadeOutSeconds, .5) * 1000;
    const loadTimeout = Math.max(1, seconds(screenSettings.loadTimeoutSeconds, 15)) * 1000;
    screen.style.setProperty('--screen-fade-in', `${fadeIn}ms`);
    screen.style.setProperty('--screen-fade-out', `${fadeOut}ms`);
    let state = 'intro', idleTimer = 0, hideTimer = 0, loadTimer = 0, playRequest = 0;
    let lastFocus = document.activeElement;
    let previousInert = main.inert;
    const pressedPointers = new Set();
    video.muted = true;
    video.defaultMuted = true;
    video.playsInline = true;
    main.inert = true;
    screen.setAttribute('aria-hidden', 'false');

    function scheduleIdle() {
        clearTimeout(idleTimer);
        if (state !== 'awake' || document.hidden || pressedPointers.size) return;
        idleTimer = setTimeout(showIdleScreen, idleDelay);
    }
    function watchVideo() {
        clearTimeout(loadTimer);
        if (!document.hidden && (state === 'intro' || state === 'idle')) loadTimer = setTimeout(hideScreen, loadTimeout);
    }
    async function playVideo(restart = false) {
        const request = ++playRequest;
        retry.hidden = true; skip.hidden = true;
        video.loop = state === 'idle';
        if (restart) { try { video.currentTime = 0; } catch (_) {} }
        if (document.hidden) return;
        watchVideo();
        try {
            await video.play();
        } catch (error) {
            if (request !== playRequest || !['intro', 'idle'].includes(state) || document.hidden) return;
            if (error.name === 'NotAllowedError') {
                // 저전력 모드 등에서 무음 자동 재생도 막힐 때만 직접 재생 버튼을 보여준다.
                clearTimeout(loadTimer);
                retry.hidden = false; skip.hidden = false;
                screen.classList.add('is-ready');
                retry.focus({preventScroll: true});
            } else hideScreen();
        }
    }
    function showIdleScreen() {
        if (state !== 'awake' || document.hidden || pressedPointers.size) return;
        state = 'idle';
        const nextVideo = screenVideos[Math.floor(Math.random() * screenVideos.length)];
        if (nextVideo && video.getAttribute('src') !== nextVideo) {
            video.setAttribute('src', nextVideo);
            video.load();
        }
        lastFocus = document.activeElement;
        previousInert = main.inert;
        main.inert = true;
        screen.setAttribute('aria-hidden', 'false');
        screen.classList.remove('is-hiding', 'is-ready');
        void screen.offsetWidth;
        screen.classList.add('is-visible');
        screen.focus({preventScroll: true});
        void playVideo(true);
    }
    function hideScreen() {
        if (state === 'hiding' || state === 'awake') return;
        ++playRequest;
        clearTimeout(loadTimer);
        retry.hidden = true; skip.hidden = true;
        state = 'hiding';
        screen.classList.add('is-hiding');
        screen.classList.remove('is-visible');
        hideTimer = setTimeout(() => {
            video.pause(); video.loop = false;
            screen.classList.remove('is-hiding', 'is-ready');
            screen.setAttribute('aria-hidden', 'true');
            main.inert = previousInert;
            state = 'awake';
            if (lastFocus && lastFocus !== document.body && lastFocus.isConnected) lastFocus.focus({preventScroll: true});
            finishIntro();
            scheduleIdle();
        }, fadeOut);
    }
    video.addEventListener('playing', () => {
        if (state !== 'intro' && state !== 'idle') { video.pause(); return; }
        screen.classList.add('is-ready');
        retry.hidden = true; skip.hidden = true;
        watchVideo();
    });
    video.addEventListener('timeupdate', watchVideo);
    video.addEventListener('waiting', watchVideo);
    video.addEventListener('ended', () => { if (state === 'intro') hideScreen(); });
    video.addEventListener('error', hideScreen);
    retry.addEventListener('click', () => void playVideo());
    skip.addEventListener('click', hideScreen);

    function handleActivity(event) {
        if (event.type === 'pointerdown') pressedPointers.add(event.pointerId);
        if (event.type === 'pointerup' || event.type === 'pointercancel') pressedPointers.delete(event.pointerId);
        if (event.target.closest?.('#screen-play, #screen-skip')) return;
        if (state === 'awake') { scheduleIdle(); return; }
        if (state === 'intro') {
            // 처음에는 영상 한 편을 모두 보여준다. Esc로만 건너뛸 수 있다.
            if (event.type === 'keydown' && event.key === 'Escape') hideScreen();
        } else if (state === 'idle') hideScreen();
        // 화면보호기를 깨우는 입력이 아래 페이지의 버튼을 누르지 않게 한다.
        if (!['pointermove', 'scroll'].includes(event.type)) {
            if (event.cancelable) event.preventDefault();
            event.stopImmediatePropagation();
        }
    }
    ['pointermove', 'pointerdown', 'pointerup', 'pointercancel', 'keydown', 'wheel', 'click', 'touchstart', 'touchmove'].forEach(type => {
        document.addEventListener(type, handleActivity, {capture: true, passive: false});
    });
    document.addEventListener('scroll', handleActivity, {capture: true, passive: true});
    window.addEventListener('blur', () => { pressedPointers.clear(); scheduleIdle(); });
    window.addEventListener('focus', scheduleIdle);
    document.addEventListener('visibilitychange', () => {
        pressedPointers.clear(); clearTimeout(idleTimer); clearTimeout(loadTimer);
        if (document.hidden) { ++playRequest; video.pause(); }
        else if (state === 'intro' || state === 'idle') void playVideo();
        else scheduleIdle();
    });
    window.addEventListener('pagehide', () => {
        ++playRequest; clearTimeout(idleTimer); clearTimeout(loadTimer); clearTimeout(hideTimer); video.pause();
    });
    window.addEventListener('pageshow', event => {
        if (!event.persisted) return;
        // 뒤로/앞으로 탐색 캐시에서 돌아와도 페이드 중간에 갇히지 않는다.
        main.inert = previousInert;
        screen.classList.remove('is-visible', 'is-hiding', 'is-ready');
        screen.setAttribute('aria-hidden', 'true');
        video.pause(); video.loop = false;
        retry.hidden = true; skip.hidden = true;
        state = 'awake'; finishIntro(); scheduleIdle();
    });
    void screen.offsetWidth;
    if (video.error) hideScreen(); else void playVideo(true);
}, {once: true});
