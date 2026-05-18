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
import traceback

from datetime import datetime, timezone, timedelta
from dataclasses import dataclass, field
from urllib.parse import urlparse

import aiohttp
from aiohttp.resolver import AsyncResolver


# ================= 配置 =================

API_BASE_URL = "https://xskq.ahut.edu.cn/api"

WEB_DICT = {
    "token_api": f"{API_BASE_URL}/flySource-auth/oauth/token",
    "task_id_api": f"{API_BASE_URL}/flySource-yxgl/dormSignTask/getStudentTaskPage?userDataType=student&current=1&size=15",
    "auth_check_api": f"{API_BASE_URL}/flySource-base/wechat/getWechatMpConfig?configUrl=https://xskq.ahut.edu.cn/wise/pages/ssgl/dormsign?taskId={{TASK_ID}}&autoSign=1&scanSign=0&userId={{STUDENT_ID}}",
    "apiLog_api": f"{API_BASE_URL}/flySource-base/apiLog/save?menuTitle=%E6%99%9A%E5%AF%9D%E7%AD%BE%E5%88%B0",
    "get_location_api": f"{API_BASE_URL}/flySource-yxgl/dormSignTask/getTaskByIdForApp?taskId={{TASK_ID}}&signDate={{date_str}}",
    "sign_in_api": f"{API_BASE_URL}/flySource-yxgl/dormSignRecord/stuSign"
}

AUTHORIZATION = (
    "Basic "
    "Zmx5c291cmNlX3dpc2VfYXBwOkRBNzg4YXNkVURqbmFzZF9mbHlzb3VyY2VfZHNkYWREQUlVaXV3cWU="
)

UA_LIST = [
    "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/128 Mobile MicroMessenger/8.0.61",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 19_0) AppleWebKit/605.1.15 Mobile MicroMessenger/8.0.61"
]

SIGN_IN_LOCK = asyncio.Lock()


# ================= User 类 =================

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
            try:
                resolver = AsyncResolver(
                    nameservers=[
                        "223.5.5.5",
                        "223.6.6.6",
                        "119.29.29.29",
                        "8.8.8.8"          # 新增备用 DNS
                    ]
                )
                connector = aiohttp.TCPConnector(resolver=resolver)
                print("使用自定义 DNS (223.5.5.5, 223.6.6.6, 119.29.29.29, 8.8.8.8)", file=sys.stderr)
            except Exception as e:
                print(f"自定义 DNS 初始化失败: {e}，回退系统默认 DNS", file=sys.stderr)
                connector = aiohttp.TCPConnector()

            # 增加超时时间，应对网络抖动
            timeout = aiohttp.ClientTimeout(
                total=60,
                connect=20,
                sock_connect=20,
                sock_read=30
            )

            self._session = aiohttp.ClientSession(
                connector=connector,
                timeout=timeout,
                headers={
                    "User-Agent": random.choice(UA_LIST),
                    "authorization": AUTHORIZATION,
                    "Content-Type": "application/json;charset=UTF-8",
                    "X-Requested-With": "com.tencent.mm",
                    "Origin": "https://xskq.ahut.edu.cn",
                }
            )

        return self._session

    async def close(self):
        if self._session:
            await self._session.close()


# ================= 工具函数 =================

def password_md5(pwd: str) -> str:
    return hashlib.md5(pwd.encode()).hexdigest()


def generate_params(user: User) -> dict:
    """生成登录表单数据（用于 data=）"""
    return {
        "tenantId": "000000",
        "username": user.student_Id,
        "password": password_md5(user.password),
        "type": "account",
        "grant_type": "password",
        "scope": "all"
    }


def generate_sign(url: str, token: str) -> str:
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
    """每次请求动态生成 headers，不污染 Session"""
    headers = {}
    if user.token:
        headers["flysource-auth"] = f"bearer {user.token}"
        if url:
            headers["flysource-sign"] = generate_sign(url, user.token)
    return headers


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


# ================= 登录（带重试机制）=================

