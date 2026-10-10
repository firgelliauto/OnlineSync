import {adminGraphql} from './shopify.mjs';
function fail(message,status=409){const error=new Error(message);error.status=status;throw error}
export async function resolveProductFiles(db,shop,files,env){return await Promise.all(files.map(async file=>{
      if(!file.filename)return file;
      const data=await adminGraphql(db,shop,env,`query ExistingSyncImage($query:String!){files(first:2,query:$query){nodes{id fileStatus ... on MediaImage{image{url} originalSource{url}}}}}`,{query:'filename:'+JSON.stringify(file.filename)});
      const exact=data.files.nodes.filter(node=>(node.image?.url||node.originalSource?.url)?.includes('/'+file.filename));
      if(exact.length>1)fail('Synced image filename is ambiguous');
      if(!exact.length)return file;
      if(exact[0].fileStatus==='FAILED')fail('A synced image failed Shopify processing; review it before retrying');
      if(exact[0].fileStatus!=='READY')fail('A synced image is still processing; retry after it finishes',503);
      return {id:exact[0].id,alt:file.alt};
    }));}
