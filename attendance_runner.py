# -*- coding: utf-8 -*-
"""
考勤脚本执行器 - 供 Node.js 后端调用
接收学号和密码，执行单人或多人签到，返回 JSON 结果
"""

import sys
import json
import asyncio
import logging
from datetime import datetime

# ========== 导入你原有脚本的核心类 ==========
# 假设你原有的脚本叫 attendance_core.py，把核心代码放进去
# 或者直接把原有的 User 类和 sign_in 函数复制过来

# 这里我把你原有代码的核心部分精简整合：

import base64
from datetime import datetime, timezone, timedelta
import hashlib
import random
import time
from dataclasses import dataclass
from urllib.parse import urlparse
import aiohttp

# ========== 配置常量 ==========
API_BASE_URL = "https://xskq.ahut.edu.cn/api"
WEB_DICT = {
    "token_api": f"{API_BASE_URL}/flySource-auth/oauth/token",
    "task_id_api": f"{API_BASE_URL}/flySource-yxgl/dormSignTask/getStudentTaskPage?userDataType=student&current=1&size=15",
    "auth_check_api": f"{API_BASE_URL}/flySource-base/wechat/getWechatMpConfig?configUrl=https://xskq.ahut.edu.cn/wise/pages/ssgl/dormsign?taskId={{TASK_ID}}&autoSign=1&scanSign=0&userId={{STUDENT_ID}}",
    "apiLog_api": f"{API_BASE_URL}/flySource-base/apiLog/save?menuTitle=%E6%99%9A%E5%AF%9D%E7%AD%BE%E5%88%B0",
    "get_location_api": f"{API_BASE_URL}/flySource-yxgl/dormSignTask/getTaskByIdForApp?taskId={{TASK_ID}}&signDate={{date_str}}",
    "sign_in_api": f"{API_BASE_URL}/flySource-yxgl/dormSignRecord/stuSign",
}

UA_LIST = [
    "Mozilla/5.0 (Linux; Android 15; MIX Fold 4 Build/TKQ1.240502.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/128.0.6613.137 Mobile Safari/537.36 MicroMessenger/8.0.61.2660(0x28003D37) WeChat/arm64 Weixin NetType/WIFI Language/zh_CN ABI/arm64",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.61(0x18003D29) NetType/WIFI Language/zh_CN",
]

# 并发限制
MAX_CONCURRENT = 5
SIGN_IN_LOCK = asyncio.Lock()


@dataclass
class User:
    student_Id: str
    password: str
    username: str = ''
    latitude: float = 0
    longitude: float = 0
    token: str = None
    taskId: str = None
    room_id: str = ""
    _session = None
    
    @property
    def session(self):
        if self._session is None:
            self._session = aiohttp.ClientSession(headers={
                'User-Agent': random.choice(UA_LIST),
                'authorization': "Basic Zmx5c291cmNlX3dpc2VfYXBwOkRBNzg4YXNkVURqbmFzZF9mbHlzb3VyY2VfZHNkYWREQUlVaXV3cWU=",
                'Content-Type': "application/json;charset=UTF-8",
                'X-Requested-With': "com.tencent.mm",
                'Origin': "https://xskq.ahut.edu.cn",
            })
        else:
            if self.token:
                self._session.headers["flysource-auth"] = f"bearer {self.token}"
        return self._session
    
    async def close(self):
        if self._session:
            await self._session.close()


def password_md5(pwd: str) -> str:
    return hashlib.md5(pwd.encode('utf-8')).hexdigest()


def generate_sign(url, token) -> str:
    if not token:
        return ''
    parsed_url = urlparse(url)
    api = parsed_url.path + "?sign="
    timestamp = int(time.time() * 1000)
    inner = f"{timestamp}{token}"
    inner_hash = hashlib.md5(inner.encode("utf-8")).hexdigest()
    raw = f"{api}{inner_hash}"
    final_hash = hashlib.md5(raw.encode("utf-8")).hexdigest()
    encoded_time = base64.b64encode(str(timestamp).encode("utf-8")).decode("utf-8")
    return f"{final_hash}1.{encoded_time}"


def generate_header(user: User, url: str = None) -> dict:
    header = {}
    if user.token:
        header['flysource-auth'] = f"bearer {user.token}"
        if url:
            header['flysource-sign'] = generate_sign(url, user.token)
    return header


