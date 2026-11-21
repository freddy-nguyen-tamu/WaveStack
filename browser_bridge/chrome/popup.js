document.querySelector('#version').textContent = 'Extension '+chrome.runtime.getManifest().version+' · automatic bridge';
const status=document.querySelector('#status');
function refresh(){
  chrome.runtime.sendMessage({type:'STATUS'},res=>{
    status.textContent=res?.connected
      ? 'Connected automatically. Leave the comic tab open.'
      : (res?.error || 'Waiting for Python. Open your comic and run python run.py.');
  });
}
refresh();
document.querySelector('#connect').addEventListener('click',()=>{
  status.textContent='Connecting to the selected tab…';
  chrome.tabs.query({active:true,currentWindow:true},tabs=>{
    if(!tabs?.[0]) {status.textContent='Open a supported chapter tab first';return;}
    chrome.runtime.sendMessage({type:'AUTO_CONNECT',tabId:tabs[0].id},res=>{
      status.textContent=res?.ok?'Connected. It will reconnect automatically on later runs.':
        (res?.error||chrome.runtime.lastError?.message||'No Python listener yet');
    });
  });
});
