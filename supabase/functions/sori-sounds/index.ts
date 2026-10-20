// @ts-nocheck — 별도 패키지 없이 실행하는 JavaScript 호환 함수이다.
// Supabase Edge Function. Dashboard의 배포한 함수(sorimadangPlus 등) / index.ts에 전체 붙여 넣는다.
// 서비스 키는 Supabase 서버 환경에서만 읽으며 홈페이지에는 넣지 않는다.
const MAX_BYTES = 50 * 1024 * 1024;
const MAX_SECONDS = 60;
const BUCKET = 'sorimadang-sounds';
const ID = /^user-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const fail=(status,message)=>{throw new HttpError(status,message)};
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});
const origins=env=>String(env.ALLOWED_ORIGINS||'').split(',').map(s=>s.trim()).filter(Boolean);
function publicSound(row) {return {id:row.id,author:row.author,title:row.title,recordedDate:row.recorded_date,source:row.source,createdAt:row.created_at,duration:row.duration,bytes:row.bytes,contentType:row.content_type}}
const dateValid=date=>date==='' || /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(Date.parse(date)) && new Date(date).toISOString().slice(0,10)===date;
function inspectAudio(buffer, extension) {
    const data = new Uint8Array(buffer), view = new DataView(buffer);
    const text = (offset, length) => String.fromCharCode(...data.subarray(offset, offset + length));
    let duration = 0;
    if (extension === 'wav') {
        if (data.length < 44 || text(0,4) !== 'RIFF' || text(8,4) !== 'WAVE') fail(415, '올바른 WAV 파일이 아니다.');
        let format, audioBytes = 0;
        for (let offset = 12; offset + 8 <= data.length;) {
            const kind = text(offset,4), size = view.getUint32(offset+4,true), start = offset+8;
            if (start + size > data.length) fail(415, 'WAV 파일이 손상되었거나 불완전하다.');
            if (kind === 'fmt ' && size >= 16) {
                let type = view.getUint16(start,true);
                const channels = view.getUint16(start+2,true), rate = view.getUint32(start+4,true);
                const byteRate = view.getUint32(start+8,true), align = view.getUint16(start+12,true), bits = view.getUint16(start+14,true);
                if (type === 65534 && size >= 40) type = view.getUint16(start+24,true);
                if (![1,3].includes(type) || channels < 1 || channels > 8 || rate < 8000 || rate > 192000
                    || ![8,16,24,32,64].includes(bits) || align !== channels*bits/8 || byteRate !== rate*align)
                    fail(415, 'PCM 또는 Float WAV로 변환한 뒤 추가해달라.');
                format = {byteRate, align};
            }
            if (kind === 'data') audioBytes += size;
            offset = start + size + (size % 2);
        }
        if (!format || !audioBytes || audioBytes % format.align) fail(415, 'WAV의 소리 데이터를 찾을 수 없다.');
        duration = audioBytes / format.byteRate;
    } else if (extension === 'mp3') {
        let offset = 0, frames = 0;
        if (text(0,3) === 'ID3') {
            if (data.length < 10 || data.subarray(6,10).some(n=>n>127)) fail(415, 'MP3 태그가 올바르지 않다.');
            offset = 10 + data[6]*2097152 + data[7]*16384 + data[8]*128 + data[9];
            if (data[3] === 4 && (data[5] & 16)) offset += 10;
        }
        while (offset < data.length && data[offset] === 0) offset++;
        while (offset + 4 <= data.length) {
            if (text(offset,3) === 'TAG' || text(offset,8) === 'APETAGEX' || data[offset] === 0 && data.subarray(offset).every(value => value === 0)) break;
            const a=data[offset+1], b=data[offset+2], version=(a>>3)&3, layer=(a>>1)&3;
            const bitrateIndex=b>>4, rateIndex=(b>>2)&3;
            if (data[offset] !== 255 || (a & 224) !== 224 || version === 1 || layer !== 1 || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3)
                fail(415, '올바른 MP3 파일이 아니다. MP3로 다시 변환해달라.');
            const rate=[44100,48000,32000][rateIndex] / (version === 3 ? 1 : version === 2 ? 2 : 4);
            const bitrate=(version === 3 ? [0,32,40,48,56,64,80,96,112,128,160,192,224,256,320] : [0,8,16,24,32,40,48,56,64,80,96,112,128,144,160])[bitrateIndex]*1000;
            const frameSize=Math.floor((version === 3 ? 144 : 72)*bitrate/rate)+((b>>1)&1);
            if (offset+frameSize > data.length) fail(415, 'MP3 파일의 끝부분이 불완전하다.');
            duration += (version === 3 ? 1152 : 576)/rate;
            offset += frameSize; frames++;
            if (duration > MAX_SECONDS+.1) fail(413, '1분 이하의 소리만 등록할 수 있다.');
        }
        if (!frames) fail(415, 'MP3의 소리 데이터를 찾을 수 없다.');
    } else fail(415, 'MP3 또는 WAV 파일만 등록할 수 있다.');
    if (duration < .05 || duration > MAX_SECONDS+.1) fail(413, '0.05초 이상, 1분 이하의 소리만 등록할 수 있다.');
    return {duration, contentType:extension === 'wav' ? 'audio/wav' : 'audio/mpeg'};
}

