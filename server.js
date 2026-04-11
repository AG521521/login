require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const cors = require('cors');
const cron = require('node-cron');

const app = express();

// ============ 基础中间件 ============
app.use(cors({
  origin: ['https://login.agai.online', 'http://localhost:3000', 'https://login-page-xxx.pages.dev'],
  credentials: true
}));
app.use(express.json());

// OPTIONS 预检
app.options('*', (req, res) => {
  res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.sendStatus(200);
});

// ============ 健康检查（Railway 必需）============
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'healthy', time: new Date().toISOString() });
});

app.get('/', (req, res) => {
  res.json({
    status: 'running',
    message: '考勤系统 API 运行中',
    version: '2.0.0',
    endpoints: [
      'POST /api/register',
      'POST /api/login',
      'GET /api/user/profile',
      'GET /api/subscriptions',
      'POST /api/subscriptions',
      'POST /api/sign/trigger',
      'GET /api/sign/logs'
    ]
  });
});

// ============ 数据库连接 ============
const MONGODB_URI = process.env.MONGODB_URI;

if (MONGODB_URI) {
  mongoose.connect(MONGODB_URI)
    .then(() => console.log('✅ MongoDB connected'))
    .catch(err => console.error('❌ MongoDB error:', err.message));
} else {
  console.log('⚠️ MONGODB_URI 未设置，使用内存模式');
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
    days: [Number],
    time: String
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
const JWT_SECRET = process.env.JWT_SECRET || 'attendance-secret-key-2024';
const JWT_EXPIRE = '7d';

// ============ 认证中间件 ============
const authMiddleware = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      return res.status(401).json({ success: false, message: '未提供认证令牌' });
    }
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await User.findById(decoded.userId).select('-password');
    if (!user) {
      return res.status(401).json({ success: false, message: '用户不存在' });
    }
    req.user = user;
    next();
  } catch (error) {
    return res.status(401).json({ success: false, message: '无效的认证令牌' });
  }
};

// ============ 模拟签到函数 ============
async function mockSign(studentId) {
  await new Promise(resolve => setTimeout(resolve, 1500));
  const success = Math.random() > 0.1;
  return {
    success,
    message: success ? '签到成功（模拟模式）' : '签到失败：网络超时（模拟）',
  };
}

// ============ API 路由 ============

// 用户注册
app.post('/api/register', async (req, res) => {
  try {
    const { studentId, password, name, email, attendancePassword } = req.body;
    
    if (!studentId || !password || !name) {
      return res.status(400).json({ success: false, message: '请填写学号、密码和姓名' });
    }
    
    if (!MONGODB_URI) {
      return res.status(503).json({ success: false, message: '数据库未配置' });
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
      email,
      attendancePassword: attendancePassword || 'Ahgydx@920'
    });
    await user.save();
    
    const token = jwt.sign({ userId: user._id }, JWT_SECRET, { expiresIn: JWT_EXPIRE });
    
    res.json({
      success: true,
      token,
      user: { id: user._id, studentId: user.studentId, name: user.name, email: user.email }
    });
  } catch (error) {
    console.error('注册错误:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 用户登录
app.post('/api/login', async (req, res) => {
  try {
    const { studentId, password } = req.body;
    
    if (!MONGODB_URI) {
      return res.status(503).json({ success: false, message: '数据库未配置' });
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
      user: { id: user._id, studentId: user.studentId, name: user.name, email: user.email }
    });
  } catch (error) {
    console.error('登录错误:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 获取用户信息
app.get('/api/user/profile', authMiddleware, async (req, res) => {
  res.json({ success: true, user: req.user });
});

// 获取订阅列表
app.get('/api/subscriptions', authMiddleware, async (req, res) => {
  try {
    const subscriptions = await Subscription.find({ userId: req.user._id });
    res.json({ success: true, subscriptions });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 创建订阅
app.post('/api/subscriptions', authMiddleware, async (req, res) => {
  try {
    const { courseName, schedule, autoSign, maxRetries } = req.body;
    
    const subscription = new Subscription({
      userId: req.user._id,
      courseName: courseName || '晚寝签到',
      schedule: schedule || { days: [1,2,3,4,5], time: '21:25' },
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

// 更新订阅
app.put('/api/subscriptions/:id', authMiddleware, async (req, res) => {
  try {
    const subscription = await Subscription.findOne({ _id: req.params.id, userId: req.user._id });
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

// 删除订阅
app.delete('/api/subscriptions/:id', authMiddleware, async (req, res) => {
  try {
    const subscription = await Subscription.findOneAndDelete({ _id: req.params.id, userId: req.user._id });
    if (!subscription) {
      return res.status(404).json({ success: false, message: '订阅不存在' });
    }
    res.json({ success: true, message: '订阅已删除' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 手动触发签到
app.post('/api/sign/trigger', authMiddleware, async (req, res) => {
  try {
    const signResult = await mockSign(req.user.studentId);
    
    const subscriptions = await Subscription.find({ userId: req.user._id, enabled: true });
    for (const sub of subscriptions) {
      const log = new SignLog({
        userId: req.user._id,
        subscriptionId: sub._id,
        courseName: sub.courseName,
        status: signResult.success ? 'success' : 'failed',
        message: signResult.message
      });
      await log.save();
    }
    
    res.json({ success: true, result: signResult });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 获取签到记录
app.get('/api/sign/logs', authMiddleware, async (req, res) => {
  try {
    const logs = await SignLog.find({ userId: req.user._id }).sort({ signTime: -1 }).limit(50);
    res.json({ success: true, logs });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============ 定时任务 ============
cron.schedule('25 21 * * *', async () => {
  console.log('⏰ 定时签到开始:', new Date().toISOString());
  // 简化版：只记录日志，不做实际签到
  console.log('✅ 定时任务完成');
}, { timezone: "Asia/Shanghai" });

// ============ 启动服务 ============
const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on http://0.0.0.0:${PORT}`);
  console.log(`📍 Health check: http://0.0.0.0:${PORT}/health`);
});
