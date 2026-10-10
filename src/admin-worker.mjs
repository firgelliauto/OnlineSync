import { verifyAdmin } from './admin-auth.mjs';
import { adminOverview,adminCustomers,adminCustomer } from './admin-data.mjs';
import { cloudflareUsage } from './cloudflare-usage.mjs';
import { adminPage } from './admin-page.mjs';

const headers = {
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
};
export default {
  async fetch(request, env) {
    const user = await verifyAdmin(request, env);
    if (!user) return new Response('Private OnlineSync dashboard. Sign in through Cloudflare Access.', { status: 403, headers });
    if (request.method !== 'GET') return new Response('Read-only dashboard', { status: 405, headers: { ...headers, Allow: 'GET' } });
    const url=new URL(request.url),path=url.pathname;
    if (path === '/' || /^\/customers\/[^/]+$/.test(path)) return new Response(adminPage(), { headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' } });
    if(path==='/api/usage')return Response.json(await cloudflareUsage(env),{headers});
    if(path==='/api/customers' || /^\/api\/customers\/[^/]+$/.test(path)) {
      try {
        const data=path==='/api/customers'?
          await adminCustomers(env.DB,env,{query:url.searchParams.get('q')??'',offset:Number(url.searchParams.get('offset')??0)}):
          await adminCustomer(env.DB,env,decodeURIComponent(path.slice('/api/customers/'.length)));
        return Response.json(data??{error:'Customer group not found'},{status:data?200:404,headers});
      }catch(error){return Response.json({error:error.status===400?'Invalid customer search':'Could not read customer details'}, {status:error.status===400||error instanceof URIError?400:503,headers})}
    }
    if (path === '/api/overview') {
      try { return Response.json(await adminOverview(env.DB, env), { headers }); }
      catch (error) {
        console.error('Admin overview failed');
        return Response.json({ error: 'Could not read app health. Check the OnlineSync database and Worker logs.' }, { status: 503, headers });
      }
    }
    return new Response('Not found', { status: 404, headers });
  }
};
