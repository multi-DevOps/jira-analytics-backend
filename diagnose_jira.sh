#!/bin/bash

# Jira Diagnostic Script
# This helps identify why no issues are being fetched

JIRA_URL="https://multiicon.atlassian.net"
JIRA_EMAIL="multiicon@gmail.com"
JIRA_API_TOKEN="$1"  # Pass as argument: ./diagnose.sh "ATATT3xFfGF0tstOktvnRM0ASoTslpDquMckCNiIH7UNv-l6EkwVtmlJQD-YuQslQ7GD__MXDi0Oi86tyZEPOgC5b8BkNdYc2rivFNRzNaQ-ZI4zTcNkJwT0lXtIHGbjY-35wwVryJXHR3o7K-yZPLhSqwujl8OHgFQEgFu3K8qdF_g41dZdqBY=093E6DA7"

if [ -z "$JIRA_API_TOKEN" ]; then
    echo "❌ Error: API token required"
    echo "Usage: ./diagnose.sh 'your-api-token'"
    exit 1
fi

# Encode credentials
CREDENTIALS=$(echo -n "$JIRA_EMAIL:$JIRA_API_TOKEN" | base64)

echo "═══════════════════════════════════════════════════"
echo "🔍 JIRA DIAGNOSTIC TEST"
echo "═══════════════════════════════════════════════════"
echo ""
echo "Configuration:"
echo "  JIRA_URL: $JIRA_URL"
echo "  JIRA_EMAIL: $JIRA_EMAIL"
echo ""

# Test 1: Health check
echo "Test 1: Health Check"
echo "─────────────────────────────────────────────────────"
curl -s -X GET "$JIRA_URL/rest/api/3/myself" \
  -H "Authorization: Basic $CREDENTIALS" \
  -H "Content-Type: application/json" | jq '.' 2>/dev/null || echo "❌ Failed"
echo ""

# Test 2: All issues (no filter)
echo "Test 2: All Issues (No Filter)"
echo "─────────────────────────────────────────────────────"
curl -s -X POST "$JIRA_URL/rest/api/3/search/jql" \
  -H "Authorization: Basic $CREDENTIALS" \
  -H "Content-Type: application/json" \
  -d '{"jql": "project is not EMPTY", "maxResults": 5}' | jq '.issues | length' 2>/dev/null
echo ""

# Test 3: Last 30 days
echo "Test 3: Issues from Last 30 Days"
echo "─────────────────────────────────────────────────────"
curl -s -X POST "$JIRA_URL/rest/api/3/search/jql" \
  -H "Authorization: Basic $CREDENTIALS" \
  -H "Content-Type: application/json" \
  -d '{"jql": "updated >= -30d", "maxResults": 5}' | jq '.issues | length' 2>/dev/null
echo ""

# Test 4: Last 90 days
echo "Test 4: Issues from Last 90 Days"
echo "─────────────────────────────────────────────────────"
curl -s -X POST "$JIRA_URL/rest/api/3/search/jql" \
  -H "Authorization: Basic $CREDENTIALS" \
  -H "Content-Type: application/json" \
  -d '{"jql": "updated >= -90d", "maxResults": 5}' | jq '.issues | length' 2>/dev/null
echo ""

# Test 5: All issues with assignee
echo "Test 5: Issues with Assignee"
echo "─────────────────────────────────────────────────────"
curl -s -X POST "$JIRA_URL/rest/api/3/search/jql" \
  -H "Authorization: Basic $CREDENTIALS" \
  -H "Content-Type: application/json" \
  -d '{"jql": "assignee is not EMPTY", "maxResults": 5}' | jq '.issues | length' 2>/dev/null
echo ""

echo "═══════════════════════════════════════════════════"
echo "If all tests show 0, there may be no issues in Jira"
echo "If tests show numbers, update days parameter"
echo "═══════════════════════════════════════════════════"
