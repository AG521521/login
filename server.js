// ============ 环境变量（Railway 会自动注入）============
// require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const cors = require('cors');
const cron = require('node-cron');
const { spawn } = require('child_process');
const path = require('path');

const app = express();

// ============ CORS 白名单 ============
const allowedOrigins = [
  'https://login.agai.online',
  'https://api.agai.online',
  'https://attendance-frontend.ag985211ag.workers.dev',
  'https://attendance-frontend.pages.dev',
  'https://attendance-frontend-9ut.pages.dev',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:5500',
  'http://127.0.0.1:5500'
];

// ============ CORS 中间件 ============
app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      console.log('❌ CORS 拒绝的域名:', origin);
      callback(null, true); // 开发阶段允许所有
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  optionsSuccessStatus: 200
}));

// ============ 额外的 OPTIONS 处理 ============
app.options('*', (req, res) => {
  console.log('📡 OPTIONS 请求来自:', req.headers.origin);
  res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  res.header('Access-Control-Allow-Credentials', 'true');
  res.header('Access-Control-Max-Age', '86400');
  res.sendStatus(200);
});

// ============ JSON 解析中间件 ============
app.use(express.json());

// ============ 数据库连接 ============
const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
  console.error('❌ 环境变量 MONGODB_URI 未设置！');
  console.log('⚠️ 将以内存模式运行（数据不会持久化）');
} else {
  mongoose.connect(MONGODB_URI)
    .then(() => console.log('✅ MongoDB 连接成功'))
    .catch(err => console.error('❌ MongoDB 连接失败:', err.message));
}

// ============ 数据模型 ============
const userSchema = new mongoose.Schema({
  studentId: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  name: { type: String, required: true },
  email: String,
  attendancePassword: { type: String, default: 'Ahgydx@920' },
  createdAt: { type: Date, default: Date.now },
  lastLogin: Date,
  isActive: { type: Boolean, default: true }
});

const subscriptionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  courseName: { type: String, required: true },
  schedule: {
    days: { type: [Number], default: [1, 2, 3, 4, 5] },
    time: { type: String, default: '21:25' }
  },
  autoSign: { type: Boolean, default: true },
  enabled: { type: Boolean, default: true },
  maxRetries: { type: Number, default: 3 },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

const signLogSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  subscriptionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Subscription' },
  courseName: String,
  status: { type: String, enum: ['success', 'failed', 'pending'] },
  message: String,
  signTime: { type: Date, default: Date.now }
});

const User = mongoose.models.User || mongoose.model('User', userSchema);
const Subscription = mongoose.models.Subscription || mongoose.model('Subscription', subscriptionSchema);
const SignLog = mongoose.models.SignLog || mongoose.model('SignLog', signLogSchema);

// ============ JWT 配置 ============
const JWT_SECRET = process.env.JWT_SECRET || 'attendance-secret-key-2024-please-change-in-production';
const JWT_EXPIRE = '7d';

// ============ 认证中间件 ============
const authMiddleware = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ success: false, message: '未提供认证令牌' });
    }
    
    const token = authHeader.split(' ')[1];
    if (!token) {
      return res.status(401).json({ success: false, message: '令牌格式错误' });
    }
    
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await User.findById(decoded.userId).select('-password');
    
    if (!user) {
      return res.status(401).json({ success: false, message: '用户不存在' });
    }
    
    req.user = user;
    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ success: false, message: '登录已过期，请重新登录' });
    }
    return res.status(401).json({ success: false, message: '无效的认证令牌' });
  }
};

// ============ 调用 Python 签到脚本 ============
async function realSign(studentId, password, maxRetries = 3) {
  return new Promise((resolve, reject) => {
    const pythonScript = path.join(__dirname, 'attendance_runner.py');
    
    const pythonProcess = spawn('python3', [pythonScript]);
    
    let output = '';
    let errorOutput = '';
    
    pythonProcess.stdout.on('data', (data) => {
      output += data.toString();
    });
    
    pythonProcess.stderr.on('data', (data) => {
      errorOutput += data.toString();
      console.error('Python stderr:', data.toString());
    });
    
    pythonProcess.on('close', (code) => {
      if (code !== 0) {
        console.error(`Python 脚本退出码: ${code}`);
        resolve({
          success: false,
          message: `签到脚本执行失败`,
          errors: [errorOutput || '未知错误']
        });
        return;
      }
      try {
        const result = JSON.parse(output);
        resolve(result);
      } catch (e) {
        console.error('解析 Python 输出失败:', output);
        resolve({
          success: false,
          message: '解析签到结果失败',
          errors: [output]
        });
      }
    });
    
    pythonProcess.on('error', (err) => {
      console.error('启动 Python 进程失败:', err);
      resolve({
        success: false,
        message: '无法启动签到脚本，请检查 Python 环境',
        errors: [err.message]
      });
    });
    
    const inputData = {
      action: 'sign_single',
      user: { studentId, password },
      maxRetries
    };
    
    pythonProcess.stdin.write(JSON.stringify(inputData));
    pythonProcess.stdin.end();
  });
}

