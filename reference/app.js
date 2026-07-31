const express = require('express');
const app = express();

app.use(express.json());
app.use(express.static('public'));

// In-memory task storage (simple, no database yet)
let tasks = [
  { id: 1, title: 'Setup Kubernetes cluster', done: false },
  { id: 2, title: 'Migrate app to Docker', done: false },
  { id: 3, title: 'Configure Argo CD', done: false }
];
let nextId = 4;

// Health check endpoint (used later by Kubernetes probes)
app.get('/health', (req, res) => {
  res.json({ status: 'healthy' });
});

// API info endpoint
app.get('/api/info', (req, res) => {
  res.json({
    message: 'Startup Tech Co. - Task Manager',
    version: '1.0.0',
    environment: process.env.NODE_ENV || 'development',
    hostname: require('os').hostname()
  });
});

// Get all tasks
app.get('/api/tasks', (req, res) => {
  res.json(tasks);
});

// Add a new task
app.post('/api/tasks', (req, res) => {
  const { title } = req.body;
  if (!title) {
    return res.status(400).json({ error: 'Title is required' });
  }
  const newTask = { id: nextId++, title, done: false };
  tasks.push(newTask);
  res.status(201).json(newTask);
});

// Mark task as done
app.put('/api/tasks/:id', (req, res) => {
  const task = tasks.find(t => t.id === parseInt(req.params.id));
  if (!task) {
    return res.status(404).json({ error: 'Task not found' });
  }
  task.done = !task.done;
  res.json(task);
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Task Manager app running on port ${PORT}`);
});
