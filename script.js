// 링크와 설명 상자의 아이디를 연결한다.
function setupTooltip(linkId, tooltipId) {
    const link = document.getElementById(linkId);
    const tooltip = document.getElementById(tooltipId);

    // 설명 상자를 마우스 옆에 배치하고 화면 밖으로 나가지 않게 조정한다.
    function moveTooltip(x, y) {
        const gap = 16;
        const margin = 12;
        const box = tooltip.getBoundingClientRect();
        let left = x + gap;
        let top = y + gap;

        if (left + box.width > window.innerWidth - margin) {
            left = x - box.width - gap;
        }
        if (top + box.height > window.innerHeight - margin) {
            top = y - box.height - gap;
        }

        left = Math.max(margin, Math.min(left, window.innerWidth - box.width - margin));
        top = Math.max(margin, Math.min(top, window.innerHeight - box.height - margin));
        tooltip.style.left = `${left}px`;
        tooltip.style.top = `${top}px`;
    }

    function hideTooltip() {
        tooltip.hidden = true;
    }

    function showTooltipAtLink() {
        const linkBox = link.getBoundingClientRect();
        tooltip.hidden = false;
        moveTooltip(linkBox.left, linkBox.bottom);
    }

    link.addEventListener('mouseenter', (event) => {
        tooltip.hidden = false;
        moveTooltip(event.clientX, event.clientY);
    });

    link.addEventListener('mousemove', (event) => {
        if (!tooltip.hidden) {
            moveTooltip(event.clientX, event.clientY);
        }
    });

    link.addEventListener('mouseleave', () => {
        if (document.activeElement === link) {
            showTooltipAtLink();
        } else {
            hideTooltip();
        }
    });

    // 키보드로 링크를 선택해도 설명을 볼 수 있다.
    link.addEventListener('focus', showTooltipAtLink);
    link.addEventListener('blur', hideTooltip);
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') hideTooltip();
    });
    window.addEventListener('resize', hideTooltip);
    window.addEventListener('scroll', hideTooltip, true);
}

setupTooltip('times-link', 'times-tooltip');
setupTooltip('sori-link', 'sori-tooltip');
setupTooltip('sound-link', 'sound-tooltip');

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

// 주소의 # 값에 맞춰 오른쪽 콘텐츠만 전환한다. 뒤로 가기도 사용할 수 있다.
function showContentPage() {
    const main = document.getElementById('content-main');
    const pageNames = ['playlist', 'cd', 'generator', 'participants'];
    const requestedPage = window.location.hash.slice(1);
    const pageName = pageNames.includes(requestedPage) ? requestedPage : 'playlist';

    pageNames.forEach((name) => {
        document.getElementById(`${name}-page`).hidden = name !== pageName;
    });

    document.querySelectorAll('#main-nav a, #generator-nav a').forEach((link) => {
        if (link.getAttribute('href') === `#${pageName}`) {
            link.setAttribute('aria-current', 'page');
        } else {
            link.removeAttribute('aria-current');
        }
    });

    main.scrollTop = 0;
}

// 페이지를 처음 열거나 새로고침하면 재생목록 화면에서 시작한다.
window.history.replaceState(window.history.state, '', '#playlist');
window.addEventListener('hashchange', showContentPage);
showContentPage();