def generate_params(user: User):
    return {
        'tenantId': '000000',
        'username': user.student_Id,
        'password': password_md5(user.password),
        'type': 'account',
        'grant_type': 'password',
        'scope': 'all'
    }


def generate_stuTaskId(lat, lng, acc, date, taskId, fileId=""):
    data = {
        "latitude": str(lat),
        "longitude": str(lng),
        "locationAccuracy": str(acc),
        "signDate": date,
        "taskId": taskId,
        "fileId": fileId
    }
    json_str = json.dumps(data, separators=(',', ':'))
    return hashlib.md5(json_str.encode()).hexdigest()


def generate_signCode(timestamp_ms):
    dt = datetime.fromtimestamp(timestamp_ms / 1000, tz=timezone.utc) + timedelta(hours=8)
    week = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
    month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
    w = week[dt.weekday()]
    m = month[dt.month - 1]
    time_str = f"{w} {m} {dt.day:02d} {dt.year} {dt.strftime('%H:%M:%S')} GMT+0800 (中国标准时间)"
    return hashlib.md5(time_str.encode()).hexdigest()


def generate_data(user: User) -> dict:
    signLat = user.latitude + round(random.uniform(-0.01, 0.01), 6)
    signLng = user.longitude + round(random.uniform(-0.01, 0.01), 6)
    locationAccuracy = round(random.uniform(25, 35), 2)
    return {
        "signType": 0,
        "taskId": user.taskId,
        "signLat": signLat,
        "signLng": signLng,
        "locationAccuracy": locationAccuracy,
        "stuTaskId": generate_stuTaskId(signLat, signLng, locationAccuracy, 
                                        datetime.now().strftime('%Y-%m-%d'), user.taskId),
        "scanCode": "",
        "scanType": "",
        "roomId": user.room_id,
        "signKey": user.room_id,
        "signCode": generate_signCode(int(time.time() * 1000)),
    }


def get_time_str():
    return datetime.now().strftime('%Y-%m-%d')


async def sign_in_by_step(user: User, step: int) -> dict:
    """执行单步签到"""
    if step == 0:
        async with user.session.post(
            url=WEB_DICT["token_api"],
            params=generate_params(user),
            headers=generate_header(user)
        ) as resp:
            token_result = await resp.json()
        if 'refresh_token' in token_result:
            user.token = token_result['refresh_token']
            user.username = token_result.get('userName', '')
            return {'success': True, 'msg': '', 'step': step + 1}
        else:
            error_desc = token_result.get('error_description', '未知错误')
            if "Bad credentials" in error_desc:
                error_desc = "密码错误"
            return {'success': False, 'msg': error_desc, 'step': -1}
    
    elif step == 1:
        async with user.session.get(
            url=WEB_DICT['task_id_api'],
            headers=generate_header(user, WEB_DICT['task_id_api'])
        ) as resp:
            task_result = await resp.json()
        if task_result.get('code') == 200:
            records = task_result.get('data', {}).get('records', [])
            if records and records[0].get("taskId"):
                user.taskId = records[0].get("taskId")
                return {'success': True, 'msg': '', 'step': step + 1}
        if "请求未授权" in str(task_result):
            user.token = ''
            return {'success': False, 'msg': 'token失效', 'step': 0}
        return {'success': False, 'msg': task_result.get('msg', '获取taskId失败'), 'step': step}
    
    elif step == 2:
        url = WEB_DICT['auth_check_api'].format(TASK_ID=user.taskId, STUDENT_ID=user.student_Id)
        async with user.session.get(url, headers=generate_header(user, url)) as resp:
            auth_result = await resp.json()
        if auth_result.get('code') == 200:
            return {'success': True, 'msg': '', 'step': step + 1}
        if "请求未授权" in str(auth_result):
            user.token = ''
            return {'success': False, 'msg': 'token失效', 'step': 0}
        return {'success': False, 'msg': auth_result.get('msg', '获取配置失败'), 'step': step}
    
    elif step == 3:
        async with user.session.post(
            url=WEB_DICT["apiLog_api"],
            headers=generate_header(user, WEB_DICT['apiLog_api'])
        ) as resp:
            if resp.status == 200:
                return {'success': True, 'msg': '', 'step': step + 1}
        return {'success': False, 'msg': '开启时间窗口失败', 'step': step}
    
    elif step == 4:
        url = WEB_DICT['get_location_api'].format(
            TASK_ID=user.taskId, 
            date_str=datetime.now().strftime('%Y-%m-%d')
        )
        async with user.session.get(url, headers=generate_header(user, url)) as resp:
            location_result = await resp.json()
        if location_result.get('code') == 200:
            dorm = location_result.get('data', {}).get('dormitoryRegisterVO', {})
            user.latitude = float(dorm.get('locationLat', 31.668))
            user.longitude = float(dorm.get('locationLng', 118.227))
            user.room_id = dorm.get("roomId", "")
            return {'success': True, 'msg': '', 'step': step + 1}
        user.latitude = 31.668
        user.longitude = 118.227
        return {'success': True, 'msg': '使用默认位置', 'step': step + 1}
    
    elif step == 5:
        async with SIGN_IN_LOCK:
            await asyncio.sleep(random.uniform(4, 10))
            async with user.session.post(
                url=WEB_DICT["sign_in_api"],
                json=generate_data(user),
                headers=generate_header(user, WEB_DICT['sign_in_api'])
            ) as resp:
                sign_in_result = await resp.json()
            if sign_in_result.get('code') == 200 or '您今天已完成签到' in sign_in_result.get('msg', ''):
                return {'success': True, 'msg': sign_in_result.get('msg', '签到成功'), 'step': step + 1}
            if "请求未授权" in str(sign_in_result):
                user.token = ''
                return {'success': False, 'msg': 'token失效', 'step': 0}
            return {'success': False, 'msg': sign_in_result.get('msg', '签到失败'), 'step': step}
    
    return {'success': False, 'msg': '未知步骤', 'step': -1}


