require('dotenv').config();
const fetch = require('node-fetch');

const JIRA_URL = process.env.JIRA_URL.replace(/\/$/, '');
const AUTH = Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64');
const HEADERS = { 'Authorization': `Basic ${AUTH}`, 'Accept': 'application/json', 'Content-Type': 'application/json' };

async function run() {
    console.log("🔍 Fetching all Jira fields to locate 'Rough Estimated Hours' and 'Assigned To'...");
    const res = await fetch(`${JIRA_URL}/rest/api/3/field`, { headers: HEADERS });
    if (!res.ok) {
        console.error("Failed to fetch fields:", await res.text());
        return;
    }

    const fields = await res.json();
    console.log(`Total fields in Jira: ${fields.length}`);

    const matchingFields = fields.filter(f => 
        f.name.toLowerCase().includes('rough') || 
        f.name.toLowerCase().includes('estimate') ||
        f.name.toLowerCase().includes('assigned') ||
        f.name.toLowerCase().includes('development month') ||
        f.name.toLowerCase().includes('dev month')
    );

    console.log("\nMatching Fields:");
    matchingFields.forEach(f => {
        console.log(`- Name: "${f.name}", ID: ${f.id}, Schema:`, f.schema ? f.schema.type : 'none');
    });
}

run();
