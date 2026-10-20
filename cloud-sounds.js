/* 공개 API 연결. 서비스 키는 Supabase Edge Function에서만 사용한다. */
(() => {
    const config=window.SORI_CLOUD || {};
    const enabled=config.enabled === true;
    let scriptPromise,widget=null,token='';
    function apiUrl() {
        if (!enabled) throw new Error('공용 저장소가 아직 연결되지 않았다.');
        let url;
        try { url=new URL(config.apiUrl); } catch (_) { throw new Error('cloud-config.js의 apiUrl을 확인해달라.'); }
        if (url.protocol!=='https:' || url.username || url.password || url.search || url.hash || !/^\/functions\/v1\/[A-Za-z0-9_-]+\/?$/.test(url.pathname))
            throw new Error('Supabase Edge Function 주소 설정을 확인해달라.');
        return url.origin+url.pathname.replace(/\/$/,'');
    }
    async function request(path,options={}) {
        const controller=new AbortController();
        const timer=setTimeout(()=>controller.abort(),options.method==='POST'?120000:15000);
        try {
            const response=await fetch(apiUrl()+path,{...options,signal:controller.signal});
            let data;
            try { data=await response.json(); } catch (_) { throw new Error('공용 저장소 응답을 읽을 수 없다. API 주소를 확인해달라.'); }
            if (!response.ok) { const error=new Error(data.error || '공용 저장소 요청에 실패했다.');error.status=response.status;throw error; }
            return data;
        } catch(error) {
            if (error.name==='AbortError') throw new Error('연결 시간이 초과되었다. 입력 내용은 남아 있으니 다시 시도해달라.');
            if (error instanceof TypeError) throw new Error('공용 저장소에 연결할 수 없다. 인터넷 연결과 서버의 허용 주소를 확인해달라.');
            throw error;
        } finally { clearTimeout(timer); }
    }
    function asSound(row) {
        if (!/^user-[a-f0-9-]{36}$/i.test(row.id) || !Number.isFinite(row.duration)) throw new Error('공용 음원 정보가 올바르지 않다.');
        const created=new Date(row.createdAt);
        const registeredDate=`${created.getFullYear()}-${String(created.getMonth()+1).padStart(2,'0')}-${String(created.getDate()).padStart(2,'0')}`;
        return {id:row.id,person:row.author,name:row.title,duration:row.duration,url:apiUrl()+'/audio/'+encodeURIComponent(row.id),
            isUser:true,isPublic:true,recordedDate:row.recordedDate,createdAt:row.createdAt,registeredDate,source:row.source};
    }
    async function list(query='',before='') {
        const params=new URLSearchParams({q:query});if(before)params.set('before',before);
        const data=await request('/sounds?'+params);return {sounds:data.sounds.map(asSound),next:data.next};
    }
    async function get(id) {
        try { return asSound((await request('/sounds/'+encodeURIComponent(id))).sound); }
        catch(error) { if(error.status===404)return null;throw error; }
    }
    function loadWidgetScript() {
        if(window.turnstile)return Promise.resolve();
        if(scriptPromise)return scriptPromise;
        scriptPromise=new Promise((resolve,reject)=>{
            const script=document.createElement('script');script.src='https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';script.async=true;
            const timeout=setTimeout(()=>reject(new Error('자동 등록 방지 확인을 불러오지 못했다. 새로고침해달라.')),15000);
            script.onload=()=>{clearTimeout(timeout);resolve()};script.onerror=()=>{clearTimeout(timeout);reject(new Error('자동 등록 방지 확인을 불러오지 못했다.'))};document.head.append(script);
        }).catch(error=>{scriptPromise=null;throw error});
        return scriptPromise;
    }
    async function showChallenge(element) {
        apiUrl();if(!config.turnstileSiteKey){element.hidden=true;return;}element.hidden=false;await loadWidgetScript();
        if(widget!==null) {window.turnstile.reset(widget);token='';return;}
        widget=window.turnstile.render(element,{sitekey:config.turnstileSiteKey,action:'sorimadang-upload',theme:'dark',size:'flexible',
            callback:value=>{token=value},'expired-callback':()=>{token=''},'error-callback':()=>{token=''}});
    }
    function resetChallenge() { token='';if(widget!==null)window.turnstile?.reset(widget); }
    async function publish(record) {
        if(config.turnstileSiteKey&&!token)throw new Error('등록 버튼 위의 자동 등록 방지 확인을 완료해달라.');
        const extension=(record.filename || '').split('.').pop().toLowerCase();
        const meta={id:record.id,author:record.author,title:record.title,recordedDate:record.recordedDate,source:record.source,extension};
        try {
            const data=await request('/sounds',{method:'POST',headers:{'Content-Type':extension==='wav'?'audio/wav':'audio/mpeg',
                'X-Sound-Metadata':encodeURIComponent(JSON.stringify(meta)),'X-Turnstile-Token':token},body:record.blob});
            return asSound(data.sound);
        } finally { resetChallenge(); }
    }
    // 마이크 녹음은 브라우저마다 WebM/MP4가 다르므로 공개 저장 전에 호환되는 WAV로 바꾼다.
    async function recordingWav(buffer, maxSeconds = 60) {
        const rate=24000, length=Math.ceil(Math.min(buffer.duration,maxSeconds)*rate);
        const Context=window.OfflineAudioContext || window.webkitOfflineAudioContext;
        const ctx=new Context(1,length,rate),source=ctx.createBufferSource();source.buffer=buffer;source.connect(ctx.destination);source.start();
        const rendered=await ctx.startRendering(), samples=rendered.getChannelData(0);
        const bytes=new ArrayBuffer(44+samples.length*2),view=new DataView(bytes);
        const text=(offset,value)=>{for(let i=0;i<value.length;i++)view.setUint8(offset+i,value.charCodeAt(i))};
        text(0,'RIFF');view.setUint32(4,36+samples.length*2,true);text(8,'WAVE');text(12,'fmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,rate,true);view.setUint32(28,rate*2,true);view.setUint16(32,2,true);view.setUint16(34,16,true);text(36,'data');view.setUint32(40,samples.length*2,true);
        for(let i=0;i<samples.length;i++){const value=Math.max(-1,Math.min(1,samples[i]));view.setInt16(44+i*2,Math.round(value*(value<0?32768:32767)),true);if(i && i%240000===0)await new Promise(resolve=>setTimeout(resolve,0));}
        return new Blob([bytes],{type:'audio/wav'});
    }
    window.SoriCloud={enabled,list,get,publish,showChallenge,resetChallenge,recordingWav};
})();