async def login(user: User) -> dict:
    headers = {
        "User-Agent": random.choice(UA_LIST),
        "authorization": AUTHORIZATION,
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Requested-With": "com.tencent.mm",
        "Origin": "https://xskq.ahut.edu.cn",
        "Referer": f"https://xskq.ahut.edu.cn/wise/pages/ssgl/dormsign?userId={user.student_Id}"
    }

    max_retries = 3
    form_data = generate_params(user)

    for attempt in range(max_retries):
        try:
            async with user.session.post(
                url=WEB_DICT["token_api"],
                data=form_data,
                headers=headers
            ) as resp:
                text = await resp.text()
                print(f"[LOGIN] 状态: {resp.status}", file=sys.stderr)
                print(f"[LOGIN] URL: {resp.url}", file=sys.stderr)
                print(f"[LOGIN] 响应体前500字符: {text[:500]}", file=sys.stderr)

                try:
                    result = json.loads(text)
                except Exception:
                    return {
                        "success": False,
                        "msg": f"登录接口返回非JSON: {text[:200]}"
                    }

                if 'refresh_token' in result:
                    user.token = result['refresh_token']
                    user.username = result.get('userName', '')
                    return {"success": True, "msg": ""}
                else:
                    error_msg = result.get("error_description") or result.get("msg", "登录失败")
                    return {"success": False, "msg": error_msg}

        except asyncio.TimeoutError:
            print(f"[LOGIN] 第 {attempt+1} 次尝试超时", file=sys.stderr)
            if attempt < max_retries - 1:
                await asyncio.sleep(2 * (attempt + 1))
                continue
            return {"success": False, "msg": "连接超时，请稍后重试"}

        except Exception as e:
            traceback.print_exc(file=sys.stderr)
            return {"success": False, "msg": str(e)}

    return {"success": False, "msg": "登录失败"}


# ================= 后续步骤（taskId、位置、签到）=================

async def get_task_id(user: User) -> dict:
    async with user.session.get(
        url=WEB_DICT["task_id_api"],
        headers=generate_header(user, WEB_DICT["task_id_api"])
    ) as resp:
        text = await resp.text()
        try:
            result = json.loads(text)
        except Exception:
            return {"success": False, "msg": f"获取taskId返回非JSON: {text[:200]}"}

    if result.get('code') == 200:
        records = result.get('data', {}).get('records', [])
        if records and records[0].get("taskId"):
            user.taskId = records[0].get("taskId")
            return {"success": True, "msg": ""}
    if "请求未授权" in str(result):
        user.token = ''
        return {"success": False, "msg": "token失效", "need_relogin": True}
    return {"success": False, "msg": result.get('msg', '获取taskId失败')}


async def get_auth_config(user: User) -> dict:
    url = WEB_DICT['auth_check_api'].format(TASK_ID=user.taskId, STUDENT_ID=user.student_Id)
    async with user.session.get(
        url=url,
        headers=generate_header(user, url)
    ) as resp:
        text = await resp.text()
        try:
            result = json.loads(text)
        except Exception:
            return {"success": False, "msg": f"获取微信配置返回非JSON: {text[:200]}"}

    if result.get('code') == 200:
        return {"success": True, "msg": ""}
    if "请求未授权" in str(result):
        user.token = ''
        return {"success": False, "msg": "token失效", "need_relogin": True}
    return {"success": False, "msg": result.get('msg', '获取配置失败')}


async def open_api_log(user: User) -> dict:
    async with user.session.post(
        url=WEB_DICT["apiLog_api"],
        headers=generate_header(user, WEB_DICT['apiLog_api'])
    ) as resp:
        if resp.status == 200:
            return {"success": True, "msg": ""}
        return {"success": False, "msg": "开启时间窗口失败"}


async def get_location(user: User) -> dict:
    url = WEB_DICT['get_location_api'].format(
        TASK_ID=user.taskId,
        date_str=datetime.now().strftime('%Y-%m-%d')
    )
    async with user.session.get(
        url=url,
        headers=generate_header(user, url)
    ) as resp:
        text = await resp.text()
        try:
            result = json.loads(text)
        except Exception:
            return {"success": False, "msg": f"获取位置返回非JSON: {text[:200]}"}

    if result.get('code') == 200:
        dorm = result.get('data', {}).get('dormitoryRegisterVO', {})
        user.latitude = float(dorm.get('locationLat', 31.668))
        user.longitude = float(dorm.get('locationLng', 118.227))
        user.room_id = dorm.get("roomId", "")
        return {"success": True, "msg": ""}
    return {"success": False, "msg": result.get('msg', '获取位置失败')}