// ============ 健康检查接口 ============
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    time: new Date().toISOString(),
    mongodb: !!MONGODB_URI,
    uptime: process.uptime()
  });
});

// ============ 根路径 ============
app.get('/', (req, res) => {
  res.json({
    status: 'running',
    message: '智能考勤系统 API',
    version: '2.2.0',
    features: ['真实签到', '定时任务', 'MongoDB'],
    endpoints: [
      'GET /health',
      'POST /api/register',
      'POST /api/login',
      'GET /api/user/profile',
      'GET /api/subscriptions',
      'POST /api/subscriptions',
      'PUT /api/subscriptions/:id',
      'DELETE /api/subscriptions/:id',
      'POST /api/sign/trigger',
      'GET /api/sign/logs'
    ]
  });
});

// ============ 用户注册 ============
app.post('/api/register', async (req, res) => {
  try {
    const { studentId, password, name, email, attendancePassword } = req.body;
    
    if (!studentId || !password || !name) {
      return res.status(400).json({ success: false, message: '请填写学号、密码和姓名' });
    }
    
    if (!MONGODB_URI) {
      return res.status(503).json({ success: false, message: '数据库未配置，请联系管理员' });
    }
    
    const existingUser = await User.findOne({ studentId });
    if (existingUser) {
      return res.status(400).json({ success: false, message: '该学号已注册' });
    }
    
    const hashedPassword = await bcrypt.hash(password, 10);
    
    const user = new User({
      studentId,
      password: hashedPassword,
      name,
      email: email || '',
      attendancePassword: attendancePassword || 'Ahgydx@920'
    });
    
    await user.save();
    
    const token = jwt.sign({ userId: user._id }, JWT_SECRET, { expiresIn: JWT_EXPIRE });
    
    res.json({
      success: true,
      token,
      user: {
        id: user._id,
        studentId: user.studentId,
        name: user.name,
        email: user.email
      }
    });
  } catch (error) {
    console.error('注册错误:', error);
    res.status(500).json({ success: false, message: '服务器错误：' + error.message });
  }
});

// ============ 用户登录 ============
app.post('/api/login', async (req, res) => {
  try {
    const { studentId, password } = req.body;
    
    if (!studentId || !password) {
      return res.status(400).json({ success: false, message: '请填写学号和密码' });
    }
    
    if (!MONGODB_URI) {
      return res.status(503).json({ success: false, message: '数据库未配置，请联系管理员' });
    }
    
    const user = await User.findOne({ studentId });
    if (!user) {
      return res.status(401).json({ success: false, message: '学号或密码错误' });
    }
    
    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(401).json({ success: false, message: '学号或密码错误' });
    }
    
    user.lastLogin = new Date();
    await user.save();
    
    const token = jwt.sign({ userId: user._id }, JWT_SECRET, { expiresIn: JWT_EXPIRE });
    
    res.json({
      success: true,
      token,
      user: {
        id: user._id,
        studentId: user.studentId,
        name: user.name,
        email: user.email
      }
    });
  } catch (error) {
    console.error('登录错误:', error);
    res.status(500).json({ success: false, message: '服务器错误：' + error.message });
  }
});

// ============ 获取用户信息 ============
app.get('/api/user/profile', authMiddleware, async (req, res) => {
  res.json({ success: true, user: req.user });
});

