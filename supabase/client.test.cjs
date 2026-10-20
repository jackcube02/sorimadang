const assert=require('node:assert/strict'),fs=require('node:fs');
const {JSDOM,VirtualConsole}=require('jsdom');
const {IDBFactory,IDBDatabase}=require('fake-indexeddb');
const base=require('node:path').resolve(__dirname,'..')+'/';
const indexedDB=new IDBFactory();
const remoteRows=new Map();let failRemote=false;let lastUploaded;
const wavPrefix=Buffer.from('RIFF0000WAVEfmt ');

const tick=()=>new Promise(r=>setTimeout(r,10));
async function until(check){for(let i=0;i<200;i++){if(check())return;await tick()}throw Error('Timed out: '+check.toString())}
async function app(saved,failStorage=false){
 const errors=[],vc=new VirtualConsole();vc.on('jsdomError',e=>errors.push(e));
 const dom=new JSDOM(fs.readFileSync(base+'index.html','utf8'),{url:'https://example.com/',runScripts:'outside-only',pretendToBeVisual:true,virtualConsole:vc});
 const w=dom.window;w.indexedDB=failStorage ? {open(){const request={};setTimeout(()=>request.onerror(),0);return request;}} : indexedDB;w.Blob=Blob;w.structuredClone=structuredClone;
 w.URL.createObjectURL=URL.createObjectURL;w.URL.revokeObjectURL=URL.revokeObjectURL;w.fetch=fetch;
 w.matchMedia=()=>({matches:false});w.scrollTo=()=>{};
 if(saved)w.localStorage.setItem('sorimadang-project-v1',saved);
 const media=w.HTMLMediaElement.prototype;
 media.load=function(){};media.pause=function(){this._paused=true};media.play=async function(){this._paused=false;this.dispatchEvent(new w.Event('play'))};
 Object.defineProperty(media,'paused',{get(){return this._paused!==false}});
 const el=w.HTMLElement.prototype;el.setPointerCapture=function(id){this._capture=id};el.hasPointerCapture=function(id){return this._capture===id};el.releasePointerCapture=function(){this._capture=null};
 el.getBoundingClientRect=function(){return {left:0,top:0,right:1000,bottom:400,width:1000,height:400}};
 Object.defineProperty(el,'clientWidth',{get(){return 1000}});
 const canvas={scale(){},clearRect(){},fillRect(){},beginPath(){},moveTo(){},lineTo(){},stroke(){},setTransform(){},closePath(){},fill(){}};
 w.HTMLCanvasElement.prototype.getContext=()=>canvas;
 class Context {constructor(){this.state='running';this.currentTime=0;this.sampleRate=44100}addEventListener(){}close(){return Promise.resolve()}resume(){return Promise.resolve()}async decodeAudioData(bytes){if(new TextDecoder().decode(bytes).endsWith('INVALID'))throw Object.assign(Error('bad'),{name:'EncodingError'});return {duration:w.decodedDuration||2,length:88200,numberOfChannels:1,sampleRate:44100,getChannelData(){return new Float32Array(88200)}}}}
 w.AudioContext=Context;
 let tracksStopped=0;
 w.navigator.mediaDevices={getUserMedia:async()=>({getTracks:()=>[{stop(){tracksStopped++}}]})};
 class Recorder extends w.EventTarget {static isTypeSupported(type){return type.startsWith('audio/webm')}constructor(stream,options){super();this.mimeType=options?.mimeType||'audio/webm';this.state='inactive'}start(){this.state='recording'}stop(){if(this.state==='inactive')throw Error('double stop');this.state='inactive';setTimeout(()=>{const event=new w.Event('dataavailable');event.data=new Blob(['AUDIO'],{type:this.mimeType});this.dispatchEvent(event);this.dispatchEvent(new w.Event('stop'))},0)}}
 w.MediaRecorder=Recorder;
 w.soundLibrary=[{id:'original',person:'권호준',name:'원본',url:'original.wav',duration:2}];
 w.eval(fs.readFileSync(base+'editor-audio.js','utf8'));

 w.SORI_CLOUD={enabled:true,apiUrl:'https://sound-api.example/functions/v1/sorimadangPlus',turnstileSiteKey:'public-test-key'};
 w.URLSearchParams=URLSearchParams;w.AbortController=AbortController;
 w.turnstile={render(el,options){w.challenge=options;return 'widget'},reset(){}};
 w.OfflineAudioContext=class {constructor(channels,length,rate){this.length=length;this.sampleRate=rate;this.destination={}}createBufferSource(){return {connect(){},start(){}}}async startRendering(){return {getChannelData:()=>new Float32Array(this.length).fill(.25)}}};
 w.fetch=async(url,options={})=>{
  if(!String(url).startsWith('https://sound-api.example'))return fetch(url,options);
  if(failRemote)throw new w.TypeError('offline');
  const parsed=new URL(url);parsed.pathname=parsed.pathname.replace(/^\/functions\/v1\/(?:sori-sounds|sorimadangPlus)(?=\/)/,'');
  if(options.method==='POST'){
   assert(options.body instanceof Blob);if(w.SORI_CLOUD.turnstileSiteKey)assert(options.headers['X-Turnstile-Token']);
   const meta=JSON.parse(decodeURIComponent(options.headers['X-Sound-Metadata']));lastUploaded={...meta,blob:options.body};
   const row={...meta,createdAt:new Date().toISOString(),duration:2,bytes:options.body.size,contentType:options.body.type};remoteRows.set(meta.id,row);
   return Response.json({sound:row},{status:201});
  }
  if(parsed.pathname.startsWith('/audio/'))return new Response(wavPrefix);
  if(parsed.pathname.startsWith('/sounds/')){const row=remoteRows.get(parsed.pathname.split('/')[2]);return Response.json(row?{sound:row}:{error:'not found'},{status:row?200:404})}
  const q=parsed.searchParams.get('q')||'';return Response.json({sounds:[...remoteRows.values()].filter(row=>(row.author+row.title).includes(q)),next:null});
 };
 w.eval(fs.readFileSync(base+'cloud-sounds.js','utf8'));
 w.eval(fs.readFileSync(base+'user-sounds.js','utf8'));
 w.eval(fs.readFileSync(base+'generator.js','utf8'));
 await until(()=>w.document.querySelector('#user-sound-list')?.children.length);
 const $=id=>w.document.getElementById(id);
 $('generator-page').inert=false;$('generator-page').hidden=false;
 return {dom,w,$,errors,stopped:()=>tracksStopped};
}
function pointer(w,type,x){const e=new w.Event(type,{bubbles:true});Object.assign(e,{pointerId:1,button:0,clientX:x});return e}

