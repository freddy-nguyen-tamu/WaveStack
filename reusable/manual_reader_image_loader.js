/* Imported reader only. The generated reader still owns layout and ordered reveal.
 * Fetch the exact published image URL so HTTP failures are diagnosable without
 * a second probing request. Never send the user's session to another origin. */
const manualOriginalAllLoaded=allLoaded;
allLoaded=()=>manualOriginalAllLoaded()&&!known.some(x=>x.manualReadFailed);
function manualFailure(im,message){
  im.manualReadFailed=true;im.status='loaded';
  const figure=im.el.parentElement;
  if(figure){missingGlyph(figure,im.order+1,message);figure.title=`Panel ${im.order+1}: ${message}`;}
  console.error('OPEN_READER_MANUAL_IMAGE_FAILED',im.order+1,message);
  const parent=$('#pages');if(!parent)return;
  let note=parent.querySelector('.or-manual-read-error');
  if(!note){note=document.createElement('section');note.className='or-manual-read-error';note.setAttribute('role','alert');note.style.cssText='background:#232f3e;color:#fff;padding:12px 16px;font:14px/1.5 Arial,sans-serif;text-align:center;overflow-wrap:anywhere';const text=document.createElement('span');text.className='or-manual-read-detail';const retry=document.createElement('a');retry.href=location.href;retry.textContent=' Reload chapter';retry.style.color='#febd69';note.append(text,retry);parent.prepend(note);}
  note.querySelector('.or-manual-read-detail').textContent=`Some imported pages could not be read. Panel ${im.order+1}: ${message}.`;
  if(settings.auto)updateAuto(false);
}
function manualHttpError(response,detail){const error=Error(`HTTP ${response.status}${detail?' — '+detail:''}`);error.status=response.status;error.retryAfter=response.headers.get('Retry-After');return error;}
async function manualDecode(im,blob){
 const objectUrl=URL.createObjectURL(blob);const image=im.el;
 let timer;try{image.src=objectUrl;await Promise.race([image.decode(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Image decoding timed out')),15000);})]);if(!(image.naturalWidth>0&&image.naturalHeight>0))throw Error('Decoded image has no dimensions');image.dataset.loaded='yes';}
 finally{clearTimeout(timer);URL.revokeObjectURL(objectUrl);}
}
// Assignment occurs while render() is awaiting its manifest, before it starts
// the generated ordered queue. No change to the static archive reader bundle.
needPreload=function(im){
 if(im.status==='loaded'||im.status==='loading')return;
 im.status='loading';
 (async()=>{
  try{
   const u=new URL(im.url,location.href),slug=location.pathname.split('/')[2];
   if(u.origin!==location.origin||u.username||u.password||!/^import-[a-f0-9]{32}$/.test(slug)||!new RegExp('^/api/manual-image/'+slug+'/[a-f0-9]{64}$').test(u.pathname)||u.search||u.hash)throw Error('Invalid imported page URL');
   for(let attempt=0;;attempt++){
    try{
     const r=await fetch(u.href,{credentials:'same-origin',cache:'no-store',redirect:'error',signal:AbortSignal.timeout(35000)});
     if(!r.ok){let detail='';if(/json/i.test(r.headers.get('Content-Type')||'')){try{const data=await r.json();detail=typeof data.error==='string'?data.error.slice(0,220):'';}catch{}}throw manualHttpError(r,detail);}
     if(!/^image\/(png|jpeg)(?:;|$)/i.test(r.headers.get('Content-Type')||''))throw Error('Image endpoint returned a non-image response');
     const blob=await r.blob();if(!blob.size||blob.size>12*1024*1024)throw Error('Image size is invalid');
     await manualDecode(im,blob);im.manualReadFailed=false;im.status='loaded';return;
    }catch(e){
     // Never retry an authorization/missing/integrity error or a GitHub
     // cooldown by hammering the endpoint. Two bounded transient retries.
     const transient=[408,500,503,504].includes(e.status)||e instanceof TypeError||['TimeoutError','AbortError','NetworkError'].includes(e.name);
     if(!transient||attempt>=2)throw e;
     await new Promise(resolve=>setTimeout(resolve,1000*2**attempt));
    }
   }
  }catch(e){manualFailure(im,String(e?.message||e));}
 })();
};
