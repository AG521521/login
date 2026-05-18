#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
考勤脚本执行器
供 Node.js 后端调用
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

    "token_api":
    f"{API_BASE_URL}/flySource-auth/oauth/token",

    "task_id_api":
    f"{API_BASE_URL}/flySource-yxgl/dormSignTask/getStudentTaskPage?userDataType=student&current=1&size=15",

    "auth_check_api":
    f"{API_BASE_URL}/flySource-base/wechat/getWechatMpConfig?configUrl=https://xskq.ahut.edu.cn/wise/pages/ssgl/dormsign?taskId={{TASK_ID}}&autoSign=1&scanSign=0&userId={{STUDENT_ID}}",

    "apiLog_api":
    f"{API_BASE_URL}/flySource-base/apiLog/save?menuTitle=%E6%99%9A%E5%AF%9D%E7%AD%BE%E5%88%B0",

    "get_location_api":
    f"{API_BASE_URL}/flySource-yxgl/dormSignTask/getTaskByIdForApp?taskId={{TASK_ID}}&signDate={{date_str}}",

    "sign_in_api":
    f"{API_BASE_URL}/flySource-yxgl/dormSignRecord/stuSign"

}


AUTHORIZATION = (
    "Basic "
    "Zmx5c291cmNlX3dpc2VfYXBwOkRBNzg4YXNkVURqbmFzZF9mbHlzb3VyY2VfZHNkYWREQUlVaXV3cWU="
)


UA_LIST=[

"Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/128 Mobile MicroMessenger/8.0.61",

"Mozilla/5.0 (iPhone; CPU iPhone OS 19_0) AppleWebKit/605.1.15 Mobile MicroMessenger/8.0.61"

]


SIGN_IN_LOCK=asyncio.Lock()


# ================= DNS诊断 =================

try:

    import socket

    print(
        "=== DNS诊断 ===",
        file=sys.stderr
    )

    print(
        socket.gethostbyname_ex(
            "xskq.ahut.edu.cn"
        ),
        file=sys.stderr
    )

except Exception as e:

    print(
        f"DNS检测异常:{e}",
        file=sys.stderr
    )


# ================= User =================

@dataclass
class User:

    student_Id:str
    password:str

    username:str=''

    latitude:float=0
    longitude:float=0

    token:str=None
    taskId:str=None
    room_id:str=""

    _session:aiohttp.ClientSession=field(
        default=None,
        init=False
    )


    @property
    def session(self):

        if self._session is None:

            try:

                resolver=AsyncResolver(
                    nameservers=[
                        "223.5.5.5",
                        "223.6.6.6",
                        "119.29.29.29"
                    ]
                )

                connector=aiohttp.TCPConnector(
                    resolver=resolver
                )

                print(
                    "使用自定义DNS",
                    file=sys.stderr
                )

            except:

                connector=aiohttp.TCPConnector()

            timeout=aiohttp.ClientTimeout(
                total=30,
                connect=10
            )

            self._session=aiohttp.ClientSession(

                connector=connector,

                timeout=timeout,

                headers={

                    "User-Agent":
                    random.choice(UA_LIST),

                    "authorization":
                    AUTHORIZATION,

                    "X-Requested-With":
                    "com.tencent.mm",

                    "Origin":
                    "https://xskq.ahut.edu.cn"
                }

            )

        return self._session


    async def close(self):

        if self._session:

            await self._session.close()


# ================= 工具函数 =================


def password_md5(pwd):

    return hashlib.md5(
        pwd.encode()
    ).hexdigest()



def generate_header(
        user,
        url=None
):

    headers={}

    if user.token:

        headers[
            "flysource-auth"
        ]=f"bearer {user.token}"

    return headers



def generate_params(user):

    return {

        "tenantId":"000000",

        "username":
        user.student_Id,

        "password":
        password_md5(
            user.password
        ),

        "type":"account",

        "grant_type":
        "password",

        "scope":"all"

    }


# ================= 登录 =================


async def login(user):

    headers={

        "User-Agent":
        random.choice(
            UA_LIST
        ),

        "authorization":
        AUTHORIZATION,

        "Content-Type":
        "application/x-www-form-urlencoded",

        "X-Requested-With":
        "com.tencent.mm",

        "Origin":
        "https://xskq.ahut.edu.cn",

        "Referer":
        f"https://xskq.ahut.edu.cn/wise/pages/ssgl/dormsign?userId={user.student_Id}"

    }

    async with user.session.post(

            url=WEB_DICT[
                "token_api"
            ],

            params=generate_params(
                user
            ),

            headers=headers

    ) as resp:

        text=await resp.text()

        print(
            f"登录状态:{resp.status}",
            file=sys.stderr
        )

        print(
            text,
            file=sys.stderr
        )

        result=json.loads(
            text
        )


    return result


# ================= 主签到 =================


async def sign_in_single(
        user
):

    try:

        token_result=await login(
            user
        )

        if "refresh_token" not in token_result:

            return {

                "success":
                False,

                "message":
                token_result.get(
                    "msg",
                    "登录失败"
                )

            }

        user.token=token_result[
            "refresh_token"
        ]

        return {

            "success":
            True,

            "message":
            "登录成功"

        }

    except Exception as e:

        traceback.print_exc(
            file=sys.stderr
        )

        return {

            "success":
            False,

            "message":
            str(e)

        }

    finally:

        await user.close()



# ================= 入口 =================


async def main():

    try:

        input_data=json.loads(
            sys.stdin.read()
        )

        user_data=input_data.get(
            "user",
            {}
        )

        user=User(

            student_Id=str(
                user_data.get(
                    "studentId"
                )
            ),

            password=user_data.get(
                "password",
                ""
            )

        )

        result=await sign_in_single(
            user
        )

        print(
            json.dumps(
                result,
                ensure_ascii=False
            )
        )

    except Exception as e:

        print(
            json.dumps({

                "success":
                False,

                "message":
                str(e)

            },
            ensure_ascii=False
            )
        )


if __name__=="__main__":

    asyncio.run(main())
