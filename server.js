// server.js
// Yasha Tech Solutions – backend aligned with current localStorage schema
// Uses JSON files on disk (no DB yet). Replace with Mongo/Postgres later.

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const app = express();
app.use(cors());
app.use(express.json());

// Serve all static files (index.html, CSS, JS, images, other HTML) from project root
app.use(express.static(path.join(__dirname)));


// ----------------- JSON storage helpers -----------------
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

function loadJson(fileName, fallback) {
  const filePath = path.join(DATA_DIR, fileName);
  if (!fs.existsSync(filePath)) return fallback;
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    console.error('Error reading', fileName, e);
    return fallback;
  }
}

function saveJson(fileName, value) {
  const filePath = path.join(DATA_DIR, fileName);
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

// Files:
// users.json          -> yasha_users
// profiles.json       -> map { emailLower: profileObject } (yasha_profile_<email>)
// courseVideos.json   -> {id, course, title, description, src, duration?}
// tests.json          -> {id, course, question, options, correctIndex}
// questions.json      -> student doubts from course page
// testResults.json    -> marks / test submissions


// ----------------- uploads (videos) -----------------
const UPLOAD_ROOT = path.join(__dirname, 'uploads');
const VIDEO_DIR = path.join(UPLOAD_ROOT, 'videos');
if (!fs.existsSync(UPLOAD_ROOT)) fs.mkdirSync(UPLOAD_ROOT);
if (!fs.existsSync(VIDEO_DIR)) fs.mkdirSync(VIDEO_DIR);

app.use('/uploads', express.static(UPLOAD_ROOT)); // serve uploads

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, VIDEO_DIR),
  filename: (req, file, cb) => {
    const ts = Date.now();
    const safe = file.originalname.replace(/\s+/g, '_');
    cb(null, `${ts}_${safe}`);
  }
});

const videoMimeTypes = [
  'video/mp4',
  'video/webm',
  'video/ogg',
  'video/x-matroska',
  'video/quicktime'
];

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    if (videoMimeTypes.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Only video files are allowed'), false);
  },
  limits: {
    fileSize: 1 * 1024 * 1024 * 1024 // 1 GB – increase only if infra supports it
  }
});


// ----------------- HTML routes (for AWS) -----------------

// Root -> index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Explicit routes for other pages (in case static doesn’t catch them)
app.get('/userpage.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'userpage.html'));
});

app.get('/teacher.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'teacher.html'));
});

app.get('/admin.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

app.get('/profile.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'profile.html'));
});


// ===================================================================
// AUTH & USERS (index.html / admin.html / basic login)
// ===================================================================

// Signup – mirrors yasha_users structure
app.post('/api/auth/signup', (req, res) => {
  const { name, email, phone, password, role, courseType } = req.body || {};
  if (!name || !email || !phone || !password || !role) {
    return res.status(400).json({ message: 'Missing required fields' });
  }

  const users = loadJson('users.json', []);
  const exists = users.find(u => u.email.toLowerCase() === email.toLowerCase());
  if (exists) {
    return res.status(409).json({ message: 'Email already registered' });
  }

  const newUser = {
    name,
    email,
    phone,
    password,
    role,                      // 'student' or 'teacher'
    courseType: role === 'student' ? (courseType || null) : null,
    status: 'pending',         // pending/approved/rejected
    createdAt: new Date().toISOString(),
    courses: [],               // for userpage.html & teacher courses
    projectLog: [],
    profile: {}
  };

  users.push(newUser);
  saveJson('users.json', users);
  res.status(201).json({ message: 'Signup successful (pending approval)', user: newUser });
});

// Login – you can call this from index.html instead of pure localStorage auth
app.post('/api/auth/login', (req, res) => {
  const { email, password, role } = req.body || {};
  if (!email || !password || !role) {
    return res.status(400).json({ message: 'Missing email/password/role' });
  }

  const users = loadJson('users.json', []);
  const user = users.find(
    u =>
      u.email.toLowerCase() === email.toLowerCase() &&
      u.password === password &&
      (u.role || 'student') === role
  );

  if (!user) {
    return res.status(401).json({ message: 'Invalid credentials' });
  }
  if (user.status === 'pending') {
    return res.status(403).json({ message: 'Account pending admin approval' });
  }
  if (user.status === 'rejected') {
    return res.status(403).json({ message: 'Account rejected' });
  }

  res.json({
    message: 'Login successful',
    user: {
      name: user.name,
      email: user.email,
      role: user.role,
      status: user.status,
      courseType: user.courseType
    }
  });
});

