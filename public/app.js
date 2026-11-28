(function(){
"use strict";
var $=function(s){return document.querySelector(s)};
var $$=function(s){return Array.prototype.slice.call(document.querySelectorAll(s))};
var reduce=window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches;
var lang='en';
try{var saved=localStorage.getItem('muirLang');if(saved&&I18N[saved])lang=saved;}catch(e){}

UI.en.sent="Thanks! Tap a button below to send it to David by text or email. He'll get back to you soon.";
UI.es.sent="¡Gracias! Toque un botón abajo para enviarlo a David por texto o correo. Le responderá pronto.";
UI.pt.sent="Obrigado! Toque num botão abaixo para enviar ao David por texto ou e-mail. Ele vai responder em breve.";
var BTN={en:['Text David','Email David'],es:['Enviar texto a David','Correo a David'],pt:['Mandar texto ao David','E-mail ao David']};

/* ---------- language ---------- */
function applyLang(L){
  lang=L;var T=I18N[L];
  document.documentElement.lang=L;
  $$('[data-t]').forEach(function(el){var k=el.getAttribute('data-t');if(T[k]!=null)el.textContent=T[k];});
  $$('[data-tph]').forEach(function(el){var k=el.getAttribute('data-tph');if(T[k]!=null)el.setAttribute('placeholder',T[k]);});
  $$('.langs button').forEach(function(b){b.setAttribute('aria-pressed',b.getAttribute('data-lang')===L?'true':'false');});
  buildQuestions();
  if(chat.length===1&&chat[0].cls==='bot'){chat=[{cls:'bot',text:UI[L].hi}];renderChat();}
  try{localStorage.setItem('muirLang',L);}catch(e){}
}
$$('.langs button').forEach(function(b){b.addEventListener('click',function(){applyLang(b.getAttribute('data-lang'));});});

/* ---------- translate visitor text to English for David ---------- */
var LNAME={es:'Spanish',pt:'Portuguese'};
function toEnglish(text){
  if(lang==='en'||!text||!text.trim())return Promise.resolve(text);
  var ctl=window.AbortController?new AbortController():null;var tm=setTimeout(function(){if(ctl)ctl.abort()},8000);
  return fetch('/api/translate',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({lang:lang,text:text}),signal:ctl?ctl.signal:undefined})
    .then(function(r){return r.json()}).then(function(j){clearTimeout(tm);return j&&j.ok&&j.text?j.text:text}).catch(function(){clearTimeout(tm);return text});
}
/* ---------- message box: common questions + autocorrect ---------- */
var ta=$('#m'),sug=$('#m-sug');
function addQ(t){var cur=ta.value||'';ta.value=(cur.trim()?cur.replace(/\s*$/,'')+(/[.!?]$/.test(cur.trim())?' ':'. '):'')+t+(/[.?!]$/.test(t)?' ':'. ');ta.focus();updSug();}
function buildQuestions(){var ul=$('#cq');if(!ul)return;ul.innerHTML='';(lang==='en'?Q:QX[lang]).forEach(function(t){var li=document.createElement('li'),b=document.createElement('button');b.type='button';b.textContent=t;b.addEventListener('click',function(){addQ(t)});li.appendChild(b);ul.appendChild(li);});}
function updSug(){
  var msg=ta.value||'';var m=msg.match(/([A-Za-z'-]+)$/);var part=m?m[1]:'';var s=[];
  if(part.length>=2){var lp=part.toLowerCase();if(FIX[lp]&&FIX[lp]!==part)s.push(FIX[lp]);
    W.forEach(function(w){if(s.length<4&&w.toLowerCase().indexOf(lp)===0&&w.toLowerCase()!==lp&&s.indexOf(w)<0)s.push(w)});}
  sug.innerHTML='';
  if(s.length){var lab=document.createElement('span');lab.style.cssText='font-size:16px;color:var(--mut);align-self:center';lab.textContent=I18N[lang].n112;sug.appendChild(lab);}
  s.forEach(function(w){var b=document.createElement('button');b.type='button';b.textContent=w;b.addEventListener('click',function(){ta.value=ta.value.replace(/[A-Za-z'-]+$/,w)+' ';ta.focus();updSug();});sug.appendChild(b);});
}
if(ta){ta.addEventListener('input',function(){
  var v=ta.value,pos=ta.selectionStart,atEnd=pos===v.length;
  if(atEnd){
    v=v.replace(/(^|[^A-Za-z'-])([A-Za-z'-]+)([ .,!?\n])$/,function(all,pre,word,end){var f=FIX[word.toLowerCase()];if(!f||word==='I'||word===f)return all;return pre+f+end;});
    v=v.replace(/(^|[.!?]\s+)([a-z])/g,function(a,p1,c){return p1+c.toUpperCase()});
    if(v!==ta.value)ta.value=v;
  }
  updSug();});}
var sendBtn=$('#sendmsg');
if(sendBtn)sendBtn.addEventListener('click',function(){
  var name=($('#n')||{}).value||'',contact=($('#c')||{}).value||'',topic=($('#t')||{}).value||'',msg=(ta||{}).value||'';
  var st=$('#sendst');if(!st){st=document.createElement('p');st.id='sendst';st.setAttribute('role','status');st.style.cssText='margin:10px 0 0;font-size:18px';sendBtn.parentNode.insertBefore(st,sendBtn.nextSibling);}
  if(!msg.trim()||!contact.trim()){st.style.color='#F2B8A2';st.textContent='Please add your phone or email and a short message.';return;}
  sendBtn.disabled=true;st.style.color='';st.textContent='Sending...';
  Promise.all([toEnglish(topic),toEnglish(msg)]).then(function(r){
    var m=r[1];if(lang!=='en'&&msg.trim())m+='\n\n--- Original ('+LNAME[lang]+') ---\n'+msg;
    return fetch('/api/contact',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:name,contact:contact,topic:r[0],message:m})}).then(function(x){return x.json()});
  }).then(function(j){
    sendBtn.disabled=false;
    if(j&&j.ok){st.style.color='var(--gold)';st.textContent='Thanks! Your message was sent. We will get back to you soon.';if(ta)ta.value='';}
    else{st.style.color='#F2B8A2';st.textContent=(j&&j.error)||'It did not send. Please call or text (603) 600-2843.';}
  }).catch(function(){sendBtn.disabled=false;st.style.color='#F2B8A2';st.textContent='It did not send. Please call or text (603) 600-2843.';});
});
/* ---------- chat helper ---------- */
var chat=[{cls:'bot',text:UI[lang].hi}],log=$('#chatlog'),qIn=$('#aq');
function renderChat(){log.innerHTML='';chat.forEach(function(c){var p=document.createElement('p');p.className=c.cls;p.textContent=c.text;log.appendChild(p);});log.scrollTop=log.scrollHeight;}
function answer(t){var x=' '+t.toLowerCase()+' ';
  if(HAND.concat(HANDX).some(function(h){return x.indexOf(h)>=0}))return null;
  function score(e){var sc=0;e.k.forEach(function(k){if(x.indexOf(k)>=0)sc+=k.length>4?2:1});return sc;}
  if(lang!=='en'){var b2=null,s2=0;KBX.forEach(function(e){var sc=score(e);if(sc>s2){s2=sc;b2=e}});if(s2>0)return b2[lang];}
  var best=-1,bs=0;KB.forEach(function(e,i){var sc=score(e);if(sc>bs){bs=sc;best=i}});
  if(bs<=0)return null;return lang==='en'?KB[best].a:KBX[best][lang];}
var lastQ='';
function show(id,on){var el=$(id);if(el)el.hidden=!on;}
function ask(){var t=(qIn.value||'').trim();if(!t)return;lastQ=t;qIn.value='';chat.push({cls:'me',text:t});var a=answer(t);
  if(a){chat.push({cls:'bot',text:a});show('#cfollow',true);show('#chand',false);}
  else{chat.push({cls:'bot',text:UI[lang].forDavid});show('#cfollow',false);openHand();}
  renderChat();}
function openHand(){show('#chand',true);show('#herr',false);show('#hlinks',false);$('#hsend').hidden=false;}
$('#askbtn').addEventListener('click',ask);
qIn.addEventListener('keydown',function(e){if(e.key==='Enter'){e.preventDefault();ask();}});
$('#csolved').addEventListener('click',function(){show('#cfollow',false);chat.push({cls:'bot',text:UI[lang].glad});renderChat();});
$('#cstuck').addEventListener('click',function(){show('#cfollow',false);chat.push({cls:'bot',text:UI[lang].pass});renderChat();openHand();});
$('#hsend').addEventListener('click',function(){
  var n=$('#hn').value.trim(),c=$('#hc').value.trim();
  if(!n||!c){show('#herr',true);return;}show('#herr',false);
  var qs=chat.filter(function(x){return x.cls==='me'}).map(function(x){return x.text}).slice(-3).join(' | ')||lastQ;
  var hs=$('#hsend');hs.disabled=true;
  toEnglish(qs).then(function(en){
  var txt='MUIR Tech website question from '+n+' ('+c+'): '+en+(lang!=='en'?' [Original, '+LNAME[lang]+': '+qs+']':'');
  var box=$('#hlinks');box.innerHTML='';
  var a1=document.createElement('a');a1.className='key k1';a1.href='sms:+16036002843?&body='+encodeURIComponent(txt);a1.textContent=BTN[lang][0];
  var a2=document.createElement('a');a2.className='key k2';a2.href='mailto:muirtechnh@gmail.com?subject='+encodeURIComponent('Website question from '+n)+'&body='+encodeURIComponent(txt);a2.textContent=BTN[lang][1];
  box.appendChild(a1);box.appendChild(a2);box.hidden=false;hs.hidden=true;hs.disabled=false;
  chat.push({cls:'bot',text:UI[lang].sent});renderChat();});});

/* ---------- rotating ads ---------- */
var ADS=[{name:'Your Business Here',line:'A short line about what you offer and why locals love it.',where:'Your town · your phone or website'},{name:'Lakeside Bakery (example)',line:'Fresh bread and coffee every morning.',where:'Example only · not a real business'},{name:'Harbor Marine (example)',line:'Boat service and winter storage.',where:'Example only · not a real business'},{name:'Pine Ridge Realty (example)',line:'Homes and cottages around the lake.',where:'Example only · not a real business'}];
var adI=0,adPaused=!!reduce,dots=$('#addots'),pbtn=$('#adpause');
function showAd(i){adI=i;var a=ADS[i];$('#adname').textContent=a.name;$('#adline').textContent=a.line;$('#adwhere').textContent=a.where;
  Array.prototype.forEach.call(dots.children,function(d,j){d.className=j===i?'on':'';d.setAttribute('aria-current',j===i?'true':'false');});}
if(dots){ADS.forEach(function(a,i){var b=document.createElement('button');b.type='button';b.setAttribute('aria-label','Show ad '+(i+1));b.addEventListener('click',function(){showAd(i)});dots.appendChild(b);});
  showAd(0);
  function setP(p){adPaused=p;pbtn.textContent=p?'Play ads':'Pause ads';pbtn.setAttribute('aria-label',p?'Play the rotating ads':'Pause the rotating ads');}
  setP(adPaused);pbtn.addEventListener('click',function(){setP(!adPaused)});
  setInterval(function(){if(!adPaused&&!document.hidden)showAd((adI+1)%ADS.length)},6000);}

/* ---------- chip wires ---------- */
var cvs=$$('canvas.wirecv');
if(!reduce&&cvs.length&&window.requestAnimationFrame){
  var one=function(p){return{p:p,u:Math.random(),sp:.8+Math.random()*1.8,dir:Math.random()<.5?1:-1,wait:Math.random()*.8,len:.45+Math.random()*.3}};
  var mk=function(){var o=[];PINS.forEach(function(p){o.push(one(p),one(p))});return o};
  var states=cvs.map(mk),last=performance.now(),vis=cvs.map(function(){return true});
  if('IntersectionObserver' in window){var io=new IntersectionObserver(function(es){es.forEach(function(e){vis[cvs.indexOf(e.target)]=e.isIntersecting})});cvs.forEach(function(c){io.observe(c)});}
  var tick=function(now){var dt=Math.min(.05,(now-last)/1000);last=now;
    if(!document.hidden)cvs.forEach(function(cv,ci){if(!vis[ci])return;var r=cv.getBoundingClientRect();var dpr=Math.min(2,window.devicePixelRatio||1);var Wd=Math.max(1,Math.round(r.width*dpr)),H=Math.max(1,Math.round(r.height*dpr));
      if(cv.width!==Wd||cv.height!==H){cv.width=Wd;cv.height=H;}
      var g=cv.getContext('2d');g.clearRect(0,0,Wd,H);g.globalCompositeOperation='lighter';g.lineCap='round';var lw=Math.max(2,Wd/150);
      states[ci].forEach(function(s){if(s.wait>0){s.wait-=dt;return;}s.u+=dt*s.sp;
        if(s.u>1+s.len){s.u=0;s.sp=.7+Math.random()*1.6;s.dir=Math.random()<.5?1:-1;s.wait=Math.random()*.9;s.len=.45+Math.random()*.3;return;}
        var p=s.p,a0=s.dir>0?[p[0],p[1]]:[p[2],p[3]],a1=s.dir>0?[p[2],p[3]]:[p[0],p[1]];
        var h=Math.min(1,s.u),t=Math.max(0,s.u-s.len);
        var hx=(a0[0]+(a1[0]-a0[0])*h)*Wd,hy=(a0[1]+(a1[1]-a0[1])*h)*H,tx=(a0[0]+(a1[0]-a0[0])*t)*Wd,ty=(a0[1]+(a1[1]-a0[1])*t)*H;
        if(hx===tx&&hy===ty)return;
        var gr=g.createLinearGradient(tx,ty,hx,hy);gr.addColorStop(0,'rgba(60,220,255,0)');gr.addColorStop(.7,'rgba(110,245,255,.9)');gr.addColorStop(1,'rgba(255,255,255,1)');
        g.strokeStyle=gr;g.lineWidth=lw*3.2;g.globalAlpha=.45;g.beginPath();g.moveTo(tx,ty);g.lineTo(hx,hy);g.stroke();
        g.lineWidth=lw;g.globalAlpha=1;g.beginPath();g.moveTo(tx,ty);g.lineTo(hx,hy);g.stroke();});
    });
    requestAnimationFrame(tick);};
  requestAnimationFrame(tick);
}

buildQuestions();renderChat();
if(lang!=='en')applyLang(lang);
})();

/* muirtech v3 */