async def do_sign(user: User) -> dict:
    async with SIGN_IN_LOCK:
        await asyncio.sleep(random.uniform(4, 10))
        async with user.session.post(
            url=WEB_DICT["sign_in_api"],
            json=generate_data(user),
            headers=generate_header(user, WEB_DICT['sign_in_api'])
        ) as resp:
            text = await resp.text()
            try:
                result = json.loads(text)
            except Exception:
                return {"success": False, "msg": f"签到返回非JSON: {text[:200]}"}

        if result.get('code') == 200 or '您今天已完成签到' in result.get('msg', ''):
            return {"success": True, "msg": result.get('msg', '签到成功')}
        if "请求未授权" in str(result):
            user.token = ''
            return {"success": False, "msg": "token失效", "need_relogin": True}
        if '未到签到时间' in result.get('msg', ''):
            return {"success": False, "msg": result.get('msg'), "fatal": True}
        return {"success": False, "msg": result.get('msg', '签到失败')}


# ================= 完整签到流程 =================

async def sign_in_single(user: User, max_retries: int = 3) -> dict:
    # 登录
    login_result = await login(user)
    if not login_result["success"]:
        await user.close()
        return {"success": False, "message": login_result["msg"]}

    step = 1          # 1:taskId, 2:微信配置, 3:时间窗口, 4:位置, 5:签到
    retries = 0

    while retries < max_retries:
        if step == 1:
            result = await get_task_id(user)
            if result.get("need_relogin"):
                relogin = await login(user)
                if not relogin["success"]:
                    return {"success": False, "message": relogin["msg"]}
                continue
            if not result["success"]:
                retries += 1
                await asyncio.sleep(1)
                continue
            step = 2

        elif step == 2:
            result = await get_auth_config(user)
            if result.get("need_relogin"):
                relogin = await login(user)
                if not relogin["success"]:
                    return {"success": False, "message": relogin["msg"]}
                continue
            if not result["success"]:
                retries += 1
                await asyncio.sleep(1)
                continue
            step = 3

        elif step == 3:
            result = await open_api_log(user)
            if not result["success"]:
                retries += 1
                await asyncio.sleep(1)
                continue
            step = 4

        elif step == 4:
            result = await get_location(user)
            if not result["success"]:
                retries += 1
                await asyncio.sleep(1)
                continue
            step = 5

        elif step == 5:
            result = await do_sign(user)
            if result.get("need_relogin"):
                relogin = await login(user)
                if not relogin["success"]:
                    return {"success": False, "message": relogin["msg"]}
                continue
            if result.get("fatal"):
                await user.close()
                return {"success": False, "message": result["msg"]}
            if result["success"]:
                await user.close()
                return {"success": True, "message": result["msg"]}
            else:
                retries += 1
                await asyncio.sleep(2)

    await user.close()
    return {"success": False, "message": "签到失败，已达最大重试次数"}


# ================= 主入口 =================

async def main():
    # 静默 DNS 诊断（不输出错误，只做内部测试）
    try:
        import socket
        socket.gethostbyname_ex("xskq.ahut.edu.cn")
    except Exception:
        pass   # 忽略，自定义 DNS 会接管

    try:
        input_data = json.loads(sys.stdin.read())
        action = input_data.get('action', 'sign_single')

        if action == 'verify':
            user_data = input_data.get('user', {})
            user = User(
                student_Id=str(user_data.get('studentId')),
                password=user_data.get('password', '')
            )
            try:
                result = await login(user)
                if result["success"]:
                    print(json.dumps({
                        "success": True,
                        "username": user.username,
                        "message": "密码正确"
                    }, ensure_ascii=False))
                else:
                    print(json.dumps({
                        "success": False,
                        "message": result["msg"]
                    }, ensure_ascii=False))
            finally:
                await user.close()
            return

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

        else:
            print(json.dumps({
                "success": False,
                "message": f"未知操作: {action}"
            }, ensure_ascii=False))

    except Exception as e:
        traceback.print_exc(file=sys.stderr)
        print(json.dumps({
            "success": False,
            "message": str(e)
        }, ensure_ascii=False))


if __name__ == "__main__":
    asyncio.run(main())
