/* 숫자는 모두 초 단위다. 이 값만 바꾸면 시간을 조절할 수 있다. */
const screenSettings = {
    idleSeconds: 5,        // 조작이 없을 때 화면보호기가 나타나기까지의 시간
    introHoldSeconds: 2,   // 첫 화면의 글자가 완전히 나타난 뒤 유지하는 시간
    fadeInSeconds: 0.8,    // 글자와 화면이 나타나는 시간
    fadeOutSeconds: 1.2    // 화면이 사라지는 시간
};

// 본문이 그려지기 전에 검은 첫 화면을 준비한다.
document.documentElement.classList.add('has-title-screen');

document.addEventListener('DOMContentLoaded', () => {
    const screen = document.getElementById('title-screen');
    const main = document.getElementById('main');
    if (!screen || !main) {
        document.documentElement.classList.remove('has-title-screen');
        return;
    }
    const seconds = (value, fallback) => Number.isFinite(value) && value >= 0 ? value : fallback;
    const idleDelay = Math.max(0.1, seconds(screenSettings.idleSeconds, 5)) * 1000;
    const holdDelay = seconds(screenSettings.introHoldSeconds, 2) * 1000;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const fadeIn = reducedMotion ? 0 : seconds(screenSettings.fadeInSeconds, 0.8) * 1000;
    const fadeOut = reducedMotion ? 0 : seconds(screenSettings.fadeOutSeconds, 1.2) * 1000;
    screen.style.setProperty('--screen-fade-in', `${fadeIn}ms`);
    screen.style.setProperty('--screen-fade-out', `${fadeOut}ms`);

    let state = 'intro';
    let idleTimer = 0;
    let introTimer = 0;
    let hideTimer = 0;
    let lastFocus = document.activeElement;
    let previousInert = main.inert;
    const pressedPointers = new Set();
    main.inert = true;
    screen.setAttribute('aria-hidden', 'false');

    function scheduleIdle() {
        clearTimeout(idleTimer);
        if (state !== 'awake' || document.hidden || pressedPointers.size) return;
        idleTimer = setTimeout(showIdleScreen, idleDelay);
    }

    function showIdleScreen() {
        if (state !== 'awake' || document.hidden || pressedPointers.size) return;
        state = 'idle';
        lastFocus = document.activeElement;
        previousInert = main.inert;
        main.inert = true;
        screen.setAttribute('aria-hidden', 'false');
        screen.classList.remove('is-hiding');
        screen.classList.add('is-visible', 'is-ready');
        screen.focus({preventScroll: true});
    }

    function hideScreen() {
        if (state === 'hiding' || state === 'awake') return;
        clearTimeout(introTimer);
        state = 'hiding';
        screen.classList.add('is-hiding');
        screen.classList.remove('is-visible');
        hideTimer = setTimeout(() => {
            screen.classList.remove('is-hiding');
            screen.setAttribute('aria-hidden', 'true');
            main.inert = previousInert;
            state = 'awake';
            if (lastFocus && lastFocus !== document.body && lastFocus.isConnected) {
                lastFocus.focus({preventScroll: true});
            }
            scheduleIdle();
        }, fadeOut);
    }

    function handleActivity(event) {
        if (event.type === 'pointerdown') pressedPointers.add(event.pointerId);
        if (event.type === 'pointerup' || event.type === 'pointercancel') pressedPointers.delete(event.pointerId);
        if (state === 'intro') {
            // 첫 화면은 자동으로 끝난다. 클릭과 키 입력으로 건너뛸 수도 있다.
            if (event.type === 'pointerdown' || event.type === 'keydown') hideScreen();
            else return;
        } else if (state === 'idle') {
            hideScreen();
        } else if (state === 'awake') {
            scheduleIdle();
            return;
        }
        // 화면을 깨우는 클릭이나 키가 뒤의 버튼까지 누르지 않게 한다.
        if (state === 'hiding' && !['pointermove', 'scroll'].includes(event.type)) {
            if (event.cancelable) event.preventDefault();
            event.stopImmediatePropagation();
        }
    }

    ['pointermove', 'pointerdown', 'pointerup', 'pointercancel', 'keydown', 'wheel', 'click'].forEach(type => {
        document.addEventListener(type, handleActivity, {capture: true, passive: false});
    });
    document.addEventListener('scroll', handleActivity, {capture: true, passive: true});
    window.addEventListener('blur', () => { pressedPointers.clear(); scheduleIdle(); });
    window.addEventListener('focus', scheduleIdle);
    document.addEventListener('visibilitychange', () => {
        pressedPointers.clear();
        clearTimeout(idleTimer);
        if (!document.hidden) scheduleIdle();
    });
    window.addEventListener('pagehide', () => {
        clearTimeout(idleTimer);
        clearTimeout(introTimer);
        clearTimeout(hideTimer);
    });
    window.addEventListener('pageshow', event => {
        if (!event.persisted) return;
        // 뒤로 가기로 돌아올 때 중간 페이드 상태에 갇히지 않게 한다.
        main.inert = previousInert;
        screen.classList.remove('is-visible', 'is-hiding');
        screen.classList.add('is-ready');
        screen.setAttribute('aria-hidden', 'true');
        state = 'awake';
        scheduleIdle();
    });

    // 로컬 서체를 기다리되, 서체를 읽지 못해도 첫 화면이 계속 가리지 않게 한다.
    let fontTimer;
    const fontReady = document.fonts ? document.fonts.load('16px JungGothic').catch(() => {}) : Promise.resolve();
    Promise.race([fontReady, new Promise(resolve => { fontTimer = setTimeout(resolve, 800); })]).then(() => {
        clearTimeout(fontTimer);
        if (state !== 'intro') return;
        // 초기 투명 상태를 확정한 뒤 전환한다. 배경 탭에서도 타이머는 정상 진행된다.
        void screen.offsetWidth;
        screen.classList.add('is-ready');
        introTimer = setTimeout(hideScreen, fadeIn + holdDelay);
    });
});