// Admin: list all users
app.get('/api/admin/users', (req, res) => {
  const users = loadJson('users.json', []);
  res.json(users);
});

// Admin: update user status
app.patch('/api/admin/users/:email/status', (req, res) => {
  const { email } = req.params;
  const { status } = req.body || {};
  if (!['pending', 'approved', 'rejected'].includes(status)) {
    return res.status(400).json({ message: 'Invalid status' });
  }

  const users = loadJson('users.json', []);
  const idx = users.findIndex(u => u.email.toLowerCase() === email.toLowerCase());
  if (idx === -1) return res.status(404).json({ message: 'User not found' });

  users[idx].status = status;
  saveJson('users.json', users);
  res.json({ message: 'Status updated', user: users[idx] });
});


// ===================================================================
// STUDENT PROFILE (profile.html) – yasha_profile_<email>
// ===================================================================

app.get('/api/students/:email/profile', (req, res) => {
  const key = req.params.email.toLowerCase();
  const profiles = loadJson('profiles.json', {}); // { emailLower: profileObj }
  res.json(profiles[key] || null);
});

app.put('/api/students/:email/profile', (req, res) => {
  const email = req.params.email;
  const key = email.toLowerCase();
  const profiles = loadJson('profiles.json', {});

  profiles[key] = {
    ...(profiles[key] || {}),
    ...req.body,
    email,
    updatedAt: new Date().toISOString()
  };

  saveJson('profiles.json', profiles);
  res.json({ message: 'Profile saved', profile: profiles[key] });
});


// ===================================================================
// STUDENT DASHBOARD: courses & project log (userpage.html)
// ===================================================================

app.get('/api/students/:email/dashboard', (req, res) => {
  const email = req.params.email.toLowerCase();
  const users = loadJson('users.json', []);
  const user = users.find(u => u.email.toLowerCase() === email);
  if (!user) return res.status(404).json({ message: 'Student not found' });

  res.json({
    courses: user.courses || [],
    projectLog: user.projectLog || []
  });
});

app.post('/api/students/:email/courses', (req, res) => {
  const email = req.params.email.toLowerCase();
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ message: 'Course name required' });

  const users = loadJson('users.json', []);
  const idx = users.findIndex(u => u.email.toLowerCase() === email);
  if (idx === -1) return res.status(404).json({ message: 'Student not found' });

  const me = users[idx];
  me.courses = me.courses || [];
  if (me.courses.find(c => c.name === name)) {
    return res.status(409).json({ message: 'Course already added' });
  }
  me.courses.push({ name, progress: 0 });
  users[idx] = me;
  saveJson('users.json', users);

  res.status(201).json({ message: 'Course added', courses: me.courses });
});

app.patch('/api/students/:email/courses', (req, res) => {
  const email = req.params.email.toLowerCase();
  const { name, progress } = req.body || {};
  if (!name) return res.status(400).json({ message: 'Course name required' });

  const users = loadJson('users.json', []);
  const idx = users.findIndex(u => u.email.toLowerCase() === email);
  if (idx === -1) return res.status(404).json({ message: 'Student not found' });

  const me = users[idx];
  me.courses = me.courses || [];
  const cIdx = me.courses.findIndex(c => c.name === name);
  if (cIdx === -1) return res.status(404).json({ message: 'Course not found for student' });

  me.courses[cIdx].progress = Number(progress || 0);
  users[idx] = me;
  saveJson('users.json', users);

  res.json({ message: 'Progress updated', course: me.courses[cIdx] });
});

app.post('/api/students/:email/project-log', (req, res) => {
  const email = req.params.email.toLowerCase();
  const { text } = req.body || {};
  if (!text) return res.status(400).json({ message: 'Text required' });

  const users = loadJson('users.json', []);
  const idx = users.findIndex(u => u.email.toLowerCase() === email);
  if (idx === -1) return res.status(404).json({ message: 'Student not found' });

  const me = users[idx];
  me.projectLog = me.projectLog || [];
  const entry = { text, time: new Date().toLocaleString() };
  me.projectLog.unshift(entry);
  users[idx] = me;
  saveJson('users.json', users);

  res.status(201).json({ message: 'Project update added', log: me.projectLog });
});


