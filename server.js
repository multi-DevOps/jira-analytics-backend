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
const ASSIGNED_TO_FIELD = process.env.JIRA_ASSIGNED_TO_FIELD_ID || 'customfield_10544';
const PLANNED_UNPLANNED_FIELD = process.env.JIRA_PLANNED_UNPLANNED_FIELD_ID || 'customfield_10370';
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
        'project', 'priority', 'labels', 'issuetype', ASSIGNED_TO_FIELD, PLANNED_UNPLANNED_FIELD
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

// Helper to calculate Monthly Gap Analytics (Planned vs Unplanned) directly from Jira Cloud
function processMonthlyAnalytics(issues) {
  const projectToCategoryMap = {
    'Bonton Travel ERP': 'Bonton',
    'Bonton Escalation': 'Bonton',
    'Bonton Tech Support': 'Bonton',
    'CSS': 'Bonton',
    'Mobile': 'Mobile',
    'Market Maya': 'MM',
    'ForexERP': 'ForexERP',
    'AI Project': 'AI Project',
    'UIUX': 'UIUX',
    'Devops Works': 'DevOps',
    'OPS': 'DevOps',
    'Planning': 'Bonton'
  };

  const monthsData = {};

  // Group issues into months by updated/created date
  issues.forEach(issue => {
    const fields = issue.fields;
    const dateObj = new Date(fields.updated || fields.created);
    const monthKey = `${dateObj.getFullYear()}-${String(dateObj.getMonth() + 1).padStart(2, '0')}`;

    if (!monthsData[monthKey]) {
      monthsData[monthKey] = {};
    }

    const rawProjName = fields.project?.name || 'Unknown Project';
    const category = projectToCategoryMap[rawProjName] || rawProjName;

    if (!monthsData[monthKey][category]) {
      monthsData[monthKey][category] = {
        project: category,
        jira_projects: new Set(),
        planned_tickets: 0,
        unplanned_tickets: 0,
        planned_total_hr: 0,
        planned_delivery_hr: 0,
        unplanned_total_hr: 0,
        unplanned_delivery_hr: 0
      };
    }

    const projRecord = monthsData[monthKey][category];
    projRecord.jira_projects.add(rawProjName);

    // Planned vs Unplanned classification
    const rawPlannedVal = fields[PLANNED_UNPLANNED_FIELD]?.value || '';
    const labels = fields.labels || [];
    const issueType = fields.issuetype?.name || '';
    
    let isUnplanned = false;
    if (rawPlannedVal) {
      isUnplanned = rawPlannedVal.toLowerCase() === 'unplanned';
    } else {
      isUnplanned = labels.some(l => l.toLowerCase().includes('unplanned') || l.toLowerCase().includes('urgent')) ||
                    ['Bug', 'Incident'].includes(issueType);
    }

    let timeSpentSeconds = fields.timespent || 0;
    if (!timeSpentSeconds && fields.worklog?.worklogs) {
      timeSpentSeconds = fields.worklog.worklogs.reduce((sum, wl) => sum + (wl.timeSpentSeconds || 0), 0);
    }
    const hoursWorked = Math.round((timeSpentSeconds / 3600) * 100) / 100;
    const estHours = Math.round(((fields.timeoriginalestimate || 0) / 3600) * 100) / 100;

    if (isUnplanned) {
      projRecord.unplanned_tickets += 1;
      projRecord.unplanned_delivery_hr += hoursWorked;
      projRecord.unplanned_total_hr += estHours;
    } else {
      projRecord.planned_tickets += 1;
      projRecord.planned_delivery_hr += hoursWorked;
      projRecord.planned_total_hr += estHours;
    }
  });

  // Default baseline capacity fallback (per project) if estimates in Jira are not filled out
  const BASELINE_CAPACITY = {
    'Bonton': { planned: 768.0, unplanned: 192.0 },
    'Mobile': { planned: 384.0, unplanned: 96.0 },
    'MM': { planned: 640.0, unplanned: 160.0 },
    'ForexERP': { planned: 640.0, unplanned: 160.0 },
    'AI Project': { planned: 640.0, unplanned: 160.0 },
    'UIUX': { planned: 384.0, unplanned: 96.0 },
    'DevOps': { planned: 384.0, unplanned: 96.0 }
  };

  const result = {};

  Object.keys(monthsData).forEach(monthKey => {
    const rows = [];
    let totPlannedTickets = 0, totUnplannedTickets = 0;
    let totPlannedTotal = 0, totPlannedDelivery = 0, totPlannedGap = 0;
    let totUnplannedTotal = 0, totUnplannedDelivery = 0, totUnplannedGap = 0;

    // Standard list of categories to always render
    const allCategories = Array.from(new Set([
      ...Object.keys(BASELINE_CAPACITY),
      ...Object.keys(monthsData[monthKey])
    ]));

    allCategories.forEach(cat => {
      const item = monthsData[monthKey][cat] || {
        project: cat,
        jira_projects: new Set([cat]),
        planned_tickets: 0,
        unplanned_tickets: 0,
        planned_total_hr: 0,
        planned_delivery_hr: 0,
        unplanned_total_hr: 0,
        unplanned_delivery_hr: 0
      };

      const baseCap = BASELINE_CAPACITY[cat] || { planned: 160.0, unplanned: 40.0 };
      
      // Use Jira timeoriginalestimate if available; else fall back to baseline target capacity
      const plannedTotal = item.planned_total_hr > 0 ? item.planned_total_hr : baseCap.planned;
      const plannedDelivery = Math.round(item.planned_delivery_hr * 100) / 100;
      const plannedGap = Math.round((plannedTotal - plannedDelivery) * 100) / 100;
      const plannedGapPct = plannedTotal ? Math.round((plannedGap / plannedTotal) * 10000) / 100 : 0;

      const unplannedTotal = item.unplanned_total_hr > 0 ? item.unplanned_total_hr : baseCap.unplanned;
      const unplannedDelivery = Math.round(item.unplanned_delivery_hr * 100) / 100;
      const unplannedGap = Math.round((unplannedTotal - unplannedDelivery) * 100) / 100;
      const unplannedGapPct = unplannedTotal ? Math.round((unplannedGap / unplannedTotal) * 10000) / 100 : 0;

      const totalCap = plannedTotal + unplannedTotal;
      const totalGapHrs = Math.round((plannedGap + unplannedGap) * 100) / 100;
      const totalGapPct = totalCap ? Math.round((totalGapHrs / totalCap) * 10000) / 100 : 0;

      rows.push({
        project: cat,
        planned_tickets: item.planned_tickets,
        planned_total_hr: plannedTotal,
        planned_delivery_hr: plannedDelivery,
        planned_gap_hr: plannedGap,
        planned_gap_pct: plannedGapPct,
        unplanned_tickets: item.unplanned_tickets,
        unplanned_total_hr: unplannedTotal,
        unplanned_delivery_hr: unplannedDelivery,
        unplanned_gap_hr: unplannedGap,
        unplanned_gap_pct: unplannedGapPct,
        gap_hrs: totalGapHrs,
        gap_pct: totalGapPct
      });

      totPlannedTickets += item.planned_tickets;
      totUnplannedTickets += item.unplanned_tickets;
      totPlannedTotal += plannedTotal;
      totPlannedDelivery += plannedDelivery;
      totPlannedGap += plannedGap;
      totUnplannedTotal += unplannedTotal;
      totUnplannedDelivery += unplannedDelivery;
      totUnplannedGap += unplannedGap;
    });

    // Total Row
    const totCap = totPlannedTotal + totUnplannedTotal;
    const totPlannedGapPct = totPlannedTotal ? Math.round((totPlannedGap / totPlannedTotal) * 10000) / 100 : 0;
    const totUnplannedGapPct = totUnplannedTotal ? Math.round((totUnplannedGap / totUnplannedTotal) * 10000) / 100 : 0;
    const overallGapHrs = Math.round((totPlannedGap + totUnplannedGap) * 100) / 100;
    const overallGapPct = totCap ? Math.round((overallGapHrs / totCap) * 10000) / 100 : 0;

    const totalRow = {
      project: 'Total',
      planned_tickets: totPlannedTickets,
      planned_total_hr: Math.round(totPlannedTotal * 100) / 100,
      planned_delivery_hr: Math.round(totPlannedDelivery * 100) / 100,
      planned_gap_hr: Math.round(totPlannedGap * 100) / 100,
      planned_gap_pct: totPlannedGapPct,
      unplanned_tickets: totUnplannedTickets,
      unplanned_total_hr: Math.round(totUnplannedTotal * 100) / 100,
      unplanned_delivery_hr: Math.round(totUnplannedDelivery * 100) / 100,
      unplanned_gap_hr: Math.round(totUnplannedGap * 100) / 100,
      unplanned_gap_pct: totUnplannedGapPct,
      gap_hrs: overallGapHrs,
      gap_pct: overallGapPct
    };

    result[monthKey] = {
      rows,
      total: totalRow
    };
  });

  return result;
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

    const rawPlannedVal = fields[PLANNED_UNPLANNED_FIELD]?.value || '';
    let isUnplanned = false;
    if (rawPlannedVal) {
      isUnplanned = rawPlannedVal.toLowerCase() === 'unplanned';
    } else {
      isUnplanned = labels.some(l => l.toLowerCase().includes('unplanned') || l.toLowerCase().includes('urgent')) ||
                    ['Bug', 'Incident'].includes(issueType);
    }
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

  const monthlyAnalytics = processMonthlyAnalytics(issues);

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
    projects: Object.values(projectMetrics),
    monthly_analytics: monthlyAnalytics
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
