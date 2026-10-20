// 링크와 설명 상자의 아이디를 연결한다.
function setupTooltip(linkId, tooltipId, focusId = linkId) {
    const link = document.getElementById(linkId);
    const tooltip = document.getElementById(tooltipId);
    const focusTarget = document.getElementById(focusId);
    if (!link || !tooltip || !focusTarget) return;
    let hideTimer;

    function moveTooltip(x, y) {
        const gap = 16, margin = 12;
        const box = tooltip.getBoundingClientRect();
        let left = x + gap, top = y + gap;
        if (left + box.width > window.innerWidth - margin) left = x - box.width - gap;
        if (top + box.height > window.innerHeight - margin) top = y - box.height - gap;
        tooltip.style.left = `${Math.max(margin, Math.min(left, window.innerWidth - box.width - margin))}px`;
        tooltip.style.top = `${Math.max(margin, Math.min(top, window.innerHeight - box.height - margin))}px`;
    }
    function hideTooltip() { clearTimeout(hideTimer); tooltip.hidden = true; }
    function showTooltip(x, y) {
        clearTimeout(hideTimer);
        document.querySelectorAll('[role="tooltip"]').forEach(box => { if (box !== tooltip) box.hidden = true; });
        tooltip.hidden = false;
        moveTooltip(x, y);
    }
    function showAtLink() {
        const box = link.getBoundingClientRect();
        showTooltip(box.left, box.bottom);
    }
    function leaveTooltip() {
        clearTimeout(hideTimer);
        // 긴 작품 소개는 마우스를 상자로 옮겨 스크롤할 수 있다.
        hideTimer = setTimeout(() => {
            if (document.activeElement !== focusTarget || !focusTarget.matches(':focus-visible')) hideTooltip();
        }, 180);
    }
    link.addEventListener('mouseenter', event => showTooltip(event.clientX, event.clientY));
    link.addEventListener('mousemove', event => { if (!tooltip.hidden) moveTooltip(event.clientX, event.clientY); });
    link.addEventListener('mouseleave', leaveTooltip);
    tooltip.addEventListener('mouseenter', () => clearTimeout(hideTimer));
    tooltip.addEventListener('mouseleave', leaveTooltip);
    focusTarget.addEventListener('focus', showAtLink);
    focusTarget.addEventListener('blur', hideTooltip);
    document.addEventListener('keydown', event => { if (event.key === 'Escape') hideTooltip(); });
    window.addEventListener('resize', hideTooltip);
    window.addEventListener('hashchange', hideTooltip);
    window.addEventListener('scroll', event => { if (!(event.target instanceof Node) || !tooltip.contains(event.target)) hideTooltip(); }, true);
}

setupTooltip('times-link', 'times-tooltip');
setupTooltip('sori-link', 'sori-tooltip');
setupTooltip('sound-link', 'sound-tooltip');
setupTooltip('hojun-link', 'hojun-tooltip');
setupTooltip('minuk-link', 'minuk-tooltip');
setupTooltip('chanhyeok-link', 'chanhyeok-tooltip');
setupTooltip('myeongseon-link', 'myeongseon-tooltip');
setupTooltip('juhee-link', 'juhee-tooltip');

// HTML을 평소처럼 작성하면 영문·숫자·마침표·쉼표에 위치 조절용 span을 자동으로 붙인다.
function setupTextPosition() {
    const textAreas = document.querySelectorAll('#content-text, #content-main, [role="tooltip"]');

    textAreas.forEach((area) => {
        const walker = document.createTreeWalker(area, NodeFilter.SHOW_TEXT);
        const textNodes = [];
        while (walker.nextNode()) {
            const node = walker.currentNode;
            if (!node.parentElement.closest('.english-text, .number-text, .period-text, .comma-text, script, style')) {
                textNodes.push(node);
            }
        }

        textNodes.forEach((node) => {
            // 시간의 콜론은 숫자와 함께 움직이고, 마침표와 쉼표는 따로 조절한다.
            const pattern = /[A-Za-z]+|[0-9]+(?::[0-9]+)*|[.,]/g;
            const text = node.textContent;
            const matches = [...text.matchAll(pattern)];
            if (matches.length === 0) return;

            const fragment = document.createDocumentFragment();
            let start = 0;
            matches.forEach((match) => {
                fragment.append(document.createTextNode(text.slice(start, match.index)));
                const span = document.createElement('span');
                if (match[0] === '.') {
                    span.className = 'period-text';
                } else if (match[0] === ',') {
                    span.className = 'comma-text';
                } else {
                    span.className = /^[0-9]/.test(match[0]) ? 'number-text' : 'english-text';
                }
                span.textContent = match[0];
                fragment.append(span);
                start = match.index + match[0].length;
            });
            fragment.append(document.createTextNode(text.slice(start)));
            node.replaceWith(fragment);
        });
    });
}