// ===================================================================
// COURSE VIDEOS (teacher.html + course.html)
// ===================================================================

app.get('/api/videos', (req, res) => {
  const { course } = req.query;
  const videos = loadJson('courseVideos.json', []);
  if (course) {
    return res.json(videos.filter(v => v.course === course));
  }
  res.json(videos);
});

app.post('/api/videos', (req, res) => {
  const { course, title, description, src, duration } = req.body || {};
  if (!course || !title || !src) {
    return res.status(400).json({ message: 'course, title and src are required' });
  }

  const videos = loadJson('courseVideos.json', []);
  const id = 'v_' + Date.now();
  const video = { id, course, title, description: description || '', src, duration: duration || null };
  videos.push(video);
  saveJson('courseVideos.json', videos);

  res.status(201).json({ message: 'Video added', video });
});

app.post('/api/upload/video', upload.single('video'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: 'No video file uploaded' });
  }

  const relativePath = `/uploads/videos/${req.file.filename}`;
  res.status(201).json({
    message: 'Video uploaded successfully',
    videoUrl: relativePath,
    originalName: req.file.originalname,
    size: req.file.size
  });
});


// ===================================================================
// TESTS & RESULTS (teacher.html tests section + future student tests)
// ===================================================================

app.get('/api/tests', (req, res) => {
  const { course } = req.query;
  const tests = loadJson('tests.json', []);
  if (course) return res.json(tests.filter(t => t.course === course));
  res.json(tests);
});

app.post('/api/tests', (req, res) => {
  const { course, question, options } = req.body || {};
  if (!course || !question || !options || !Array.isArray(options) || options.length < 2) {
    return res.status(400).json({ message: 'course, question, options[>=2] required' });
  }

  const tests = loadJson('tests.json', []);
  const test = {
    id: 't_' + Date.now(),
    course,
    question,
    options,
    correctIndex: 0 // correct option is first line
  };
  tests.push(test);
  saveJson('tests.json', tests);

  res.status(201).json({ message: 'Test question added', test });
});

app.post('/api/tests/submit', (req, res) => {
  const { studentEmail, studentName, course, score, total } = req.body || {};
  if (!studentEmail || !course || typeof score === 'undefined' || typeof total === 'undefined') {
    return res.status(400).json({ message: 'studentEmail, course, score, total required' });
  }

  const results = loadJson('testResults.json', []);
  const entry = {
    studentEmail,
    studentName: studentName || null,
    course,
    score: Number(score),
    total: Number(total),
    submittedAt: new Date().toISOString()
  };
  results.push(entry);
  saveJson('testResults.json', results);

  res.status(201).json({ message: 'Result recorded', result: entry });
});

app.get('/api/tests/results', (req, res) => {
  const { course } = req.query;
  const results = loadJson('testResults.json', []);
  if (course) return res.json(results.filter(r => r.course === course));
  res.json(results);
});


// ===================================================================
// STUDENT Q&A (course.html asks; teacher.html sees list)
// ===================================================================

app.post('/api/questions', (req, res) => {
  const {
    course,
    videoId,
    videoTitle,
    studentName,
    studentPhone,
    studentEmail,
    question,
    timeText
  } = req.body || {};

  if (!course || !videoId || !question || !studentEmail) {
    return res.status(400).json({ message: 'course, videoId, question, studentEmail required' });
  }

  const questions = loadJson('questions.json', []);
  const item = {
    id: 'q_' + Date.now(),
    course,
    videoId,
    videoTitle: videoTitle || null,
    studentName: studentName || null,
    studentPhone: studentPhone || null,
    studentEmail,
    question,
    timeText: timeText || null,
    createdAt: new Date().toISOString()
  };
  questions.push(item);
  saveJson('questions.json', questions);

  res.status(201).json({ message: 'Question recorded', question: item });
});

app.get('/api/questions', (req, res) => {
  const { course } = req.query;
  const questions = loadJson('questions.json', []);
  let list = questions;
  if (course) list = list.filter(q => q.course === course);
  list = list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)); // newest first
  res.json(list);
});


// ===================================================================
// START SERVER
// ===================================================================

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Yasha Tech API running on http://13.60.180.98:${PORT}`);
});
