// ============ 智能考勤系统 API v3.5.1 ============
// 功能：学号登录、考勤密码保存、 自动签到订阅、邮箱VIP（Resend）、卡密系统、管理员后台
// 包含：邀请功能、系统通知配置、邮件宣传信息、时区修复、管理员删除用户、管理员代签到
// 新增：用户留言反馈系统

const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const cors = require('cors');
const cron = require('node-cron');
const { spawn } = require('child_process');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const { Server } = require('socket.io');
const app = express();
const server = http.createServer(app);
const PlantData = require('./models/PlantData');//zhiwu
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// ============ WebSocket 用户映射 ============
const userSockets = new Map();

io.on('connection', (socket) => {
  console.log('🔌 WebSocket 客户端已连接:', socket.id);
  
  socket.on('bindUser', (userId) => {
    if (userId) {
      userSockets.set(userId, socket.id);
      console.log(`👤 用户 ${userId} 绑定 WebSocket: ${socket.id}`);
    }
  });

  socket.on('disconnect', () => {
    for (const [uid, sid] of userSockets.entries()) {
      if (sid === socket.id) {
        userSockets.delete(uid);
        console.log(`👤 用户 ${uid} 断开 WebSocket`);
      }
    }
  });
});

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

// ============ 时区辅助函数 ============
function getBeijingTime(date = new Date()) {
  return date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
}

// ============ 生成邀请码 ============
function generateInviteCode(length = 8) {
  return crypto.randomBytes(length).toString('hex').substring(0, length).toUpperCase();
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
  attendancePassword: { type: String, default: 'Ahgydx@920' },
  createdAt: { type: Date, default: Date.now },
  lastLogin: Date,
  totalSignCount: { type: Number, default: 0 },
  successSignCount: { type: Number, default: 0 },
  // 邀请功能字段
  inviteCode: { type: String, unique: true, sparse: true },
  invitedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  inviteCount: { type: Number, default: 0 }
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

// 系统配置模型
const systemConfigSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  value: mongoose.Schema.Types.Mixed,
  updatedAt: { type: Date, default: Date.now }
});

// 邀请记录模型
const inviteLogSchema = new mongoose.Schema({
  inviterId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  inviteeId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  rewardDays: { type: Number, default: 10 },
  createdAt: { type: Date, default: Date.now }
});

// 留言/反馈模型
const feedbackSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  title: { type: String, required: true },
  content: { type: String, required: true },
  type: { type: String, enum: ['bug', 'suggestion', 'question', 'other'], default: 'other' },
  status: { type: String, enum: ['pending', 'read', 'replied', 'closed'], default: 'pending' },
  adminReply: { type: String, default: '' },
  repliedAt: { type: Date },
  repliedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// ============ 支付订单模型 ============
