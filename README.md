# 智能考勤系统

这是一个基于 Node.js、Express、MongoDB 和 Python 签到脚本的智能考勤服务，包含学号登录、考勤密码验证、自动签到订阅、邮箱验证码、VIP/卡密、支付回调、管理员后台和植物工厂数据接口。

## 技术栈

- 后端：Node.js、Express、Mongoose、Socket.IO
- 数据库：MongoDB
- 定时任务：node-cron
- 邮件服务：Resend API
- 签到脚本：Python 3.11、aiohttp
- 部署：Railway / Nixpacks

## 目录说明

| 文件 | 说明 |
| --- | --- |
| `server.js` | 核心 API 服务、认证、订阅、支付、管理员接口和定时任务 |
| `attendance_runner.py` | 调用学校考勤接口完成密码验证和签到 |
| `index.html` | 登录页 |
| `dashboard` | 简易控制面板页面 |
| `PlantData.js` | 植物工厂数据模型 |
| `ControlCmd.js` | 植物工厂控制指令模型 |
| `nixpacks.toml` | Railway/Nixpacks 构建配置 |
| `railway.json` | Railway 构建配置 |
| `requirements.txt` | Python 依赖 |
| `package.json` | Node.js 依赖和启动命令 |

## 环境变量

服务启动前需要配置以下变量：

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `MONGODB_URI` | 是 | MongoDB 连接字符串 |
| `JWT_SECRET` | 是 | JWT 签名密钥，生产环境必须使用强随机值 |
| `ADMIN_CREDENTIALS` | 否 | 管理员登录账号，格式为 `账号:密码`，多个账号用英文逗号分隔；默认 `111:0101` |
| `RESEND_API_KEY` | 否 | Resend 邮件服务密钥，不配置时验证码仅输出到日志 |
| `PAYMENT_SECRET` | 视支付功能而定 | 支付回调用于验签的密钥 |
| `PORT` | 否 | 服务监听端口，默认 `8080` |

建议本地创建 `.env` 文件保存环境变量，但不要提交到仓库。当前 `.gitignore` 已忽略 `.env` 和 `node_modules/`。

## 本地运行

1. 安装 Node.js 依赖：

```bash
npm install
```

2. 安装 Python 依赖：

```bash
pip install -r requirements.txt
```

3. 配置环境变量：

```bash
MONGODB_URI=mongodb+srv://...
JWT_SECRET=replace-with-a-long-random-secret
ADMIN_CREDENTIALS=111:0101
RESEND_API_KEY=...
PAYMENT_SECRET=...
PORT=8080
```

4. 启动服务：

```bash
npm start
```

5. 健康检查：

```bash
curl http://localhost:8080/health
```

## 登录流程

登录接口为：

```http
POST /api/login
Content-Type: application/json

{
  "studentId": "学号",
  "attendancePassword": "考勤系统密码"
}
```

当前后端逻辑：

1. 管理员账号不再免密登录。默认管理员账号为 `111`，密码为 `0101`。可通过 `ADMIN_CREDENTIALS` 覆盖，例如 `ADMIN_CREDENTIALS=111:0101,admin:change-me`。
2. 普通新用户必须提供 `attendancePassword`，服务会调用 `attendance_runner.py` 验证密码。
3. 普通老用户如果密码验证失败，当前代码仍会允许登录并返回 `warning`，提示去个人中心更新密码。
4. 登录成功后返回 JWT，前端保存到 `localStorage.token`。

注意：`index.html` 里的提示文案写着“登录时不验证密码”，但后端实际会验证新用户密码。建议尽快统一产品文案和后端行为。

## 主要 API

### 认证与用户

- `POST /api/login`：登录或创建用户
- `GET /api/user/profile`：获取当前用户信息
- `PUT /api/user/profile`：更新昵称和考勤密码

### 订阅与签到

- `GET /api/subscriptions`：获取订阅列表
- `POST /api/subscriptions`：创建订阅
- `PUT /api/subscriptions/:id`：更新订阅
- `DELETE /api/subscriptions/:id`：删除订阅
- `POST /api/subscriptions/:id/toggle`：切换订阅启用状态
- `POST /api/sign/manual`：手动签到
- `GET /api/sign/logs`：获取签到记录
- `GET /api/stats`：获取用户统计

### 邮箱、VIP 与邀请

- `POST /api/email/send-code`：发送邮箱验证码
- `POST /api/email/verify`：验证邮箱
- `POST /api/email/rebind`：换绑邮箱
- `POST /api/vip/redeem`：兑换卡密
- `GET /api/invite/info`：获取邀请信息
- `POST /api/invite/apply`：填写邀请码

### 管理员

- `GET /api/admin/stats`：系统统计
- `GET /api/admin/users`：用户列表
- `GET /api/admin/users/:id`：用户详情
- `PUT /api/admin/users/:id`：更新用户
- `DELETE /api/admin/users/:id`：删除用户
- `POST /api/admin/sign/:userId`：管理员代签到
- `GET /api/admin/cards`：卡密列表
- `POST /api/admin/cards/generate`：生成卡密
- `GET /api/admin/cards/export`：导出卡密