function serviceKey(env) {
    if(env.SUPABASE_SERVICE_ROLE_KEY)return env.SUPABASE_SERVICE_ROLE_KEY;
    try{return JSON.parse(env.SUPABASE_SECRET_KEYS||'{}').default||''}catch(_){return '';}
}
function backend(env) {
    const key=serviceKey(env);
    if (!env.SUPABASE_URL || !key) fail(503,'Supabase 서버 환경을 확인해달라.');
    const base=env.SUPABASE_URL.replace(/\/$/,'');
    async function api(path,options={}) {
        const headers=new Headers(options.headers);
        headers.set('apikey',key);
        if(!key.startsWith('sb_secret_'))headers.set('Authorization','Bearer '+key);
        const response=await fetch(base+path,{...options,headers,signal:AbortSignal.timeout(30000)});
        if (!response.ok) {const error=new Error('Supabase request failed');error.upstreamStatus=response.status;await response.body?.cancel();throw error;}
        return response;
    }
    async function db(path,options={}) {
        const response=await api('/rest/v1/'+path,{...options,headers:{'Content-Type':'application/json',Prefer:'return=representation',...options.headers}});
        return response.status===204?null:response.json();
    }
    const find=async(id,published=false)=>(await db('sori_sounds?'+new URLSearchParams({id:'eq.'+id, ...(published?{status:'eq.published'}:{})})))[0]||null;
    async function removePending(row) {
        // 오브젝트 삭제가 확인된 뒤에만 DB 예약 용량을 돌려준다.
        await api('/storage/v1/object/'+BUCKET,{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({prefixes:[row.object_key]})});
        await db('sori_sounds?'+new URLSearchParams({id:'eq.'+row.id,status:'eq.pending'}),{method:'DELETE'});
    }
    return {api,db,find,removePending};
}
async function readAudio(request) {
    const declared=request.headers.get('Content-Length');
    if (declared!==null && (!Number.isInteger(Number(declared)) || Number(declared)<1 || Number(declared)>MAX_BYTES)) fail(413,'파일은 50MB 이하로 등록해달라.');
    const reader=request.body?.getReader();if(!reader)fail(400,'음원 파일이 없다.');
    const chunks=[];let total=0;
    while(true){const {done,value}=await reader.read();if(done)break;total+=value.byteLength;if(total>MAX_BYTES){await reader.cancel();fail(413,'파일은 50MB 이하로 등록해달라.')}chunks.push(value);}
    if(!total || declared!==null && total!==Number(declared))fail(400,'파일 크기가 일치하지 않는다.');
    const data=new Uint8Array(total);let offset=0;for(const chunk of chunks){data.set(chunk,offset);offset+=chunk.byteLength}return data.buffer;
}
async function verifyHuman(request,env,origin) {
    // 선택 사항: Turnstile을 연결하면 서버 확인까지 필수로 적용된다.
    if(!env.TURNSTILE_SECRET)return;
    const token=request.headers.get('X-Turnstile-Token');if(!token || token.length>2048)fail(403,'자동 등록 방지 확인을 완료해달라.');
    const response=await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({secret:env.TURNSTILE_SECRET,response:token}),signal:AbortSignal.timeout(10000)});
    const result=await response.json();
    if(!result.success || result.hostname!==new URL(origin).hostname || result.action!=='sorimadang-upload')fail(403,'자동 등록 방지 확인을 다시 진행해달라.');
}
async function upload(request,env,origin,store) {
    if(!origin || !origins(env).includes(origin))fail(403,'이 사이트에서는 등록할 수 없다.');
    let meta;const encoded=request.headers.get('X-Sound-Metadata')||'';
    if(encoded.length>4096)fail(400,'작성 정보가 너무 길다.');
    try{meta=JSON.parse(decodeURIComponent(encoded))}catch(_){fail(400,'작성 정보를 읽을 수 없다.')}
    if(!ID.test(meta?.id||'') || typeof meta.author!=='string' || typeof meta.title!=='string')fail(400,'작성 정보가 올바르지 않다.');
    meta.author=meta.author.trim();meta.title=meta.title.trim();
    if(!meta.author || meta.author.length>30 || !meta.title || meta.title.length>80 || !['file','recording'].includes(meta.source)
        || typeof meta.recordedDate!=='string' || !dateValid(meta.recordedDate) || !['mp3','wav'].includes(meta.extension))fail(400,'닉네임·제목·날짜·형식을 확인해달라.');
    const existing=await store.find(meta.id);
    if(existing?.status==='published')return json({sound:publicSound(existing)});
    if(existing)fail(409,'이미 등록 중이거나 사용할 수 없는 소리이다.');
    await verifyHuman(request,env,origin);
    const bytes=await readAudio(request),audio=inspectAudio(bytes,meta.extension);
    // 서버가 관측한 전달 IP를 일일 해시로 바꿔 저장한다. 사용자 본인 인증은 아니다.
    const ip=(request.headers.get('x-forwarded-for')||'unknown').split(',').at(-1).trim();
    const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(`${new Date().toISOString().slice(0,10)}:${ip}:${serviceKey(env)}`));
    const hash=Array.from(new Uint8Array(digest),n=>n.toString(16).padStart(2,'0')).join('');
    // 이전 실행이 중단되어 남은 예약은 다음 업로드 때 정리한다.
    const stale=await store.db('sori_sounds?'+new URLSearchParams({status:'eq.pending',created_at:'lt.'+new Date(Date.now()-3600000).toISOString(),limit:'20'}));
    for(const row of stale)await store.removePending(row);
    const record={id:meta.id,author:meta.author,title:meta.title,recorded_date:meta.recordedDate,source:meta.source,
        duration:audio.duration,bytes:bytes.byteLength,content_type:audio.contentType,object_key:`sounds/${meta.id}.${meta.extension}`};
    const reserved=await store.db('rpc/reserve_sori_sound',{method:'POST',body:JSON.stringify({p_sound:record,p_ip_hash:hash})});
    if(reserved.error)fail(reserved.status,reserved.error);
    if(reserved.existing)return json({sound:publicSound(reserved.existing)});
    try {
        const uploaded=await store.api('/storage/v1/object/'+BUCKET+'/'+record.object_key,{method:'POST',headers:{'Content-Type':audio.contentType,'x-upsert':'false'},body:bytes});
        await uploaded.body?.cancel();
        const rows=await store.db('sori_sounds?'+new URLSearchParams({id:'eq.'+record.id,status:'eq.pending'}),{method:'PATCH',body:JSON.stringify({status:'published'})});
        if(!rows?.[0])throw new Error('Publication failed');
        return json({sound:publicSound(rows[0])},201);
    } catch(error) {
        // DB 응답만 유실된 경우 이미 공개된 음원을 삭제하지 않는다.
        try {const row=await store.find(record.id);if(row?.status==='published')return json({sound:publicSound(row)});if(row?.status==='pending')await store.removePending(row);}catch(_){}
        throw error;
    }
}
async function listSounds(url,store) {
    const before=url.searchParams.get('before')||'',query=(url.searchParams.get('q')||'').trim().slice(0,100);
    let date=null,id='';
    if(before){const parts=before.split('|');[date,id]=parts;if(parts.length!==2 || !ID.test(id) || !Number.isFinite(Date.parse(date)))fail(400,'목록 위치가 올바르지 않다.');}
    const result=await store.db('rpc/list_sori_sounds',{method:'POST',body:JSON.stringify({p_query:query,p_before_time:date,p_before_id:id})});
    const rows=result.slice(0,200),last=rows.at(-1);
    return json({sounds:rows.map(publicSound),next:result.length>200?`${last.created_at}|${last.id}`:null});
}
function byteRange(header,size) {
    if(!header)return null;const match=/^bytes=(\d*)-(\d*)$/.exec(header);
    if(!match || !match[1]&&!match[2])return false;
    let start,end;if(!match[1]){const count=Number(match[2]);if(!count)return false;start=Math.max(0,size-count);end=size-1}
    else{start=Number(match[1]);end=match[2]?Math.min(Number(match[2]),size-1):size-1}
    return Number.isSafeInteger(start)&&Number.isSafeInteger(end)&&start<size&&start<=end?{start,end}:false;
}
async function serveAudio(request,store,id) {
    const row=await store.find(id,true);if(!row)fail(404,'이 소리를 찾을 수 없다.');
    const range=byteRange(request.headers.get('Range'),row.bytes);
    if(range===false)return new Response(null,{status:416,headers:{'Content-Range':`bytes */${row.bytes}`}});
    const headers=new Headers({'Content-Type':row.content_type,'Accept-Ranges':'bytes','Content-Length':String(range?range.end-range.start+1:row.bytes),'Cache-Control':'no-store'});
    if(range)headers.set('Content-Range',`bytes ${range.start}-${range.end}/${row.bytes}`);
    if(request.method==='HEAD')return new Response(null,{status:range?206:200,headers});
    let object;try{object=await store.api('/storage/v1/object/authenticated/'+BUCKET+'/'+row.object_key,{headers:range?{Range:`bytes=${range.start}-${range.end}`}:{}})}catch(error){if(error.upstreamStatus===404)fail(404,'음원 파일을 찾을 수 없다.');throw error}
    if(range && object.status!==206){await object.body?.cancel();fail(503,'구간 재생을 불러오지 못했다. 다시 시도해달라.');}
    return new Response(object.body,{status:range?206:200,headers});
}
export async function handleRequest(request,env) {
    const url=new URL(request.url),origin=request.headers.get('Origin');
    // 함수 이름은 자유롭게 지정할 수 있다. Gateway의 접두부 유무와 직접 경로를 모두 처리한다.
    const path=url.pathname.replace(/^\/(?:functions\/v1\/)?[A-Za-z0-9_-]+(?=\/(?:health|sounds|audio)(?:\/|$))/,'')||'/';
    let response;
    try {
        if(origin&&!origins(env).includes(origin))fail(403,'허용되지 않은 사이트 주소이다.');
        if(request.method==='OPTIONS')response=new Response(null,{status:204});
        else {
            const store=backend(env);
            if(path==='/health'&&request.method==='GET') {
                const settings=(await store.db('sori_settings?id=eq.1'))[0];if(!settings)throw new Error('Settings missing');
                await store.db('sori_sounds?select=id&limit=1');
                const bucket=await (await store.api('/storage/v1/bucket/'+BUCKET)).json();
                if(bucket.public)throw new Error('Bucket must be private');
                response=json({ok:true,provider:'supabase',uploadsReady:Boolean(settings.uploads_enabled&&origins(env).length),maxBytes:MAX_BYTES,maxSeconds:MAX_SECONDS,captchaRequired:Boolean(env.TURNSTILE_SECRET)});
            } else if(path==='/sounds'&&request.method==='GET')response=await listSounds(url,store);
            else if(path==='/sounds'&&request.method==='POST')response=await upload(request,env,origin,store);
            else if(/^\/(sounds|audio)\/[^/]+$/.test(path)) {
                const [,kind,id]=path.split('/');if(!ID.test(id))fail(404,'소리를 찾을 수 없다.');
                if(kind==='audio'&&['GET','HEAD'].includes(request.method))response=await serveAudio(request,store,id);
                else if(kind==='sounds'&&request.method==='GET'){const row=await store.find(id,true);if(!row)fail(404,'소리를 찾을 수 없다.');response=json({sound:publicSound(row)});}
                else fail(405,'지원하지 않는 요청이다.');
            } else fail(405,'지원하지 않는 요청이다.');
        }
    } catch(error) {
        if(!(error instanceof HttpError))console.error('Sound storage request failed',error.name);
        response=json({error:error instanceof HttpError?error.message:'공용 저장소에 연결하지 못했다. 잠시 뒤 다시 시도해달라.'},error instanceof HttpError?error.status:503);
    }
    const headers=new Headers(response.headers);headers.set('X-Content-Type-Options','nosniff');headers.set('Vary','Origin');
    if(origin&&origins(env).includes(origin))headers.set('Access-Control-Allow-Origin',origin);
    headers.set('Access-Control-Allow-Methods','GET, HEAD, POST, OPTIONS');
    headers.set('Access-Control-Allow-Headers','Content-Type, X-Sound-Metadata, X-Turnstile-Token, Range');
    headers.set('Access-Control-Expose-Headers','Content-Length, Content-Range, Accept-Ranges');
    return new Response(response.body,{status:response.status,headers});
}
if(typeof Deno!=='undefined')Deno.serve(request=>handleRequest(request,{
    SUPABASE_URL:Deno.env.get('SUPABASE_URL'),SUPABASE_SERVICE_ROLE_KEY:Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),SUPABASE_SECRET_KEYS:Deno.env.get('SUPABASE_SECRET_KEYS'),
    ALLOWED_ORIGINS:Deno.env.get('ALLOWED_ORIGINS'),TURNSTILE_SECRET:Deno.env.get('TURNSTILE_SECRET')
}));
