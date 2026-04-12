// ============ 智能考勤系统 API v3.0 ============
// 功能：学号登录、自动签到订阅、自定义日期、邮箱绑定

const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const cron = require('node-cron');
const { spawn } = require('child_process');
const path = require('path');
const nodemailer = require('nodemailer');

const app = express();

// ============ CORS 配置 ============
const allowedOrigins = [
  'https://login.agai.online',
  'https://api.agai.online',
  'https://attendance-frontend.ag985211ag.workers.dev',
  'http://localhost:3000',
  'http://127.0.0.1:5500'
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

// 用户模型
const userSchema = new mongoose.Schema({
  studentId: { type: String, required: true, unique: true },
  name: { type: String, default: '' },
  email: { type: String, default: '' },
  emailVerified: { type: Boolean, default: false },
  isVip: { type: Boolean, default: false },
  vipExpireAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now },
  lastLogin: Date,
  totalSignCount: { type: Number, default: 0 },
  successSignCount: { type: Number, default: 0 }
});

// 签到订阅模型
const subscriptionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  name: { type: String, default: '晚寝签到' },
  enabled: { type: Boolean, default: true },
  // 自定义日期配置
  scheduleType: { type: String, enum: ['daily', 'weekdays', 'custom'], default: 'weekdays' },
  customDays: { type: [Number], default: [1, 2, 3, 4, 5] }, // 0=周日, 1=周一...
  signTime: { type: String, default: '21:25' },
  maxRetries: { type: Number, default: 3 },
  notifyOnSuccess: { type: Boolean, default: true },
  notifyOnFailure: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// 签到日志模型
const signLogSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  subscriptionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Subscription' },
  subscriptionName: { type: String, default: '手动签到' },
  status: { type: String, enum: ['success', 'failed', 'pending'] },
  message: { type: String, default: '' },
  signTime: { type: Date, default: Date.now },
  executedAt: { type: Date, default: Date.now }
});

