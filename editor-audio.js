/* 재생과 저장에 똑같이 적용하는 페이드. 파형 확대는 여기에 관여하지 않는다. */
(() => {
    const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
    function fades(clip) {
        const duration = Math.max(0, clip.out - clip.in);
        let fadeIn = clamp(Number(clip.fadeIn) || 0, 0, duration);
        let fadeOut = clamp(Number(clip.fadeOut) || 0, 0, duration);
        if (fadeIn + fadeOut > duration) {
            const scale = duration / (fadeIn + fadeOut);
            fadeIn *= scale; fadeOut *= scale;
        }
        return {duration, fadeIn, fadeOut};
    }
    function envelope(clip, time) {
        const {duration, fadeIn, fadeOut} = fades(clip);
        if (time < 0 || time > duration || !duration) return 0;
        const edge = Math.min(.004, duration / 3);
        return Math.max(0, Math.min(1, time / Math.max(edge, fadeIn), (duration - time) / Math.max(edge, fadeOut)));
    }
    function fadePoints(clip) {
        const {duration, fadeIn, fadeOut} = fades(clip);
        const edge = Math.min(.004, duration / 3);
        return [...new Set([0, Math.max(edge, fadeIn), duration - Math.max(edge, fadeOut), duration])].sort((a,b) => a-b);
    }
    async function encodeMp3(left, right, sampleRate, scale, onProgress, cancelled) {
        if (!window.lamejs?.Mp3Encoder) throw new Error('MP3 변환기를 불러오지 못했다. 새로고침하거나 WAV로 저장해달라.');
        const encoder = new window.lamejs.Mp3Encoder(2, sampleRate, 192);
        const parts = [];
        const block = 1152;
        for (let start = 0; start < left.length; start += block) {
            cancelled();
            const count = Math.min(block, left.length - start);
            const l = new Int16Array(count), r = new Int16Array(count);
            for (let i = 0; i < count; i++) {
                const a = clamp(left[start+i] * scale, -1, 1), b = clamp(right[start+i] * scale, -1, 1);
                l[i] = Math.round(a * (a < 0 ? 32768 : 32767));
                r[i] = Math.round(b * (b < 0 ? 32768 : 32767));
            }
            const bytes = encoder.encodeBuffer(l, r);
            if (bytes.length) parts.push(new Uint8Array(bytes));
            if ((start / block) % 24 === 0) {
                onProgress(start / left.length);
                await new Promise(resolve => setTimeout(resolve, 0));
            }
        }
        cancelled();
        const tail = encoder.flush();
        if (tail.length) parts.push(new Uint8Array(tail));
        onProgress(1);
        return new Blob(parts, {type: 'audio/mpeg'});
    }
    // 출력 범위의 절대 시간으로 원본을 읽는다. 블록 경계에서 페이드를 다시 시작하지 않는다.
    function mixClipBlock(clip, buffer, blockStart, sampleRate, left, right) {
        const from = Math.max(0, Math.ceil((clip.start - blockStart) * sampleRate - 1e-7));
        const to = Math.min(left.length, Math.ceil((clip.start + clip.out - clip.in - blockStart) * sampleRate - 1e-7));
        const l = buffer.getChannelData(0), r = buffer.getChannelData(Math.min(1, buffer.numberOfChannels - 1));
        for (let frame = from; frame < to; frame++) {
            const time = blockStart + frame / sampleRate - clip.start;
            const position = (clip.in + time) * buffer.sampleRate;
            const low = clamp(Math.floor(position), 0, buffer.length - 1);
            const high = Math.min(buffer.length - 1, low + 1);
            const fraction = clamp(position - low, 0, 1);
            const gain = clip.gain * envelope(clip, time);
            left[frame] += (l[low] * (1 - fraction) + l[high] * fraction) * gain;
            right[frame] += (r[low] * (1 - fraction) + r[high] * fraction) * gain;
        }
    }
    function wavHeader(frames, sampleRate) {
        if (frames * 4 > 0xffffffff - 36) throw new Error('WAV 형식의 파일 크기 한도를 넘었다. 저장 범위를 줄이거나 MP3를 선택해달라.');
        const data = new ArrayBuffer(44), view = new DataView(data);
        const text = (offset, value) => { for (let i=0;i<value.length;i++) view.setUint8(offset+i, value.charCodeAt(i)); };
        text(0,'RIFF');view.setUint32(4,36+frames*4,true);text(8,'WAVE');text(12,'fmt ');
        view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,2,true);view.setUint32(24,sampleRate,true);
        view.setUint32(28,sampleRate*4,true);view.setUint16(32,4,true);view.setUint16(34,16,true);text(36,'data');view.setUint32(40,frames*4,true);
        return data;
    }
    function wavBlock(left, right, scale) {
        const data = new ArrayBuffer(left.length * 4), view = new DataView(data);
        for (let frame=0;frame<left.length;frame++) {
            const l=clamp(left[frame]*scale,-1,1),r=clamp(right[frame]*scale,-1,1);
            view.setInt16(frame*4,Math.round(l*(l<0?32768:32767)),true);
            view.setInt16(frame*4+2,Math.round(r*(r<0?32768:32767)),true);
        }
        return data;
    }
    // 블록마다 인코더를 재시작하지 않아 긴 MP3도 하나로 이어진다.
    function createMp3Stream(sampleRate) {
        if (!window.lamejs?.Mp3Encoder) throw new Error('MP3 변환기를 불러오지 못했다. 새로고침하거나 WAV로 저장해달라.');
        const encoder = new window.lamejs.Mp3Encoder(2, sampleRate, 192);
        return {
            async encode(left, right, scale, cancelled) {
                const parts=[];
                for(let start=0;start<left.length;start+=1152) {
                    cancelled();
                    const size=Math.min(1152,left.length-start),l=new Int16Array(size),r=new Int16Array(size);
                    for(let i=0;i<size;i++) {
                        const a=clamp(left[start+i]*scale,-1,1),b=clamp(right[start+i]*scale,-1,1);
                        l[i]=Math.round(a*(a<0?32768:32767));r[i]=Math.round(b*(b<0?32768:32767));
                    }
                    const bytes=encoder.encodeBuffer(l,r);
                    if(bytes.length) parts.push(new Uint8Array(bytes));
                    if((start/1152)%24===0) await new Promise(resolve=>setTimeout(resolve,0));
                }
                return parts;
            },
            finish() { return new Uint8Array(encoder.flush()); }
        };
    }
    window.SoriAudio = {fades, envelope, fadePoints, encodeMp3, mixClipBlock, wavHeader, wavBlock, createMp3Stream};
})();
