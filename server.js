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

function jiraRequest(apiPath, res) {
  const options = {
    hostname: JIRA_DOMAIN,
    path: apiPath,
    method: 'GET',
    headers: {
      'Authorization': 'Basic ' + AUTH,
      'Accept': 'application/json'
    }
  };
  const req = https.request(options, (r) => {
    let body = '';
    r.on('data', chunk => body += chunk);
    r.on('end', () => {
      res.writeHead(r.statusCode, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(body);
    });
  });
  req.on('error', (e) => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  });
  req.end();
}

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // GET /tickets?project=OK&pageToken=xxx
  if (parsed.pathname === '/tickets') {
    const project   = parsed.query.project || 'OK';
    const pageToken = parsed.query.pageToken || '';
    const jql       = encodeURIComponent(`project=${project} ORDER BY key ASC`);
    const fields    = 'summary,status,priority,assignee,issuetype,updated,duedate';
    let apiPath     = `/rest/api/3/search/jql?jql=${jql}&fields=${fields}&maxResults=100`;
    if (pageToken) apiPath += `&nextPageToken=${encodeURIComponent(pageToken)}`;
    jiraRequest(apiPath, res);
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

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => console.log(`✅ Jira Viewer running on port ${PORT}`));