// 邮箱验证码模型
const emailCodeSchema = new mongoose.Schema({
  email: { type: String, required: true },
  code: { type: String, required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  used: { type: Boolean, default: false },
  expiresAt: { type: Date, required: true },
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.models.User || mongoose.model('User', userSchema);
const Subscription = mongoose.models.Subscription || mongoose.model('Subscription', subscriptionSchema);
const SignLog = mongoose.models.SignLog || mongoose.model('SignLog', signLogSchema);
const EmailCode = mongoose.models.EmailCode || mongoose.model('EmailCode', emailCodeSchema);

// ============ JWT 配置 ============
const JWT_SECRET = process.env.JWT_SECRET || 'attendance-secret-key-2024';
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

// ============ 邮箱配置 ============
const EMAIL_USER = process.env.EMAIL_USER || '';
const EMAIL_PASS = process.env.EMAIL_PASS || '';

const transporter = EMAIL_USER && EMAIL_PASS ? nodemailer.createTransport({
  service: 'qq',
  auth: { user: EMAIL_USER, pass: EMAIL_PASS }
}) : null;

// 发送验证码
async function sendVerificationCode(email, code) {
  if (!transporter) {
    console.log('📧 邮箱未配置，模拟发送验证码:', code);
    return true;
  }
  
  try {
    await transporter.sendMail({
      from: `"智能考勤系统" <${EMAIL_USER}>`,
      to: email,
      subject: '邮箱验证码 - 智能考勤系统',
      html: `
        <div style="max-width: 400px; margin: 0 auto; padding: 20px; font-family: Arial;">
          <h2 style="color: #667eea;">智能考勤系统</h2>
          <p>您的验证码是：</p>
          <div style="font-size: 32px; font-weight: bold; color: #667eea; padding: 20px; background: #f5f7fa; text-align: center; border-radius: 10px;">
            ${code}
          </div>
          <p>验证码 5 分钟内有效。</p>
          <hr style="margin: 20px 0;">
          <p style="color: #999; font-size: 12px;">AG工作室 · 智能考勤系统</p>
        </div>
      `
    });
    return true;
  } catch (error) {
    console.error('发送邮件失败:', error);
    return false;
  }
}

// 发送签到通知
async function sendSignNotification(email, studentId, result, subscriptionName) {
  if (!transporter) return false;
  
  const emoji = result.success ? '✅' : '❌';
  const statusText = result.success ? '成功' : '失败';
  
  try {
    await transporter.sendMail({
      from: `"智能考勤系统" <${EMAIL_USER}>`,
      to: email,
      subject: `${emoji} 签到${statusText}通知 - ${subscriptionName}`,
      html: `
        <div style="max-width: 400px; margin: 0 auto; padding: 20px; font-family: Arial;">
          <h2 style="color: #667eea;">签到${statusText}通知</h2>
          <p><strong>学号：</strong>${studentId}</p>
          <p><strong>任务：</strong>${subscriptionName}</p>
          <p><strong>时间：</strong>${new Date().toLocaleString('zh-CN')}</p>
          <p><strong>结果：</strong><span style="color: ${result.success ? '#28a745' : '#dc3545'};">${result.message}</span></p>
          <hr>
          <p style="color: #999; font-size: 12px;">AG工作室 · 智能考勤系统</p>
        </div>
      `
    });
    return true;
  } catch (error) {
    console.error('发送通知失败:', error);
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

// ============ API 路由 ============

// 健康检查
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', time: new Date().toISOString() });
});

app.get('/', (req, res) => {
  res.json({ status: 'running', version: '3.0.0' });
});

// ============ 登录（不验证密码，直接通过）============
app.post('/api/login', async (req, res) => {
  try {
    const { studentId, attendancePassword } = req.body;
    
    if (!studentId) {
      return res.status(400).json({ success: false, message: '请输入学号' });
    }
    
    if (!MONGODB_URI) {
      return res.status(503).json({ success: false, message: '数据库未配置' });
    }
    
    // 查找或创建用户
    let user = await User.findOne({ studentId });
    
    if (!user) {
      user = new User({
        studentId,
        name: studentId,
        lastLogin: new Date()
      });
      await user.save();
    } else {
      user.lastLogin = new Date();
      await user.save();
    }
    
    // 保存考勤密码到内存（不存数据库，仅用于本次会话的签到）
    // 实际签到时会从请求中获取
    
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

// 发送验证码
app.post('/api/email/send-code', authMiddleware, async (req, res) => {
  try {
    const { email } = req.body;
    const user = req.user;
    
    if (!email) {
      return res.status(400).json({ success: false, message: '请输入邮箱' });
    }
    
    // 检查邮箱是否已被其他用户绑定
    const existingUser = await User.findOne({ email, _id: { $ne: user._id } });
    if (existingUser) {
      return res.status(400).json({ success: false, message: '该邮箱已被绑定' });
    }
    
    // 生成 6 位验证码
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    
    // 保存验证码
    await EmailCode.deleteMany({ email, used: false });
    const emailCode = new EmailCode({
      email,
      code,
      userId: user._id,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000)
    });
    await emailCode.save();
    
    // 发送邮件
    const sent = await sendVerificationCode(email, code);
    
    if (!sent && EMAIL_USER) {
      return res.status(500).json({ success: false, message: '邮件发送失败' });
    }
    
    res.json({ 
      success: true, 
      message: EMAIL_USER ? '验证码已发送' : '验证码已生成（邮箱未配置，请输入 123456）',
      debugCode: EMAIL_USER ? undefined : '123456'
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 验证并绑定邮箱
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
    
    // 标记已使用
    emailCode.used = true;
    await emailCode.save();
    
    // 更新用户邮箱
    user.email = email;
    user.emailVerified = true;
    user.isVip = true;
    
    // VIP 有效期 30 天（示例）
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

// ============ 订阅管理 ============

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

// 更新订阅
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

// 删除订阅
app.delete('/api/subscriptions/:id', authMiddleware, async (req, res) => {
  try {
    await Subscription.findOneAndDelete({ _id: req.params.id, userId: req.user._id });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 切换订阅状态
app.post('/api/subscriptions/:id/toggle', authMiddleware, async (req, res) => {
  try {
    const subscription = await Subscription.findOne({
      _id: req.params.id,
      userId: req.user._id
    });
    
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
    const { studentId, attendancePassword } = req.body;
    const user = req.user;
    
    const signStudentId = studentId || user.studentId;
    const signPassword = attendancePassword || 'Ahgydx@920';
    
    console.log(`🚀 手动签到: ${signStudentId}`);
    
    const signResult = await realSign(signStudentId, signPassword, 3);
    
    // 更新用户签到统计
    user.totalSignCount = (user.totalSignCount || 0) + 1;
    if (signResult.success) {
      user.successSignCount = (user.successSignCount || 0) + 1;
    }
    await user.save();
    
    // 记录日志
    const log = new SignLog({
      userId: user._id,
      subscriptionName: '手动签到',
      status: signResult.success ? 'success' : 'failed',
      message: signResult.message || JSON.stringify(signResult.errors || [])
    });
    await log.save();
    
    // 发送邮件通知（如果是 VIP 且绑定了邮箱）
    if (user.isVip && user.emailVerified && user.email) {
      await sendSignNotification(user.email, signStudentId, signResult, '手动签到');
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
    
    const todaySigns = await SignLog.countDocuments({
      userId: user._id,
      executedAt: { $gte: today }
    });
    
    const todaySuccess = await SignLog.countDocuments({
      userId: user._id,
      status: 'success',
      executedAt: { $gte: today }
    });
    
    const activeSubscriptions = await Subscription.countDocuments({
      userId: user._id,
      enabled: true
    });
    
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

// ============ 定时任务（每天晚上自动签到）============
async function executeAutoSign() {
  console.log('⏰ 自动签到任务开始:', new Date().toISOString());
  
  if (!MONGODB_URI) {
    console.log('⚠️ 数据库未连接');
    return;
  }
  
  try {
    const today = new Date();
    const dayOfWeek = today.getDay(); // 0=周日, 1=周一...
    
    // 获取所有启用的订阅
    const subscriptions = await Subscription.find({ enabled: true })
      .populate('userId');
    
    // 筛选今天需要签到的订阅
    const todaySubscriptions = subscriptions.filter(sub => {
      if (sub.scheduleType === 'daily') return true;
      if (sub.scheduleType === 'weekdays') return dayOfWeek >= 1 && dayOfWeek <= 5;
      if (sub.scheduleType === 'custom') {
        return sub.customDays && sub.customDays.includes(dayOfWeek);
      }
      return false;
    });
    
    // 按用户分组
    const userMap = new Map();
    for (const sub of todaySubscriptions) {
      const user = sub.userId;
      if (user) {
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
        
        const signResult = await realSign(
          user.studentId,
          'Ahgydx@920',
          3
        );
        
        // 更新统计
        user.totalSignCount = (user.totalSignCount || 0) + 1;
        if (signResult.success) {
          user.successSignCount = (user.successSignCount || 0) + 1;
        }
        await user.save();
        
        // 记录日志
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
        
        // 发送通知
        if (user.isVip && user.emailVerified && user.email) {
          const shouldNotify = signResult.success ? 
            subscriptions.some(s => s.notifyOnSuccess) : 
            subscriptions.some(s => s.notifyOnFailure);
          
          if (shouldNotify) {
            await sendSignNotification(
              user.email, 
              user.studentId, 
              signResult, 
              subscriptions.map(s => s.name).join(', ')
            );
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

// 每天 21:25 执行
cron.schedule('25 21 * * *', executeAutoSign, { timezone: "Asia/Shanghai" });

// 每天 21:30 执行（备用）
cron.schedule('30 21 * * *', executeAutoSign, { timezone: "Asia/Shanghai" });

// ============ 启动服务 ============
const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 服务器运行在端口 ${PORT}`);
  console.log(`📍 版本: 3.0.0`);
  console.log(`🤖 自动签到已启用 (每天 21:25 和 21:30)`);
});
