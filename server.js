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

// Generic GET to Jira
function jiraGet(apiPath, res) {
  const options = {
    hostname: JIRA_DOMAIN, path: apiPath, method: 'GET',
    headers: { 'Authorization': 'Basic ' + AUTH, 'Accept': 'application/json' }
  };
  const req = https.request(options, (r) => {
    let body = '';
    r.on('data', chunk => body += chunk);
    r.on('end', () => {
      res.writeHead(r.statusCode, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(body);
    });
  });
  req.on('error', (e) => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  });
  req.end();
}

// Generic POST to Jira
function jiraPost(apiPath, body, res) {
  const data = JSON.stringify(body);
  const options = {
    hostname: JIRA_DOMAIN, path: apiPath, method: 'POST',
    headers: {
      'Authorization': 'Basic ' + AUTH,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(data)
    }
  };
  const req = https.request(options, (r) => {
    let respBody = '';
    r.on('data', chunk => respBody += chunk);
    r.on('end', () => {
      res.writeHead(r.statusCode, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(respBody);
    });
  });
  req.on('error', (e) => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  });
  req.write(data);
  req.end();
}

// Read request body
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch(e) { reject(e); } });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // GET /tickets
  if (req.method === 'GET' && parsed.pathname === '/tickets') {
    const project   = parsed.query.project || 'OK';
    const pageToken = parsed.query.pageToken || '';
    const jql       = encodeURIComponent(`project=${project} ORDER BY key ASC`);
    const fields    = 'summary,status,priority,assignee,issuetype,updated,duedate';
    let apiPath     = `/rest/api/3/search/jql?jql=${jql}&fields=${fields}&maxResults=100`;
    if (pageToken) apiPath += `&nextPageToken=${encodeURIComponent(pageToken)}`;
    jiraGet(apiPath, res);
    return;
  }

  // GET /projects — list all accessible projects
  if (req.method === 'GET' && parsed.pathname === '/projects') {
    const options = {
      hostname: JIRA_DOMAIN,
      path: '/rest/api/3/project?maxResults=100&orderBy=name',
      method: 'GET',
      headers: { 'Authorization': 'Basic ' + AUTH, 'Accept': 'application/json' }
    };
    const apiReq = https.request(options, (r) => {
      let body = '';
      r.on('data', chunk => body += chunk);
      r.on('end', () => {
        try {
          const data = JSON.parse(body);
          const projects = (Array.isArray(data) ? data : (data.values || [])).map(p => ({
            key: p.key, name: p.name, id: p.id
          }));
          res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify(projects));
        } catch(e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
    });
    apiReq.on('error', (e) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    });
    apiReq.end();
    return;
  }

  // GET /meta?project=OK — get issue types, priorities, assignable users
  if (req.method === 'GET' && parsed.pathname === '/meta') {
    const project = parsed.query.project || 'OK';

    // Helper to fetch all assignees with pagination
    async function fetchAllAssignees(project) {
      let all = [], startAt = 0, maxResults = 50;
      while(true) {
        const data = await new Promise(resolve => {
          const opts = {
            hostname: JIRA_DOMAIN,
            path: `/rest/api/3/user/assignable/search?project=${project}&maxResults=${maxResults}&startAt=${startAt}`,
            method: 'GET',
            headers: { 'Authorization': 'Basic ' + AUTH, 'Accept': 'application/json' }
          };
          const r = https.request(opts, resp => {
            let b=''; resp.on('data',c=>b+=c);
            resp.on('end',()=>{ try{resolve(JSON.parse(b))}catch(e){resolve([])} });
          });
          r.on('error', () => resolve([])); r.end();
        });
        const arr = Array.isArray(data) ? data : [];
        all = all.concat(arr);
        if(arr.length < maxResults) break;
        startAt += maxResults;
        if(startAt > 500) break; // safety cap
      }
      return all;
    }

    const fetch3 = [
      new Promise(resolve => {
        const opts = {
          hostname: JIRA_DOMAIN,
          path: `/rest/api/3/issue/createmeta?projectKeys=${project}&expand=projects.issuetypes`,
          method: 'GET',
          headers: { 'Authorization': 'Basic ' + AUTH, 'Accept': 'application/json' }
        };
        const r = https.request(opts, resp => {
          let b=''; resp.on('data',c=>b+=c); resp.on('end',()=>{ try{resolve(JSON.parse(b))}catch(e){resolve({})} });
        });
        r.on('error', () => resolve({})); r.end();
      }),
      new Promise(resolve => {
        const opts = {
          hostname: JIRA_DOMAIN, path: `/rest/api/3/priority`,
          method: 'GET',
          headers: { 'Authorization': 'Basic ' + AUTH, 'Accept': 'application/json' }
        };
        const r = https.request(opts, resp => {
          let b=''; resp.on('data',c=>b+=c); resp.on('end',()=>{ try{resolve(JSON.parse(b))}catch(e){resolve([])} });
        });
        r.on('error', () => resolve([])); r.end();
      }),
      fetchAllAssignees(project)
    ];

    const [meta, prios, assignees] = await Promise.all(fetch3);
    const proj = (meta.projects || [])[0] || {};
    const sort = (arr, key) => [...arr].sort((a,b) => a[key].localeCompare(b[key]));
    const result = {
      issueTypes: sort((proj.issuetypes || []).map(t => ({ id: t.id, name: t.name })), 'name'),
      priorities: (Array.isArray(prios) ? prios : []).map(p => ({ id: p.id, name: p.name })),
      assignees:  sort((Array.isArray(assignees) ? assignees : []).map(u => ({ accountId: u.accountId, displayName: u.displayName })), 'displayName')
    };
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(result));
    return;
  }

  // GET /boards?project=OK — get boards for a project
  if (req.method === 'GET' && parsed.pathname === '/boards') {
    const project = parsed.query.project || 'OK';
    const opts = {
      hostname: JIRA_DOMAIN,
      path: `/rest/agile/1.0/board?projectKeyOrId=${project}&maxResults=50`,
      method: 'GET',
      headers: { 'Authorization': 'Basic ' + AUTH, 'Accept': 'application/json' }
    };
    const apiReq = https.request(opts, (r) => {
      let body = '';
      r.on('data', chunk => body += chunk);
      r.on('end', () => {
        try {
          const data = JSON.parse(body);
          const boards = (data.values || []).map(b => ({ id: b.id, name: b.name, type: b.type }))
            .sort((a,b) => a.name.localeCompare(b.name));
          res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify(boards));
        } catch(e) {
          res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify([]));
        }
      });
    });
    apiReq.on('error', () => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify([]));
    });
    apiReq.end();
    return;
  }

  // GET /epics?project=OK — get epics for a project
  if (req.method === 'GET' && parsed.pathname === '/epics') {
    const project = parsed.query.project || 'OK';
    const jql = encodeURIComponent(`project=${project} AND issuetype=Epic ORDER BY summary ASC`);
    const opts = {
      hostname: JIRA_DOMAIN,
      path: `/rest/api/3/search/jql?jql=${jql}&fields=summary,status&maxResults=100`,
      method: 'GET',
      headers: { 'Authorization': 'Basic ' + AUTH, 'Accept': 'application/json' }
    };
    const apiReq = https.request(opts, (r) => {
      let body = '';
      r.on('data', chunk => body += chunk);
      r.on('end', () => {
        try {
          const data = JSON.parse(body);
          const epics = (data.issues || []).map(i => ({ key: i.key, summary: i.fields.summary || i.key }))
            .sort((a,b) => a.summary.localeCompare(b.summary));
          res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify(epics));
        } catch(e) {
          res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify([]));
        }
      });
    });
    apiReq.on('error', () => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify([]));
    });
    apiReq.end();
    return;
  }

  // POST /create-batch — create multiple Jira issues
  if (req.method === 'POST' && parsed.pathname === '/create-batch') {
    try {
      const body = await readBody(req);
      const { issues } = body;
      if (!Array.isArray(issues) || issues.length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No issues provided' }));
        return;
      }

      const issueList = issues.map(({ project, summary, description, issueType, priority, assignee, duedate, epic }) => {
        const fields = {
          project:   { key: project || 'OK' },
          summary:   summary,
          issuetype: { id: issueType },
        };
        if (priority)    fields.priority  = { id: priority };
        if (description) fields.description = {
          type: 'doc', version: 1,
          content: [{ type: 'paragraph', content: [{ type: 'text', text: description }] }]
        };
        if (assignee) fields.assignee = { accountId: assignee };
        if (duedate)  fields.duedate  = duedate;
        if (epic)     fields['customfield_10014'] = epic; // Epic Link field
        return { fields };
      });

      const data = JSON.stringify({ issueUpdates: issueList });
      const options = {
        hostname: JIRA_DOMAIN,
        path: '/rest/api/3/issue/bulk',
        method: 'POST',
        headers: {
          'Authorization': 'Basic ' + AUTH,
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data)
        }
      };
      const apiReq = https.request(options, (r) => {
        let respBody = '';
        r.on('data', chunk => respBody += chunk);
        r.on('end', () => {
          res.writeHead(r.statusCode, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(respBody);
        });
      });
      apiReq.on('error', (e) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      });
      apiReq.write(data);
      apiReq.end();
    } catch(e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  if (req.method === 'POST' && parsed.pathname === '/create') {
    try {
      const body = await readBody(req);
      const { project, summary, description, issueType, priority, assignee, duedate } = body;

      const fields = {
        project:   { key: project || 'OK' },
        summary:   summary,
        issuetype: { id: issueType },
        priority:  { id: priority },
      };
      if (description) fields.description = {
        type: 'doc', version: 1,
        content: [{ type: 'paragraph', content: [{ type: 'text', text: description }] }]
      };
      if (assignee)  fields.assignee = { accountId: assignee };
      if (duedate)   fields.duedate  = duedate;

      jiraPost('/rest/api/3/issue', { fields }, res);
    } catch(e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Serve index.html
  if (parsed.pathname === '/' || parsed.pathname === '/index.html') {
    const filePath = path.join(__dirname, 'index.html');
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }

  // Serve create.html
  if (parsed.pathname === '/create.html') {
    const filePath = path.join(__dirname, 'create.html');
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => console.log(`✅ Jira Viewer running on port ${PORT}`));
