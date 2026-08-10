const fs = require('fs');
const http = require('http');

http.get('http://localhost:3001/api/data', (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    const json = JSON.parse(data);
    const developers = json.developers;
    const currentMonth = 'Aug-26'; // Default

    const allPlanIssues = [];
    developers.forEach(dev => {
      dev.issues_list.forEach(issue => {
        const projName = (issue.project || '').toLowerCase();
        const isPlan = projName.includes('plan') || (issue.key && issue.key.startsWith('PLAN-'));
        if (isPlan && !allPlanIssues.some(existing => existing.key === issue.key)) {
          allPlanIssues.push({
            ...issue,
            dev_owner: dev.name
          });
        }
      });
    });

    const targetNames = ['Meet Bundela', 'Devam Udani', 'Harsh Bhalodiya'];
    targetNames.forEach(devName => {
      const targetNameLower = devName.toLowerCase().trim();
      
      const devPlanIssues = allPlanIssues.filter(issue => {
        let isMonthMatch = false;
        const issueMonth = issue.dev_month || issue.target_month;
        if (issueMonth) {
          isMonthMatch = issueMonth === currentMonth;
        } else if (issue.due_date && issue.due_date !== 'No Due Date') {
          try {
            const d = new Date(issue.due_date);
            const mStr = d.toLocaleString('en-US', { month: 'short' }) + '-' + String(d.getFullYear()).slice(-2);
            isMonthMatch = mStr === currentMonth;
          } catch(e) {}
        } else {
          isMonthMatch = currentMonth === 'Aug-26';
        }

        if (!isMonthMatch) return false;

        const assignedToName = (issue.assigned_to || '').toLowerCase().trim();
        const devOwnerName = (issue.dev_owner || '').toLowerCase().trim();

        return (
          assignedToName === targetNameLower ||
          devOwnerName === targetNameLower ||
          (assignedToName && targetNameLower.includes(assignedToName)) ||
          (assignedToName && assignedToName.includes(targetNameLower))
        );
      });
      console.log(`${devName}: ${devPlanIssues.length} tasks in ${currentMonth}`);
    });
  });
});