const paymentOrderSchema = new mongoose.Schema({
  orderNo: { type: String, required: true, unique: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  amount: { type: Number, required: true },
  days: { type: Number, default: 0 },
  times: { type: Number, default: 0 },
  cardCategory: { type: String, enum: ['days', 'times'], default: 'days' },
  payMethod: { type: String, enum: ['wechat', 'alipay'], default: 'wechat' },
  status: { type: String, enum: ['pending', 'paid', 'expired'], default: 'pending' },
  cardId: { type: mongoose.Schema.Types.ObjectId, ref: 'Card' },
  expireAt: { type: Date },  // ← 新增：订单过期时间
  createdAt: { type: Date, default: Date.now },
  paidAt: Date
});

const PaymentOrder = mongoose.models.PaymentOrder || mongoose.model('PaymentOrder', paymentOrderSchema);

const User = mongoose.models.User || mongoose.model('User', userSchema);
const Subscription = mongoose.models.Subscription || mongoose.model('Subscription', subscriptionSchema);
const SignLog = mongoose.models.SignLog || mongoose.model('SignLog', signLogSchema);
const EmailCode = mongoose.models.EmailCode || mongoose.model('EmailCode', emailCodeSchema);
const Card = mongoose.models.Card || mongoose.model('Card', cardSchema);
const SystemConfig = mongoose.models.SystemConfig || mongoose.model('SystemConfig', systemConfigSchema);
const InviteLog = mongoose.models.InviteLog || mongoose.model('InviteLog', inviteLogSchema);
const Feedback = mongoose.models.Feedback || mongoose.model('Feedback', feedbackSchema);

// ============ 初始化系统配置 ============
async function initSystemConfig() {
  const defaults = [
    { 
      key: 'dashboard_notice', 
      value: { 
        enabled: true, 
        title: '📢 系统公告', 
        content: '欢迎使用智能考勤系统！绑定邮箱即可获得 30 天 VIP。邀请好友注册，双方各得 10 天 VIP！', 
        style: 'info' 
      } 
    },
    { key: 'email_template', value: { footer: 'AG工作室 · 智能考勤系统', website: 'https://login.agai.online' } },
    { key: 'invite_reward_days', value: 10 }
  ];
  
  for (const cfg of defaults) {
    const exists = await SystemConfig.findOne({ key: cfg.key });
    if (!exists) {
      await SystemConfig.create(cfg);
      console.log(`✅ 初始化配置: ${cfg.key}`);
    }
  }
  console.log('✅ 系统配置初始化完成');
}

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
        from: 'AG工作室 <noreply@agai.online>',
        to: email,
        subject: '邮箱验证码 - AG工作室',
        html: `
          <div style="max-width: 450px; margin: 0 auto; padding: 20px; font-family: Arial, sans-serif;">
            <div style="text-align: center; margin-bottom: 24px;">
              <h1 style="color: #667eea; margin: 0;">📋 AG工作室</h1>
              <p style="color: #888; margin: 5px 0 0;">AG工作室</p>
            </div>
            <p style="font-size: 16px;">您的邮箱验证码是：</p>
            <div style="font-size: 36px; font-weight: bold; color: #667eea; padding: 20px; background: #f5f7fa; text-align: center; border-radius: 12px; letter-spacing: 5px;">
              ${code}
            </div>
            <p style="margin-top: 20px; color: #666;">验证码 5 分钟内有效，请勿泄露给他人。</p>
            
            <div style="margin-top: 24px; padding: 16px; background: linear-gradient(135deg, #667eea10 0%, #764ba210 100%); border-radius: 12px; text-align: center;">
              <p style="margin: 0 0 8px 0; font-weight: 600; color: #667eea;">🎉 绑定邮箱即送 30 天 VIP</p>
              <p style="margin: 0 0 12px 0; font-size: 13px; color: #666;">享受签到邮件通知 · 邀请好友再送 VIP</p>
              <a href="https://login.agai.online" style="display: inline-block; padding: 8px 20px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: #fff; text-decoration: none; border-radius: 20px; font-size: 14px; font-weight: 500;">立即体验</a>
            </div>
            
            <hr style="margin: 24px 0; border: none; border-top: 1px solid #eee;">
            <p style="color: #999; font-size: 12px; text-align: center;">
              AG工作室 · 智能考勤系统<br>
              🌐 https://login.agai.online
            </p>
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

async function sendSignNotification(email, studentId, result, subscriptionName, signTime = null) {
  console.log(`📧 准备发送通知: email=${email}, studentId=${studentId}, success=${result.success}`);
  
  if (!RESEND_API_KEY) {
    console.log('📧 Resend 未配置，跳过通知');
    return false;
  }
  
  const emoji = result.success ? '✅' : '❌';
  const statusText = result.success ? '成功' : '失败';
  const statusColor = result.success ? '#28a745' : '#dc3545';
  const displayTime = signTime 
    ? signTime.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) 
    : getBeijingTime();
  
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'AG工作室 <noreply@agai.online>',
        to: email,
        subject: `${emoji} 签到${statusText}通知 - ${subscriptionName}`,
        html: `
          <div style="max-width: 450px; margin: 0 auto; padding: 20px; font-family: Arial, sans-serif;">
            <div style="text-align: center; margin-bottom: 24px;">
              <h1 style="color: #667eea; margin: 0;">📋 签到通知</h1>
            </div>
            <div style="background: #f5f7fa; padding: 20px; border-radius: 12px;">
              <p><strong>学号：</strong>${studentId}</p>
              <p><strong>任务：</strong>${subscriptionName}</p>
              <p><strong>时间：</strong>${displayTime}</p>
              <p><strong>结果：</strong><span style="color: ${statusColor};">${result.message || statusText}</span></p>
            </div>
            
            <div style="margin-top: 24px; padding: 16px; background: linear-gradient(135deg, #667eea10 0%, #764ba210 100%); border-radius: 12px; text-align: center;">
              <p style="margin: 0 0 8px 0; font-weight: 600; color: #667eea;">🚀 智能考勤 · 让签到更简单</p>
              <p style="margin: 0 0 12px 0; font-size: 13px; color: #666;">自动签到 · 邮件通知 · 永久免费</p>
              <a href="https://login.agai.online" style="display: inline-block; padding: 8px 20px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: #fff; text-decoration: none; border-radius: 20px; font-size: 14px; font-weight: 500;">访问官网</a>
              <p style="margin: 12px 0 0 0; font-size: 12px; color: #999;">邀请好友注册，双方各得 10 天 VIP！</p>
            </div>
            
            <hr style="margin: 24px 0; border: none; border-top: 1px solid #eee;">
            <p style="color: #999; font-size: 12px; text-align: center;">
              AG工作室 · 智能考勤系统<br>
              📧 客服邮箱：support@agai.online<br>
              🌐 官网：https://login.agai.online
            </p>
          </div>
        `
      })
    });
    
    if (response.ok) {
      console.log('✅ 签到通知发送成功:', email);
      return true;
    } else {
      const error = await response.text();
      console.error('❌ 通知发送失败:', error);
      return false;
    }
  } catch (error) {
    console.error('❌ 发送通知异常:', error);
    return false;
  }
}


// ============ 调用 Python 签到脚本 ============
async function realSign(studentId, password, maxRetries = 3) {
  return new Promise((resolve) => {
    const pythonScript = path.join(__dirname, 'attendance_runner.py');
    const pythonProcess = spawn('python3', [pythonScript], {
      timeout: 60000  // 60秒超时
    });
    
    let output = '';
    let errorOutput = '';
    let isResolved = false;
    
    // 超时处理
    const timeout = setTimeout(() => {
      if (!isResolved) {
        isResolved = true;
        pythonProcess.kill();
        console.error('⏰ Python 脚本执行超时');
        resolve({ success: false, message: '签到脚本执行超时', errors: ['执行超时'] });
      }
    }, 55000);  // 55秒超时
    
    pythonProcess.stdout.on('data', (data) => { 
      output += data.toString(); 
      console.log('Python stdout:', data.toString().substring(0, 200));
    });
    
    pythonProcess.stderr.on('data', (data) => { 
      errorOutput += data.toString();
      console.error('Python stderr:', data.toString());
    });
    
    pythonProcess.on('close', (code) => {
      if (isResolved) return;
      isResolved = true;
      clearTimeout(timeout);
      
      console.log(`Python 进程退出，代码: ${code}`);
      console.log('Python stdout 长度:', output.length);
      console.log('Python stderr 长度:', errorOutput.length);
      
      if (code !== 0) {
        resolve({ success: false, message: '脚本执行失败', errors: [errorOutput || '未知错误'] });
        return;
      }
      try {
        const result = JSON.parse(output);
        resolve(result);
      } catch (e) {
        console.error('解析 Python 输出失败:', output.substring(0, 500));
        resolve({ success: false, message: '解析失败', errors: [output.substring(0, 200)] });
      }
    });
    
    pythonProcess.on('error', (err) => {
      if (isResolved) return;
      isResolved = true;
      clearTimeout(timeout);
      console.error('Python 进程启动失败:', err);
      resolve({ success: false, message: '无法启动签到脚本', errors: [err.message] });
    });
    
    // 发送输入数据
    const inputData = JSON.stringify({
      action: 'sign_single',
      user: { studentId, password },
      maxRetries
    });
    
    console.log('发送给 Python 的数据:', inputData.substring(0, 100));
    pythonProcess.stdin.write(inputData);
    pythonProcess.stdin.end();
  });
}

// ============ 自动签到执行函数 ============
async function executeAutoSign() {
  console.log('⏰ 自动签到任务开始:', getBeijingTime());
  
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
        
        const signPassword = user.attendancePassword || 'Ahgydx@920';
        const signTime = new Date();
        const signResult = await realSign(user.studentId, signPassword, 3);
        
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
            message: signResult.message || '',
            signTime: signTime
          });
          await log.save();
        }
        
        if (user.isVip && user.emailVerified && user.email) {
          const now = new Date();
          const vipValid = user.vipExpireAt && user.vipExpireAt > now;
          
          if (vipValid) {
            const shouldNotify = signResult.success ? 
              subscriptions.some(s => s.notifyOnSuccess) : 
              subscriptions.some(s => s.notifyOnFailure);
            
            if (shouldNotify) {
              const subscriptionNames = subscriptions.map(s => s.name).join(', ');
              await sendSignNotification(
                user.email, 
                user.studentId, 
                signResult, 
                subscriptionNames,
                signTime
              );
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
// ============ 植物工厂数据接口 ============

// 1. 接收ESP8266上传的数据（POST）
app.post('/api/plant/data', async (req, res) => {
    try {
        const data = await PlantData.create(req.body);
        console.log('✅ 收到植物工厂数据:', req.body.temperature + '°C');
        res.json({ success: true, id: data._id });
    } catch (err) {
        console.error('❌ 存储失败:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// 2. 前端拉取最新数据（GET）
app.get('/api/plant/data', async (req, res) => {
    try {
        const data = await PlantData.findOne().sort({ createdAt: -1 });
        if (!data) {
            return res.json({ error: '暂无数据' });
        }
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


app.get('/health', (req, res) => {
  res.json({ status: 'healthy', time: getBeijingTime() });
});

app.get('/', (req, res) => {
  res.json({ status: 'running', version: '3.5.0', emailService: RESEND_API_KEY ? 'Resend' : '未配置' });
});

// ============ 登录 ============
app.post('/api/login', async (req, res) => {
  try {
    const { studentId, attendancePassword } = req.body;
    
    if (!studentId) {
      return res.status(400).json({ success: false, message: '请输入学号' });
    }
    
    if (!MONGODB_URI) {
      return res.status(503).json({ success: false, message: '数据库未配置' });
    }
    
    let user = await User.findOne({ studentId });
    
    if (!user) {
      let inviteCode;
      let isUnique = false;
      while (!isUnique) {
        inviteCode = generateInviteCode(8);
        const existing = await User.findOne({ inviteCode });
        if (!existing) isUnique = true;
      }
      
      user = new User({ 
        studentId, 
        name: studentId,
        attendancePassword: attendancePassword || 'Ahgydx@920',
        inviteCode,
        lastLogin: new Date()
      });
      await user.save();
    } else {
      user.lastLogin = new Date();
      if (attendancePassword) {
        user.attendancePassword = attendancePassword;
      }
      if (!user.inviteCode) {
        let inviteCode;
        let isUnique = false;
        while (!isUnique) {
          inviteCode = generateInviteCode(8);
          const existing = await User.findOne({ inviteCode });
          if (!existing) isUnique = true;
        }
        user.inviteCode = inviteCode;
      }
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
        inviteCode: user.inviteCode,
        invitedBy: user.invitedBy,
        inviteCount: user.inviteCount,
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
      inviteCode: user.inviteCode,
      invitedBy: user.invitedBy,
      inviteCount: user.inviteCount,
      totalSignCount: user.totalSignCount,
      successSignCount: user.successSignCount,
      createdAt: user.createdAt
    }
  });
});

// 更新用户信息
app.put('/api/user/profile', authMiddleware, async (req, res) => {
  try {
    const { name, attendancePassword } = req.body;
    const user = req.user;
    if (name) user.name = name;
    if (attendancePassword) user.attendancePassword = attendancePassword;
    await user.save();
    res.json({ success: true, user: { name: user.name } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============ 系统通知 ============
app.get('/api/notice', authMiddleware, async (req, res) => {
  try {
    const config = await SystemConfig.findOne({ key: 'dashboard_notice' });
    res.json({ 
      success: true, 
      notice: config?.value || { enabled: false, title: '', content: '', style: 'info' } 
    });
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

// ============ 换绑邮箱 ============
app.post('/api/email/rebind', authMiddleware, async (req, res) => {
  try {
    const { email, code } = req.body;
    const user = req.user;
    
    // 检查是否已绑定邮箱
    if (!user.emailVerified) {
      return res.status(400).json({ success: false, message: '您还没有绑定邮箱，请先绑定' });
    }
    
    if (!email || !code) {
      return res.status(400).json({ success: false, message: '请填写新邮箱和验证码' });
    }
    
    // 不能换绑成同一个邮箱
    if (email === user.email) {
      return res.status(400).json({ success: false, message: '新邮箱不能和当前邮箱相同' });
    }
    
    // 检查新邮箱是否已被其他人绑定
    const existingUser = await User.findOne({ email, _id: { $ne: user._id } });
    if (existingUser) {
      return res.status(400).json({ success: false, message: '该邮箱已被其他用户绑定' });
    }
    
    // 验证验证码
    const emailCode = await EmailCode.findOne({ email, code, used: false });
    if (!emailCode) {
      return res.status(400).json({ success: false, message: '验证码错误' });
    }
    
    if (emailCode.expiresAt < new Date()) {
      return res.status(400).json({ success: false, message: '验证码已过期' });
    }
    
    // 标记验证码已使用
    emailCode.used = true;
    await emailCode.save();
    
    // 更新邮箱
    const oldEmail = user.email;
    user.email = email;
    await user.save();
    
    console.log(`📧 用户 ${user.studentId} 换绑邮箱: ${oldEmail} → ${email}`);
    
    // 发送通知邮件到新邮箱
    if (RESEND_API_KEY) {
      try {
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${RESEND_API_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            from: 'AG工作室 <noreply@agai.online>',
            to: email,
            subject: '邮箱换绑成功 - AG工作室',
            html: `
              <div style="max-width: 450px; margin: 0 auto; padding: 20px; font-family: Arial, sans-serif;">
                <div style="text-align: center; margin-bottom: 24px;">
                  <h1 style="color: #667eea; margin: 0;">📋 AG工作室</h1>
                </div>
                <p>您的绑定邮箱已成功更换为：<strong>${email}</strong></p>
                <p>原邮箱 <strong>${oldEmail}</strong> 将不再接收签到通知。</p>
                <hr style="margin: 24px 0;">
                <p style="color: #999; font-size: 12px; text-align: center;">
                  如果这不是您本人的操作，请联系管理员
                </p>
              </div>
            `
          })
        });
      } catch (e) {
        console.error('发送换绑通知失败:', e);
      }
    }
    
    res.json({
      success: true,
      message: '邮箱换绑成功',
      user: {
        email: user.email,
        emailVerified: user.emailVerified
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

// ============ 邀请功能 ============
app.get('/api/invite/info', authMiddleware, async (req, res) => {
  try {
    const user = req.user;
    
    const invitedUsers = await User.find({ invitedBy: user._id }).select('studentId name createdAt');
    const rewardConfig = await SystemConfig.findOne({ key: 'invite_reward_days' });
    
    res.json({
      success: true,
      inviteCode: user.inviteCode,
      inviteCount: user.inviteCount || 0,
      inviteUrl: `https://login.agai.online?invite=${user.inviteCode}`,
      rewardDays: rewardConfig?.value || 10,
      invitedUsers
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/api/invite/apply', authMiddleware, async (req, res) => {
  try {
    const { inviteCode } = req.body;
    const user = req.user;
    
    if (user.invitedBy) {
      return res.status(400).json({ success: false, message: '您已经绑定过邀请人了' });
    }
    
    const inviter = await User.findOne({ inviteCode: inviteCode.toUpperCase() });
    if (!inviter) {
      return res.status(400).json({ success: false, message: '邀请码无效' });
    }
    
    if (inviter._id.toString() === user._id.toString()) {
      return res.status(400).json({ success: false, message: '不能邀请自己' });
    }
    
    const rewardConfig = await SystemConfig.findOne({ key: 'invite_reward_days' });
    const rewardDays = rewardConfig?.value || 10;
    
    user.invitedBy = inviter._id;
    
    const now = new Date();
    let expireAt = user.vipExpireAt && user.vipExpireAt > now ? new Date(user.vipExpireAt) : now;
    expireAt.setDate(expireAt.getDate() + rewardDays);
    user.isVip = true;
    user.vipExpireAt = expireAt;
    await user.save();
    
    let inviterExpireAt = inviter.vipExpireAt && inviter.vipExpireAt > now ? new Date(inviter.vipExpireAt) : now;
    inviterExpireAt.setDate(inviterExpireAt.getDate() + rewardDays);
    inviter.isVip = true;
    inviter.vipExpireAt = inviterExpireAt;
    inviter.inviteCount = (inviter.inviteCount || 0) + 1;
    await inviter.save();
    
    const log = new InviteLog({
      inviterId: inviter._id,
      inviteeId: user._id,
      rewardDays
    });
    await log.save();
    
    res.json({
      success: true,
      message: `成功绑定邀请人！您和邀请人各获得 ${rewardDays} 天 VIP`,
      rewardDays
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
    
    const signPassword = attendancePassword || user.attendancePassword || 'Ahgydx@920';
    const signTime = new Date();
    
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
      message: signResult.message || JSON.stringify(signResult.errors || []),
      signTime: signTime
    });
    await log.save();
    
    if (user.isVip && user.emailVerified && user.email) {
      const now = new Date();
      if (user.vipExpireAt && user.vipExpireAt > now) {
        await sendSignNotification(user.email, user.studentId, signResult, '手动签到', signTime);
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

// ============ 留言反馈 API ============

// 提交留言
app.post('/api/feedback', authMiddleware, async (req, res) => {
  try {
    const { title, content, type } = req.body;
    const user = req.user;
    
    if (!title || !content) {
      return res.status(400).json({ success: false, message: '请填写标题和内容' });
    }
    
    const feedback = new Feedback({
      userId: user._id,
      title,
      content,
      type: type || 'other',
      status: 'pending'
    });
    
    await feedback.save();
    
    res.json({ success: true, feedback, message: '留言提交成功，我们会尽快回复！' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 获取用户的留言列表
app.get('/api/feedback/my', authMiddleware, async (req, res) => {
  try {
    const feedbacks = await Feedback.find({ userId: req.user._id })
      .sort({ createdAt: -1 })
      .limit(50);
    
    res.json({ success: true, feedbacks });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 获取单条留言详情
app.get('/api/feedback/:id', authMiddleware, async (req, res) => {
  try {
    const feedback = await Feedback.findById(req.params.id);
    
    if (!feedback) {
      return res.status(404).json({ success: false, message: '留言不存在' });
    }
    
    // 检查权限：只能看自己的，管理员可以看所有
    if (feedback.userId.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: '无权查看' });
    }
    
    res.json({ success: true, feedback });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============ 管理员 API ============

// 系统统计
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
    const totalInvites = await InviteLog.countDocuments();
    
    res.json({
      success: true,
      stats: {
        users: { total: totalUsers, vip: vipUsers, today: todayUsers },
        signs: { total: totalSigns, today: todaySigns, success: successSigns, successRate },
        subscriptions: { active: activeSubscriptions },
        invites: { total: totalInvites }
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 获取系统配置
app.get('/api/admin/config', adminMiddleware, async (req, res) => {
  try {
    const configs = await SystemConfig.find();
    const configMap = {};
    configs.forEach(c => { configMap[c.key] = c.value; });
    res.json({ success: true, configs: configMap });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 更新系统配置
app.put('/api/admin/config/:key', adminMiddleware, async (req, res) => {
  try {
    const { key } = req.params;
    const { value } = req.body;
    
    let config = await SystemConfig.findOne({ key });
    if (!config) {
      config = new SystemConfig({ key, value });
    } else {
      config.value = value;
      config.updatedAt = new Date();
    }
    await config.save();
    
    res.json({ success: true, config });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 用户列表
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

// 用户详情
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

// 更新用户
app.put('/api/admin/users/:id', adminMiddleware, async (req, res) => {
  try {
    const { name, email, attendancePassword, isVip, vipExpireAt, role, isActive } = req.body;
    
    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ success: false, message: '用户不存在' });
    }
    
    if (name !== undefined) user.name = name;
    if (email !== undefined) user.email = email;
    if (attendancePassword !== undefined) user.attendancePassword = attendancePassword;
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

// 删除用户
app.delete('/api/admin/users/:id', adminMiddleware, async (req, res) => {
  try {
    const userId = req.params.id;
    
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false, message: '用户不存在' });
    }
    
    if (user._id.toString() === req.user._id.toString()) {
      return res.status(400).json({ success: false, message: '不能删除自己的账号' });
    }
    
    await Subscription.deleteMany({ userId: user._id });
    await SignLog.deleteMany({ userId: user._id });
    await EmailCode.deleteMany({ userId: user._id });
    await InviteLog.deleteMany({ $or: [{ inviterId: user._id }, { inviteeId: user._id }] });
    await Feedback.deleteMany({ userId: user._id });
    
    await Card.updateMany(
      { usedBy: user._id }, 
      { $unset: { usedBy: '', usedAt: '' }, status: 'unused' }
    );
    
    await User.deleteOne({ _id: user._id });
    
    console.log(`✅ 管理员 ${req.user.studentId} 删除了用户 ${user.studentId}`);
    
    res.json({ success: true, message: '用户已删除' });
  } catch (error) {
    console.error('删除用户错误:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 管理员代签到
app.post('/api/admin/sign/:userId', adminMiddleware, async (req, res) => {
  try {
    const targetUserId = req.params.userId;
    const { attendancePassword } = req.body;
    
    const targetUser = await User.findById(targetUserId);
    if (!targetUser) {
      return res.status(404).json({ success: false, message: '用户不存在' });
    }
    
    const signPassword = attendancePassword || targetUser.attendancePassword || 'Ahgydx@920';
    const signTime = new Date();
    
    console.log(`🚀 管理员 ${req.user.studentId} 为 ${targetUser.studentId} 执行签到`);
    
    const signResult = await realSign(targetUser.studentId, signPassword, 3);
    
    targetUser.totalSignCount = (targetUser.totalSignCount || 0) + 1;
    if (signResult.success) {
      targetUser.successSignCount = (targetUser.successSignCount || 0) + 1;
    }
    await targetUser.save();
    
    const log = new SignLog({
      userId: targetUser._id,
      subscriptionName: `管理员代签 (by ${req.user.studentId})`,
      status: signResult.success ? 'success' : 'failed',
      message: signResult.message || '',
      signTime: signTime
    });
    await log.save();
    
    if (targetUser.isVip && targetUser.emailVerified && targetUser.email) {
      const now = new Date();
      if (targetUser.vipExpireAt && targetUser.vipExpireAt > now) {
        await sendSignNotification(
          targetUser.email, 
          targetUser.studentId, 
          signResult, 
          '管理员代签',
          signTime
        );
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
    console.error('代签错误:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============ 支付 API ============
// 收款码图片地址
const PAY_QR_URLS = {
  wechat: 'https://login.agai.online/vxcode.png',   // 微信收款码
  alipay: 'https://login.agai.online/zfbcode.png'    // 支付宝收款码
};

// 默认收款码（兼容旧版）
const PAY_QR_URL = PAY_QR_URLS.wechat;

// ============ 生成唯一金额 ============
async function generateUniqueAmount(basePrice) {
  for (let i = 0; i < 10; i++) {
    const offset = parseFloat((Math.random() * 0.09 + 0.01).toFixed(2));
    const amount = parseFloat((basePrice + offset).toFixed(2));

    const exists = await PaymentOrder.findOne({
      amount,
      status: 'pending',
      createdAt: { $gt: new Date(Date.now() - 30 * 60 * 1000) }  // 30分钟内的待支付订单
    });

    if (!exists) return amount;
  }

  // 如果 10 次都没生成唯一金额，加一个时间戳后缀
  const timestamp = Date.now().toString().slice(-2);
  return parseFloat((basePrice + parseFloat('0.' + timestamp)).toFixed(2));
}
// 卡密套餐配置
const CARD_PACKAGES = [
  { days: 30, times: 0, cardCategory: 'days', price: 9.9, name: '30天VIP卡', description: '适合短期使用' },
  { days: 120, times: 0, cardCategory: 'days', price: 32.8, name: '一学期VIP卡', description: '性价比之选（上岸吧）' },
  { days: 365, times: 0, cardCategory: 'days', price: 53.2, name: '一学年VIP卡', description: '年度最划算（我上岸）' },
  { days: 0, times: 0, cardCategory: 'days', price: 0.01, name: '测试用勿拍', description: '仅测试' },
  // 如果以后需要次数卡，可以在这里追加
   { days: 0, times: 30, cardCategory: 'times', price: 19.9, name: '30次签到卡', description: '可签到30次，永久有效' },
   { days: 0, times: 10, cardCategory: 'times', price: 8.8, name: '10次签到卡', description: '可签到10次，永久有效' }
];


// 获取套餐列表
app.get('/api/payment/packages', authMiddleware, async (req, res) => {
  res.json({ success: true, packages: CARD_PACKAGES });
});

// 创建订单
app.post('/api/payment/create-order', authMiddleware, async (req, res) => {
  try {
    const { days, times, cardCategory, payMethod } = req.body;
    const user = req.user;
    
    // 根据类别查找套餐
    let pkg;
    if (cardCategory === 'times') {
      pkg = CARD_PACKAGES.find(p => p.times === parseInt(times) && p.cardCategory === 'times');
    } else {
      pkg = CARD_PACKAGES.find(p => p.days === parseInt(days) && p.cardCategory === 'days');
    }
    
    if (!pkg) {
      return res.status(400).json({ success: false, message: '无效的套餐' });
    }
    
    // 生成唯一金额
    const amount = await generateUniqueAmount(pkg.price);
    
    const orderNo = 'PAY' + Date.now() + Math.random().toString(36).substring(2, 8).toUpperCase();
    
    const order = new PaymentOrder({
      orderNo,
      userId: user._id,
      amount,
      days: pkg.days,
      times: pkg.times,
      cardCategory: pkg.cardCategory,
      payMethod: payMethod || 'wechat',
      status: 'pending',
      expireAt: new Date(Date.now() + 30 * 60 * 1000)  // 30分钟过期
    });
    await order.save();
    
    // 返回双收款码
    res.json({
      success: true,
      order: {
        orderNo: order.orderNo,
        amount: order.amount,
        days: order.days,
        times: order.times,
        cardCategory: order.cardCategory,
        payMethod: order.payMethod,
        expireAt: order.expireAt
      },
      qrCodes: {
        wechat: PAY_QR_URLS.wechat,
        alipay: PAY_QR_URLS.alipay
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// V免签心跳检测与配置验证
app.get('/api/payment/notify', (req, res) => {
  console.log('📡 收到V免签配置验证请求:', req.query);
  // 返回标准JSON响应
  res.json({ 
    code: 1, 
    msg: 'ok',
    data: {
      heartbeat: 'ok',
      time: new Date().toISOString()
    }
  });
});

// 接收支付通知（V免签回调）
app.post('/api/payment/notify', async (req, res) => {
  try {
    const { money, mark, sign } = req.body;
    
    // 验证签名（简化版，实际需要验证）
    const SECRET_KEY = process.env.PAYMENT_SECRET || 'my-secret-key-2024';
    const expectedSign = crypto.createHash('md5').update(money + mark + SECRET_KEY).digest('hex');
    
    // 这里先用简化验证，正式使用要严格验证
    console.log(`💰 收到支付通知: 金额=${money}, 备注=${mark}`);
    
    // 查找匹配的待支付订单
    const order = await PaymentOrder.findOne({
      amount: parseFloat(money),
      status: 'pending'
    }).sort({ createdAt: 1 });
    
    if (!order) {
      console.log('⚠️ 没有找到匹配的订单');
      return res.json({ code: 0, msg: '没有找到匹配的订单' });
    }
    
    // 生成卡密
    const code = 'VIP' + crypto.randomBytes(6).toString('hex').toUpperCase();
    const card = new Card({
      code,
      days: order.days,
      type: `vip_${order.days}d`,
      status: 'unused',
      createdAt: new Date()
    });
    await card.save();
    
    // 更新订单
    order.status = 'paid';
    order.paidAt = new Date();
    order.cardId = card._id;
    await order.save();
    
    // ========== WebSocket 实时推送 ==========
    const socketId = userSockets.get(order.userId.toString());
    if (socketId) {
      io.to(socketId).emit('paymentSuccess', {
        orderNo: order.orderNo,
        cardCode: code,
        amount: order.amount,
        days: order.days,
        times: order.times,
        cardCategory: order.cardCategory
      });
      console.log(`📡 WebSocket 推送支付成功: 用户=${order.userId}, 卡密=${code}`);
    }
    
    // 发送邮件通知用户（如果已绑定邮箱）
    const buyer = await User.findById(order.userId);
    if (buyer && buyer.email && buyer.emailVerified) {
      // 发送卡密邮件
      if (RESEND_API_KEY) {
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${RESEND_API_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            from: 'AG工作室 <noreply@agai.online>',
            to: buyer.email,
            subject: '🎉 卡密购买成功 - AG工作室',
            html: `
              <div style="max-width: 450px; margin: 0 auto; padding: 20px; font-family: Arial, sans-serif;">
                <div style="text-align: center; margin-bottom: 24px;">
                  <h1 style="color: #667eea; margin: 0;">🎉 购买成功</h1>
                </div>
                <div style="background: #d4edda; padding: 20px; border-radius: 12px;">
                  <p style="margin: 0 0 15px 0;"><strong>订单号：</strong>${order.orderNo}</p>
                  <p style="margin: 0 0 15px 0;"><strong>套餐：</strong>${order.days}天VIP</p>
                  <p style="margin: 0 0 20px 0;"><strong>金额：</strong>¥${order.amount}</p>
                  <div style="background: #fff; padding: 15px; border-radius: 8px; text-align: center;">
                    <p style="margin: 0 0 10px 0;">您的卡密是：</p>
                    <div style="font-size: 28px; font-weight: bold; color: #667eea; letter-spacing: 3px;">${code}</div>
                  </div>
                </div>
                <p style="margin-top: 20px; color: #888; font-size: 13px; text-align: center;">
                  请前往 <a href="https://login.agai.online">AG工作室</a> 兑换使用
                </p>
              </div>
            `
          })
        }).catch(e => console.error('发送邮件失败:', e));
      }
    }
    
    console.log(`✅ 支付成功: 订单${order.orderNo}, 卡密${code}`);
    res.json({ code: 1, msg: '支付成功' });
    
  } catch (error) {
    console.error('支付回调错误:', error);
    res.json({ code: 0, msg: error.message });
  }
});

// 查询订单状态
app.get('/api/payment/order/:orderNo', authMiddleware, async (req, res) => {
  try {
    const order = await PaymentOrder.findOne({ 
      orderNo: req.params.orderNo,
      userId: req.user._id 
    });
    
    if (!order) {
      return res.status(404).json({ success: false, message: '订单不存在' });
    }
    
    res.json({
      success: true,
      order: {
        orderNo: order.orderNo,
        amount: order.amount,
        days: order.days,
        status: order.status,
        paidAt: order.paidAt
      },
      // 如果已支付，返回卡密
      cardCode: order.status === 'paid' && order.cardId ? 
        (await Card.findById(order.cardId))?.code : null
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============ 管理员留言管理 API ============

// 获取所有留言（管理员）
app.get('/api/admin/feedback', adminMiddleware, async (req, res) => {
  try {
    const { page = 1, limit = 20, status, type } = req.query;
    
    const query = {};
    if (status) query.status = status;
    if (type) query.type = type;
    
    const feedbacks = await Feedback.find(query)
      .populate('userId', 'studentId name email')
      .populate('repliedBy', 'studentId name')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));
    
    const total = await Feedback.countDocuments(query);
    
    const pendingCount = await Feedback.countDocuments({ status: 'pending' });
    const readCount = await Feedback.countDocuments({ status: 'read' });
    const repliedCount = await Feedback.countDocuments({ status: 'replied' });
    const closedCount = await Feedback.countDocuments({ status: 'closed' });
    
    res.json({ 
      success: true, 
      feedbacks, 
      total, 
      page: parseInt(page),
      stats: { pending: pendingCount, read: readCount, replied: repliedCount, closed: closedCount }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 回复留言（管理员）
app.put('/api/admin/feedback/:id/reply', adminMiddleware, async (req, res) => {
  try {
    const { reply } = req.body;
    const feedback = await Feedback.findById(req.params.id);
    
    if (!feedback) {
      return res.status(404).json({ success: false, message: '留言不存在' });
    }
    
    if (!reply) {
      return res.status(400).json({ success: false, message: '请输入回复内容' });
    }
    
    feedback.adminReply = reply;
    feedback.status = 'replied';
    feedback.repliedAt = new Date();
    feedback.repliedBy = req.user._id;
    feedback.updatedAt = new Date();
    
    await feedback.save();
    
    res.json({ success: true, feedback, message: '回复成功' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 更新留言状态（管理员）
app.put('/api/admin/feedback/:id/status', adminMiddleware, async (req, res) => {
  try {
    const { status } = req.body;
    const feedback = await Feedback.findById(req.params.id);
    
    if (!feedback) {
      return res.status(404).json({ success: false, message: '留言不存在' });
    }
    
    feedback.status = status;
    feedback.updatedAt = new Date();
    await feedback.save();
    
    res.json({ success: true, feedback });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 删除留言（管理员）
app.delete('/api/admin/feedback/:id', adminMiddleware, async (req, res) => {
  try {
    const feedback = await Feedback.findByIdAndDelete(req.params.id);
    
    if (!feedback) {
      return res.status(404).json({ success: false, message: '留言不存在' });
    }
    
    res.json({ success: true, message: '留言已删除' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============ 卡密管理 ============

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
//cron.schedule('30 21 * * *', executeAutoSign, { timezone: "Asia/Shanghai" });

// ============ 启动服务 ============
const PORT = process.env.PORT || 8080;

initSystemConfig().then(() => {
  // 使用 server.listen 而不是 app.listen（支持 WebSocket）
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 服务器运行在端口 ${PORT}`);
    console.log(`📍 版本: 3.6.0 (V免签升级 + WebSocket实时推送)`);
    console.log(`📧 邮件服务: ${RESEND_API_KEY ? 'Resend 已配置' : '未配置'}`);
    console.log(`🤖 自动签到已启用 (每天 21:25)`);
    console.log(`🔌 WebSocket 已启用`);
  });
});
