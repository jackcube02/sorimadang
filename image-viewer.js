/* CD 이미지 확대 보기. 크기·어둡기·페이드 시간은 style.css의 #image-viewer에서 조절한다. */
(() => {
    const viewer = document.getElementById('image-viewer');
    const large = document.getElementById('image-large');
    const closeButton = document.getElementById('image-close');
    const main = document.getElementById('main');
    if (!viewer || !large || !closeButton || !main) return;
    let opener = null, previousInert = false, closeTimer = 0, closing = false;

    function ready() {
        if (!viewer.hidden && !closing) viewer.classList.add('is-ready');
    }
    large.addEventListener('load', ready);

    function openImage(button) {
        if (!viewer.hidden) return;
        const image = button.querySelector('img');
        if (!image) return;
        clearTimeout(closeTimer);
        closing = false;
        opener = button;
        previousInert = main.inert;
        main.inert = true;
        document.querySelectorAll('[role="tooltip"]').forEach(box => { box.hidden = true; });
        document.documentElement.classList.add('image-is-open');
        document.body.classList.add('image-is-open');
        viewer.classList.remove('is-open', 'is-ready');
        large.alt = image.alt;
        large.src = image.currentSrc || image.src;
        viewer.hidden = false;
        if (large.complete && large.naturalWidth > 0) ready();
        void viewer.offsetWidth; // 투명한 시작 상태를 확정한 다음 페이드인한다.
        viewer.classList.add('is-open');
        closeButton.focus({preventScroll: true});
    }

    function finishClose(restoreFocus = true) {
        clearTimeout(closeTimer);
        viewer.hidden = true;
        viewer.classList.remove('is-open', 'is-ready');
        main.inert = previousInert;
        document.documentElement.classList.remove('image-is-open');
        document.body.classList.remove('image-is-open');
        closing = false;
        if (restoreFocus && opener?.isConnected) opener.focus({preventScroll: true});
        opener = null;
    }
    function closeImage(immediate = false) {
        if (viewer.hidden) return;
        if (immediate) { finishClose(false); return; }
        if (closing) return;
        closing = true;
        viewer.classList.remove('is-open');
        // CSS에서 시간을 바꾸면 닫기 완료 시점도 함께 바뀐다.
        const duration = getComputedStyle(viewer).transitionDuration;
        const milliseconds = (parseFloat(duration) || 0) * (duration.endsWith('ms') ? 1 : 1000);
        closeTimer = setTimeout(finishClose, milliseconds);
    }

    document.querySelectorAll('.cd-image-button').forEach(button => {
        button.addEventListener('click', () => openImage(button));
    });
    closeButton.addEventListener('click', () => closeImage());
    viewer.addEventListener('click', event => { if (event.target === viewer) closeImage(); });
    viewer.addEventListener('keydown', event => {
        event.stopPropagation();
        if (event.key === 'Escape') { event.preventDefault(); closeImage(); }
        if (event.key === 'Tab') { event.preventDefault(); closeButton.focus({preventScroll: true}); }
    });
    window.addEventListener('hashchange', () => closeImage(true));
    window.addEventListener('pagehide', () => closeImage(true));
})();