### 支付

- `GET /api/payment/packages`：获取套餐
- `POST /api/payment/create-order`：创建订单
- `GET /api/payment/notify`：支付回调
- `POST /api/payment/notify`：支付回调
- `GET /api/payment/order/:orderNo`：查询订单状态

### 植物工厂

- `POST /api/plant/data`：上传传感器数据
- `GET /api/plant/data`：获取最新数据
- `GET /api/plant/data/history`：获取历史数据
- `POST /api/plant/control`：提交控制指令
- `GET /api/plant/control/pending`：设备轮询待执行指令

## 代码审查结论

### 高优先级问题

1. 老用户密码验证失败仍会发放 JWT。
   `server.js` 的 `/api/login` 中，如果 `verifyPassword` 失败但用户已存在，服务仍返回 `success: true` 和 `token`。这会让“考勤密码错误”和“登录成功”同时成立。建议改为：密码错误直接返回 `401`，或拆分“系统登录”和“考勤密码更新”两个流程。

2. `JWT_SECRET` 有硬编码默认值。
   当前默认值为 `attendance-secret-key-2024-please-change`。生产环境如果忘记配置环境变量，所有 token 都可被已知密钥伪造。建议启动时强制检查 `JWT_SECRET`，生产环境没有配置就拒绝启动。

3. 考勤密码明文保存。
   `attendancePassword` 用于后续自动签到，业务上可能需要可用明文或可解密密文，但不建议直接明文入库。建议使用 KMS 或服务端密钥做加密存储，并限制日志、管理接口和导出接口暴露。

4. 管理员账号硬编码且可绕过密码验证。（已修复）
   `/api/login` 已改为通过 `ADMIN_CREDENTIALS` 配置管理员账号，并要求管理员密码校验通过后才发放 token。默认管理员为 `111`，密码为 `0101`。生产环境建议通过环境变量改成更强密码。

5. CORS 白名单没有真正生效。
   当前 `allowedOrigins` 不匹配时仍然 `callback(null, true)`，等同于放开所有来源。建议非白名单来源返回错误，并让 WebSocket CORS 也使用同一份白名单。

### 中优先级问题

1. 前后端接口路径不一致。
   `dashboard` 请求 `/subscriptions`、`/sign/trigger`，但后端实际接口是 `/api/subscriptions`、`/api/sign/manual`。这会导致控制面板部分功能不可用。建议统一 `API_BASE`，或给后端补兼容路由。

2. 前端把 token 和考勤密码放在 `localStorage`。
   `localStorage` 容易被 XSS 读取。建议 token 使用 `HttpOnly`、`Secure`、`SameSite` Cookie；考勤密码不要保存在浏览器本地。

3. 登录、验证码、支付回调缺少限流。
   登录和邮箱验证码接口适合加 IP + 学号维度的限流，避免撞库、短信/邮件滥用和回调重放。

4. 用户输入缺少统一校验。
   学号、邮箱、订阅时间、重试次数、管理员更新字段建议使用 schema 校验，例如 `zod`、`joi` 或 `express-validator`。

5. 订阅更新接口直接 `Object.assign(subscription, req.body)`。
   这会让用户提交非预期字段。建议只允许更新白名单字段，例如 `name`、`scheduleType`、`customDays`、`signTime`、`maxRetries`、`enabled`、`notifyOnSuccess`、`notifyOnFailure`。

### 低优先级优化

1. `server.js` 体积过大，建议按模块拆分为 `routes/`、`models/`、`services/`、`middleware/`。
2. `/api/plant/control` 出现重复路由定义，建议保留一个明确实现。
3. 版本号在文件头、`/health` 附近和启动日志中不一致，建议从 `package.json` 读取。
4. `bcrypt` 当前被引入但未使用，建议删除未使用依赖或补齐账号密码认证用途。
5. 日志中避免输出包含密码、token、邮箱验证码等敏感内容。

## 建议整改顺序

1. 修正登录语义：密码错误不发 token，或明确支持“账号登录”和“考勤密码验证”分离。
2. 强制配置 `JWT_SECRET`，删除默认密钥。
3. 管理员密码生产环境改为强密码，并通过 `ADMIN_CREDENTIALS` 环境变量配置。
4. 加密保存考勤密码，并清理敏感日志。
5. 统一前后端 API 地址和接口名称。
6. 加登录、验证码和支付回调限流。
7. 拆分 `server.js`，补充自动化测试。

## 已做的基础检查

- Python 文件 `attendance_runner.py` 已通过 `python -m py_compile`。
- JavaScript 文件已用 Node.js `--check` 做语法检查，`server.js`、`PlantData.js`、`ControlCmd.js` 均通过。
- 仓库当前没有测试脚本，暂未执行单元测试或接口测试。