(async()=>{
const a=await app(),{w,$}=a;
// Existing and custom function names both work; nested endpoint URLs are rejected.
const configuredUrl=w.SORI_CLOUD.apiUrl;
w.SORI_CLOUD.apiUrl='https://sound-api.example/functions/v1/sori-sounds';await w.SoriCloud.list();
w.SORI_CLOUD.apiUrl=configuredUrl+'/health';await assert.rejects(()=>w.SoriCloud.list(),/주소 설정/);
w.SORI_CLOUD.apiUrl=configuredUrl;
assert(w.SoriUserSounds.sharing);assert($('user-library').textContent.includes('모든 방문자'));
Object.defineProperty($('user-audio-file'),'files',{configurable:true,value:[new File([wavPrefix,'AUDIO'],'public.wav',{type:'audio/wav'})]});
$('user-audio-file').dispatchEvent(new w.Event('change'));await until(()=>!$('user-sound-form').hidden&&!$('user-title').disabled);
$('user-author').value='다른 방문자';$('user-title').value='<img src=x onerror=alert(1)>';
const submit=()=>$('user-sound-form').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));
submit();await until(()=>$('user-sound-message').textContent.includes('자동 등록 방지'));assert.equal(remoteRows.size,0);assert(!$('user-sound-form').hidden);
w.challenge.callback('human-token');submit();await until(()=>remoteRows.size===1&&$('user-sound-form').hidden);
const id=[...remoteRows.keys()][0];assert(lastUploaded.blob instanceof Blob);assert.equal(lastUploaded.extension,'wav');assert.equal($('user-sound-list').querySelector('img'),null);assert.equal($('user-sound-list').querySelector('.sound-name').textContent,'<img src=x onerror=alert(1)>');
assert($('user-sound-list').textContent.includes('공유된 소리'));assert.equal($('user-sound-list').querySelector('[data-action=publish]'),null);
$('user-sound-list').querySelector('[data-action=add]').click();await until(()=>JSON.parse(w.localStorage.getItem('sorimadang-project-v1')||'{}').clips?.length===1);
const saved=w.localStorage.getItem('sorimadang-project-v1');
// A second window reads shared metadata and restores the clip using the remote audio URL.
const b=await app(saved);assert(b.$('user-sound-list').querySelector(`[data-sound-id="${id}"]`));assert.equal(JSON.parse(b.w.localStorage.getItem('sorimadang-project-v1')).clips.length,1);
// New remote items appear through the refresh button without page navigation.
const added='user-'+crypto.randomUUID();remoteRows.set(added,{id:added,author:'새 방문자',title:'다른 기기',createdAt:new Date().toISOString(),recordedDate:'',source:'file',duration:1});
b.$('refresh-user-sounds').click();await until(()=>b.$('user-sound-list').querySelector(`[data-sound-id="${added}"]`));
// Files over one minute are rejected; exactly one minute is accepted.
w.decodedDuration=61;
Object.defineProperty($('user-audio-file'),'files',{configurable:true,value:[new File([wavPrefix,'AUDIO'],'too-long.wav',{type:'audio/wav'})]});
$('user-audio-file').dispatchEvent(new w.Event('change'));await until(()=>$('user-sound-message').textContent.includes('1분 이하'));assert($('user-sound-form').hidden);
w.decodedDuration=60;$('user-audio-file').dispatchEvent(new w.Event('change'));await until(()=>!$('user-sound-form').hidden&&!$('user-title').disabled);$('cancel-user-sound').click();
// Supabase-only mode requires no CAPTCHA account. Recording stops at 60 seconds and trims encoder overrun.
w.SORI_CLOUD.turnstileSiteKey='';w.decodedDuration=61.2;
const realNow=w.Date.now;

