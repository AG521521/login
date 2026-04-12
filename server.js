// ============ 智能考勤系统 API v3.1 ============
// 功能：学号登录、自动签到订阅、邮箱VIP（Resend）、卡密系统、管理员后台

const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const cors = require('cors');
const cron = require('node-cron');
const { spawn } = require('child_process');
const path = require('path');
const crypto = require('crypto');

const app = express();

// ============ CORS 配置 ============
const allowedOrigins = [
  'https://login.agai.online',
  'https://api.agai.online',
  'https://attendance-frontend.ag985211ag.workers.dev',
  'http://localhost:3000',
  'http://127.0.0.1:5500',
  'http://localhost:5500'
];

app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(null, true);
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  optionsSuccessStatus: 200
}));

app.options('*', (req, res) => {
  res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Credentials', 'true');
  res.sendStatus(200);
});

app.use(express.json());

// ============ 数据库连接 ============
const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
  console.error('❌ MONGODB_URI 未设置！');
} else {
  mongoose.connect(MONGODB_URI)
    .then(() => console.log('✅ MongoDB 连接成功'))
    .catch(err => console.error('❌ MongoDB 连接失败:', err.message));
}

// ============ 数据模型 ============

const userSchema = new mongoose.Schema({
  studentId: { type: String, required: true, unique: true },
  name: { type: String, default: '' },
  email: { type: String, default: '' },
  emailVerified: { type: Boolean, default: false },
  isVip: { type: Boolean, default: false },
  vipExpireAt: { type: Date, default: null },
  role: { type: String, enum: ['user', 'admin'], default: 'user' },
  isActive: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now },
  lastLogin: Date,
  totalSignCount: { type: Number, default: 0 },
  successSignCount: { type: Number, default: 0 }
});

const subscriptionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  name: { type: String, default: '晚寝签到' },
  enabled: { type: Boolean, default: true },
  scheduleType: { type: String, enum: ['daily', 'weekdays', 'custom'], default: 'weekdays' },
  customDays: { type: [Number], default: [1, 2, 3, 4, 5] },
  signTime: { type: String, default: '21:25' },
  maxRetries: { type: Number, default: 3 },
  notifyOnSuccess: { type: Boolean, default: true },
  notifyOnFailure: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

const signLogSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  subscriptionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Subscription' },
  subscriptionName: { type: String, default: '手动签到' },
  status: { type: String, enum: ['success', 'failed', 'pending'] },
  message: { type: String, default: '' },
  signTime: { type: Date, default: Date.now },
  executedAt: { type: Date, default: Date.now }
});

const emailCodeSchema = new mongoose.Schema({
  email: { type: String, required: true },
  code: { type: String, required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  used: { type: Boolean, default: false },
  expiresAt: { type: Date, required: true },
  createdAt: { type: Date, default: Date.now }
});

const cardSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true },
  days: { type: Number, default: 30 },
  type: { type: String, enum: ['vip_30d', 'vip_90d', 'vip_365d'], default: 'vip_30d' },
  status: { type: String, enum: ['unused', 'used'], default: 'unused' },
  usedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  usedAt: Date,
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.models.User || mongoose.model('User', userSchema);
const Subscription = mongoose.models.Subscription || mongoose.model('Subscription', subscriptionSchema);
const SignLog = mongoose.models.SignLog || mongoose.model('SignLog', signLogSchema);
const EmailCode = mongoose.models.EmailCode || mongoose.model('EmailCode', emailCodeSchema);
const Card = mongoose.models.Card || mongoose.model('Card', cardSchema);

// ============ JWT 配置 ============
const JWT_SECRET = process.env.JWT_SECRET || 'attendance-secret-key-2024-please-change';
const JWT_EXPIRE = '30d';

// ============ 认证中间件 ============
const authMiddleware = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ success: false, message: '未登录' });
    }
    
    const token = authHeader.split(' ')[1];
    if (!token) {
      return res.status(401).json({ success: false, message: '令牌格式错误' });
    }
    
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await User.findById(decoded.userId);
    
    if (!user) {
      return res.status(401).json({ success: false, message: '用户不存在' });
    }
    
    req.user = user;
    next();
  } catch (error) {
    return res.status(401).json({ success: false, message: '登录已过期' });
  }
};

