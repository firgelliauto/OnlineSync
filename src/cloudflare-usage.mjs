const endpoint='https://api.cloudflare.com/client/v4/graphql';
const cache=new Map();
const limits={
  free:{requests:100000,rowsRead:5000000,rowsWritten:100000,queueOperations:10000,storageBytes:5000000000},
  paid:{requests:10000000,rowsRead:25000000000,rowsWritten:50000000,queueOperations:1000000,storageBytes:5000000000,cpuMs:30000000}
};

async function analytics(token,accountId,selection) {
  const response=await fetch(endpoint,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
    signal:AbortSignal.timeout(15000),body:JSON.stringify({query:`query Usage { viewer { accounts(filter:{accountTag:"${accountId}"}) { ${selection} } } }`})});
  if(!response.ok)throw new Error('Analytics unavailable');
  const result=await response.json();
  const account=result.data?.viewer?.accounts?.[0];
  if(result.errors?.length || !account)throw new Error('Analytics unavailable');
  return account;
}

const sum=(rows,key)=>rows.reduce((total,row)=>total+Number(row.sum?.[key]??0),0);

export async function cloudflareUsage(env,{now=Date.now(),fresh=false}={}) {
  const plan=env.CLOUDFLARE_PLAN;
  if(!limits[plan])return {status:'not_configured',message:'The Cloudflare plan needs verification.'};
  const date=new Date(now),start=new Date(now);
  start.setUTCHours(0,0,0,0);
  if(plan==='paid')start.setUTCDate(1);
  const base={plan,period:plan==='free'?'Today · UTC':'Calendar month · UTC',start:start.toISOString(),end:date.toISOString(),
    limits:limits[plan],planVerifiedAt:env.CLOUDFLARE_PLAN_VERIFIED_AT,account:{},onlineSync:{}};
  if(!env.CLOUDFLARE_ANALYTICS_TOKEN)return {...base,status:'not_configured',message:'Live analytics is not connected yet.'};
  if(!/^[a-f0-9]{32}$/.test(env.CLOUDFLARE_ACCOUNT_ID??'') || !/^[a-f0-9-]{36}$/.test(env.CLOUDFLARE_DATABASE_ID??'') ||
    !/^[a-f0-9]{32}$/.test(env.CLOUDFLARE_QUEUE_ID??''))return {...base,status:'unavailable'};
  // Never expose the token. Isolate-local caching avoids polling the API each minute.
  const key=env.CLOUDFLARE_ACCOUNT_ID+plan+env.CLOUDFLARE_ANALYTICS_TOKEN+start.toISOString();
  const prior=cache.get(key);
  if(!fresh && prior?.expires>now)return prior.promise;
  const promise=(async()=>{
    const filter=`datetime_geq:"${start.toISOString()}",datetime_leq:"${date.toISOString()}"`;
    const storageFilter=`datetime_geq:"${new Date(now-86400000).toISOString()}",datetime_leq:"${date.toISOString()}"`;
    const results=await Promise.allSettled([
      analytics(env.CLOUDFLARE_ANALYTICS_TOKEN,env.CLOUDFLARE_ACCOUNT_ID,`
        account:workersInvocationsAdaptive(limit:1,filter:{${filter}}){sum{requests errors cpuTimeUs}}
        main:workersInvocationsAdaptive(limit:1,filter:{${filter},scriptName:"online-sync"}){sum{requests errors cpuTimeUs}}
        admin:workersInvocationsAdaptive(limit:1,filter:{${filter},scriptName:"online-sync-admin"}){sum{requests errors cpuTimeUs}}`),
      analytics(env.CLOUDFLARE_ANALYTICS_TOKEN,env.CLOUDFLARE_ACCOUNT_ID,`
        account:d1AnalyticsAdaptiveGroups(limit:1,filter:{${filter}}){sum{rowsRead rowsWritten}}
        app:d1AnalyticsAdaptiveGroups(limit:1,filter:{${filter},databaseId:"${env.CLOUDFLARE_DATABASE_ID}"}){sum{rowsRead rowsWritten}}`),
      analytics(env.CLOUDFLARE_ANALYTICS_TOKEN,env.CLOUDFLARE_ACCOUNT_ID,`
        account:d1StorageAdaptiveGroups(limit:10000,filter:{${storageFilter}}){dimensions{databaseId} max{databaseSizeBytes}}
        app:d1StorageAdaptiveGroups(limit:1,filter:{${storageFilter},databaseId:"${env.CLOUDFLARE_DATABASE_ID}"}){max{databaseSizeBytes}}`),
      analytics(env.CLOUDFLARE_ANALYTICS_TOKEN,env.CLOUDFLARE_ACCOUNT_ID,`
        account:queueMessageOperationsAdaptiveGroups(limit:1,filter:{${filter}}){sum{billableOperations}}
        app:queueMessageOperationsAdaptiveGroups(limit:1,filter:{${filter},queueId:"${env.CLOUDFLARE_QUEUE_ID}"}){sum{billableOperations}}`)
    ]);
    const out={...base,generatedAt:new Date(now).toISOString(),status:'ok',unavailable:[]};
    for(let i=0;i<results.length;i++){
      const result=results[i];
      if(result.status!=='fulfilled'){out.unavailable.push(['workers','database','storage','queue'][i]);continue}
      const data=result.value;
      if(i===0)for(const name of ['requests','errors','cpuTimeUs']){
        const output=name==='cpuTimeUs'?'cpuMs':name,divisor=name==='cpuTimeUs'?1000:1;
        out.account[output]=sum(data.account,name)/divisor;
        out.onlineSync[output]=(sum(data.main,name)+sum(data.admin,name))/divisor;
      }
      if(i===1)for(const name of ['rowsRead','rowsWritten']){out.account[name]=sum(data.account,name);out.onlineSync[name]=sum(data.app,name)}
      if(i===2){
        if(data.account.length && data.account.length<10000)out.account.storageBytes=data.account.reduce((n,row)=>n+Number(row.max.databaseSizeBytes),0);
        if(data.app.length)out.onlineSync.storageBytes=Number(data.app[0].max.databaseSizeBytes);
      }
      if(i===3){out.account.queueOperations=sum(data.account,'billableOperations');out.onlineSync.queueOperations=sum(data.app,'billableOperations')}
    }
    out.status=out.unavailable.length===4?'unavailable':out.unavailable.length?'partial':'ok';
    return out;
  })();
  cache.clear();cache.set(key,{promise,expires:now+300000});
  return promise;
}
