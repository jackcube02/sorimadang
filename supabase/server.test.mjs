import assert from 'node:assert/strict';
import fs from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
const base=new URL('.',import.meta.url);
const source=fs.readFileSync(new URL('functions/sori-sounds/index.ts',base),'utf8');
const {handleRequest}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const db=new PGlite();
await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
create schema storage; create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
grant usage on schema public to service_role;`);
await db.exec(fs.readFileSync(new URL('schema.sql',base),'utf8'));
await db.exec(fs.readFileSync(new URL('schema.sql',base),'utf8')); // Re-running setup preserves existing tables/settings.
const query=(sql,args=[])=>db.query(sql,args);
for(const role of ['anon','authenticated']){
 assert.equal((await query("select has_table_privilege($1,'public.sori_sounds','INSERT') as allowed",[role])).rows[0].allowed,false);
 assert.equal((await query("select has_function_privilege($1,'public.reserve_sori_sound(jsonb,text)','EXECUTE') as allowed",[role])).rows[0].allowed,false);
}
await db.exec('set role service_role');
const objects=new Map();let failUpload=false,failPublish=false,losePublishResponse=false;
const env={SUPABASE_URL:'https://project.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'test-service-key',ALLOWED_ORIGINS:'https://jackcube02.github.io'};
globalThis.fetch=async(input,options={})=>{
 const url=new URL(input),headers=new Headers(options.headers),method=options.method||'GET';
 if(url.hostname==='challenges.cloudflare.com')return Response.json({success:false});
 assert.equal(url.origin,env.SUPABASE_URL);if(headers.get('apikey')==='sb_secret_test')assert.equal(headers.get('Authorization'),null);else assert.equal(headers.get('Authorization'),'Bearer test-service-key');
 const path=url.pathname;
 if(path.startsWith('/rest/v1/rpc/')){
  const body=JSON.parse(options.body);let result;
  if(path.endsWith('reserve_sori_sound'))result=(await query('select public.reserve_sori_sound($1::jsonb,$2) as result',[JSON.stringify(body.p_sound),body.p_ip_hash])).rows[0].result;
  else result=(await query('select * from public.list_sori_sounds($1,$2,$3)',[body.p_query,body.p_before_time,body.p_before_id])).rows;
  return Response.json(result);
 }
 if(path.startsWith('/rest/v1/')){
  const table=path.split('/').at(-1);assert(['sori_settings','sori_sounds'].includes(table));
  const args=[],where=[];for(const [key,value] of url.searchParams){if(['id','status','created_at'].includes(key)){const operator=value.slice(0,value.indexOf('.')),val=value.slice(value.indexOf('.')+1);assert(['eq','lt'].includes(operator));args.push(val);where.push(`${key} ${operator==='eq'?'=':'<'} $${args.length}`)}}
  const filter=where.length?' where '+where.join(' and '):'';
  let sql=`select * from public.${table}${filter}`;
  if(method==='DELETE')sql=`delete from public.${table}${filter} returning *`;
  if(method==='PATCH'){
   if(failPublish){failPublish=false;return Response.json({error:'test publication failure'},{status:500})}
   assert.equal(JSON.parse(options.body).status,'published');sql=`update public.${table} set status='published'${filter} returning *`;
  }
  const limit=url.searchParams.get('limit');if(limit&&method==='GET')sql+=' limit '+Number(limit);
  const rows=(await query(sql,args)).rows;
  if(method==='PATCH'&&losePublishResponse){losePublishResponse=false;throw Error('response lost after commit')}
  return Response.json(rows);
 }
 if(path==='/storage/v1/bucket/sorimadang-sounds')return Response.json({public:false});
 if(path==='/storage/v1/object/sorimadang-sounds'&&method==='DELETE'){
  for(const key of JSON.parse(options.body).prefixes)objects.delete(key);return Response.json([]);
 }
 const key=path.replace(/^\/storage\/v1\/object\/(authenticated\/)?sorimadang-sounds\//,'');
 if(method==='POST'){
  if(failUpload){failUpload=false;return Response.json({error:'storage unavailable'},{status:500})}
  assert.equal(headers.get('x-upsert'),'false');if(objects.has(key))return Response.json({error:'duplicate'},{status:409});
  objects.set(key,Buffer.from(options.body));return Response.json({Key:key});
 }
 const bytes=objects.get(key);if(!bytes)return Response.json({error:'missing'},{status:404});
 const range=headers.get('Range');if(range){const [a,b]=range.replace('bytes=','').split('-').map(Number);return new Response(bytes.subarray(a,b+1),{status:206})}
 return new Response(bytes);
};
const origin=env.ALLOWED_ORIGINS,uuid=()=>`user-${crypto.randomUUID()}`;
function wav(seconds=1){const size=Math.round(16000*seconds),b=Buffer.alloc(44+size);b.write('RIFF');b.writeUInt32LE(36+size,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(8000,24);b.writeUInt32LE(16000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(size,40);return b;}
const req=(path,options={},settings=env)=>handleRequest(new Request('https://project.supabase.co/functions/v1/sorimadangPlus'+path,{...options,headers:{Origin:origin,...options.headers}}),settings);
const upload=(id,body=wav(),overrides={},requestOrigin=origin)=>req('/sounds',{method:'POST',headers:{Origin:requestOrigin,'Content-Length':String(body.length),'X-Forwarded-For':'192.0.2.1','X-Sound-Metadata':encodeURIComponent(JSON.stringify({id,author:'방문자',title:'공유 테스트',recordedDate:'2026-10-21',source:'file',extension:'wav',...overrides}))},body});
try {
 let r=await req('/health');assert.equal(r.status,200);const health=await r.json();assert.equal(health.maxSeconds,60);assert.equal(health.captchaRequired,false);r=await req('/health',{}, {...env,SUPABASE_SERVICE_ROLE_KEY:undefined,SUPABASE_SECRET_KEYS:JSON.stringify({default:'sb_secret_test'})});assert.equal(r.status,200);
 // Both deployed function names work, including the gateway's shortened URL.
 for(const prefix of ['/functions/v1/sori-sounds','/functions/v1/sorimadangPlus','/sori-sounds','/sorimadangPlus','']) {
  const response=await handleRequest(new Request('https://htyvuozlyqomnkefvbin.supabase.co'+prefix+'/health'),env);
  assert.equal(response.status,200,prefix);const data=await response.json();assert.equal(data.ok,true);assert.equal(data.uploadsReady,true);assert.equal(data.maxSeconds,60);
  const listing=await handleRequest(new Request('https://project.supabase.co'+prefix+'/sounds'),env);
  assert.equal(listing.status,200,prefix);assert.deepEqual((await listing.json()).sounds,[]);
 }
 const id=uuid();r=await upload(id,wav(60));assert.equal(r.status,201,await r.clone().text());assert.equal((await r.json()).sound.duration,60);
 r=await upload(uuid(),wav(61));assert.equal(r.status,413);r=await upload(uuid(),wav(60.11));assert.equal(r.status,413);
 r=await upload(uuid(),Buffer.from('0000ftypmp42'),{extension:'mp3'});assert.equal(r.status,415);
 r=await upload(uuid(),wav(),{},'https://evil.test');assert.equal(r.status,403);
 r=await req('/sounds',{method:'POST'}, {...env,TURNSTILE_SECRET:'test'});assert.equal(r.status,400);
 const frame=Buffer.alloc(417);frame.set([255,251,144,0]);r=await upload(uuid(),Buffer.concat([frame,frame,frame]),{extension:'mp3'});assert.equal(r.status,201);
 r=await upload(id);assert.equal(r.status,200);assert.equal(objects.size,2);
 r=await req('/sounds?q='+encodeURIComponent('방문자'));assert.equal((await r.json()).sounds.length,2);
 r=await req('/audio/'+id,{headers:{Range:'bytes=10-19'}});assert.equal(r.status,206);assert.equal((await r.arrayBuffer()).byteLength,10);
 r=await req('/audio/'+id,{headers:{Range:'bytes=-5'}});assert.equal(r.status,206);assert.equal((await r.arrayBuffer()).byteLength,5);
 r=await req('/audio/'+id,{method:'HEAD'});assert.equal(r.status,200);assert.equal(await r.text(),'');
 r=await req('/audio/'+id,{headers:{Range:'bytes=9999999-'}});assert.equal(r.status,416);
 for(const mode of ['upload','publish']){
  const broken=uuid();if(mode==='upload')failUpload=true;else failPublish=true;
  r=await upload(broken);assert.equal(r.status,503);assert(!objects.has(`sounds/${broken}.wav`));assert.equal((await query('select * from public.sori_sounds where id=$1',[broken])).rows.length,0);
 }
 const recovered=uuid();losePublishResponse=true;r=await upload(recovered);assert.equal(r.status,200);assert(objects.has(`sounds/${recovered}.wav`));
 // A visitor cannot delete. Admin hiding blocks future media and metadata requests.
 r=await req('/sounds/'+id,{method:'DELETE'});assert.equal(r.status,405);
 await query("update public.sori_sounds set status='hidden' where id=$1",[id]);r=await req('/audio/'+id);assert.equal(r.status,404);
 // Registration limits and the 900 MB cap are enforced by the real SQL transaction.
 await query('update public.sori_settings set uploads_per_hour=100,uploads_per_day=100');
 const used=Number((await query('select sum(bytes) as total from public.sori_sounds')).rows[0].total);
 await query('update public.sori_settings set max_storage_bytes=$1',[used+16044]);
 const attempts=await Promise.all([upload(uuid()),upload(uuid())]);assert.deepEqual(attempts.map(r=>r.status).sort(),[201,507]);
 await query('update public.sori_settings set max_storage_bytes=900000000,uploads_enabled=false');r=await upload(uuid());assert.equal(r.status,503);
 await query('update public.sori_settings set uploads_enabled=true,uploads_per_day=1');r=await upload(uuid());assert.equal(r.status,429);
 // Stable cursor across more than one metadata page.
 for(let i=0;i<205;i++)await query("insert into public.sori_sounds(id,author,title,source,created_at,duration,bytes,content_type,object_key,status) values($1,'목록','페이징','file','2026-10-20T00:00:00Z',1,16044,'audio/wav',$2,'published')",[uuid(),`page/${i}`]);
 r=await req('/sounds');const first=await r.json();assert.equal(first.sounds.length,200);assert(first.next);
 r=await req('/sounds?before='+encodeURIComponent(first.next));const second=await r.json();assert.equal(second.next,null);assert(!second.sounds.some(s=>first.sounds.some(a=>a.id===s.id)));
 console.log('PASS: PostgreSQL schema/RLS grants, upload/read/search/pagination/ranges, 60-second boundary, rollback/retry, hide, concurrent storage cap and rate limits. Supabase HTTP is simulated.');
} finally {await db.close();}