const adminMiddleware = async (req, res, next) => {
  try {
    await authMiddleware(req, res, async () => {
      if (req.user.role !== 'admin') {
        return res.status(403).json({ success: false, message: '需要管理员权限' });
      }
      next();
    });
  } catch (error) {
    res.status(401).json({ success: false, message: '未授权' });
  }
};

// ============ 邮箱配置（Resend API）============
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';

async function sendVerificationCode(email, code) {
  if (!RESEND_API_KEY) {
    console.log('📧 Resend 未配置，验证码:', code);
    return false;
  }
  
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: '智能考勤系统 <noreply@agai.online>',
        to: email,
        subject: '邮箱验证码 - 智能考勤系统',
        html: `
          <div style="max-width: 400px; margin: 0 auto; padding: 20px; font-family: Arial, sans-serif;">
            <div style="text-align: center; margin-bottom: 24px;">
              <h1 style="color: #667eea; margin: 0;">📋 智能考勤系统</h1>
              <p style="color: #888; margin: 5px 0 0;">AG工作室</p>
            </div>
            <p style="font-size: 16px;">您的邮箱验证码是：</p>
            <div style="font-size: 36px; font-weight: bold; color: #667eea; padding: 20px; background: #f5f7fa; text-align: center; border-radius: 12px; letter-spacing: 5px;">
              ${code}
            </div>
            <p style="margin-top: 20px; color: #666;">验证码 5 分钟内有效，请勿泄露给他人。</p>
            <hr style="margin: 24px 0; border: none; border-top: 1px solid #eee;">
            <p style="color: #999; font-size: 12px; text-align: center;">AG工作室 · 智能考勤系统 · 自动发送请勿回复</p>
          </div>
        `
      })
    });
    
    if (response.ok) {
      console.log('✅ 验证码邮件发送成功:', email);
      return true;
    } else {
      const error = await response.text();
      console.error('❌ Resend 发送失败:', error);
      return false;
    }
  } catch (error) {
    console.error('❌ 发送邮件异常:', error);
    return false;
  }
}

async function sendSignNotification(email, studentId, result, subscriptionName) {
  if (!RESEND_API_KEY) {
    return false;
  }
  
  const emoji = result.success ? '✅' : '❌';
  const statusText = result.success ? '成功' : '失败';
  const statusColor = result.success ? '#28a745' : '#dc3545';
  
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: '智能考勤系统 <noreply@agai.online>',
        to: email,
        subject: `${emoji} 签到${statusText}通知 - ${subscriptionName}`,
        html: `
          <div style="max-width: 400px; margin: 0 auto; padding: 20px; font-family: Arial, sans-serif;">
            <div style="text-align: center; margin-bottom: 24px;">
              <h1 style="color: #667eea; margin: 0;">📋 签到通知</h1>
            </div>
            <div style="background: #f5f7fa; padding: 20px; border-radius: 12px;">
              <p><strong>学号：</strong>${studentId}</p>
              <p><strong>任务：</strong>${subscriptionName}</p>
              <p><strong>时间：</strong>${new Date().toLocaleString('zh-CN')}</p>
              <p><strong>结果：</strong><span style="color: ${statusColor};">${result.message || statusText}</span></p>
            </div>
            <hr style="margin: 24px 0; border: none; border-top: 1px solid #eee;">
            <p style="color: #999; font-size: 12px; text-align: center;">AG工作室 · 智能考勤系统</p>
          </div>
        `
      })
    });
    
    if (response.ok) {
      console.log('✅ 签到通知发送成功:', email);
      return true;
    } else {
      return false;
    }
  } catch (error) {
    return false;
  }
}

