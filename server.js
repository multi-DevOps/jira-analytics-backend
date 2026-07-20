// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const teamsConfig = require('./teamsConfig');

const app = express();
app.use(cors());
app.use(express.json());

const JIRA_URL = process.env.JIRA_URL.replace(/\/$/, '');
const JIRA_EMAIL = process.env.JIRA_EMAIL;
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN;
const ASSIGNED_TO_FIELD = process.env.JIRA_ASSIGNED_TO_FIELD_ID || 'customfield_10025';
const PORT = process.env.PORT || 3001;

function encodeCredentials() {
  return Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString('base64');
}

// Bulk fetch ALL relevant Jira issues with cursor pagination (No tickets missed)
async function fetchAllJiraIssues(days = 365) {
  // Expanded to 90 days and including unclosed or active issues to prevent missing anything
  const jql = `updated >= -${days}d ORDER BY updated DESC`;
  const url = `${JIRA_URL}/rest/api/3/search/jql`;
  
  let allIssues = [];
  let nextPageToken = null; 
  const maxResults = 100;
  let hasMore = true;

  console.log(`\n🔍 Bulk fetching ALL Jira issues from board...`);

  while (hasMore) {
    const payload = {
      jql,
      maxResults,
      fields: [
        'key', 'summary', 'status', 'created', 'updated', 'duedate',
        'timespent', 'timeoriginalestimate', 'worklog',
        'project', 'priority', 'labels', 'issuetype', ASSIGNED_TO_FIELD
      ]
    };

    if (nextPageToken) {
      payload.nextPageToken = nextPageToken;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${encodeCredentials()}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Jira API HTTP ${response.status}: ${err}`);
    }

    const data = await response.json();
    const issues = data.issues || [];
    allIssues = allIssues.concat(issues);
    
    if (data.nextPageToken) {
      nextPageToken = data.nextPageToken;
    } else {
      hasMore = false;
    }
  }

  console.log(`✅ Total issues loaded into memory: ${allIssues.length}`);
  return allIssues;
}

// Comprehensive Metrics Processing
function processJiraAnalytics(issues) {
  const now = new Date();

  const developerMetrics = {};
  const projectMetrics = {};
  const teamMetrics = {};

  // 1. Initialize all 32 developers from teamsConfig
  Object.keys(teamsConfig).forEach(teamName => {
    teamsConfig[teamName].forEach(devName => {
      if (!developerMetrics[devName]) {
        developerMetrics[devName] = {
          name: devName,
          total_tickets: 0,
          closed_tickets: 0,
          total_seconds_worked: 0,
          total_hours_worked: 0,
          escalations_handled: 0,
          delayed_tickets: 0,
          planned_tasks: 0,
          unplanned_tasks: 0,
          issues_list: []
        };
      }
    });

    teamMetrics[teamName] = {
      team_name: teamName,
      members: teamsConfig[teamName],
      total_tickets: 0,
      closed_tickets: 0,
      total_hours_worked: 0,
      escalations: 0,
      delayed_tickets: 0,
      planned_tasks: 0,
      unplanned_tasks: 0,
    };
  });

  let totalEscalationsGlobal = 0;
  let totalHoursGlobal = 0;

  // 2. Map every issue accurately
  issues.forEach(issue => {
    const fields = issue.fields;
    
    const customFieldVal = fields[ASSIGNED_TO_FIELD];
    let devName = 'Unassigned';
    
    if (typeof customFieldVal === 'string') {
      devName = customFieldVal.trim();
    } else if (customFieldVal && typeof customFieldVal === 'object') {
      devName = (customFieldVal.value || customFieldVal.displayName || 'Unassigned').trim();
    }

    if (!developerMetrics[devName]) {
      developerMetrics[devName] = {
        name: devName,
        total_tickets: 0,
        closed_tickets: 0,
        total_seconds_worked: 0,
        total_hours_worked: 0,
        escalations_handled: 0,
        delayed_tickets: 0,
        planned_tasks: 0,
        unplanned_tasks: 0,
        issues_list: []
      };
    }

    const devRecord = developerMetrics[devName];

    // Accurate worklog calculation
    let timeSpentSeconds = fields.timespent || 0;
    if (!timeSpentSeconds && fields.worklog?.worklogs) {
      timeSpentSeconds = fields.worklog.worklogs.reduce((sum, wl) => sum + (wl.timeSpentSeconds || 0), 0);
    }
    const hoursWorked = Math.round((timeSpentSeconds / 3600) * 10) / 10;

    const status = fields.status?.name || 'Unknown';
    const isClosed = ['Done', 'Closed', 'Resolved'].includes(status);

    const labels = fields.labels || [];
    const issueType = fields.issuetype?.name || '';
    const priority = fields.priority?.name || '';
    
    const isEscalation = labels.some(l => l.toLowerCase().includes('escalat')) || 
                         issueType.toLowerCase().includes('escalat') ||
                         ['Highest', 'Urgent'].includes(priority);

    let isDelayed = false;
    if (fields.duedate) {
      const dueDate = new Date(fields.duedate);
      if (!isClosed && now > dueDate) {
        isDelayed = true;
      } else if (isClosed && fields.updated) {
        const closedDate = new Date(fields.updated);
        if (closedDate > dueDate) isDelayed = true;
      }
    }

    const isUnplanned = labels.some(l => l.toLowerCase().includes('unplanned') || l.toLowerCase().includes('urgent')) ||
                        ['Bug', 'Incident'].includes(issueType);
    const classification = isUnplanned ? 'unplanned' : 'planned';

    devRecord.total_tickets += 1;
    if (isClosed) devRecord.closed_tickets += 1;
    devRecord.total_seconds_worked += timeSpentSeconds;
    devRecord.total_hours_worked = Math.round((devRecord.total_seconds_worked / 3600) * 10) / 10;
    if (isEscalation) devRecord.escalations_handled += 1;
    if (isDelayed) devRecord.delayed_tickets += 1;
    if (isUnplanned) devRecord.unplanned_tasks += 1;
    else devRecord.planned_tasks += 1;

    devRecord.issues_list.push({
      key: issue.key,
      summary: fields.summary || '',
      status,
      project: fields.project?.name || 'Unknown',
      priority,
      issueType,
      hours_worked: hoursWorked,
      due_date: fields.duedate || 'No Due Date',
      is_delayed: isDelayed,
      is_escalation: isEscalation,
      classification
    });

    const projectName = fields.project?.name || 'Unknown Project';
    if (!projectMetrics[projectName]) {
      projectMetrics[projectName] = {
        project_name: projectName,
        total_tickets: 0,
        delayed_tickets: 0,
        total_hours_worked: 0,
        escalations: 0
      };
    }
    projectMetrics[projectName].total_tickets += 1;
    if (isDelayed) projectMetrics[projectName].delayed_tickets += 1;
    projectMetrics[projectName].total_hours_worked = Math.round((projectMetrics[projectName].total_hours_worked + hoursWorked) * 10) / 10;
    if (isEscalation) projectMetrics[projectName].escalations += 1;

    if (isEscalation) totalEscalationsGlobal += 1;
    totalHoursGlobal += hoursWorked;
  });

  // 3. Team aggregates
  Object.keys(teamsConfig).forEach(teamName => {
    const members = teamsConfig[teamName];
    const team = teamMetrics[teamName];

    members.forEach(memberName => {
      const dev = developerMetrics[memberName];
      if (dev) {
        team.total_tickets += dev.total_tickets;
        team.closed_tickets += dev.closed_tickets;
        team.total_hours_worked = Math.round((team.total_hours_worked + dev.total_hours_worked) * 10) / 10;
        team.escalations += dev.escalations_handled;
        team.delayed_tickets += dev.delayed_tickets;
        team.planned_tasks += dev.planned_tasks;
        team.unplanned_tasks += dev.unplanned_tasks;
      }
    });
  });

  return {
    generated_at: new Date().toISOString(),
    teams_config: teamsConfig,
    summary: {
      total_issues_analyzed: issues.length,
      total_hours_worked: Math.round(totalHoursGlobal * 10) / 10,
      total_escalations: totalEscalationsGlobal,
      total_developers: Object.keys(developerMetrics).length
    },
    developers: Object.values(developerMetrics),
    teams: Object.values(teamMetrics),
    projects: Object.values(projectMetrics)
  };
}

app.get('/api/data', async (req, res) => {
  try {
    const issues = await fetchAllJiraIssues();
    const analytics = processJiraAnalytics(issues);
    res.json(analytics);
  } catch (error) {
    console.error('❌ Error processing analytics:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`\n🚀 Advanced Jira Analytics Backend running on port ${PORT}`);
});