setupTextPosition();

// 일반 메뉴는 오른쪽에서, 소리마당은 전체화면에서 연다.
const generatorPage = document.getElementById('generator-page');
const homeContainer = document.getElementById('container');
let previousPage = 'playlist';
let generatorOpen = false;
let generatorCloseTimer;
// 좁은 화면과 마우스가 없는 터치 기기는 모바일 안내를 사용한다.
const mobileLayout = window.matchMedia('(max-width: 768px), (hover: none) and (pointer: coarse)');
window.isSoriMobile = () => mobileLayout.matches;
function applyGeneratorMode() {
    const mobile = mobileLayout.matches;
    const editor = document.getElementById('sound-generator');
    const notice = document.getElementById('mobile-generator-notice');
    editor.hidden = mobile;
    editor.inert = mobile;
    notice.hidden = !mobile;
    notice.inert = !mobile;
    generatorPage.classList.toggle('is-mobile-notice', mobile);
    if (generatorOpen) document.getElementById(mobile ? 'mobile-generator-back' : 'generator-back')?.focus({preventScroll: true});
}
mobileLayout.addEventListener('change', () => {
    applyGeneratorMode();
    // 편집 중 화면을 좁히면 재생·녹음도 종료한다.
    window.dispatchEvent(new CustomEvent('generator-visibility', {detail: {open: generatorOpen && !mobileLayout.matches}}));
});

function closeGenerator() {
    window.location.hash = previousPage;
}

function showContentPage() {
    const main = document.getElementById('content-main');
    const pageNames = ['playlist', 'cd', 'participants'];
    const requestedPage = window.location.hash.slice(1);
    const opening = requestedPage === 'generator';
    const pageName = opening ? previousPage : pageNames.includes(requestedPage) ? requestedPage : 'playlist';
    const wasOpen = generatorOpen;
    generatorOpen = opening;
    document.title = opening ? 'sorimadang | edit' : 'sorimadang | home';
    document.body.classList.toggle('generator-is-open', opening);
    document.documentElement.classList.toggle('generator-is-open', opening);
    applyGeneratorMode();
    clearTimeout(generatorCloseTimer);

    pageNames.forEach(name => {
        document.getElementById(`${name}-page`).hidden = name !== pageName;
    });
    document.querySelectorAll('#main-nav a, #generator-nav a').forEach(link => {
        if (link.getAttribute('href') === `#${opening ? 'generator' : pageName}`) link.setAttribute('aria-current', 'page');
        else link.removeAttribute('aria-current');
    });

    if (opening) {
        window.soriPlayer?.pause();
        generatorPage.hidden = false;
        generatorPage.inert = false;
        homeContainer.inert = true;
        // 화면 밖의 시작 위치를 먼저 확정해야 슬라이드가 보인다.
        void generatorPage.offsetWidth;
        generatorPage.classList.add('is-open');
        document.getElementById(mobileLayout.matches ? 'mobile-generator-back' : 'generator-back')?.focus({preventScroll: true});
    } else {
        previousPage = pageName;
        homeContainer.inert = false;
        generatorPage.inert = true;
        generatorPage.classList.remove('is-open');
        if (wasOpen) {
            document.querySelector('#generator-nav a').focus({preventScroll: true});
            const duration = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0
                : parseFloat(getComputedStyle(generatorPage).getPropertyValue('--generator-slide-duration'));
            generatorCloseTimer = setTimeout(() => { if (!generatorOpen) generatorPage.hidden = true; }, duration);
        } else generatorPage.hidden = true;
        if (!wasOpen) main.scrollTop = 0;
    }
    window.dispatchEvent(new CustomEvent('generator-visibility', {detail: {open: opening && !mobileLayout.matches}}));
}

// 뒤로가기 버튼, Esc, 키보드 탭 이동을 전체화면 안에서 처리한다.
generatorPage.addEventListener('click', event => {
    if (event.target.closest('#generator-back, #mobile-generator-back')) closeGenerator();
});
generatorPage.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault();
        closeGenerator();
    }
    if (event.key !== 'Tab') return;
    const controls = [...generatorPage.querySelectorAll('a[href], button, input, select, [tabindex="0"]')]
        .filter(element => !element.disabled && !element.closest('[hidden], [inert]') && element.getClientRects().length);
    const first = controls[0], last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
});

// 처음 열거나 새로고침하면 재생목록에서 시작한다.
window.history.replaceState(window.history.state, '', '#playlist');
window.addEventListener('hashchange', showContentPage);
showContentPage();
