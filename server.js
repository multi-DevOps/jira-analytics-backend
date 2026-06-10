require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

const JIRA_URL = process.env.JIRA_URL.replace(/\/$/, '');
const JIRA_EMAIL = process.env.JIRA_EMAIL;
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN;
const PORT = process.env.PORT || 3001;

console.log('\n🔧 Configuration:');
console.log(`   JIRA_URL: ${JIRA_URL}`);
console.log(`   JIRA_EMAIL: ${JIRA_EMAIL}`);
console.log(`   PORT: ${PORT}\n`);

// Helper function to encode credentials
function encodeCredentials() {
  const credentials = `${JIRA_EMAIL}:${JIRA_API_TOKEN}`;
  return Buffer.from(credentials).toString('base64');
}

// Helper function to make API requests - FIXED VERSION
async function makeRequest(endpoint, params = {}, retries = 3) {
  const url = `${JIRA_URL}/rest/api/3/${endpoint}`;

  const headers = {
    'Authorization': `Basic ${encodeCredentials()}`,
    'Accept': 'application/json',
    'Content-Type': 'application/json'
  };

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      let response;
      
      // Search endpoint uses POST with JQL in body
      if (endpoint === 'search' || endpoint.includes('search/jql')) {
        console.log(`   📤 POST to ${endpoint}`);
        console.log(`   📋 JQL: ${params.jql}`);
        
        response = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(params),
          timeout: 30000
        });
      } else {
        // Other endpoints use GET with query params
        const queryString = new URLSearchParams(params).toString();
        const fullUrl = queryString ? `${url}?${queryString}` : url;
        console.log(`   🔍 GET ${endpoint}`);
        
        response = await fetch(fullUrl, {
          method: 'GET',
          headers,
          timeout: 30000
        });
      }

      if (!response.ok) {
        const errText = await response.text();
        console.log(`   ❌ HTTP ${response.status}: ${errText.substring(0, 100)}`);
        
        if (response.status === 401 || response.status === 403) {
          throw new Error(`Authentication failed (${response.status}) - Check credentials`);
        }
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();
      console.log(`   ✅ Got ${data.issues?.length || 0} issues`);
      return data;
      
    } catch (error) {
      console.log(`   ⚠️  Attempt ${attempt + 1} failed: ${error.message}`);
      if (attempt < retries - 1) {
        const waitTime = Math.pow(2, attempt) * 1000;
        console.log(`   ⏳ Waiting ${waitTime}ms before retry...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
      } else {
        throw error;
      }
    }
  }
}

// Get users from recent issues
async function getUsersFromIssues(days = 7) {
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);
  const dateStr = startDate.toISOString().split('T')[0];

  // Correct JQL format - no quotes around date
  const jql = `updated >= ${dateStr}`;
  
  const params = {
    jql,
    maxResults: 100,
    fields: ['assignee']
  };

  try {
    console.log(`\n🔍 Getting users from issues updated since ${dateStr}...`);
    const data = await makeRequest('search/jql', params);

    const users = {};
    for (const issue of data.issues || []) {
      const assignee = issue.fields?.assignee;
      if (assignee?.accountId) {
        const userId = assignee.accountId;
        if (!users[userId]) {
          users[userId] = {
            accountId: userId,
            displayName: assignee.displayName || 'Unknown',
            active: true
          };
        }
      }
    }

    const userList = Object.values(users);
    console.log(`✅ Found ${userList.length} unique users\n`);
    return userList;
    
  } catch (error) {
    console.error('❌ Error getting users:', error.message);
    return [];
  }
}

// Get issues for a user
async function getUserIssues(userKey, userName, days = 7) {
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);
  const dateStr = startDate.toISOString().split('T')[0];

  // Correct JQL format - use = for exact match, no quotes
  const jql = `assignee = ${userKey} AND updated >= ${dateStr} ORDER BY updated DESC`;
  
  const params = {
    jql,
    maxResults: 100,
    fields: [
      'key', 'summary', 'status', 'created', 'updated', 'timetracking',
      'project', 'priority', 'labels', 'issuetype'
    ]
  };

  try {
    const data = await makeRequest('search/jql', params);
    console.log(`   📊 ${userName}: ${data.issues?.length || 0} issues`);
    return data.issues || [];
  } catch (error) {
    console.error(`❌ Error getting issues for ${userName}:`, error.message);
    return [];
  }
}

// Classify task as planned or unplanned
function classifyTask(issue, labels = []) {
  const issueLabels = labels || issue.fields?.labels || [];
  
  for (const label of issueLabels) {
    if (label.toLowerCase().includes('planned')) return 'planned';
    if (label.toLowerCase().includes('unplanned') || label.toLowerCase().includes('urgent')) {
      return 'unplanned';
    }
  }

  const issueType = issue.fields?.issuetype?.name || '';
  if (['Bug', 'Incident'].includes(issueType)) return 'unplanned';

  return 'planned';
}

// Calculate developer metrics
async function calculateDeveloperMetrics(userKey, userName, days = 7) {
  const issues = await getUserIssues(userKey, userName, days);

  const metrics = {
    user: userName,
    user_key: userKey,
    period_days: days,
    assigned_tasks: issues.length,
    closed_tasks: 0,
    planned_tasks: 0,
    unplanned_tasks: 0,
    delivered_tasks: 0,
    delivery_percentage: 0,
    average_resolution_time: 0,
    status_breakdown: {},
    issues_by_priority: {},
    issues_detail: []
  };

  const resolutionTimes = [];

  for (const issue of issues) {
    const fields = issue.fields;
    const status = fields.status?.name || 'Unknown';
    const priority = fields.priority?.name || 'Medium';
    const labels = fields.labels || [];

    metrics.status_breakdown[status] = (metrics.status_breakdown[status] || 0) + 1;
    metrics.issues_by_priority[priority] = (metrics.issues_by_priority[priority] || 0) + 1;

    if (['Done', 'Closed', 'Resolved'].includes(status)) {
      metrics.closed_tasks++;
      metrics.delivered_tasks++;

      const created = fields.created;
      const updated = fields.updated;
      if (created && updated) {
        const createdDate = new Date(created);
        const updatedDate = new Date(updated);
        const daysElapsed = Math.floor((updatedDate - createdDate) / (1000 * 60 * 60 * 24));
        resolutionTimes.push(daysElapsed);
      }
    }

    const classification = classifyTask(issue, labels);
    if (classification === 'planned') {
      metrics.planned_tasks++;
    } else {
      metrics.unplanned_tasks++;
    }

    metrics.issues_detail.push({
      key: issue.key,
      summary: fields.summary || '',
      status,
      priority,
      type: fields.issuetype?.name || '',
      created: fields.created,
      updated: fields.updated,
      classification
    });
  }

  if (metrics.assigned_tasks > 0) {
    metrics.delivery_percentage = Math.round((metrics.delivered_tasks / metrics.assigned_tasks) * 1000) / 10;
  }

  if (resolutionTimes.length > 0) {
    metrics.average_resolution_time = 
      Math.round((resolutionTimes.reduce((a, b) => a + b, 0) / resolutionTimes.length) * 10) / 10;
  }

  return metrics;
}

// Get team metrics
async function getTeamMetrics(days = 7) {
  console.log('\n👥 Calculating team metrics...');
  const users = await getUsersFromIssues(days);

  const teamMetrics = {
    total_developers: users.length,
    team_velocity: 0,
    sprint_success_rate: 0,
    planned_vs_unplanned: { planned: 0, unplanned: 0 },
    capacity_utilization: 0,
    developers: []
  };

  let totalClosed = 0;
  let totalAssigned = 0;
  let totalPlanned = 0;
  let totalUnplanned = 0;

  for (const user of users) {
    const devMetrics = await calculateDeveloperMetrics(user.accountId, user.displayName, days);
    
    teamMetrics.developers.push({
      name: user.displayName,
      assigned: devMetrics.assigned_tasks,
      closed: devMetrics.closed_tasks,
      delivery_percentage: devMetrics.delivery_percentage,
      planned: devMetrics.planned_tasks,
      unplanned: devMetrics.unplanned_tasks
    });

    totalClosed += devMetrics.closed_tasks;
    totalAssigned += devMetrics.assigned_tasks;
    totalPlanned += devMetrics.planned_tasks;
    totalUnplanned += devMetrics.unplanned_tasks;
  }

  const daysElapsed = Math.max(days, 1);
  teamMetrics.team_velocity = Math.round((totalClosed / daysElapsed) * 100) / 100;

  if (totalPlanned + totalUnplanned > 0) {
    teamMetrics.sprint_success_rate = Math.round((totalClosed / (totalPlanned + totalUnplanned)) * 1000) / 10;
  }

  teamMetrics.planned_vs_unplanned = {
    planned: totalPlanned,
    unplanned: totalUnplanned
  };

  if (users.length > 0) {
    const developersWithTasks = teamMetrics.developers.filter(d => d.assigned > 0).length;
    teamMetrics.capacity_utilization = Math.round((developersWithTasks / users.length) * 1000) / 10;
  }

  return teamMetrics;
}

// Get management metrics
async function getManagementMetrics(days = 30) {
  console.log('\n📈 Calculating management metrics...');
  const users = await getUsersFromIssues(days);

  const mgmtMetrics = {
    release_prediction: {},
    resource_forecasting: {},
    department_productivity: {},
    team_comparison: []
  };

  let allClosed = 0;
  let allAssigned = 0;
  const allDevs = [];

  for (const user of users) {
    const devMetrics = await calculateDeveloperMetrics(user.accountId, user.displayName, days);
    allDevs.push(devMetrics);
    allClosed += devMetrics.closed_tasks;
    allAssigned += devMetrics.assigned_tasks;

    mgmtMetrics.team_comparison.push({
      developer: user.displayName,
      assigned: devMetrics.assigned_tasks,
      closed: devMetrics.closed_tasks,
      delivery_rate: devMetrics.delivery_percentage,
      avg_resolution_days: devMetrics.average_resolution_time
    });
  }

  // Release Prediction
  if (allAssigned > 0) {
    const velocity = Math.max(allClosed / days, 0.1);
    const daysToComplete = Math.round((allAssigned / velocity) * 10) / 10;
    const estimatedDate = new Date();
    estimatedDate.setDate(estimatedDate.getDate() + daysToComplete);

    mgmtMetrics.release_prediction = {
      estimated_days: Math.max(daysToComplete, 1),
      estimated_date: estimatedDate.toISOString().split('T')[0],
      confidence: allClosed > 0 ? 'High' : 'Low'
    };
  }

  // Resource Forecasting
  const avgDelivery = allDevs.length > 0
    ? allDevs.reduce((sum, d) => sum + d.delivery_percentage, 0) / allDevs.length
    : 0;

  mgmtMetrics.resource_forecasting = {
    average_delivery_rate: Math.round(avgDelivery * 10) / 10,
    team_size: users.length,
    recommended_team_size: avgDelivery > 0
      ? Math.max(1, Math.round((users.length * 100) / avgDelivery))
      : users.length
  };

  // Department Productivity
  const avgResolutionTime = allDevs.length > 0
    ? allDevs.reduce((sum, d) => sum + d.average_resolution_time, 0) / allDevs.length
    : 0;

  mgmtMetrics.department_productivity = {
    total_tasks_closed: allClosed,
    total_tasks_assigned: allAssigned,
    productivity_index: Math.round((allClosed / Math.max(allAssigned, 1)) * 1000) / 10,
    average_resolution_time: Math.round(avgResolutionTime * 10) / 10
  };

  return mgmtMetrics;
}

// Get all data
async function getAllData(daysShort = 7, daysLong = 30) {
  console.log('\n═══════════════════════════════════════════════════');
  console.log('📊 FETCHING ALL ANALYTICS DATA');
  console.log('═══════════════════════════════════════════════════');
  
  const users = await getUsersFromIssues(daysShort);
  
  console.log(`\n📝 Calculating metrics for ${users.length} developers...`);
  const developerMetrics = await Promise.all(
    users.map(u => calculateDeveloperMetrics(u.accountId, u.displayName, daysShort))
  );

  const teamMetrics = await getTeamMetrics(daysShort);
  const managementMetrics = await getManagementMetrics(daysLong);

  const result = {
    generated_at: new Date().toISOString(),
    developer_metrics: {
      users: developerMetrics
    },
    team_metrics: teamMetrics,
    management_metrics: managementMetrics
  };

  console.log('\n✅ All data fetched successfully!');
  console.log('═══════════════════════════════════════════════════\n');
  
  return result;
}

// Routes
app.get('/api/health', (req, res) => {
  console.log('🏥 Health check');
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/api/data', async (req, res) => {
  try {
    const daysShort = parseInt(req.query.days_short || '7');
    const daysLong = parseInt(req.query.days_long || '30');
    const data = await getAllData(daysShort, daysLong);
    res.json(data);
  } catch (error) {
    console.error('❌ Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/developers', async (req, res) => {
  try {
    console.log('\n👨‍💻 Fetching developer metrics...');
    const daysShort = parseInt(req.query.days_short || '7');
    const users = await getUsersFromIssues(daysShort);
    const devMetrics = await Promise.all(
      users.map(u => calculateDeveloperMetrics(u.accountId, u.displayName, daysShort))
    );
    res.json({ developers: devMetrics });
  } catch (error) {
    console.error('❌ Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/team', async (req, res) => {
  try {
    const daysShort = parseInt(req.query.days_short || '7');
    const data = await getTeamMetrics(daysShort);
    res.json(data);
  } catch (error) {
    console.error('❌ Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/management', async (req, res) => {
  try {
    const daysLong = parseInt(req.query.days_long || '30');
    const data = await getManagementMetrics(daysLong);
    res.json(data);
  } catch (error) {
    console.error('❌ Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`\n🚀 Backend API running at http://localhost:${PORT}`);
  console.log(`\n📝 Test endpoints:`);
  console.log(`   curl http://localhost:${PORT}/api/health`);
  console.log(`   curl http://localhost:${PORT}/api/data\n`);
});
