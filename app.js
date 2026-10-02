/* temporary until assemble workflow runs: join parts */
(async()=>{
  const parts=await Promise.all(['./app-part1.js','./app-part2.js'].map(u=>fetch(u).then(r=>{
    if(!r.ok) throw new Error('failed '+u+' '+r.status); return r.text();
  })));
  const s=document.createElement('script');
  s.textContent=parts.join('');
  document.head.appendChild(s);
})().catch(e=>{console.error(e);document.body.insertAdjacentHTML('afterbegin','<pre style="color:red">app load failed: '+e+'</pre>');});
