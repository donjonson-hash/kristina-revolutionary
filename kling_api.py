"""
Kling AI API — JWT с nbf
"""
import asyncio
import logging
import os
import time
import json
import hmac
import hashlib
import base64
from typing import Optional
import aiohttp

logger = logging.getLogger(__name__)

class KlingAPI:
    def __init__(self):
        self.access_key = os.getenv("KLING_ACCESS_KEY")
        self.secret_key = os.getenv("KLING_SECRET_KEY")
        self.base_url = "https://api.klingai.com/v1/images"
        
        if not self.access_key or not self.secret_key:
            logger.error("❌ Ключи не заданы!")
        else:
            logger.info("✅ Kling API готов")
    
    def _generate_jwt(self) -> str:
        """Генерация JWT с nbf (Not Before)"""
        try:
            import jwt
            now = int(time.time())
            payload = {
                "iss": self.access_key,
                "iat": now,           # Issued at
                "nbf": now,           # Not before (ОБЯЗАТЕЛЬНО!)
                "exp": now + 3600     # Expiration
            }
            token = jwt.encode(payload, self.secret_key, algorithm="HS256")
            return token
        except ImportError:
            return self._generate_jwt_manual()
    
    def _generate_jwt_manual(self) -> str:
        """Ручная генерация JWT с nbf"""
        now = int(time.time())
        
        header = base64.urlsafe_b64encode(json.dumps({
            "alg": "HS256",
            "typ": "JWT"
        }).encode()).decode().rstrip("=")
        
        payload = base64.urlsafe_b64encode(json.dumps({
            "iss": self.access_key,
            "iat": now,
            "nbf": now,  # ОБЯЗАТЕЛЬНО!
            "exp": now + 3600
        }).encode()).decode().rstrip("=")
        
        signature = hmac.new(
            self.secret_key.encode(),
            f"{header}.{payload}".encode(),
            hashlib.sha256
        ).digest()
        sig = base64.urlsafe_b64encode(signature).decode().rstrip("=")
        
        return f"{header}.{payload}.{sig}"
    
    async def generate(self, prompt: str, width=1024, height=1024, aspect_ratio: str = None) -> Optional[str]:
        """Генерация изображения с поддержкой aspect_ratio (9:16, 16:9, 1:1)"""
        if not self.access_key or not self.secret_key:
            return None
        
        token = self._generate_jwt()
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}"
        }
        
        # Для iPhone 9:16 вертикальный формат (сториз, рилс)
        if aspect_ratio == "9:16":
            width, height = 1080, 1920
        elif aspect_ratio == "16:9":
            width, height = 1920, 1080
        elif aspect_ratio == "1:1":
            width, height = 1024, 1024
        
        data = {
            "model_name": "kling-v2-1",
            "prompt": prompt[:900],
            "negative_prompt": "blurry, low quality, distorted face, ugly, deformed",
            "width": width,
            "height": height,
            "n": 1
        }
        
        url = f"{self.base_url}/generations"
        logger.info(f"🎨 POST {url}")
        
        try:
            async with aiohttp.ClientSession() as s:
                async with s.post(url, headers=headers, json=data, timeout=60) as r:
                    text = await r.text()
                    logger.info(f"📡 {r.status}: {text[:300]}")
                    
                    if r.status != 200:
                        logger.error(f"❌ HTTP {r.status}")
                        return None
                    
                    resp = json.loads(text)
                    if resp.get("code") != 0:
                        logger.error(f"❌ API {resp.get('code')}: {resp.get('message')}")
                        return None
                    
                    task_id = resp.get("data", {}).get("task_id")
                    if not task_id:
                        logger.error("❌ Нет task_id")
                        return None
                    
                    logger.info(f"✅ Task: {task_id}")
                    return await self._wait_result(s, headers, task_id)
                    
        except Exception as e:
            logger.error(f"❌ Exception: {e}")
            return None
    
    async def _wait_result(self, session, headers, task_id, max_try=30):
        url = f"{self.base_url}/generations/{task_id}"
        for i in range(max_try):
            try:
                async with session.get(url, headers=headers, timeout=10) as r:
                    resp = json.loads(await r.text())
                    status = resp.get("data", {}).get("task_status")
                    logger.info(f"⏳ {i+1}: {status}")
                    
                    if status == "succeed":
                        images = resp.get("data", {}).get("task_result", {}).get("images", [])
                        if images:
                            url = images[0].get("url")
                            logger.info(f"✅ Готово!")
                            return url
                    elif status == "failed":
                        logger.error("❌ Failed")
                        return None
                    await asyncio.sleep(2)
            except Exception as e:
                await asyncio.sleep(2)
        logger.error("❌ Таймаут")
        return None

_kling = None
def get_kling_api():
    global _kling
    if _kling is None:
        _kling = KlingAPI()
    return _kling
