require('dotenv').config();
const fetch = require('node-fetch');

const JIRA_URL = process.env.JIRA_URL.replace(/\/$/, '');
const AUTH = Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64');
const HEADERS = { 'Authorization': `Basic ${AUTH}`, 'Accept': 'application/json', 'Content-Type': 'application/json' };

async function run() {
    console.log("🔍 Fetching issues from PLAN project...");
    const payload = {
        jql: 'project = PLAN ORDER BY updated DESC',
        maxResults: 20,
        fields: [
            'key', 'summary', 'status', 'project', ASSIGNED_TO_FIELD = 'customfield_10544',
            'customfield_10229', 'customfield_10477', 'customfield_10303', 'customfield_10438', 'timeoriginalestimate', 'assignee'
        ]
    };

    const res = await fetch(`${JIRA_URL}/rest/api/3/search/jql`, {
        method: 'POST',
        headers: HEADERS,
        body: JSON.stringify(payload)
    });

    if (!res.ok) {
        console.error("Fetch failed:", await res.text());
        return;
    }

    const data = await res.json();
    console.log(`Found ${data.issues.length} issues in PLAN project:\n`);

    data.issues.forEach(issue => {
        const f = issue.fields;
        console.log(`Ticket ${issue.key}: "${f.summary}"`);
        console.log(`  - Dev Month (10229):`, JSON.stringify(f.customfield_10229));
        console.log(`  - Assigned To (10544):`, JSON.stringify(f.customfield_10544));
        console.log(`  - Assignee:`, f.assignee ? f.assignee.displayName : 'None');
        console.log(`  - Rough Est 10477:`, f.customfield_10477);
        console.log(`  - Rough Est 10303:`, f.customfield_10303);
        console.log(`  - Dev Hours 10438:`, f.customfield_10438);
        console.log(`  - Time Original Est:`, f.timeoriginalestimate);
        console.log('--------------------------------------------------');
    });
}

run();