$('record-audio').click();await until(()=>!$('stop-recording').hidden);const started=realNow();w.Date.now=()=>started+61000;await until(()=>!$('user-sound-form').hidden&&!$('user-title').disabled);w.Date.now=realNow;assert($('stop-recording').hidden);assert($('upload-challenge').hidden);
assert($('download-user-sound').download.endsWith('.wav'));$('user-title').value='직접 녹음';submit();await until(()=>remoteRows.size===3&&$('user-sound-form').hidden);
assert.equal(lastUploaded.source,'recording');assert.equal(lastUploaded.blob.type,'audio/wav');const bytes=await lastUploaded.blob.arrayBuffer();assert.equal(new TextDecoder().decode(bytes.slice(0,4)),'RIFF');assert.equal(new DataView(bytes).getUint32(24,true),24000);assert.equal(bytes.byteLength,44+60*24000*2);assert(a.stopped()>0);
// A temporary backend outage must not erase the last saved timeline.
failRemote=true;const c=await app(saved);assert(c.w.SoriUserSounds.hasLoadError());assert.equal(c.w.localStorage.getItem('sorimadang-project-v1'),saved);
for(const entry of [a,b,c]){assert.equal(entry.errors.length,0,entry.errors.map(e=>e.message).join('\n'));entry.dom.window.close()}
console.log('PASS: public registration, CAPTCHA gate, safe metadata, second-window list/restore, refresh, 60-second upload/auto-stop/trim, optional CAPTCHA, WAV recording conversion, outage preserves project (DOM/media/network simulated)');
})().catch(e=>{console.error(e);process.exitCode=1});