async def sign_in_single(user: User, max_retries: int = 3) -> dict:
    """为单个用户执行签到"""
    step, retries, token_retries = 0, 0, 0
    error_history = []
    
    while retries < max_retries and 0 <= step < 6:
        result = await sign_in_by_step(user, step)
        step = result['step']
        if not result['success']:
            error_history.append(result['msg'])
            if step == 0 and token_retries < 3:
                token_retries += 1
            else:
                retries += 1
        await asyncio.sleep(random.uniform(0.5, 2))
    
    if step == 6:
        return {'success': True, 'data': error_history, 'message': '签到成功'}
    else:
        return {'success': False, 'data': error_history, 'message': '签到失败: ' + '; '.join(error_history)}


async def sign_in_batch(users_data: list) -> dict:
    """批量签到"""
    users = [User(student_Id=str(u['studentId']), password=u['password']) for u in users_data]
    semaphore = asyncio.Semaphore(MAX_CONCURRENT)
    
    async def limited_sign_in(user):
        async with semaphore:
            return await sign_in_single(user)
    
    results = await asyncio.gather(*(limited_sign_in(u) for u in users))
    await asyncio.gather(*[u.close() for u in users])
    
    return {
        str(users[i].student_Id): {
            'success': result['success'],
            'message': result['message'],
            'errors': result.get('data', [])
        }
        for i, result in enumerate(results)
    }


# ========== 命令行入口 ==========
async def main():
    """从命令行参数读取输入，输出 JSON 结果"""
    try:
        # 从 stdin 读取 JSON 输入
        input_data = json.loads(sys.stdin.read())
        
        action = input_data.get('action', 'sign')
        
        if action == 'sign_single':
            # 单人签到
            user_data = input_data.get('user', {})
            user = User(
                student_Id=str(user_data.get('studentId')),
                password=user_data.get('password')
            )
            result = await sign_in_single(user)
            print(json.dumps({
                'success': result['success'],
                'message': result['message'],
                'data': result.get('data', [])
            }, ensure_ascii=False))
            
        elif action == 'sign_batch':
            # 批量签到
            users_data = input_data.get('users', [])
            result = await sign_in_batch(users_data)
            print(json.dumps({
                'success': True,
                'results': result
            }, ensure_ascii=False))
            
        else:
            print(json.dumps({
                'success': False,
                'message': f'未知操作: {action}'
            }, ensure_ascii=False))
            
    except Exception as e:
        print(json.dumps({
            'success': False,
            'message': str(e)
        }, ensure_ascii=False))


if __name__ == '__main__':
    # 设置日志级别为 WARNING，减少输出
    logging.basicConfig(level=logging.WARNING)
    asyncio.run(main())