// ============ 调用 Python 签到脚本 ============
async function realSign(studentId, password, maxRetries = 3) {
  return new Promise((resolve) => {
    const pythonScript = path.join(__dirname, 'attendance_runner.py');
    const pythonProcess = spawn('python3', [pythonScript]);
    
    let output = '';
    let errorOutput = '';
    
    pythonProcess.stdout.on('data', (data) => { output += data.toString(); });
    pythonProcess.stderr.on('data', (data) => { errorOutput += data.toString(); });
    
    pythonProcess.on('close', (code) => {
      if (code !== 0) {
        resolve({ success: false, message: '脚本执行失败', errors: [errorOutput] });
        return;
      }
      try {
        resolve(JSON.parse(output));
      } catch (e) {
        resolve({ success: false, message: '解析失败', errors: [output] });
      }
    });
    
    pythonProcess.on('error', () => {
      resolve({ success: false, message: 'Python 环境异常' });
    });
    
    pythonProcess.stdin.write(JSON.stringify({
      action: 'sign_single',
      user: { studentId, password },
      maxRetries
    }));
    pythonProcess.stdin.end();
  });
}

// ============ 自动签到执行函数 ============
async function executeAutoSign() {
  console.log('⏰ 自动签到任务开始:', new Date().toISOString());
  
  if (!MONGODB_URI) {
    console.log('⚠️ 数据库未连接');
    return;
  }
  
  try {
    const today = new Date();
    const dayOfWeek = today.getDay();
    
    const subscriptions = await Subscription.find({ enabled: true }).populate('userId');
    
    const todaySubscriptions = subscriptions.filter(sub => {
      if (sub.scheduleType === 'daily') return true;
      if (sub.scheduleType === 'weekdays') return dayOfWeek >= 1 && dayOfWeek <= 5;
      if (sub.scheduleType === 'custom') {
        return sub.customDays && sub.customDays.includes(dayOfWeek);
      }
      return false;
    });
    
    const userMap = new Map();
    for (const sub of todaySubscriptions) {
      const user = sub.userId;
      if (user && user.isActive !== false) {
        if (!userMap.has(user._id.toString())) {
          userMap.set(user._id.toString(), { user, subscriptions: [] });
        }
        userMap.get(user._id.toString()).subscriptions.push(sub);
      }
    }
    
    console.log(`📊 今天需要签到: ${userMap.size} 个用户`);
    
    for (const [userId, data] of userMap) {
      const { user, subscriptions } = data;
      
      try {
        console.log(`🔄 签到: ${user.studentId}`);
        
        const signResult = await realSign(user.studentId, 'Ahgydx@920', 3);
        
        user.totalSignCount = (user.totalSignCount || 0) + 1;
        if (signResult.success) {
          user.successSignCount = (user.successSignCount || 0) + 1;
        }
        await user.save();
        
        for (const sub of subscriptions) {
          const log = new SignLog({
            userId: user._id,
            subscriptionId: sub._id,
            subscriptionName: sub.name,
            status: signResult.success ? 'success' : 'failed',
            message: signResult.message || ''
          });
          await log.save();
        }
        
        if (user.isVip && user.emailVerified && user.email) {
          const now = new Date();
          if (user.vipExpireAt && user.vipExpireAt > now) {
            const shouldNotify = signResult.success ? 
              subscriptions.some(s => s.notifyOnSuccess) : 
              subscriptions.some(s => s.notifyOnFailure);
            
            if (shouldNotify) {
              await sendSignNotification(user.email, user.studentId, signResult, 
                subscriptions.map(s => s.name).join(', '));
            }
          } else {
            user.isVip = false;
            await user.save();
          }
        }
        
        console.log(`✅ ${user.studentId}: ${signResult.success ? '成功' : '失败'}`);
        
      } catch (error) {
        console.error(`❌ ${user.studentId}:`, error.message);
      }
      
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
    
    console.log('✅ 自动签到任务完成');
    
  } catch (error) {
    console.error('❌ 定时任务错误:', error);
  }
}

// ============ API 路由 ============

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', time: new Date().toISOString() });
});

app.get('/', (req, res) => {
  res.json({ status: 'running', version: '3.1.0', emailService: RESEND_API_KEY ? 'Resend' : '未配置' });
});

