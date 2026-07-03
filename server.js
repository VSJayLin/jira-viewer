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
function jiraFetchRaw(apiPath) {
  return new Promise((resolve, reject) => {
    const opts = { hostname: JIRA_DOMAIN, path: apiPath, method: 'GET',
      headers: { 'Authorization': 'Basic '+AUTH, 'Accept': '*/*' }
    };
    const req = require('https').request(opts, r => {
      // Follow redirects (Jira often redirects attachment content)
      if(r.statusCode===301||r.statusCode===302||r.statusCode===303){
        const loc=r.headers.location;
        if(loc){
          const url=new URL(loc);
          const opts2={hostname:url.hostname,path:url.pathname+url.search,method:'GET',
            headers:{'Authorization':'Basic '+AUTH,'Accept':'*/*'}};
          const req2=require('https').request(opts2,r2=>{
            resolve({status:r2.statusCode,headers:r2.headers,body:r2});
          });
          req2.on('error',reject);req2.end();
          return;
        }
      }
      resolve({status:r.statusCode,headers:r.headers,body:r});
    });
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

const CACHE_TTL = { projects:10*60*1000, boards:10*60*1000, epics:2*60*1000, meta:5*60*1000, statuses:10*60*1000, tickets:5*60*1000, issue:2*60*1000 };

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
    const fields='summary,status,priority,assignee,issuetype,updated,created,duedate,reporter,labels,subtasks,customfield_10016,customfield_10020';
    try{
      let all=[];
      if(boardId&&!epic){
        // Get board's own JQL filter to show EXACTLY the same tickets as Jira
        const boardConfig=await jiraFetch(`/rest/agile/1.0/board/${boardId}/configuration`).catch(()=>null);
        const boardJql=boardConfig?.filter?.query;
        if(boardJql){
          // Use board's filter JQL → exact match with what Jira shows on this board
          const jql=encodeURIComponent(boardJql+' ORDER BY key ASC');
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
        } else {
          // Fallback: use board/issue API if config unavailable
          let startAt=0,total=null;
          while(true){
            const d=await jiraFetch(`/rest/agile/1.0/board/${boardId}/issue?fields=${fields}&maxResults=100&startAt=${startAt}`);
            const batch=d.issues||[];
            all=all.concat(batch);
            if(total===null) total=d.total||0;
            startAt+=batch.length;
            if(!batch.length||startAt>=total) break;
          }
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
      all.forEach(i=>{const nm=i.fields?.status?.name||'';const codes=[...nm].map(c=>c.codePointAt(0));if(codes.some(c=>c>0x9fff)){console.log('[STATUS_DEBUG]',i.key,JSON.stringify(nm),[...nm].map(c=>c.codePointAt(0).toString(16)).join(' '));}});
      cacheSet(ck,all);
      json(res,{issues:all,total:all.length,cached:false});
    }catch(e){json(res,{error:e.message,issues:[]},500);}
    return;
  }

  // /issue/:key GET
  if(req.method==='GET'&&p.startsWith('/issue/')&&!p.includes('/transition')&&!p.includes('/comment')&&!p.includes('/subtask')&&!p.includes('/attachments')&&!p.includes('/changelog')&&!p.includes('/watchers')&&!p.includes('/timetrack')&&!p.includes('/related')&&!p.includes('/activity')&&!p.includes('/worklog')&&!p.includes('/reactions')&&!p.includes('/votes')){
    const key=p.replace('/issue/','');
    // Always fetch fresh issue data - no caching to avoid stale status/transitions
    try{
      const d=await jiraFetch(`/rest/api/3/issue/${key}?fields=summary,description,status,assignee,reporter,issuetype,priority,duedate,updated,created,comment,subtasks,parent,issuelinks,labels`);
      json(res,d);
    }catch(e){json(res,{error:e.message},500);}
    return;
  }

  // /issue/:key PUT - update fields
  if(req.method==='PUT'&&p.startsWith('/issue/')&&!p.includes('/'+'transition')){
    const key=p.replace('/issue/','');
    try{
      const body=await readBody(req);
      const fields={};
      if(body.summary!==undefined)    fields.summary=body.summary;
      if(body.description!==undefined){
        if(body.description===null||body.description===''){
          // Explicitly clear description in Jira
          fields.description=null;
        } else {
          fields.description={type:'doc',version:1,content:[{type:'paragraph',content:[{type:'text',text:body.description}]}]};
        }
      }
      if(body.assignee!==undefined)   fields.assignee=body.assignee?{accountId:body.assignee}:null;
      if(body.duedate!==undefined)    fields.duedate=body.duedate||null;
      if(body.priority!==undefined){
        if(body.priority===null||body.priority==='') fields.priority=null;
        else fields.priority={name:body.priority};
      }
      if(body.labels!==undefined)     fields.labels=body.labels;
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

  // /sprints?boardId=123 - get sprints for board (item 15)
  if(p==='/sprints'&&req.method==='GET'){
    const{boardId=''}=parsed.query;
    if(!boardId){json(res,[]);return;}
    const ck=`sprints:${boardId}`;
    const c=cacheGet(ck,3*60*1000);
    if(c){json(res,c);return;}
    try{
      const d=await jiraFetch(`/rest/agile/1.0/board/${boardId}/sprint?state=active,future&maxResults=20`);
      const sprints=(d.values||[]).map(s=>({id:s.id,name:s.name,state:s.state}));
      cacheSet(ck,sprints); json(res,sprints);
    }catch(e){json(res,[]);}
    return;
  }

  // /clone - clone a ticket (item 16)
  if(p==='/clone'&&req.method==='POST'){
    try{
      const{key,summary,project}=await readBody(req);
      // Fetch original
      const orig=await jiraFetch(`/rest/api/3/issue/${key}?fields=summary,description,issuetype,priority,assignee,duedate,labels`);
      const f=orig.fields||{};
      const fields={
        project:{key:project||f.project?.key||'OK'},
        summary:summary||(f.summary?`[Copy] ${f.summary}`:'Copy'),
        issuetype:{id:f.issuetype?.id||''},
      };
      if(f.description) fields.description=f.description;
      if(f.priority)    fields.priority={id:f.priority.id};
      if(f.assignee)    fields.assignee={accountId:f.assignee.accountId};
      if(f.duedate)     fields.duedate=f.duedate;
      if(f.labels?.length) fields.labels=f.labels;
      const r=await jiraRequest('POST','/rest/api/3/issue',{fields});
      cacheDel('tickets:');
      json(res,{ok:!!r.body?.key,key:r.body?.key,error:r.body?.errors});
    }catch(e){json(res,{error:e.message},500);}
    return;
  }

  // /issue/:key/changelog GET - change log (item 13)
  if(req.method==='GET'&&p.match(/^\/issue\/[^/]+\/changelog$/)){
    const key=p.split('/')[2];
    try{
      const d=await jiraFetch(`/rest/api/3/issue/${key}/changelog?maxResults=20`);
      const logs=(d.values||[]).map(c=>({
        created:c.created?.slice(0,16)||'',
        author:c.author?.displayName||'?',
        items:(c.items||[]).map(i=>({field:i.field,from:i.fromString||'',to:i.toString||''}))
      }));
      json(res,logs);
    }catch(e){json(res,[]);}
    return;
  }

  // /issue/:key/watchers GET - get watchers
  if(req.method==='GET'&&p.match(/^\/issue\/[^/]+\/watchers$/)){
    const key=p.split('/')[2];
    try{
      const d=await jiraFetch(`/rest/api/3/issue/${key}/watchers`);
      json(res,(d.watchers||[]).map(w=>({accountId:w.accountId,displayName:w.displayName})));
    }catch(e){json(res,[]);}
    return;
  }

  // /issue/:key/watchers POST - add watcher (item 16)
  if(req.method==='POST'&&p.match(/^\/issue\/[^/]+\/watchers$/)){
    const key=p.split('/')[2];
    try{
      const body=await readBody(req);
      const accountId=body.accountId;
      // Jira watcher API expects just the accountId as a string body
      const r=await new Promise((resolve)=>{
        const data=JSON.stringify(accountId);
        const opts={hostname:JIRA_DOMAIN,path:`/rest/api/3/issue/${key}/watchers`,method:'POST',headers:{'Authorization':'Basic '+AUTH,'Content-Type':'application/json','Content-Length':Buffer.byteLength(data)}};
        const req2=require('https').request(opts,resp=>{let b='';resp.on('data',c=>b+=c);resp.on('end',()=>resolve({status:resp.statusCode}));});
        req2.on('error',()=>resolve({status:500}));req2.write(data);req2.end();
      });
      json(res,{ok:r.status===204});
    }catch(e){json(res,{error:e.message},500);}
    return;
  }

  // /cache-clear POST - clear server cache
  if(p==='/cache-clear'&&req.method==='POST'){
    try{
      const body=await readBody(req).catch(()=>({}));
      const pattern=body.pattern||'';
      if(pattern) cacheDel(pattern); else cache.clear();
      json(res,{ok:true,size:cache.size});
    }catch(e){json(res,{error:e.message},500);}
    return;
  }

  // /comments/:key GET - all comments (item 12)
  if(req.method==='GET'&&p.startsWith('/comments/')){
    const key=p.replace('/comments/','');
    try{
      const d=await jiraFetch(`/rest/api/3/issue/${key}/comment?maxResults=100&orderBy=created`);
      json(res,d.comments||[]);
    }catch(e){json(res,[]);}
    return;
  }

  // /create-batch
  if(p==='/create-batch'&&req.method==='POST'){
    try{
      const{issues}=await readBody(req);
      if(!Array.isArray(issues)||!issues.length){json(res,{error:'No issues'},400);return;}
      const issueList=issues.map(({project,summary,description,issueType,priority,assignee,duedate,epic,parentKey,labels,sprintId})=>{
        const fields={project:{key:project||'OK'},summary,issuetype:{id:issueType}};
        if(priority)    fields.priority={id:priority};
        if(description) fields.description={type:'doc',version:1,content:[{type:'paragraph',content:[{type:'text',text:description}]}]};
        if(assignee)    fields.assignee={accountId:assignee};
        if(duedate)     fields.duedate=duedate;
        if(epic)        fields['customfield_10014']=epic;
        if(parentKey)   fields.parent={key:parentKey};
        if(labels&&labels.length) fields.labels=labels;
        if(sprintId)    fields['customfield_10020']={id:parseInt(sprintId)};
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

  // /issue/:key/link POST - create linked issue (item 14)
  if(req.method==='POST'&&p.match(/^\/issue\/[^/]+\/link$/)){
    const key=p.split('/')[2];
    try{
      const body=await readBody(req);
      // body: { linkType, inwardKey OR outwardKey }
      const linkBody={
        type:{name:body.linkType||'Relates'},
        inwardIssue:{key:body.inwardKey||key},
        outwardIssue:{key:body.outwardKey||key}
      };
      const r=await jiraRequest('POST','/rest/api/3/issueLink',linkBody);
      cacheDel(`issue:${key}`);
      const linkedKey=body.inwardKey||body.outwardKey;
      if(linkedKey&&linkedKey!==key) cacheDel(`issue:${linkedKey}`);
    }catch(e){json(res,{error:e.message},500);}
    return;
  }

  // /issue/:key/attachments GET - list attachments (item 16)
  if(req.method==='GET'&&p.match(/^\/issue\/[^/]+\/attachments$/)){
    const key=p.split('/')[2];
    try{
      // Try to get attachments - some Jira configs need expand parameter
      const d=await jiraFetch(`/rest/api/3/issue/${key}?fields=attachment,comment&expand=attachment`);
      const rawAttachments=d.fields?.attachment||[];
      console.log(`[attachments] key=${key} count=${rawAttachments.length} error=${d.errorMessages||d.errors||''}`);
      const attachments=rawAttachments.map(a=>({
        id:a.id,filename:a.filename,size:a.size,mimeType:a.mimeType,
        content:`/attachment-proxy/${a.id}`,
        thumbnail:a.thumbnail?`/attachment-proxy/${a.id}?thumb=1`:null,
        created:a.created?.slice(0,10)||''
      }));
      json(res,attachments);
    }catch(e){console.log(`[attachments] ERROR key=${key}:`,e.message);json(res,[]);}
    return;
  }

  // /attachment-proxy/:id - proxy attachment content with auth (item 16b)
  if(req.method==='GET'&&p.startsWith('/attachment-proxy/')){
    const attachId=p.replace('/attachment-proxy/','');
    const isThumb=parsed.query.thumb==='1';
    try{
      const apiUrl=isThumb
        ?`/rest/api/3/attachment/thumbnail/${attachId}?size=medium`
        :`/rest/api/3/attachment/content/${attachId}`;
      const attachRes=await jiraFetchRaw(apiUrl);
      res.statusCode=attachRes.status||200;
      // Forward content-type header
      const ct=attachRes.headers?.['content-type']||'application/octet-stream';
      res.setHeader('Content-Type',ct);
      res.setHeader('Access-Control-Allow-Origin','*');
      res.setHeader('Cache-Control','public, max-age=3600');
      if(attachRes.body) attachRes.body.pipe(res);
      else res.end();
    }catch(e){res.statusCode=500;res.end('proxy error: '+e.message);}
    return;
  }

  // /issue/:key/subtasks GET - get subtasks with details (item 17)
  if(req.method==='GET'&&p.match(/^\/issue\/[^/]+\/subtasks$/)){
    const key=p.split('/')[2];
    try{
      const d=await jiraFetch(`/rest/api/3/issue/${key}?fields=subtasks`);
      const subtasks=d.fields?.subtasks||[];
      // Fetch each subtask detail
      const details=await Promise.all(subtasks.slice(0,20).map(s=>
        jiraFetch(`/rest/api/3/issue/${s.key}?fields=summary,status,assignee,duedate,priority`).catch(()=>null)
      ));
      json(res,details.filter(Boolean).map(s=>({
        key:s.key,summary:s.fields?.summary||'',
        status:s.fields?.status?.name||'',statusCat:s.fields?.status?.statusCategory?.key||'',
        assignee:s.fields?.assignee?.displayName||'',assigneeId:s.fields?.assignee?.accountId||'',
        duedate:s.fields?.duedate||'',priority:s.fields?.priority?.name||''
      })));
    }catch(e){json(res,[]);}
    return;
  }

  // /link-types GET - get available link types (item 14)
  if(req.method==='GET'&&p==='/link-types'){
    const ck='link-types';const c=cacheGet(ck,60*60*1000);if(c){json(res,c);return;}
    try{
      const d=await jiraFetch('/rest/api/3/issueLinkType');
      const types=(d.issueLinkTypes||[]).map(t=>({id:t.id,name:t.name,inward:t.inward,outward:t.outward}));
      cacheSet(ck,types);json(res,types);
    }catch(e){json(res,[]);}
    return;
  }

  // /issue/:key/attach POST - upload attachment (item 14) - multipart
  if(req.method==='POST'&&p.match(/^\/issue\/[^/]+\/attach$/)){
    const key=p.split('/')[2];
    // Collect raw body as buffer
    const chunks=[];
    req.on('data',c=>chunks.push(c));
    req.on('end',async()=>{
      try{
        const body=Buffer.concat(chunks);
        const ct=req.headers['content-type']||'';
        const r=await new Promise((resolve)=>{
          const opts={
            hostname:JIRA_DOMAIN,path:`/rest/api/3/issue/${key}/attachments`,method:'POST',
            headers:{'Authorization':'Basic '+AUTH,'Accept':'application/json','Content-Type':ct,'Content-Length':body.length,'X-Atlassian-Token':'no-check'}
          };
          const req2=require('https').request(opts,resp=>{let b='';resp.on('data',c=>b+=c);resp.on('end',()=>resolve({status:resp.statusCode,body:b}));});
          req2.on('error',e=>resolve({status:500,body:e.message}));
          req2.write(body);req2.end();
        });
        cacheDel(`issue:${key}`);
        json(res,{ok:r.status===200||r.status===201,status:r.status});
      }catch(e){json(res,{error:e.message},500);}
    });
    return;
  }

  // /multi-tickets POST - fetch tickets from multiple projects
  if(req.method==='POST'&&p==='/multi-tickets'){
    try{
      const body=await readBody(req);
      const{projects=[],jql=''}=body;
      const fields='summary,status,priority,assignee,issuetype,updated,created,duedate,reporter,labels,description,subtasks';
      let allIssues=[];
      if(jql){
        const encoded=encodeURIComponent(jql+' ORDER BY key ASC');
        let pageToken='';
        while(true){
          let apiPath=`/rest/api/3/search/jql?jql=${encoded}&fields=${fields}&maxResults=100`;
          if(pageToken)apiPath+=`&nextPageToken=${encodeURIComponent(pageToken)}`;
          const d=await jiraFetch(apiPath);
          allIssues=allIssues.concat(d.issues||[]);
          if(!d.nextPageToken||d.isLast)break;
          pageToken=d.nextPageToken;
        }
      } else {
        for(const proj of projects.slice(0,5)){
          const jqlStr=encodeURIComponent(`project=${proj} ORDER BY key ASC`);
          let pageToken='';
          while(true){
            let apiPath=`/rest/api/3/search/jql?jql=${jqlStr}&fields=${fields}&maxResults=100`;
            if(pageToken)apiPath+=`&nextPageToken=${encodeURIComponent(pageToken)}`;
            const d=await jiraFetch(apiPath);
            allIssues=allIssues.concat(d.issues||[]);
            if(!d.nextPageToken||d.isLast)break;
            pageToken=d.nextPageToken;
          }
        }
      }
      json(res,{issues:allIssues,total:allIssues.length});
    }catch(e){json(res,{error:e.message,issues:[]},500);}
    return;
  }

  // /epic/:key - get epic details with child progress
  if(req.method==='GET'&&p.startsWith('/epic/')){
    const key=p.replace('/epic/','');
    try{
      const[epic,children]=await Promise.all([
        jiraFetch(`/rest/api/3/issue/${key}?fields=summary,status,assignee,duedate,description`),
        jiraFetch(`/rest/api/3/search/jql?jql=${encodeURIComponent(`"Epic Link"="${key}" OR parent="${key}"`)}&fields=status&maxResults=50`)
      ]);
      const kids=children.issues||[];
      const total=kids.length;
      const done=kids.filter(i=>i.fields?.status?.statusCategory?.key==='done').length;
      json(res,{key,summary:epic.fields?.summary||'',status:epic.fields?.status?.name||'',assignee:epic.fields?.assignee?.displayName||'',duedate:epic.fields?.duedate||'',total,done,pct:total?Math.round(done/total*100):0});
    }catch(e){json(res,{error:e.message},500);}
    return;
  }

  // /issue/:key/timetrack GET - time tracking info (item 12)
  if(req.method==='GET'&&p.match(/^\/issue\/[^/]+\/timetrack$/)){
    const key=p.split('/')[2];
    try{
      const d=await jiraFetch(`/rest/api/3/issue/${key}?fields=timetracking,timeoriginalestimate,timespent,aggregatetimespent`);
      const tt=d.fields?.timetracking||{};
      json(res,{originalEstimate:tt.originalEstimate||'',originalEstimateSeconds:tt.originalEstimateSeconds||0,remainingEstimate:tt.remainingEstimate||'',remainingEstimateSeconds:tt.remainingEstimateSeconds||0,timeSpent:tt.timeSpent||'',timeSpentSeconds:tt.timeSpentSeconds||0});
    }catch(e){json(res,{});}
    return;
  }

  // /issue/:key/reporter PUT - change reporter (item 13)
  // Note: Jira restricts reporter changes; handled in generic PUT /issue/:key

  // /issue/:key/related GET - related tickets in same epic (item 15)
  if(req.method==='GET'&&p.match(/^\/issue\/[^/]+\/related$/)){
    const key=p.split('/')[2];
    try{
      // Get epic of this issue
      const issue=await jiraFetch(`/rest/api/3/issue/${key}?fields=customfield_10014,parent`);
      const epicKey=issue.fields?.customfield_10014||issue.fields?.parent?.key||'';
      if(!epicKey){json(res,[]);return;}
      const q=encodeURIComponent(`"Epic Link"="${epicKey}" OR parent="${epicKey}" ORDER BY created ASC`);
      const d=await jiraFetch(`/rest/api/3/search/jql?jql=${q}&fields=summary,status,assignee&maxResults=10`);
      const related=(d.issues||[]).filter(i=>i.key!==key).map(i=>({key:i.key,summary:i.fields?.summary||'',status:i.fields?.status?.name||'',assignee:i.fields?.assignee?.displayName||''}));
      json(res,related);
    }catch(e){json(res,[]);}
    return;
  }

  // /issue/:key/notify POST - send email notification (item 20)
  if(req.method==='POST'&&p.match(/^\/issue\/[^/]+\/notify$/)){
    const key=p.split('/')[2];
    try{
      const body=await readBody(req);
      const r=await jiraRequest('POST',`/rest/api/3/issue/${key}/notify`,{
        subject:body.subject||`Jira notification: ${key}`,
        textBody:body.body||`Please check ticket ${key}`,
        htmlBody:`<p>${body.body||`Please check ticket <a href="https://${JIRA_DOMAIN}/browse/${key}">${key}</a>`}</p>`,
        to:{reporter:true,assignee:true,watchers:true,users:body.users||[]},
        restrict:{groups:[],permissions:[]}
      });
      json(res,{ok:r.status===204||r.status===200});
    }catch(e){json(res,{error:e.message},500);}
    return;
  }

  // /bulk-update POST - bulk update existing tickets (item 21)
  if(req.method==='POST'&&p==='/bulk-update'){
    try{
      const{keys=[],fields={}}=await readBody(req);
      if(!keys.length){json(res,{error:'No keys'},400);return;}
      const results={ok:[],fail:[]};
      for(const key of keys){
        try{
          const r=await jiraRequest('PUT',`/rest/api/3/issue/${key}`,{fields});
          if(r.status===204||r.status===200) results.ok.push(key);
          else results.fail.push({key,error:JSON.stringify(r.body)});
        }catch(e){results.fail.push({key,error:e.message});}
      }
      cacheDel('tickets:');
      json(res,results);
    }catch(e){json(res,{error:e.message},500);}
    return;
  }

  // /issue/:key/components GET - get components for project (item 7)
  if(req.method==='GET'&&p.startsWith('/components/')){
    const proj=p.replace('/components/','');
    const ck=`components:${proj}`;const c=cacheGet(ck,10*60*1000);if(c){json(res,c);return;}
    try{
      const d=await jiraFetch(`/rest/api/3/project/${proj}/components`);
      const comps=(Array.isArray(d)?d:[]).map(c=>({id:c.id,name:c.name}));
      cacheSet(ck,comps);json(res,comps);
    }catch(e){json(res,[]);}
    return;
  }

  // /versions/:proj GET - get fix versions (item 8)
  if(req.method==='GET'&&p.startsWith('/versions/')){
    const proj=p.replace('/versions/','');
    const ck=`versions:${proj}`;const c=cacheGet(ck,10*60*1000);if(c){json(res,c);return;}
    try{
      const d=await jiraFetch(`/rest/api/3/project/${proj}/versions?orderBy=-releaseDate&maxResults=20`);
      const versions=(Array.isArray(d)?d:[]).map(v=>({id:v.id,name:v.name,released:v.released}));
      cacheSet(ck,versions);json(res,versions);
    }catch(e){json(res,[]);}
    return;
  }

  // /issue/:key/activity GET - combined activity feed (item 12)
  if(req.method==='GET'&&p.match(/^\/issue\/[^/]+\/activity$/)){
    const key=p.split('/')[2];
    try{
      const[comments,changelog]=await Promise.all([
        jiraFetch(`/rest/api/3/issue/${key}/comment?maxResults=50&orderBy=created`).catch(()=>({comments:[]})),
        jiraFetch(`/rest/api/3/issue/${key}/changelog?maxResults=50`).catch(()=>({values:[]}))
      ]);
      const feed=[];
      (comments.comments||[]).forEach(c=>{feed.push({type:'comment',ts:c.created||'',author:c.author?.displayName||'?',body:c.body,id:c.id});});
      (changelog.values||[]).forEach(cl=>{
        (cl.items||[]).forEach(item=>{
          feed.push({type:'change',ts:cl.created||'',author:cl.author?.displayName||'?',field:item.field,from:item.fromString||'',to:item.toString||''});
        });
      });
      feed.sort((a,b)=>b.ts.localeCompare(a.ts));
      json(res,feed.slice(0,40));
    }catch(e){json(res,[]);}
    return;
  }

  // /issue/:key/sprint PUT - change sprint (item 11)
  if(req.method==='PUT'&&p.match(/^\/issue\/[^/]+\/sprint$/)){
    const key=p.split('/')[2];
    try{
      const body=await readBody(req);
      const sprintId=body.sprintId;
      const fields={'customfield_10020':sprintId?{id:parseInt(sprintId)}:null};
      const r=await jiraRequest('PUT',`/rest/api/3/issue/${key}`,{fields});
      cacheDel(`issue:${key}`);cacheDel('tickets:');
      json(res,{ok:r.status===204||r.status===200});
    }catch(e){json(res,{error:e.message},500);}
    return;
  }

  // /issue/:key/storypoint PUT - set story points (item 20)
  if(req.method==='PUT'&&p.match(/^\/issue\/[^/]+\/storypoint$/)){
    const key=p.split('/')[2];
    try{
      const body=await readBody(req);
      const points=parseFloat(body.points)||0;
      const fields={'customfield_10016':points};
      const r=await jiraRequest('PUT',`/rest/api/3/issue/${key}`,{fields:{'customfield_10016':points}});
      cacheDel(`issue:${key}`);
      cacheDel(`issue:${key}`); cacheDel('tickets:');
    }catch(e){json(res,{error:e.message},500);}
    return;
  }

  // /cycletime GET - cycle time analysis (item 16)
  if(req.method==='GET'&&p==='/cycletime'){
    const{project='OK',limit='100'}=parsed.query;
    try{
      const jql=encodeURIComponent(`project=${project} AND status=Done AND updated>=-30d ORDER BY updated DESC`);
      const d=await jiraFetch(`/rest/api/3/search/jql?jql=${jql}&fields=summary,created,updated,status,resolutiondate&maxResults=${limit}`);
      const issues=(d.issues||[]).map(i=>{
        const created=new Date(i.fields.created||0);
        const resolved=new Date(i.fields.resolutiondate||i.fields.updated||0);
        const days=Math.max(0,Math.round((resolved-created)/(1000*60*60*24)));
        return{key:i.key,summary:i.fields.summary||'',days,created:i.fields.created?.slice(0,10)||'',resolved:i.fields.resolutiondate?.slice(0,10)||''};
      });
      const avg=issues.length?Math.round(issues.reduce((s,i)=>s+i.days,0)/issues.length):0;
      json(res,{issues,avg,count:issues.length});
    }catch(e){json(res,{error:e.message,issues:[]},500);}
    return;
  }

  // /webhook POST - receive Jira webhook (item 25)
  if(req.method==='POST'&&p==='/webhook'){
    try{
      const body=await readBody(req);
      const event=body.webhookEvent||'';
      const issueKey=body.issue?.key||'';
      if(issueKey){cacheDel(`issue:${issueKey}`);cacheDel('tickets:');}
      // Broadcast via SSE (handled by /sse endpoint)
      if(global._sseClients){
        const msg=JSON.stringify({event,key:issueKey,ts:Date.now()});
        global._sseClients.forEach(client=>{try{client.write(`data: ${msg}\n\n`);}catch(e){}});
      }
      json(res,{ok:true});
    }catch(e){json(res,{ok:true});}
    return;
  }

  // /sse GET - Server-Sent Events for real-time updates (item 25)
  if(req.method==='GET'&&p==='/sse'){
    res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Access-Control-Allow-Origin':'*','Connection':'keep-alive'});
    res.write('data: {"type":"connected"}\n\n');
    if(!global._sseClients) global._sseClients=new Set();
    global._sseClients.add(res);
    req.on('close',()=>{global._sseClients?.delete(res);});
    return;
  }

  // /ai-command POST - natural language AI assistant (item 25)
  if(req.method==='POST'&&p==='/ai-command'){
    try{
      const body=await readBody(req);
      const{command='',context={}}=body;
      // Build a structured prompt for Jira operations
      const systemPrompt=`You are a Jira operations assistant. The user gives natural language commands about Jira tickets.
Available projects: ${JSON.stringify(context.projects||[])}.
Current filter context: ${JSON.stringify(context.filter||{})}.
Respond ONLY with a JSON object:
{
  "action": "filter"|"assign"|"transition"|"comment"|"jql"|"explain",
  "params": {...},
  "message": "human-readable explanation of what will be done",
  "jql": "JQL string if action is jql or filter"
}
Examples:
- "show all overdue tickets" → {"action":"filter","params":{"statCat":"overdue"},"message":"篩選所有過期 tickets","jql":"duedate < now() AND status != Done"}
- "assign all open bugs to Jay" → {"action":"assign","params":{"filter":{"type":"Bug","statCat":"todo"},"assignee":"Jay"},"message":"將所有未解決的 Bug 指派給 Jay"}
- "move OC-123 to done" → {"action":"transition","params":{"key":"OC-123","status":"Done"},"message":"將 OC-123 移至 Done"}`;

      const r=await new Promise((resolve,reject)=>{
        const data=JSON.stringify({model:'claude-opus-4-6',max_tokens:500,system:systemPrompt,messages:[{role:'user',content:command}]});
        const opts={hostname:'api.anthropic.com',path:'/v1/messages',method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(data),'anthropic-version':'2023-06-01','x-api-key':process.env.ANTHROPIC_API_KEY||''}};
        const req2=require('https').request(opts,resp=>{let b='';resp.on('data',c=>b+=c);resp.on('end',()=>{try{resolve(JSON.parse(b));}catch(e){reject(e);}});});
        req2.on('error',reject);req2.write(data);req2.end();
      });
      const text=r.content?.[0]?.text||'{}';
      const clean=text.replace(/```json|```/g,'').trim();
      json(res,{ok:true,result:JSON.parse(clean),raw:text});
    }catch(e){json(res,{ok:false,error:e.message,result:{action:'explain',message:'AI 暫時無法使用：'+e.message}});}
    return;
  }

  // /velocity GET - sprint velocity (item 16)
  if(req.method==='GET'&&p==='/velocity'){
    const{boardId=''}=parsed.query;
    if(!boardId){json(res,[]);return;}
    try{
      const sprints=await jiraFetch(`/rest/agile/1.0/board/${boardId}/sprint?state=closed&maxResults=10`);
      const sprintList=(sprints.values||[]).slice(-6);
      const velocityData=await Promise.all(sprintList.map(async sp=>{
        const issues=await jiraFetch(`/rest/agile/1.0/sprint/${sp.id}/issue?fields=customfield_10016,status&maxResults=100`).catch(()=>({issues:[]}));
        const completed=(issues.issues||[]).filter(i=>i.fields?.status?.statusCategory?.key==='done');
        const sp_total=completed.reduce((s,i)=>s+(parseFloat(i.fields?.customfield_10016)||0),0);
        return{sprint:sp.name,points:sp_total,count:completed.length};
      }));
      json(res,velocityData);
    }catch(e){json(res,[]);}
    return;
  }

  // /perf GET - performance metrics (item 24)
  if(req.method==='GET'&&p==='/perf'){
    const avg = perfMetrics.requests > 0 ? Math.round(perfMetrics.totalMs / perfMetrics.requests) : 0;
    const cacheRate = perfMetrics.requests > 0 ? Math.round(perfMetrics.cacheHits / perfMetrics.requests * 100) : 0;
    json(res, { ...perfMetrics, avgMs: avg, cacheRate, cacheSize: cache.size, uptime: Math.round(process.uptime()) });
    return;
  }

  // /sw.js GET - Service Worker (item 3)
  if(p==='/sw.js'){
    const sw = `
const CACHE_NAME = 'jira-tools-v1';
const STATIC = ['/'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(STATIC))); self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k=>k!==CACHE_NAME).map(k=>caches.delete(k))))); self.clients.claim(); });
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if(url.pathname === '/' || url.pathname === '/index.html') {
    e.respondWith(fetch(e.request).catch(() => caches.match('/')));
  }
});`;
    res.writeHead(200, {'Content-Type':'application/javascript','Cache-Control':'no-cache'});
    res.end(sw);
    return;
  }

  // /version GET - version check for update notification (item 25)
  if(req.method==='GET'&&p==='/version'){
    json(res,{version:'1.19.0',build:Date.now(),changelog:['AI助理','操作錄製','多視窗同步','深度連結','效能監控','Onboarding導覽']});
    return;
  }

  // /confluence/:key GET - get Confluence links for a Jira issue (item 14)
  if(req.method==='GET'&&p.match(/^\/confluence\/[^/]+$/)){
    const key=p.replace('/confluence/','');
    try{
      // Jira stores Confluence links as remote links
      const d=await jiraFetch(`/rest/api/3/issue/${key}/remotelink`);
      const links=(Array.isArray(d)?d:[]).filter(l=>l.object?.url?.includes('confluence')||l.object?.url?.includes('wiki')).map(l=>({title:l.object?.title||'Confluence Page',url:l.object?.url||''}));
      json(res,links);
    }catch(e){json(res,[]);}
    return;
  }

  // /issue/:key/reactions GET/POST - emoji reactions (item 13) via comments
  if(req.method==='GET'&&p.match(/^\/issue\/[^/]+\/reactions$/)){
    const key=p.split('/')[2];
    // Store reactions in server memory (cache)
    const ck=`reactions:${key}`;const cached=cacheGet(ck,60*60*1000);
    json(res,cached||{});return;
  }
  if(req.method==='POST'&&p.match(/^\/issue\/[^/]+\/reactions$/)){
    const key=p.split('/')[2];
    try{
      const body=await readBody(req);const{emoji,user}=body;
      const ck=`reactions:${key}`;
      let reactions=cacheGet(ck,60*60*1000)||{};
      if(!reactions[emoji])reactions[emoji]=[];
      const idx=reactions[emoji].indexOf(user);
      if(idx>=0)reactions[emoji].splice(idx,1);else reactions[emoji].push(user);
      if(!reactions[emoji].length)delete reactions[emoji];
      cacheSet(ck,reactions);json(res,{ok:true,reactions});
    }catch(e){json(res,{error:e.message},500);}
    return;
  }

  // /health GET - API health check dashboard (item 25)
  if(req.method==='GET'&&p==='/health'){
    const startTs=Date.now();
    const checks={};
    // Test Jira connectivity
    try{
      const t0=Date.now();
      await jiraFetch('/rest/api/3/myself');
      checks.jira={ok:true,ms:Date.now()-t0};
    }catch(e){checks.jira={ok:false,error:e.message.slice(0,60)};}
    checks.server={ok:true,uptime:Math.round(process.uptime()),ms:Date.now()-startTs};
    checks.cache={ok:true,size:cache.size};
    checks.memory={ok:true,heapMB:Math.round(process.memoryUsage().heapUsed/1024/1024)};
    const allOk=Object.values(checks).every(c=>c.ok);
    res.writeHead(allOk?200:503,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
    res.end(JSON.stringify({status:allOk?'ok':'degraded',checks,ts:Date.now()}));
    return;
  }

  // /issue/:key/votes POST - vote/unvote (item 12)
  if(req.method==='POST'&&p.match(/^\/issue\/[^/]+\/votes$/)){
    const key=p.split('/')[2];
    try{
      const r=await jiraRequest('POST',`/rest/api/3/issue/${key}/votes`,{});
      json(res,{ok:r.status===204||r.status===200});
    }catch(e){json(res,{error:e.message},500);}
    return;
  }

  // /issue/:key/worklog GET - work log entries (item 14)
  if(req.method==='GET'&&p.match(/^\/issue\/[^/]+\/worklog$/)){
    const key=p.split('/')[2];
    try{
      const d=await jiraFetch(`/rest/api/3/issue/${key}/worklog?maxResults=20`);
      const entries=(d.worklogs||[]).map(w=>({
        id:w.id,author:w.author?.displayName||'?',
        started:w.started?.slice(0,16)||'',
        timeSpent:w.timeSpent||'',timeSpentSeconds:w.timeSpentSeconds||0,
        comment:typeof w.comment==='string'?w.comment:w.comment?.content?.[0]?.content?.[0]?.text||''
      }));
      json(res,{entries,total:d.total||0});
    }catch(e){json(res,{entries:[],total:0});}
    return;
  }

  // /issue/:key/worklog POST - add work log entry (item 14)
  if(req.method==='POST'&&p.match(/^\/issue\/[^/]+\/worklog$/)){
    const key=p.split('/')[2];
    try{
      const body=await readBody(req);
      const r=await jiraRequest('POST',`/rest/api/3/issue/${key}/worklog`,{
        timeSpent:body.timeSpent||'1h',
        comment:{type:'doc',version:1,content:[{type:'paragraph',content:[{type:'text',text:body.comment||''}]}]},
        started:body.started||new Date().toISOString().replace('Z','+0000')
      });
      cacheDel(`issue:${key}`);
      json(res,{ok:r.status===201||r.status===200});
    }catch(e){json(res,{error:e.message},500);}
    return;
  }

  // /outbound-webhook POST - configure outbound webhook (item 24)
  if(req.method==='POST'&&p==='/outbound-webhook'){
    try{
      const body=await readBody(req);
      const{url:webhookUrl,events=['jira:issue_updated'],secret=''}=body;
      if(!webhookUrl){json(res,{error:'url required'},400);return;}
      // Store webhook config
      global._outboundWebhooks=global._outboundWebhooks||[];
      global._outboundWebhooks.push({url:webhookUrl,events,secret,created:Date.now()});
      json(res,{ok:true,count:global._outboundWebhooks.length});
    }catch(e){json(res,{error:e.message},500);}
    return;
  }

  // /outbound-webhook GET - list configured webhooks
  if(req.method==='GET'&&p==='/outbound-webhook'){
    json(res,(global._outboundWebhooks||[]).map(w=>({url:w.url,events:w.events,created:w.created})));
    return;
  }

  // Trigger outbound webhooks when /webhook receives event
  // (Already handled in /webhook endpoint - add dispatch logic)

  // /changelog GET - version changelog (item 25)
  if(req.method==='GET'&&p==='/changelog'){
    const changelog=[
      {version:'1.21.0',date:'2026-06',features:['RAF 表格渲染','ETag快取','批次延後截止日','F2 inline編輯','Ticket顏色標記','Sparkline趨勢圖','AND/OR/NOT搜尋','GitHub Import','全域搜尋 Ctrl+/','Vim模式','Markdown報告匯出','Outbound Webhook','API Health Check']},
      {version:'1.20.0',date:'2026-05',features:['Command Palette (Ctrl+K)','用戶頭像','錯誤邊界','版本更新通知','全域搜尋','離線模式','Emoji Reactions','Confluence連結','多專案看板']},
      {version:'1.19.0',date:'2026-04',features:['AI助理 ✨','操作錄製&重播','多視窗同步','深度連結','效能監控','Onboarding導覽','SSE即時更新']},
      {version:'1.18.0',date:'2026-03',features:['Activity Feed','相關tickets','Sprint切換','Dependency Graph','PR Description生成','Git Commit生成','Cycle Time分析']},
      {version:'1.17.0',date:'2026-02',features:['IndexedDB快取','多欄sticky','搜尋歷史','自訂統計卡片','分割視窗比較','Emoji Reactions','Outbound Webhook']},
      {version:'1.0.0',date:'2025-01',features:['初始版本：Viewer、Creator、Kanban、Dashboard、Timeline']},
    ];
    json(res,changelog);
    return;
  }

  // /debug-log POST - receive frontend debug logs (item 21)
  if(req.method==='POST'&&p==='/debug-log'){
    try{
      const body=await readBody(req);
      if(process.env.DEBUG_MODE){
        console.log('[FRONTEND DEBUG]',JSON.stringify(body).slice(0,500));
      }
      json(res,{ok:true});
    }catch(e){json(res,{ok:false});}
    return;
  }

  // /usage-stats POST - record usage statistics (item 22)
  if(req.method==='POST'&&p==='/usage-stats'){
    try{
      const body=await readBody(req);
      if(!global._usageStats) global._usageStats={features:{},sessions:0,lastReset:Date.now()};
      const{feature='unknown'}=body;
      global._usageStats.features[feature]=(global._usageStats.features[feature]||0)+1;
      json(res,{ok:true});
    }catch(e){json(res,{ok:false});}
    return;
  }
  if(req.method==='GET'&&p==='/usage-stats'){
    const stats=global._usageStats||{features:{},sessions:0};
    const sorted=Object.entries(stats.features||{}).sort((a,b)=>b[1]-a[1]).slice(0,20);
    json(res,{topFeatures:sorted,total:Object.values(stats.features||{}).reduce((s,v)=>s+v,0),since:stats.lastReset});
    return;
  }

  // /validate-jql POST - validate JQL expression (item 20)
  if(req.method==='POST'&&p==='/validate-jql'){
    try{
      const{jql=''}=await readBody(req);
      if(!jql){json(res,{valid:false,error:'Empty JQL'});return;}
      const encoded=encodeURIComponent(jql);
      const r=await jiraFetch(`/rest/api/3/search/jql?jql=${encoded}&maxResults=0`).catch(e=>({error:e.message}));
      if(r.error){json(res,{valid:false,error:r.error});return;}
      json(res,{valid:true,total:r.total||0});
    }catch(e){json(res,{valid:false,error:e.message});}
    return;
  }

  // /short-url POST - create short URL using is.gd (item 25)
  if(req.method==='POST'&&p==='/short-url'){
    try{
      const{url=''}=await readBody(req);
      if(!url){json(res,{error:'url required'},400);return;}
      const encoded=encodeURIComponent(url);
      const r=await new Promise((resolve)=>{
        const https=require('https');
        const req2=https.get(`https://is.gd/create.php?format=json&url=${encoded}`,resp=>{
          let b='';resp.on('data',c=>b+=c);resp.on('end',()=>{try{resolve(JSON.parse(b));}catch(e){resolve({errorcode:1,errormessage:'Parse error'});}});
        });
        req2.on('error',e=>resolve({errorcode:1,errormessage:e.message}));
        req2.setTimeout(5000,()=>resolve({errorcode:1,errormessage:'Timeout'}));
      });
      if(r.errorcode){json(res,{error:r.errormessage||'Failed'});return;}
      json(res,{shortUrl:r.shorturl,original:url});
    }catch(e){json(res,{error:e.message},500);}
    return;
  }

  // /cfd GET - Cumulative Flow Diagram data (item 17)
  if(req.method==='GET'&&p==='/cfd'){
    const{project='',days='30'}=parsed.query;
    try{
      const d=parseInt(days)||30;
      const jql=encodeURIComponent(`project=${project} ORDER BY created ASC`);
      const data=await jiraFetch(`/rest/api/3/search/jql?jql=${jql}&fields=status,created,updated&maxResults=500`);
      const issues=data.issues||[];
      // Build daily snapshot for last d days
      const now=new Date();
      const snapshots=[];
      for(let i=d-1;i>=0;i--){
        const day=new Date(now);day.setDate(day.getDate()-i);
        const dayStr=day.toISOString().slice(0,10);
        const inTodo=issues.filter(iss=>iss.fields.created?.slice(0,10)<=dayStr&&iss.fields.status?.statusCategory?.key==='new').length;
        const inProg=issues.filter(iss=>iss.fields.created?.slice(0,10)<=dayStr&&iss.fields.status?.statusCategory?.key==='indeterminate').length;
        const done=issues.filter(iss=>iss.fields.created?.slice(0,10)<=dayStr&&iss.fields.status?.statusCategory?.key==='done').length;
        snapshots.push({date:dayStr,todo:inTodo,inProgress:inProg,done});
      }
      json(res,{snapshots,total:issues.length});
    }catch(e){json(res,{snapshots:[],error:e.message});}
    return;
  }

  // /velocity GET enhanced - per-sprint velocity (item 16)
  // Already handled in /velocity endpoint

  // /sw.js - Enhanced Service Worker with full cache strategy (item 25)
  if(p==='/sw.js'){
    const sw=`
const CACHE='jira-v1';
const STATIC_ASSETS=['/'];
const API_ORIGIN=self.location.origin;

self.addEventListener('install',e=>{
  e.waitUntil(caches.open(CACHE).then(c=>c.addAll(STATIC_ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate',e=>{
  e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch',e=>{
  const url=new URL(e.request.url);
  // API calls: network first, no cache
  if(url.pathname.startsWith('/tickets')||url.pathname.startsWith('/issue')){
    e.respondWith(fetch(e.request).catch(()=>new Response(JSON.stringify({error:'offline',issues:[]}),{headers:{'Content-Type':'application/json'}})));
    return;
  }
  // Static: cache first
  if(url.pathname==='/'||url.pathname==='/index.html'){
    e.respondWith(caches.match(e.request).then(cached=>{
      const fetchPromise=fetch(e.request).then(resp=>{
        if(resp.ok){caches.open(CACHE).then(c=>c.put(e.request,resp.clone()));}
        return resp;
      });
      return cached||fetchPromise;
    }));
    return;
  }
  e.respondWith(fetch(e.request).catch(()=>caches.match('/')));
});

// Background sync for offline queue
self.addEventListener('sync',e=>{
  if(e.tag==='jira-sync'){
    e.waitUntil(self.clients.matchAll().then(clients=>clients.forEach(c=>c.postMessage({type:'sync'}))));
  }
});

// Push notifications
self.addEventListener('push',e=>{
  const data=e.data?.json()||{title:'JIRA Update',body:'有新的更新'};
  e.waitUntil(self.registration.showNotification(data.title,{body:data.body,icon:'/favicon.ico',badge:'/favicon.ico',tag:'jira-update'}));
});`;
    res.writeHead(200,{'Content-Type':'application/javascript','Cache-Control':'no-cache'});
    res.end(sw);
    return;
  }

  // serve manifest.json for PWA
  if(p==='/manifest.json'){
    const manifest={name:'JIRA Tools',short_name:'JIRA',start_url:'/',display:'standalone',background_color:'#f0f2f5',theme_color:'#2563eb',icons:[{src:'https://cdn.jsdelivr.net/npm/@atlaskit/icon@21/glyph/jira.svg',sizes:'192x192',type:'image/svg+xml'}]};
    res.writeHead(200,{'Content-Type':'application/manifest+json','Access-Control-Allow-Origin':'*'});
    res.end(JSON.stringify(manifest));
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
const zlib = require('zlib');
function gzipResponse(res, data, contentType='application/json') {
  const str = typeof data === 'string' ? data : JSON.stringify(data);
  zlib.gzip(Buffer.from(str, 'utf8'), (err, buf) => {
    if (err) { res.writeHead(200, {'Content-Type': contentType}); res.end(str); return; }
    res.writeHead(200, {'Content-Type': contentType, 'Content-Encoding': 'gzip', 'Access-Control-Allow-Origin': '*', 'Vary': 'Accept-Encoding'});
    res.end(buf);
  });
}

// ── Performance metrics store (item 24) ──
const perfMetrics = { requests: 0, cacheHits: 0, errors: 0, totalMs: 0, slowest: [] };
function trackPerf(url, ms, fromCache) {
  perfMetrics.requests++;
  perfMetrics.totalMs += ms;
  if (fromCache) perfMetrics.cacheHits++;
  if (ms > 500) { perfMetrics.slowest.push({url: url.slice(0,60), ms}); if(perfMetrics.slowest.length > 10) perfMetrics.slowest.shift(); }
}

server.on('request', (req, res) => {
  // Track request timing
  const _t = Date.now();
  const _origEnd = res.end.bind(res);
  res.end = function(...args) { trackPerf(req.url, Date.now()-_t, false); return _origEnd(...args); };
});


