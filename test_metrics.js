const http = require('http');

http.get('http://localhost:3001/api/data', (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    try {
      const json = JSON.parse(data);
      json.developers.forEach(meet => {
        const planTasks = meet.issues_list.filter(i => i.key.startsWith('PLAN-'));
        if (planTasks.length > 0) {
          console.log(`${meet.name} has ${planTasks.length} PLAN tasks`);
        }
      });
    } catch (e) { console.error('Parse error:', e); }
  });
}).on('error', console.error);
