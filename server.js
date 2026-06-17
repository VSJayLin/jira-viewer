const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT        = process.env.PORT || 3000;
const JIRA_EMAIL  = process.env.JIRA_EMAIL  || '';
const JIRA_TOKEN  = process.env.JIRA_TOKEN  || '';
const JIRA_DOMAIN = process.env.JIRA_DOMAIN || 'viewsonic-vsi.atlassian.net';
const AUTH        = Buffer.from(`${JIRA_EMAIL}:${JIRA_TOKEN}`).toString('base64');

// ── Cache ──
const cache = new Map();
function cacheGet(key, ttl) {
  const item = cache.get(key);
  if (!item) return null;
  if (Date.now() - item.ts > ttl) { cache.delete(key); return null; }
  return item.data;
}
function cacheSet(key, data) { cache.set(key, { data, ts: Date.now() }); }
function cacheDel(pattern) { cache.forEach((v,k) => { if(k.includes(pattern)) cache.delete(k); }); }

// ── Helpers ──
function jiraFetch(apiPath) {
  return new Promise((resolve, reject) => {
    const opts = { hostname: JIRA_DOMAIN, path: apiPath, method: 'GET', headers: { 'Authorization': 'Basic '+AUTH, 'Accept': 'application/json' } };
    const req = https.request(opts, r => { let b=''; r.on('data',c=>b+=c); r.on('end',()=>{ try{resolve(JSON.parse(b))}catch(e){reject(e)} }); });
    req.on('error', reject); req.end();
  });
}
function jiraRequest(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: JIRA_DOMAIN, path: apiPath, method,
      headers: { 'Authorization':'Basic '+AUTH, 'Accept':'application/json', ...(data?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(data)}:{}) }
    };
    const req = https.request(opts, r => {
      let b=''; r.on('data',c=>b+=c);
      r.on('end',()=>{ try{resolve({status:r.statusCode,body:b?JSON.parse(b):{}})}catch(e){resolve({status:r.statusCode,body:{}})} });
    });
    req.on('error', reject);
    if(data) req.write(data);
    req.end();
  });
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let b=''; req.on('data',c=>b+=c);
    req.on('end',()=>{ try{resolve(JSON.parse(b))}catch(e){reject(e)} });
    req.on('error',reject);
  });
}
function json(res, data, status=200) {
  res.writeHead(status, {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
  res.end(JSON.stringify(data));
}

const CACHE_TTL = { projects:10*60*1000, boards:10*60*1000, epics:5*60*1000, meta:5*60*1000, statuses:10*60*1000, tickets:5*60*1000, issue:2*60*1000 };

async function fetchAllAssignees(project) {
  let all=[], startAt=0;
  while(true) {
    const data = await jiraFetch(`/rest/api/3/user/assignable/search?project=${project}&maxResults=50&startAt=${startAt}`).catch(()=>[]);
    const arr = Array.isArray(data)?data:[];
    all = all.concat(arr);
    if(arr.length<50) break;
    startAt+=50; if(startAt>500) break;
  }
  return all;
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const p = parsed.pathname;

  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,PUT,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if(req.method==='OPTIONS'){res.writeHead(204);res.end();return;}

  // /ping
  if(p==='/ping'){json(res,{ok:true,ts:Date.now()});return;}

  // /projects
  if(p==='/projects'&&req.method==='GET'){
    const c=cacheGet('projects',CACHE_TTL.projects);
    if(c){json(res,c);return;}
    try{
      const d=await jiraFetch('/rest/api/3/project?maxResults=200&orderBy=name');
      const projects=(Array.isArray(d)?d:(d.values||[])).map(p=>({key:p.key,name:p.name,id:p.id}));
      cacheSet('projects',projects); json(res,projects);
    }catch(e){json(res,{error:e.message},500);}
    return;
  }

  // /tickets
  if(p==='/tickets'&&req.method==='GET'){
    const{project='OK',boardId='',epic='',jql:customJql=''}=parsed.query;
    const ck=`tickets:${project}:${boardId}:${epic}:${customJql}`;
    const c=cacheGet(ck,CACHE_TTL.tickets);
    if(c){json(res,{issues:c,total:c.length,cached:true});return;}
    const fields='summary,status,priority,assignee,issuetype,updated,created,duedate,reporter,labels,description';
    try{
      let all=[];
      if(boardId&&!epic){
        let startAt=0,total=null;
        while(true){
          const d=await jiraFetch(`/rest/agile/1.0/board/${boardId}/issue?fields=${fields}&maxResults=100&startAt=${startAt}`);
          const batch=d.issues||[];
          all=all.concat(batch);
          if(total===null) total=d.total||0;
          startAt+=batch.length;
          if(!batch.length||startAt>=total) break;
        }
      } else {
        let jqlParts=customJql?[customJql]:[`project=${project}`];
        if(epic&&!customJql) jqlParts.push(`"Epic Link"="${epic}" OR parentEpic="${epic}" OR parent="${epic}"`);
        const jql=encodeURIComponent(jqlParts.join(' AND ')+' ORDER BY key ASC');
        let pageToken='';
        while(true){
          let apiPath=`/rest/api/3/search/jql?jql=${jql}&fields=${fields}&maxResults=100`;
          if(pageToken) apiPath+=`&nextPageToken=${encodeURIComponent(pageToken)}`;
          const d=await jiraFetch(apiPath);
          const batch=d.issues||[];
          all=all.concat(batch);
          if(!d.nextPageToken||d.isLast) break;
          pageToken=d.nextPageToken;
        }
      }
      cacheSet(ck,all);
      json(res,{issues:all,total:all.length,cached:false});
    }catch(e){json(res,{error:e.message,issues:[]},500);}
    return;
  }

  // /issue/:key GET
  if(req.method==='GET'&&p.startsWith('/issue/')&&!p.includes('/transition')&&!p.includes('/comment')&&!p.includes('/subtask')){
    const key=p.replace('/issue/','');
    const c=cacheGet(`issue:${key}`,CACHE_TTL.issue);
    if(c){json(res,c);return;}
    try{
      const d=await jiraFetch(`/rest/api/3/issue/${key}?fields=summary,description,status,assignee,reporter,issuetype,priority,duedate,updated,created,comment,subtasks,parent,issuelinks,labels`);
      cacheSet(`issue:${key}`,d); json(res,d);
    }catch(e){json(res,{error:e.message},500);}
    return;
  }

  // /issue/:key PUT - update fields
  if(req.method==='PUT'&&p.startsWith('/issue/')&&!p.includes('/'+'transition')){
    const key=p.replace('/issue/','');
    try{
      const body=await readBody(req);
      const fields={};
      if(body.assignee!==undefined) fields.assignee=body.assignee?{accountId:body.assignee}:null;
      if(body.duedate!==undefined)  fields.duedate=body.duedate||null;
      if(body.priority!==undefined) fields.priority={name:body.priority};
      if(body.labels!==undefined)   fields.labels=body.labels;
      const r=await jiraRequest('PUT',`/rest/api/3/issue/${key}`,{fields});
      cacheDel(`issue:${key}`); cacheDel('tickets:');
      json(res,{ok:r.status===204},r.status===204?200:r.status);
    }catch(e){json(res,{error:e.message},500);}
    return;
  }

  // /issue/:key/transition POST - change status
  if(req.method==='POST'&&p.match(/^\/issue\/[^/]+\/transition$/)){
    const key=p.split('/')[2];
    try{
      const body=await readBody(req);
      const trans=await jiraFetch(`/rest/api/3/issue/${key}/transitions`);
      const transitions=trans.transitions||[];
      const target=transitions.find(t=>t.id===body.transitionId||t.name.toLowerCase()===String(body.status||'').toLowerCase());
      if(!target){json(res,{error:'Transition not found',available:transitions.map(t=>({id:t.id,name:t.name}))},400);return;}
      const r=await jiraRequest('POST',`/rest/api/3/issue/${key}/transitions`,{transition:{id:target.id}});
      cacheDel(`issue:${key}`); cacheDel('tickets:');
      json(res,{ok:r.status===204,transitions:transitions.map(t=>({id:t.id,name:t.name}))});
    }catch(e){json(res,{error:e.message},500);}
    return;
  }

  // /issue/:key/comment POST - add comment (item 8)
  if(req.method==='POST'&&p.match(/^\/issue\/[^/]+\/comment$/)){
    const key=p.split('/')[2];
    try{
      const body=await readBody(req);
      const r=await jiraRequest('POST',`/rest/api/3/issue/${key}/comment`,{
        body:{type:'doc',version:1,content:[{type:'paragraph',content:[{type:'text',text:body.text}]}]}
      });
      cacheDel(`issue:${key}`);
      json(res,{ok:r.status===201||r.status===200},r.status===201||r.status===200?200:r.status);
    }catch(e){json(res,{error:e.message},500);}
    return;
  }

  // /issue/:key/subtask POST - create subtask (item 9)
  if(req.method==='POST'&&p.match(/^\/issue\/[^/]+\/subtask$/)){
    const parentKey=p.split('/')[2];
    try{
      const body=await readBody(req);
      const r=await jiraRequest('POST','/rest/api/3/issue',{fields:{
        project:{key:body.project},
        summary:body.summary,
        issuetype:{name:'Sub-task'},
        parent:{key:parentKey},
        ...(body.assignee?{assignee:{accountId:body.assignee}}:{})
      }});
      cacheDel(`issue:${parentKey}`); cacheDel('tickets:');
      json(res,{ok:!!r.body?.key,key:r.body?.key});
    }catch(e){json(res,{error:e.message},500);}
    return;
  }

  // /transitions/:key
  if(req.method==='GET'&&p.startsWith('/transitions/')){
    const key=p.replace('/transitions/','');
    try{
      const d=await jiraFetch(`/rest/api/3/issue/${key}/transitions`);
      json(res,(d.transitions||[]).map(t=>({id:t.id,name:t.name})));
    }catch(e){json(res,[]);}
    return;
  }

  // /boards
  if(p==='/boards'&&req.method==='GET'){
    const{project='OK'}=parsed.query;
    const ck=`boards:${project}`;
    const c=cacheGet(ck,CACHE_TTL.boards);
    if(c){json(res,c);return;}
    try{
      const d=await jiraFetch(`/rest/agile/1.0/board?projectKeyOrId=${project}&maxResults=50`);
      const boards=(d.values||[]).map(b=>({id:b.id,name:b.name,type:b.type})).sort((a,b)=>a.name.localeCompare(b.name));
      cacheSet(ck,boards); json(res,boards);
    }catch(e){json(res,[]);}
    return;
  }

  // /epics
  if(p==='/epics'&&req.method==='GET'){
    const{project='OK'}=parsed.query;
    const ck=`epics:${project}`;
    const c=cacheGet(ck,CACHE_TTL.epics);
    if(c){json(res,c);return;}
    try{
      const jql=encodeURIComponent(`project=${project} AND issuetype=Epic ORDER BY summary ASC`);
      const d=await jiraFetch(`/rest/api/3/search/jql?jql=${jql}&fields=summary&maxResults=100`);
      const epics=(d.issues||[]).map(i=>({key:i.key,summary:i.fields.summary||i.key}));
      cacheSet(ck,epics); json(res,epics);
    }catch(e){json(res,[]);}
    return;
  }

  // /statuses
  if(p==='/statuses'&&req.method==='GET'){
    const{project='OK'}=parsed.query;
    const ck=`statuses:${project}`;
    const c=cacheGet(ck,CACHE_TTL.statuses);
    if(c){json(res,c);return;}
    try{
      const d=await jiraFetch(`/rest/api/3/project/${project}/statuses`);
      const statuses=[...new Set((Array.isArray(d)?d:[]).flatMap(t=>(t.statuses||[]).map(s=>s.name)))].sort();
      cacheSet(ck,statuses); json(res,statuses);
    }catch(e){json(res,[]);}
    return;
  }

  // /meta
  if(p==='/meta'&&req.method==='GET'){
    const{project='OK'}=parsed.query;
    const ck=`meta:${project}`;
    const c=cacheGet(ck,CACHE_TTL.meta);
    if(c){json(res,c);return;}
    try{
      const[meta,prios,assignees]=await Promise.all([
        jiraFetch(`/rest/api/3/issue/createmeta?projectKeys=${project}&expand=projects.issuetypes`).catch(()=>({})),
        jiraFetch('/rest/api/3/priority').catch(()=>[]),
        fetchAllAssignees(project)
      ]);
      const proj=(meta.projects||[])[0]||{};
      const sort=(arr,k)=>[...arr].sort((a,b)=>a[k].localeCompare(b[k]));
      const result={
        issueTypes:sort((proj.issuetypes||[]).map(t=>({id:t.id,name:t.name})),'name'),
        priorities:(Array.isArray(prios)?prios:[]).map(p=>({id:p.id,name:p.name})),
        assignees:sort((Array.isArray(assignees)?assignees:[]).map(u=>({accountId:u.accountId,displayName:u.displayName})),'displayName')
      };
      cacheSet(ck,result); json(res,result);
    }catch(e){json(res,{error:e.message},500);}
    return;
  }

  // /labels?project=OK - get labels (item 13)
  if(p==='/labels'&&req.method==='GET'){
    const{project='OK'}=parsed.query;
    const ck=`labels:${project}`;
    const c=cacheGet(ck,10*60*1000);
    if(c){json(res,c);return;}
    try{
      const d=await jiraFetch(`/rest/api/3/label?maxResults=200`);
      const labels=(d.values||[]).sort();
      cacheSet(ck,labels); json(res,labels);
    }catch(e){json(res,[]);}
    return;
  }

  // /create-batch
  if(p==='/create-batch'&&req.method==='POST'){
    try{
      const{issues}=await readBody(req);
      if(!Array.isArray(issues)||!issues.length){json(res,{error:'No issues'},400);return;}
      const issueList=issues.map(({project,summary,description,issueType,priority,assignee,duedate,epic,parentKey,labels})=>{
        const fields={project:{key:project||'OK'},summary,issuetype:{id:issueType}};
        if(priority)    fields.priority={id:priority};
        if(description) fields.description={type:'doc',version:1,content:[{type:'paragraph',content:[{type:'text',text:description}]}]};
        if(assignee)    fields.assignee={accountId:assignee};
        if(duedate)     fields.duedate=duedate;
        if(epic)        fields['customfield_10014']=epic;
        if(parentKey)   fields.parent={key:parentKey};
        if(labels&&labels.length) fields.labels=labels;
        return{fields};
      });
      const BATCH=50;
      const result={issues:[],errors:[]};
      for(let i=0;i<issueList.length;i+=BATCH){
        const batch=issueList.slice(i,i+BATCH);
        const data=JSON.stringify({issueUpdates:batch});
        const opts={hostname:JIRA_DOMAIN,path:'/rest/api/3/issue/bulk',method:'POST',headers:{'Authorization':'Basic '+AUTH,'Accept':'application/json','Content-Type':'application/json','Content-Length':Buffer.byteLength(data)}};
        const r=await new Promise(resolve=>{
          const req=https.request(opts,resp=>{let b='';resp.on('data',c=>b+=c);resp.on('end',()=>{try{resolve(JSON.parse(b))}catch(e){resolve({issues:[],errors:[]})}});});
          req.on('error',()=>resolve({issues:[],errors:[]})); req.write(data); req.end();
        });
        result.issues.push(...(r.issues||[]));
        result.errors.push(...(r.errors||[]));
      }
      cacheDel('tickets:');
      json(res,result);
    }catch(e){json(res,{error:e.message},400);}
    return;
  }

  // serve index.html
  if(p==='/'||p==='/index.html'){
    fs.readFile(path.join(__dirname,'index.html'),(err,data)=>{
      if(err){res.writeHead(404);res.end('Not found');return;}
      res.writeHead(200,{'Content-Type':'text/html;charset=utf-8'}); res.end(data);
    });
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT,()=>console.log(`✅ JIRA Tools on port ${PORT}`));