// ============ 获取订阅列表 ============
app.get('/api/subscriptions', authMiddleware, async (req, res) => {
  try {
    const subscriptions = await Subscription.find({ userId: req.user._id });
    res.json({ success: true, subscriptions });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============ 创建订阅 ============
app.post('/api/subscriptions', authMiddleware, async (req, res) => {
  try {
    const { courseName, schedule, autoSign, maxRetries } = req.body;
    
    const subscription = new Subscription({
      userId: req.user._id,
      courseName: courseName || '晚寝签到',
      schedule: schedule || { days: [1, 2, 3, 4, 5], time: '21:25' },
      autoSign: autoSign !== false,
      maxRetries: maxRetries || 3,
      enabled: true
    });
    
    await subscription.save();
    res.json({ success: true, subscription });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============ 更新订阅 ============
app.put('/api/subscriptions/:id', authMiddleware, async (req, res) => {
  try {
    const subscription = await Subscription.findOne({
      _id: req.params.id,
      userId: req.user._id
    });
    
    if (!subscription) {
      return res.status(404).json({ success: false, message: '订阅不存在' });
    }
    
    Object.assign(subscription, req.body);
    subscription.updatedAt = new Date();
    await subscription.save();
    
    res.json({ success: true, subscription });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============ 删除订阅 ============
app.delete('/api/subscriptions/:id', authMiddleware, async (req, res) => {
  try {
    const subscription = await Subscription.findOneAndDelete({
      _id: req.params.id,
      userId: req.user._id
    });
    
    if (!subscription) {
      return res.status(404).json({ success: false, message: '订阅不存在' });
    }
    
    res.json({ success: true, message: '订阅已删除' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============ 手动触发签到（真实签到）============
app.post('/api/sign/trigger', authMiddleware, async (req, res) => {
  try {
    const user = req.user;
    
    console.log(`🚀 开始为 ${user.studentId} 执行真实签到...`);
    
    // 执行真实签到
    const signResult = await realSign(
      user.studentId,
      user.attendancePassword || 'Ahgydx@920',
      3  // 最大重试次数
    );
    
    console.log(`📋 签到结果:`, signResult);
    
    // 获取用户的所有启用订阅
    const subscriptions = await Subscription.find({
      userId: user._id,
      enabled: true
    });
    
    // 记录日志
    if (subscriptions.length === 0) {
      const log = new SignLog({
        userId: user._id,
        courseName: '手动签到',
        status: signResult.success ? 'success' : 'failed',
        message: signResult.message || JSON.stringify(signResult.errors || [])
      });
      await log.save();
    } else {
      for (const sub of subscriptions) {
        const log = new SignLog({
          userId: user._id,
          subscriptionId: sub._id,
          courseName: sub.courseName,
          status: signResult.success ? 'success' : 'failed',
          message: signResult.message || JSON.stringify(signResult.errors || [])
        });
        await log.save();
      }
    }
    
    res.json({
      success: true,
      result: {
        success: signResult.success,
        message: signResult.message,
        errors: signResult.errors || []
      }
    });
  } catch (error) {
    console.error('签到错误:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============ 获取签到记录 ============
app.get('/api/sign/logs', authMiddleware, async (req, res) => {
  try {
    const logs = await SignLog.find({ userId: req.user._id })
      .sort({ signTime: -1 })
      .limit(50);
    
    res.json({ success: true, logs });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============ 定时任务（每天 21:25 执行真实签到）============
cron.schedule('25 21 * * *', async () => {
  console.log('⏰ 定时签到任务开始:', new Date().toISOString());
  
  if (!MONGODB_URI) {
    console.log('⚠️ 数据库未连接，跳过定时任务');
    return;
  }
  
  try {
    // 获取所有启用自动签到的订阅
    const subscriptions = await Subscription.find({ enabled: true, autoSign: true })
      .populate('userId');
    
    // 按用户去重
    const userMap = new Map();
    for (const sub of subscriptions) {
      const user = sub.userId;
      if (user && user.isActive !== false) {
        if (!userMap.has(user._id.toString())) {
          userMap.set(user._id.toString(), user);
        }
      }
    }
    
    console.log(`📊 共有 ${userMap.size} 个用户需要签到`);
    
    for (const [userId, user] of userMap) {
      try {
        console.log(`🔄 正在为 ${user.studentId} 签到...`);
        
        const signResult = await realSign(
          user.studentId,
          user.attendancePassword || 'Ahgydx@920',
          3
        );
        
        // 获取该用户的所有订阅
        const userSubs = subscriptions.filter(s => s.userId._id.toString() === userId);
        
        for (const sub of userSubs) {
          const log = new SignLog({
            userId,
            subscriptionId: sub._id,
            courseName: sub.courseName,
            status: signResult.success ? 'success' : 'failed',
            message: signResult.message || JSON.stringify(signResult.errors || [])
          });
          await log.save();
        }
        
        console.log(`✅ ${user.studentId} 签到完成:`, signResult.success ? '成功' : '失败');
        
      } catch (error) {
        console.error(`❌ ${user.studentId} 签到失败:`, error.message);
      }
      
      // 间隔 5 秒，避免请求过快
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
    
    console.log('✅ 定时签到任务完成');
    
  } catch (error) {
    console.error('❌ 定时任务错误:', error);
  }
}, {
  timezone: "Asia/Shanghai"
});

// ============ 启动服务 ============
const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 服务器运行在端口 ${PORT}`);
  console.log(`📍 健康检查: http://0.0.0.0:${PORT}/health`);
  console.log(`🤖 真实签到功能已启用`);
});
