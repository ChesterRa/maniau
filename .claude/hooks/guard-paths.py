#!/usr/bin/env python3
"""Claude Code の PreToolUse フック：このリポジトリの外を指すパスへの道具の使用を止める。

止める場所：ホームの下と /mnt/（Windows 側のドライブ）。ただし次は通す。
  このリポジトリ、実在の家族の材料の置き場所（既定は ~/dev/maniau-private。
  環境変数 MANIAU_PRIVATE_DIR で変えられる）、
  このリポジトリ用の Claude Code の記憶（~/.claude/projects/<このリポジトリ>/）。
ホームの外（/tmp やシステムの場所）は、もとから止めない。
見るのは、道具の引数のパスと、Bash のコマンドに書かれたパスだけである。変数で組み立てたパス等は見抜けない。
.. と ~ で始まる語は、文字列の一部のこともあるので、指す物（か、その親）が実在する時だけ止める。
リポジトリの場所は、このファイルの置き場所から決める。
Claude Code をサブディレクトリで起動すると、このフックは読み込まれない（リポジトリの直下で起動する）。
確かめられない時（入力が壊れている等）は、通さない。
"""
from __future__ import annotations

import json
import os
import re
import shlex
import sys
from pathlib import Path

REPO = str(Path(__file__).resolve().parents[2])
PATH_STOP = r"[^\s'\"`;|&<>()]*"
PATH_KEY = re.compile(r"path|file|dir|cwd|root", re.IGNORECASE)
ASSIGN = re.compile(r"^(?:[A-Za-z_]\w*|--?[\w-]+)=(.*)$", re.DOTALL)


def block(message: str) -> int:
    print(f"止めました：{message}", file=sys.stderr)
    return 2


def path_values(value: object, key: str = "") -> list[str]:
    """MCP の道具の引数から、名前に path・file・dir 等を含む物の値を集める。"""
    if isinstance(value, dict):
        return [p for k, v in value.items() for p in path_values(v, str(k))]
    if isinstance(value, list):
        return [p for v in value for p in path_values(v, key)]
    if isinstance(value, str) and PATH_KEY.search(key):
        return [value]
    return []


def main() -> int:
    data = json.load(sys.stdin)
    tool = data.get("tool_name", "")
    args = data.get("tool_input") or {}
    if not isinstance(args, dict):
        raise ValueError("tool_input が辞書ではない")
    cwd = data.get("cwd") or os.getcwd()
    home = os.path.realpath(os.path.expanduser("~"))
    private = os.path.realpath(
        os.path.expanduser(os.environ.get("MANIAU_PRIVATE_DIR", "~/dev/maniau-private"))
    )
    allowed = [
        REPO,
        private,
        os.path.join(home, ".claude", "projects", re.sub(r"[^A-Za-z0-9]", "-", REPO)),
    ]

    def resolve(raw: str) -> str:
        p = os.path.expandvars(os.path.expanduser(raw.strip()))
        return os.path.realpath(p if os.path.isabs(p) else os.path.join(cwd, p))

    def guarded(p: str) -> bool:
        if any(p == a or p.startswith(a + os.sep) for a in allowed):
            return False
        return p == home or p.startswith(home + os.sep) or p == "/mnt" or p.startswith("/mnt/")

    explicit: list[str] = []  # 書かれたとおりのパス。外を指せば止める
    loose: list[str] = []  # 文字列の一部かもしれない語。指す物か、その親が実在する時だけ止める

    if tool == "Bash":
        cmd = args.get("command")
        if not isinstance(cmd, str):
            raise ValueError("command が文字列ではない")
        explicit += re.findall(r"\$\{?HOME\}?" + PATH_STOP, cmd)
        explicit += re.findall(r"(?<![\w.])(?:" + re.escape(home) + r"|/mnt)(?:/" + PATH_STOP + r")?", cmd)
        try:
            tokens = shlex.split(cmd)
        except ValueError:
            tokens = cmd.split()
        for token in tokens:
            m = ASSIGN.match(token)
            for word in (token, m.group(1)) if m else (token,):
                if word == "~" or word.startswith("~/") or word == ".." or word.startswith("../") or "/../" in word:
                    loose.append(word)
    elif tool.startswith("mcp__"):
        for value in path_values(args):
            if value.startswith(("/", "~", "$HOME", "${HOME}")):
                explicit.append(value)
            elif value.startswith(".."):
                loose.append(value)
    else:
        for key in ("file_path", "notebook_path", "path"):
            value = args.get(key)
            if isinstance(value, str) and value:
                explicit.append(value)
        pattern = args.get("pattern")
        if tool == "Glob" and isinstance(pattern, str) and pattern.startswith(("/", "~", "..")):
            explicit.append(re.split(r"[*?\[{]", pattern, maxsplit=1)[0] or "/")

    hits = [p for p in map(resolve, explicit) if guarded(p)]
    hits += [
        p
        for p in map(resolve, loose)
        if guarded(p) and (os.path.exists(p) or os.path.exists(os.path.dirname(p)))
    ]
    if hits:
        return block(
            f"このリポジトリの外（{hits[0]}）に触れる操作です。"
            "触れてよいのは、このリポジトリ、実在の家族の材料の置き場所、/tmp です"
            "（docs/dev/repository.md）。必要なら作り手に頼んでください。"
        )
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:  # 確かめられない時は通さない
        sys.exit(block(f"guard-paths.py が入力を確かめられませんでした（{e}）。フックを直してから続けてください。"))
