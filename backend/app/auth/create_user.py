# -*- coding: utf-8 -*-
"""管理员开号 / 重置密码 CLI（无 SMTP，07 §1/§10）。

    cd backend && uv run python -m app.auth.create_user admin@example.com --superuser
    cd backend && uv run python -m app.auth.create_user admin@example.com --superuser --setup-link https://paper.example.com
    cd backend && uv run python -m app.auth.create_user someone@example.com --reset

DB 位置随 PATENT_PROJECTS_DIR（同级 studio.db）；不需要 PATENT_STUDIO_AUTH=on 或 PATENT_STUDIO_SECRET。
第一个用户自动 superuser。密码默认交互输入，不回显；设置链接仅由服务器控制台签发。
"""

import argparse
import asyncio
import getpass
import secrets
import sys
from urllib.parse import quote, urlsplit

from fastapi_users.db import SQLAlchemyUserDatabase

from app import config
from app.auth.db import SessionLocal, UserManager, init_db
from app.auth.models import User
from app.auth.schemas import UserCreate


class ProvisioningManager(UserManager):
    setup_token = ""

    async def on_after_forgot_password(self, user, token, request=None):
        self.setup_token = token


async def _run(args) -> int:
    if args.setup_link:
        url = urlsplit(args.setup_link)
        if url.scheme not in ("http", "https") or not url.netloc or url.query or url.fragment:
            print("--setup-link 请填写站点地址，如 https://paper.example.com", file=sys.stderr)
            return 1
        if not config.AUTH_ON or len(config.AUTH_SECRET) < 32:
            print("设置链接需要启用账号并配置至少 32 字符的 PATENT_STUDIO_SECRET", file=sys.stderr)
            return 1
    await init_db()
    async with SessionLocal() as session:
        manager = ProvisioningManager(SQLAlchemyUserDatabase(session, User))
        existing = await manager.user_db.get_by_email(args.email)
        if args.promote:
            if existing is None:
                print("用户不存在，请先注册或创建账号", file=sys.stderr)
                return 1
            await manager.user_db.update(existing, {"is_superuser": True})
            print(f"已设为平台管理员：{existing.email}")
            return 0
        if args.setup_link and existing is not None:
            if not args.reset:
                print("用户已存在，签发设置链接请加 --reset；原密码不会自动更改", file=sys.stderr)
                return 1
            user = existing
            if args.superuser:
                await manager.user_db.update(user, {"is_superuser": True})
        elif args.setup_link:
            user = await manager.create(UserCreate(email=args.email, password=secrets.token_urlsafe(48),
                                                  display_name=args.display_name, is_superuser=args.superuser))
        else:
            user = None
        if args.setup_link:
            await manager.forgot_password(user)
            print(f"账号：{user.email}；密码设置链接有效期 1 小时，成功使用后失效。请勿提交或公开此链接。")
            print(args.setup_link.rstrip("/") + "/#/login?setup=" + quote(manager.setup_token))
            return 0
        if args.reset:
            if existing is None:
                print(f"用户不存在：{args.email}", file=sys.stderr)
                return 1
            await manager.user_db.update(existing, {"hashed_password": manager.password_helper.hash(args.password)})
            print(f"已重置密码：{existing.email}")
            return 0
        if existing is not None:
            print(f"用户已存在：{args.email}（重置密码加 --reset）", file=sys.stderr)
            return 1
        user = await manager.create(
            UserCreate(
                email=args.email, password=args.password, display_name=args.display_name, is_superuser=args.superuser
            )
        )
        await session.refresh(user)
        print(f"已创建：{user.email} superuser={user.is_superuser} db={config.DB_PATH}")
        return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        prog="python -m app.auth.create_user", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("email")
    ap.add_argument("password", nargs="?", help="省略时安全提示输入，不回显；推荐省略")
    ap.add_argument("--display-name", default="")
    ap.add_argument("--superuser", action="store_true", help="强制 superuser（第一个用户本就自动是）")
    ap.add_argument("--reset", action="store_true", help="已存在用户：重置密码")
    ap.add_argument("--promote", action="store_true", help="将已有账号设为平台管理员，不改密码")
    ap.add_argument("--setup-link", metavar="BASE_URL", help="签发一次性密码设置链接，无需输入密码")
    args = ap.parse_args(argv)
    if args.promote and (args.reset or args.setup_link or args.password):
        ap.error("--promote 不与改密或设置链接同时使用")
    if not args.promote and not args.setup_link and not args.password:
        args.password = getpass.getpass("设置密码（至少 8 位）：")
        if args.password != getpass.getpass("再次输入："):
            ap.error("两次密码不一致")
    if args.password and len(args.password) < 8:
        ap.error("密码至少 8 位")
    return asyncio.run(_run(args))


if __name__ == "__main__":
    sys.exit(main())
