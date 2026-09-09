'use strict';

const {uuid} = require('./contracts');
const PUBLIC_URL='https://vpsyazqueqjgtaavqzyk.supabase.co';
// Publishable key is intentionally public, as in wrangler.jsonc. Never a service-role key.
const PUBLIC_KEY='sb_publishable_fiahtjNuuCxrdZAR0ELCTA_9pBO0rR6';
function authConfig(env=process.env) {return {supabaseUrl:env.SUPABASE_URL||PUBLIC_URL,supabasePublishableKey:env.SUPABASE_PUBLISHABLE_KEY||PUBLIC_KEY};}
function authenticate({env=process.env,fetchImpl=fetch}={}) {
  return async(req,res,next)=>{
    const authorization=req.get('authorization');
    if(typeof authorization!=='string'||!/^Bearer [a-zA-Z0-9._-]{20,8192}$/.test(authorization)) return res.status(401).json({error:'Faça login para continuar.'});
    const config=authConfig(env);
    try {
      const response=await fetchImpl(config.supabaseUrl+'/auth/v1/user',{headers:{Authorization:authorization,apikey:config.supabasePublishableKey},redirect:'error',signal:AbortSignal.timeout(10000)});
      if(!response.ok) return res.status(response.status>=500?503:401).json({error:'Não foi possível validar a sessão.'});
      const user=await response.json();
      if(!uuid(user.id)||user.is_anonymous===true) return res.status(401).json({error:'Sessão inválida.'});
      req.workflowUser={id:user.id,email:typeof user.email==='string'?user.email.toLowerCase():'',email_confirmed:!!user.email_confirmed_at};
      next();
    }catch {res.status(503).json({error:'Autenticação temporariamente indisponível.'});}
  };
}
function paidAllowed(user,env=process.env) {
  const ids=(env.WORKFLOW_ALLOWED_USER_IDS||'').split(',').map(x=>x.trim()).filter(Boolean);
  const emails=(env.WORKFLOW_ALLOWED_EMAILS||'').toLowerCase().split(',').map(x=>x.trim()).filter(Boolean);
  return ids.includes(user.id)||(user.email_confirmed&&emails.includes(user.email));
}
module.exports={authenticate,authConfig,paidAllowed};
