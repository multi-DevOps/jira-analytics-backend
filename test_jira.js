require('dotenv').config();
const https = require('https');
const data = JSON.stringify({
  jql: 'project="PLAN"',
  maxResults: 2,
  fields: ['customfield_10544', 'assignee']
});
const options = {
  hostname: 'multiicon.atlassian.net',
  port: 443,
  path: '/rest/api/3/search/jql',
  method: 'POST',
  headers: {
    'Authorization': 'Basic ' + Buffer.from('techinical27.multiicon@gmail.com:' + process.env.JIRA_API_TOKEN).toString('base64'),
    'Content-Type': 'application/json',
    'Content-Length': data.length
  }
};
const req = https.request(options, res => {
  let resData = '';
  res.on('data', chunk => resData += chunk);
  res.on('end', () => {
    const d = JSON.parse(resData);
    if(d.issues) {
      d.issues.forEach(i => console.log(i.key, JSON.stringify(i.fields.customfield_10544)));
    } else {
      console.log(d);
    }
  });
});
req.write(data);
req.end();
