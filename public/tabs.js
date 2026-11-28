/* 11-27-2026: topic tabs at the top. Each tab shows one topic instead of one long scrolling page.
   Buttons are MUIR Tech's own "glass keycap" design (smoky glass key, gold letters, teal glow). */
(function(){
  /* words for the new tabs in all three languages (app.js swaps them when the language changes) */
  try{
    var W={en:{n300:'Home',n301:'Local businesses',n950:'Logos',n951:'Login / Out',n952:'Security cameras',n302:'Topics'},es:{n300:'Inicio',n301:'Negocios locales',n950:'Logotipos',n951:'Entrar / Salir',n952:'Cámaras de seguridad',n302:'Temas'},pt:{n300:'Início',n301:'Negócios locais',n950:'Logotipos',n951:'Entrar / Sair',n952:'Câmeras de segurança',n302:'Tópicos'}};
    for(var L in W){if(typeof I18N!=="undefined"&&I18N[L]){for(var k in W[L])I18N[L][k]=W[L][k]}}
  }catch(e){}

  var css=''+
  '.mtabs{width:100%;margin:4px 0 2px;padding:10px 0 14px;display:flex;flex-wrap:wrap;gap:16px 12px;justify-content:flex-start}.mtabs .mtab{flex:1 1 auto}'+
  '@media (min-width:1000px){.mtabs.mtabs{grid-template-columns:repeat(7,minmax(0,1fr))!important;column-gap:10px}.mtabs .mtab{grid-row:2;min-width:0;font-size:clamp(12px,1.15vw,15px);letter-spacing:.05em;white-space:normal;text-align:center;line-height:1.1}.mtabs .mtab.mtab-login{grid-row:1;grid-column:7}.mtabs .mtab.mtab-cams{grid-row:1;grid-column:5}.mtabs .mtab.mtab-logos{grid-row:1;grid-column:6}.mtabs{display:grid;grid-template-columns:repeat(8,auto);justify-content:stretch}.mtabs .mtab{padding-left:4px;padding-right:4px}}'+
  /* glass keycap (design #5): the real Recraft keycap picture, stretched sideways to fit each word */
  '.mtab{position:relative;display:inline-flex;align-items:flex-start;justify-content:center;font-family:"MUIR Tech Display","Syne",sans-serif;font-weight:700;font-size:15px;letter-spacing:.08em;text-transform:uppercase;'+
   'color:#D9C68C;text-decoration:none;white-space:nowrap;cursor:pointer;height:74px;padding:0 26px;box-sizing:border-box;background:none;'+
   'border-style:solid;border-width:0 22px;border-color:transparent;border-image:url(/assets/keycap-btn.webp) 0 96 fill / 0 22px stretch;'+
   'text-shadow:0 1px 0 rgba(0,0,0,.8),0 0 10px rgba(195,175,117,.25);transition:transform .14s cubic-bezier(.3,.7,.4,1),filter .2s,color .2s;will-change:transform}'+
  '.mtab>span{display:block;margin-top:13px;line-height:1.2;transition:transform .14s cubic-bezier(.3,.7,.4,1)}'+
  '.mtab:hover{transform:translateY(5px) scaleY(.96);filter:brightness(1.12) drop-shadow(0 0 10px rgba(42,200,230,.45))}'+
  '.mtab:active{transform:translateY(8px) scaleY(.92);filter:brightness(.95)}'+
  '.mtab[aria-selected="true"]{color:#F3E2A8;transform:translateY(4px) scaleY(.97);filter:brightness(1.2) drop-shadow(0 4px 12px rgba(60,220,245,.75))}'+
  '.mtab[aria-selected="true"]:hover{transform:translateY(6px) scaleY(.95)}'+
  '.mtab:focus-visible{outline:3px solid #C3AF75;outline-offset:5px}'+
  '.mtab-hide{display:none!important}'+
  'header.nav{position:relative!important;top:auto!important}'+
  '@media (max-width:700px){.mtabs{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px 12px;padding:10px 0 12px;box-sizing:border-box;max-width:100%}.mtabs .mtab{box-sizing:border-box;min-width:0;width:100%;max-width:100%}.mtab{font-size:12.5px;height:76px;padding:0 12px;border-width:0 18px;border-image-width:0 18px;white-space:normal;text-align:center}.mtab>span{margin-top:9px;line-height:1.08}.mtab:last-child:nth-child(odd){grid-column:1/-1}}'+
  '@media (prefers-reduced-motion:reduce){.mtab,.mtab>span{transition:none}.mtab:hover,.mtab:active,.mtab[aria-selected="true"]{transform:none}}';
  var st=document.createElement('style');st.id='mtabs-css';st.textContent=css;document.head.appendChild(st);

  function q(s){return document.querySelector(s)}
  /* which parts of the page belong to each tab */
  var GROUPS=[
    {id:'home',key:'n300',label:'Home',parts:['#top','.mq','section.tips','section[aria-labelledby="ph-h"]','section[aria-labelledby="about-h"]']},
    {id:'contact',key:'n4',label:'Contact',parts:['#contact']},
    {id:'services',key:'n1',label:'Services',parts:['#services','#access']},
    {id:'ai',key:'n2',label:'AI for business',parts:['#ai']},
    {id:'how',key:'n3',label:'How it works',parts:['#how']},
    {id:'cams',key:'n952',label:'Security cameras',href:'/cameras'},
    {id:'logos',key:'n950',label:'Logos',href:'/logos'},
    {id:'websites',key:'n200',label:'Websites',href:'/websites'},
    {id:'local',key:'n301',label:'Local businesses',parts:['#local']},
    {id:'login',key:'n951',label:'Login / Out',href:'/account'}
  ];
  var nav=q('header.nav');if(!nav)return;
  var onHome=!!q('#top');
  if(!onHome){ /* other pages (e.g. /websites): the same buttons, as links back to each topic */
    var b2=document.createElement('nav');b2.className='mtabs';b2.setAttribute('aria-label','Topics');
    var HREF={home:'/',services:'/#services',ai:'/#ai',how:'/#how',cams:'/cameras',logos:'/logos',websites:'/websites',local:'/#local',login:'/account',contact:'/#contact'};
    GROUPS.forEach(function(g){var a=document.createElement('a');a.className='mtab'+(g.id==='login'?' mtab-login':g.id==='cams'?' mtab-cams':g.id==='logos'?' mtab-logos':'');a.href=HREF[g.id];var sp=document.createElement('span');sp.setAttribute('data-t',g.key);sp.textContent=g.label;a.appendChild(sp);
      if(location.pathname.replace(/\.html$/,'')===HREF[g.id]){a.setAttribute('aria-current','page');a.setAttribute('aria-selected','true')}b2.appendChild(a)});
    nav.appendChild(b2);return;
  }
  var bar=document.createElement('nav');bar.className='mtabs';bar.setAttribute('aria-label','Topics');
  var list=document.createElement('div');list.setAttribute('role','tablist');list.style.display='contents';bar.appendChild(list);
  GROUPS.forEach(function(g){
    var el=document.createElement(g.href?'a':'button');
    el.className='mtab'+(g.id==='login'?' mtab-login':g.id==='cams'?' mtab-cams':g.id==='logos'?' mtab-logos':'');
    var sp=document.createElement('span');sp.setAttribute('data-t',g.key);sp.textContent=g.label;el.appendChild(sp);
    if(g.href){el.href=g.href}
    else{el.type='button';el.setAttribute('role','tab');el.setAttribute('aria-selected','false');el.id='mtab-'+g.id;
      el.addEventListener('click',function(){show(g.id,true)})}
    g.btn=el;list.appendChild(el);
  });
  nav.appendChild(bar);
  /* 11-27-2026: call, screen color and language sit in the empty top row, left of Security cameras (wide screens) */
  (function(){var ctl=nav.querySelector(':scope > div:not(.mtabs)');if(!ctl||!ctl.querySelector('.langs'))return;ctl.classList.add('hdrctl');var mq=matchMedia('(min-width:1000px)');
    function place(){if(mq.matches){if(ctl.parentNode!==bar)bar.insertBefore(ctl,bar.firstChild)}else if(ctl.parentNode===bar){nav.insertBefore(ctl,bar)}}
    place();mq.addEventListener?mq.addEventListener('change',place):mq.addListener(place);})();

  function els(g){var out=[];(g.parts||[]).forEach(function(s){document.querySelectorAll(s).forEach(function(e){out.push(e)})});return out}
  function groupOf(node){for(var i=0;i<GROUPS.length;i++){var g=GROUPS[i];if(!g.parts)continue;var E=els(g);for(var j=0;j<E.length;j++){if(E[j]===node||E[j].contains(node))return g}}return null}
  var current=null;
  function show(id,scroll,target){
    GROUPS.forEach(function(g){if(!g.parts)return;var on=g.id===id;els(g).forEach(function(e){e.classList.toggle('mtab-hide',!on)});g.btn.setAttribute('aria-selected',on?'true':'false');g.btn.tabIndex=on?0:-1});
    current=id;
    try{history.replaceState(null,'',id==='home'?location.pathname:'#'+(GROUPS.filter(function(g){return g.id===id})[0].parts[0].replace(/^#/,'').replace(/[^a-z0-9-].*$/i,'')||id))}catch(e){}
    if(scroll){var y=target?target.getBoundingClientRect().top+scrollY-16:bar.getBoundingClientRect().top+scrollY-8;window.scrollTo({top:Math.max(0,y),behavior:'smooth'})}
  }
  /* arrow keys move between tabs */
  list.addEventListener('keydown',function(e){var tabs=[].slice.call(list.querySelectorAll('button.mtab'));var i=tabs.indexOf(document.activeElement);if(i<0)return;
    if(e.key==='ArrowRight'||e.key==='ArrowLeft'){e.preventDefault();var n=tabs[(i+(e.key==='ArrowRight'?1:tabs.length-1))%tabs.length];n.focus();n.click()}});
  /* any link on the page to a section (e.g. "Send a message" -> #contact) opens that section's tab */
  document.addEventListener('click',function(e){
    var a=e.target.closest&&e.target.closest('a[href^="#"]');if(!a)return;
    var h=a.getAttribute('href');if(h==='#'||h==='#main')return;
    var t=null;try{t=q(h)}catch(x){}if(!t)return;
    var g=groupOf(t);if(!g)return;
    e.preventDefault();show(g.id,true,g.id===current?t:(t.matches('#top')?null:t));
  });
  function fromHash(){var h=location.hash;var t=null;if(h&&h!=='#main'){try{t=q(h)}catch(x){}}var g=t?groupOf(t):null;show(g?g.id:'home',!!g,t)}
  addEventListener('hashchange',fromHash);
  fromHash();
})();
/* 11-27-2026: the top logo sits on no colored band, so in the Light look it switches to the dark-letter logo */
(function(){
  var img=document.querySelector('header .hdrlogo'),sel=document.getElementById('theme');if(!img)return;
  function upd(){var light=sel&&sel.value==='light';img.src=light?'assets/muirtech-lockup-light.png':'assets/muirtech-lockup-dark.png'}
  if(sel){sel.addEventListener('change',upd);setTimeout(upd,300)}upd();
})();