// ============ 登录 ============
app.post('/api/login', async (req, res) => {
  try {
    const { studentId } = req.body;
    
    if (!studentId) {
      return res.status(400).json({ success: false, message: '请输入学号' });
    }
    
    if (!MONGODB_URI) {
      return res.status(503).json({ success: false, message: '数据库未配置' });
    }
    
    let user = await User.findOne({ studentId });
    
    if (!user) {
      user = new User({ studentId, name: studentId, lastLogin: new Date() });
      await user.save();
    } else {
      user.lastLogin = new Date();
      await user.save();
    }
    
    const token = jwt.sign({ userId: user._id }, JWT_SECRET, { expiresIn: JWT_EXPIRE });
    
    res.json({
      success: true,
      token,
      user: {
        id: user._id,
        studentId: user.studentId,
        name: user.name,
        email: user.email,
        emailVerified: user.emailVerified,
        isVip: user.isVip,
        vipExpireAt: user.vipExpireAt,
        role: user.role,
        totalSignCount: user.totalSignCount,
        successSignCount: user.successSignCount
      }
    });
  } catch (error) {
    console.error('登录错误:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 获取用户信息
app.get('/api/user/profile', authMiddleware, async (req, res) => {
  const user = req.user;
  res.json({
    success: true,
    user: {
      id: user._id,
      studentId: user.studentId,
      name: user.name,
      email: user.email,
      emailVerified: user.emailVerified,
      isVip: user.isVip,
      vipExpireAt: user.vipExpireAt,
      role: user.role,
      totalSignCount: user.totalSignCount,
      successSignCount: user.successSignCount,
      createdAt: user.createdAt
    }
  });
});

// 更新用户信息
app.put('/api/user/profile', authMiddleware, async (req, res) => {
  try {
    const { name } = req.body;
    const user = req.user;
    if (name) user.name = name;
    await user.save();
    res.json({ success: true, user: { name: user.name } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============ 邮箱绑定 ============
app.post('/api/email/send-code', authMiddleware, async (req, res) => {
  try {
    const { email } = req.body;
    const user = req.user;
    
    if (!email) {
      return res.status(400).json({ success: false, message: '请输入邮箱' });
    }
    
    const existingUser = await User.findOne({ email, _id: { $ne: user._id } });
    if (existingUser) {
      return res.status(400).json({ success: false, message: '该邮箱已被绑定' });
    }
    
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    
    await EmailCode.deleteMany({ email, used: false });
    const emailCode = new EmailCode({
      email,
      code,
      userId: user._id,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000)
    });
    await emailCode.save();
    
    const sent = await sendVerificationCode(email, code);
    
    res.json({ 
      success: true, 
      message: sent ? '验证码已发送' : '验证码已生成（邮件服务暂不可用）',
      debugCode: sent ? undefined : code
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/api/email/verify', authMiddleware, async (req, res) => {
  try {
    const { email, code } = req.body;
    const user = req.user;
    
    const emailCode = await EmailCode.findOne({ email, code, used: false });
    
    if (!emailCode) {
      return res.status(400).json({ success: false, message: '验证码错误' });
    }
    
    if (emailCode.expiresAt < new Date()) {
      return res.status(400).json({ success: false, message: '验证码已过期' });
    }
    
    emailCode.used = true;
    await emailCode.save();
    
    user.email = email;
    user.emailVerified = true;
    user.isVip = true;
    
    const vipExpireAt = new Date();
    vipExpireAt.setDate(vipExpireAt.getDate() + 30);
    user.vipExpireAt = vipExpireAt;
    
    await user.save();
    
    res.json({
      success: true,
      user: {
        email: user.email,
        emailVerified: user.emailVerified,
        isVip: user.isVip,
        vipExpireAt: user.vipExpireAt
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============ 卡密兑换 ============
app.post('/api/vip/redeem', authMiddleware, async (req, res) => {
  try {
    const { code } = req.body;
    const user = req.user;
    
    if (!code) {
      return res.status(400).json({ success: false, message: '请输入卡密' });
    }
    
    const card = await Card.findOne({ code: code.toUpperCase(), status: 'unused' });
    if (!card) {
      return res.status(400).json({ success: false, message: '卡密无效或已被使用' });
    }
    
    const now = new Date();
    let expireAt;
    if (user.isVip && user.vipExpireAt && user.vipExpireAt > now) {
      expireAt = new Date(user.vipExpireAt);
    } else {
      expireAt = new Date();
    }
    expireAt.setDate(expireAt.getDate() + card.days);
    
    user.isVip = true;
    user.vipExpireAt = expireAt;
    await user.save();
    
    card.status = 'used';
    card.usedBy = user._id;
    card.usedAt = new Date();
    await card.save();
    
    res.json({
      success: true,
      message: `兑换成功！VIP 有效期至 ${expireAt.toLocaleDateString()}`,
      vipExpireAt: expireAt
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============ 订阅管理 ============
app.get('/api/subscriptions', authMiddleware, async (req, res) => {
  try {
    const subscriptions = await Subscription.find({ userId: req.user._id });
    res.json({ success: true, subscriptions });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/api/subscriptions', authMiddleware, async (req, res) => {
  try {
    const { name, scheduleType, customDays, signTime, maxRetries, notifyOnSuccess, notifyOnFailure } = req.body;
    
    const subscription = new Subscription({
      userId: req.user._id,
      name: name || '晚寝签到',
      scheduleType: scheduleType || 'weekdays',
      customDays: customDays || [1, 2, 3, 4, 5],
      signTime: signTime || '21:25',
      maxRetries: maxRetries || 3,
      notifyOnSuccess: notifyOnSuccess !== false,
      notifyOnFailure: notifyOnFailure !== false,
      enabled: true
    });
    
    await subscription.save();
    res.json({ success: true, subscription });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

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

app.delete('/api/subscriptions/:id', authMiddleware, async (req, res) => {
  try {
    await Subscription.findOneAndDelete({ _id: req.params.id, userId: req.user._id });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/api/subscriptions/:id/toggle', authMiddleware, async (req, res) => {
  try {
    const subscription = await Subscription.findOne({ _id: req.params.id, userId: req.user._id });
    if (!subscription) {
      return res.status(404).json({ success: false, message: '订阅不存在' });
    }
    
    subscription.enabled = !subscription.enabled;
    subscription.updatedAt = new Date();
    await subscription.save();
    
    res.json({ success: true, enabled: subscription.enabled });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============ 手动签到 ============
app.post('/api/sign/manual', authMiddleware, async (req, res) => {
  try {
    const { attendancePassword } = req.body;
    const user = req.user;
    
    const signPassword = attendancePassword || 'Ahgydx@920';
    
    console.log(`🚀 手动签到: ${user.studentId}`);
    
    const signResult = await realSign(user.studentId, signPassword, 3);
    
    user.totalSignCount = (user.totalSignCount || 0) + 1;
    if (signResult.success) {
      user.successSignCount = (user.successSignCount || 0) + 1;
    }
    await user.save();
    
    const log = new SignLog({
      userId: user._id,
      subscriptionName: '手动签到',
      status: signResult.success ? 'success' : 'failed',
      message: signResult.message || JSON.stringify(signResult.errors || [])
    });
    await log.save();
    
    if (user.isVip && user.emailVerified && user.email) {
      const now = new Date();
      if (user.vipExpireAt && user.vipExpireAt > now) {
        await sendSignNotification(user.email, user.studentId, signResult, '手动签到');
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
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============ 签到日志 ============
app.get('/api/sign/logs', authMiddleware, async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const logs = await SignLog.find({ userId: req.user._id })
      .sort({ executedAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));
    
    const total = await SignLog.countDocuments({ userId: req.user._id });
    res.json({ success: true, logs, total, page: parseInt(page) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============ 统计信息 ============
app.get('/api/stats', authMiddleware, async (req, res) => {
  try {
    const user = req.user;
    
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const todaySigns = await SignLog.countDocuments({ userId: user._id, executedAt: { $gte: today } });
    const todaySuccess = await SignLog.countDocuments({ userId: user._id, status: 'success', executedAt: { $gte: today } });
    const activeSubscriptions = await Subscription.countDocuments({ userId: user._id, enabled: true });
    
    res.json({
      success: true,
      stats: {
        totalSigns: user.totalSignCount || 0,
        successSigns: user.successSignCount || 0,
        todaySigns,
        todaySuccess,
        activeSubscriptions,
        isVip: user.isVip,
        vipExpireAt: user.vipExpireAt
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============ 管理员 API ============

app.get('/api/admin/stats', adminMiddleware, async (req, res) => {
  try {
    const totalUsers = await User.countDocuments();
    const vipUsers = await User.countDocuments({ isVip: true });
    const todayUsers = await User.countDocuments({ createdAt: { $gte: new Date(new Date().setHours(0, 0, 0, 0)) } });
    
    const totalSigns = await SignLog.countDocuments();
    const todaySigns = await SignLog.countDocuments({ executedAt: { $gte: new Date(new Date().setHours(0, 0, 0, 0)) } });
    const successSigns = await SignLog.countDocuments({ status: 'success' });
    const todaySuccessSigns = await SignLog.countDocuments({ status: 'success', executedAt: { $gte: new Date(new Date().setHours(0, 0, 0, 0)) } });
    const successRate = todaySigns > 0 ? ((todaySuccessSigns / todaySigns) * 100).toFixed(1) : 0;
    
    const activeSubscriptions = await Subscription.countDocuments({ enabled: true });
    
    res.json({
      success: true,
      stats: {
        users: { total: totalUsers, vip: vipUsers, today: todayUsers },
        signs: { total: totalSigns, today: todaySigns, success: successSigns, successRate },
        subscriptions: { active: activeSubscriptions }
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/api/admin/users', adminMiddleware, async (req, res) => {
  try {
    const { page = 1, limit = 20, search = '' } = req.query;
    
    const query = search ? {
      $or: [
        { studentId: { $regex: search, $options: 'i' } },
        { name: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } }
      ]
    } : {};
    
    const users = await User.find(query)
      .select('-__v')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));
    
    const total = await User.countDocuments(query);
    
    res.json({ success: true, users, total, page: parseInt(page) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/api/admin/users/:id', adminMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ success: false, message: '用户不存在' });
    }
    
    const subscriptions = await Subscription.find({ userId: user._id });
    const logs = await SignLog.find({ userId: user._id }).sort({ executedAt: -1 }).limit(20);
    
    res.json({ success: true, user, subscriptions, logs });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.put('/api/admin/users/:id', adminMiddleware, async (req, res) => {
  try {
    const { isVip, vipExpireAt, role, isActive } = req.body;
    
    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ success: false, message: '用户不存在' });
    }
    
    if (isVip !== undefined) user.isVip = isVip;
    if (vipExpireAt) user.vipExpireAt = new Date(vipExpireAt);
    if (role) user.role = role;
    if (isActive !== undefined) user.isActive = isActive;
    
    await user.save();
    
    res.json({ success: true, user });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/api/admin/cards/generate', adminMiddleware, async (req, res) => {
  try {
    const { count = 10, days = 30 } = req.body;
    
    const cards = [];
    for (let i = 0; i < count; i++) {
      const code = 'VIP' + crypto.randomBytes(6).toString('hex').toUpperCase();
      cards.push({ code, days, type: `vip_${days}d` });
    }
    
    await Card.insertMany(cards);
    
    res.json({ success: true, cards, message: `成功生成 ${count} 张卡密` });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/api/admin/cards', adminMiddleware, async (req, res) => {
  try {
    const { page = 1, limit = 50, status } = req.query;
    
    const query = status ? { status } : {};
    
    const cards = await Card.find(query)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .populate('usedBy', 'studentId name');
    
    const total = await Card.countDocuments(query);
    const unusedCount = await Card.countDocuments({ status: 'unused' });
    const usedCount = await Card.countDocuments({ status: 'used' });
    
    res.json({ success: true, cards, total, unusedCount, usedCount, page: parseInt(page) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/api/admin/cards/export', adminMiddleware, async (req, res) => {
  try {
    const cards = await Card.find({ status: 'unused' }).select('code days');
    const text = cards.map(c => `${c.code} - ${c.days}天`).join('\n');
    
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Disposition', 'attachment; filename="vip_cards.txt"');
    res.send(text);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============ 定时任务 ============
cron.schedule('25 21 * * *', executeAutoSign, { timezone: "Asia/Shanghai" });
cron.schedule('30 21 * * *', executeAutoSign, { timezone: "Asia/Shanghai" });

// ============ 启动服务 ============
const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 服务器运行在端口 ${PORT}`);
  console.log(`📍 版本: 3.1.0 (Resend 邮件服务)`);
  console.log(`📧 邮件服务: ${RESEND_API_KEY ? '已配置' : '未配置'}`);
  console.log(`🤖 自动签到已启用 (每天 21:25 和 21:30)`);
});
