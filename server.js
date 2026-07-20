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

// Bulk fetch Jira issues with pagination
async function fetchAllJiraIssues(days = 30) {
  const jql = `updated >= -${days}d ORDER BY updated DESC`;
  const url = `${JIRA_URL}/rest/api/3/search/jql`;
  
  let allIssues = [];
  let nextPageToken = null; 
  const maxResults = 100;
  let hasMore = true;

  console.log(`\n🔍 Bulk fetching Jira issues for the last ${days} days...`);

  while (hasMore) {
    // Construct valid payload without the deprecated "startAt" property
    const payload = {
      jql,
      maxResults,
      fields: [
        'key', 'summary', 'status', 'created', 'updated', 'duedate',
        'timespent', 'timeoriginalestimate', 'worklog',
        'project', 'priority', 'labels', 'issuetype', ASSIGNED_TO_FIELD
      ]
    };

    // Attach nextPageToken only if it's not the first request
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
    
    // Check if Jira returned a token for another page of results
    if (data.nextPageToken) {
      nextPageToken = data.nextPageToken;
    } else {
      hasMore = false;
    }
  }

  console.log(`✅ Total issues fetched: ${allIssues.length}`);
  return allIssues;
}

// Calculate All Comprehensive Metrics
function processJiraAnalytics(issues, days = 30) {
  const now = new Date();

  const developerMetrics = {};
  const projectMetrics = {};
  const teamMetrics = {};

  // Initialize Team Metrics structure
  Object.keys(teamsConfig).forEach(teamName => {
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

  issues.forEach(issue => {
    const fields = issue.fields;
    
    // 1. Extract Dev Name from Custom Field ("Assigned To")
    const customFieldVal = fields[ASSIGNED_TO_FIELD];
    let devName = 'Unassigned';
    
    if (typeof customFieldVal === 'string') {
      devName = customFieldVal;
    } else if (customFieldVal && typeof customFieldVal === 'object') {
      devName = customFieldVal.value || customFieldVal.displayName || 'Unassigned';
    }

    // Initialize dev record if not exists
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

    // 2. Worklog / Time Worked Calculation
    let timeSpentSeconds = fields.timespent || 0;
    if (!timeSpentSeconds && fields.worklog?.worklogs) {
      timeSpentSeconds = fields.worklog.worklogs.reduce((sum, wl) => sum + (wl.timeSpentSeconds || 0), 0);
    }
    const hoursWorked = Math.round((timeSpentSeconds / 3600) * 10) / 10;

    // 3. Status & Closure
    const status = fields.status?.name || 'Unknown';
    const isClosed = ['Done', 'Closed', 'Resolved'].includes(status);

    // 4. Escalation Detection (Label, IssueType, or High Priority)
    const labels = fields.labels || [];
    const issueType = fields.issuetype?.name || '';
    const priority = fields.priority?.name || '';
    
    const isEscalation = labels.some(l => l.toLowerCase().includes('escalat')) || 
                         issueType.toLowerCase().includes('escalat') ||
                         ['Highest', 'Urgent'].includes(priority);

    // 5. Delayed Ticket Calculation (DueDate passed and not closed / resolved late)
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

    // 6. Planned vs Unplanned
    const isUnplanned = labels.some(l => l.toLowerCase().includes('unplanned') || l.toLowerCase().includes('urgent')) ||
                        ['Bug', 'Incident'].includes(issueType);
    const classification = isUnplanned ? 'unplanned' : 'planned';

    // Update Developer Aggregation
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

    // Project-wise Aggregation
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

    // Global Totals
    if (isEscalation) totalEscalationsGlobal += 1;
    totalHoursGlobal += hoursWorked;
  });

  // Map Developer Metrics into Team Metrics
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

// Main Data Route
app.get('/api/data', async (req, res) => {
  try {
    const days = parseInt(req.query.days || '30');
    const issues = await fetchAllJiraIssues(days);
    const analytics = processJiraAnalytics(issues, days);
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
