const LANGS={es:'spanish',pt:'portuguese'};
export default{async fetch(req,env){
  const url=new URL(req.url);
  if(url.pathname==='/api/translate'){
    if(req.method!=='POST')return new Response('Method not allowed',{status:405});
    try{
      const b=await req.json();const src=LANGS[b.lang];const text=String(b.text||'').slice(0,2000);
      if(!src||!text.trim())return Response.json({ok:true,text});
      const r=await env.AI.run('@cf/meta/m2m100-1.2b',{text,source_lang:src,target_lang:'english'});
      return Response.json({ok:true,text:(r&&r.translated_text)||text});
    }catch(e){return Response.json({ok:false,error:'translate failed'},{status:500});}
  }
  return env.ASSETS.fetch(req);
}};
