#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
考勤脚本执行器 - 供 Node.js 后端调用
"""

import sys
import json
import asyncio
import hashlib
import base64
import random
import time
from datetime import datetime, timezone, timedelta
from dataclasses import dataclass, field
from urllib.parse import urlparse
import aiohttp
from aiohttp.resolver import AsyncResolver

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

SIGN_IN_LOCK = asyncio.Lock()

# ========== DNS 诊断（输出到 stderr）==========
try:
    import socket
    print("=== DNS 诊断（自定义解析器前）===", file=sys.stderr)
    hostname = "xskq.ahut.edu.cn"
    print("getaddrinfo:", socket.getaddrinfo(hostname, 443), file=sys.stderr)
    print("gethostbyname_ex:", socket.gethostbyname_ex(hostname), file=sys.stderr)
except Exception as e:
    print(f"系统 DNS 解析异常: {e}", file=sys.stderr)


# ========== User 类 ==========
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

    _session: aiohttp.ClientSession = field(default=None, init=False)

    @property
    def session(self):
        if self._session is None:
            # 创建自定义 DNS 解析器（使用国内公共 DNS）
            try:
                resolver = AsyncResolver(
                    nameservers=[
                        "223.5.5.5",   # 阿里 DNS
                        "223.6.6.6",
                        "119.29.29.29" # 腾讯 DNS
                    ]
                )
                connector = aiohttp.TCPConnector(resolver=resolver)
                print("使用自定义 DNS (223.5.5.5, 223.6.6.6, 119.29.29.29)", file=sys.stderr)
            except Exception as e:
                print(f"自定义 DNS 初始化失败: {e}，回退系统默认 DNS", file=sys.stderr)
                connector = aiohttp.TCPConnector()

            timeout = aiohttp.ClientTimeout(total=30, connect=10)

            self._session = aiohttp.ClientSession(
                connector=connector,
                timeout=timeout,
                headers={
                    'User-Agent': random.choice(UA_LIST),
                    'authorization': "Basic Zmx5b3VyY2Vfd2lzZV9hcHA6REE3ODhhc2RVREpuYXNkX2ZseXNvdXJjZV9kc2RhZERBSVVpdXd3cWU=",
                    'Content-Type': "application/json;charset=UTF-8",
                    'X-Requested-With': "com.tencent.mm",
                    'Origin': "https://xskq.ahut.edu.cn",
                }
            )

        if self.token:
            self._session.headers["flysource-auth"] = f"bearer {self.token}"

        return self._session

    async def close(self):
        if self._session:
            await self._session.close()


# ========== 辅助函数 ==========
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


# ========== 签到步骤 ==========
async def sign_in_by_step(user: User, step: int) -> dict:
    """执行单步签到"""
    print(f"[DEBUG] 执行步骤 {step}", file=sys.stderr)

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
            if '未到签到时间' in sign_in_result.get('msg', ''):
                return {'success': False, 'msg': sign_in_result.get('msg'), 'step': -1}
            return {'success': False, 'msg': sign_in_result.get('msg', '签到失败'), 'step': step}
    
    return {'success': False, 'msg': '未知步骤', 'step': -1}


async def sign_in_single(user: User, max_retries: int = 3) -> dict:
    """为单个用户执行签到"""
    step, retries, token_retries = 0, 0, 0
    error_history = []
    
    try:
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
    except Exception as e:
        import traceback
        traceback.print_exc(file=sys.stderr)
        return {'success': False, 'errors': [str(e)], 'message': f'签到异常: {str(e)}'}
    
    await user.close()
    
    if step == 6:
        return {'success': True, 'errors': error_history, 'message': '签到成功'}
    else:
        return {'success': False, 'errors': error_history, 'message': '签到失败: ' + '; '.join(error_history[-3:])}


# ========== 命令行入口 ==========
async def main():
    try:
        input_data = json.loads(sys.stdin.read())
        action = input_data.get('action', 'sign_single')

        # 验证密码
        if action == 'verify':
            user_data = input_data.get('user', {})
            user = User(
                student_Id=str(user_data.get('studentId')),
                password=user_data.get('password', '')
            )
            try:
                async with user.session.post(
                    url=WEB_DICT["token_api"],
                    params=generate_params(user),
                    headers=generate_header(user)
                ) as resp:
                    token_result = await resp.json()

                if 'refresh_token' in token_result:
                    print(json.dumps({
                        'success': True,
                        'username': token_result.get('userName', ''),
                        'message': '密码正确'
                    }, ensure_ascii=False))
                else:
                    error_desc = token_result.get('error_description', '未知错误')
                    if "Bad credentials" in error_desc:
                        error_desc = "学号或密码错误"
                    print(json.dumps({
                        'success': False,
                        'message': error_desc
                    }, ensure_ascii=False))
            finally:
                await user.close()
            return

        # 正式签到
        elif action == 'sign_single':
            user_data = input_data.get('user', {})
            user = User(
                student_Id=str(user_data.get('studentId')),
                password=user_data.get('password', '')
            )
            result = await sign_in_single(
                user,
                max_retries=input_data.get('maxRetries', 3)
            )
            print(json.dumps(result, ensure_ascii=False))
            return

        # 未知操作
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
    asyncio.run(main())
