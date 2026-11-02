"""フックの試験：.claude/hooks/guard-paths.py と、scripts/git-hooks/ の pre-commit・commit-msg。

実行：python3 -m unittest discover -s tests/hooks
標準ライブラリと git だけを使う。作業の場所は、試験ごとに作って消す。
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
# フックは /tmp を通すので、偽のホームは /tmp の外（Git の対象外の場所）に作る
WORK = ROOT / "tests" / "hooks" / ".work"
CLAUDE_TRAILER = "Co-Authored-By: Claude <noreply@anthropic.com>"


class GuardPathsTest(unittest.TestCase):
    """偽のホームの下に、このリポジトリ・材料の置き場所・他のリポジトリを作って確かめる。"""

    @classmethod
    def setUpClass(cls) -> None:
        WORK.mkdir(parents=True, exist_ok=True)
        cls.tmp = Path(tempfile.mkdtemp(dir=WORK)).resolve()
        cls.home = cls.tmp / "home"
        cls.repo = cls.home / "dev" / "maniau"
        (cls.repo / ".claude" / "hooks").mkdir(parents=True)
        shutil.copy(ROOT / ".claude" / "hooks" / "guard-paths.py", cls.repo / ".claude" / "hooks")
        (cls.repo / "docs").mkdir()
        (cls.repo / "README.md").write_text("x\n")
        (cls.home / "dev" / "maniau-private").mkdir()
        (cls.home / "dev" / "maniau-private" / "note.txt").write_text("x\n")
        (cls.home / "dev" / "other").mkdir()
        (cls.home / "dev" / "other" / "README.md").write_text("x\n")
        (cls.home / "secret.txt").write_text("x\n")
        cls.memory = cls.home / ".claude" / "projects" / re.sub(r"[^A-Za-z0-9]", "-", str(cls.repo))
        cls.env = {**os.environ, "HOME": str(cls.home)}
        cls.env.pop("MANIAU_PRIVATE_DIR", None)

    @classmethod
    def tearDownClass(cls) -> None:
        shutil.rmtree(cls.tmp)

    def guard(self, tool: str, tool_input: object, cwd: Path | None = None, raw: str | None = None) -> int:
        payload = raw if raw is not None else json.dumps(
            {"tool_name": tool, "tool_input": tool_input, "cwd": str(cwd or self.repo)}
        )
        result = subprocess.run(
            [sys.executable, str(self.repo / ".claude" / "hooks" / "guard-paths.py")],
            input=payload, capture_output=True, text=True, env=self.env, cwd=self.repo,
        )
        return result.returncode

    def check(self, cases: list[tuple], expected: int) -> None:
        for case in cases:
            with self.subTest(case=case):
                self.assertEqual(self.guard(*case), expected)

    def test_blocks_paths_outside(self) -> None:
        home = self.home
        self.check([
            ("Bash", {"command": "ls ~/dev"}),
            ("Bash", {"command": "ls ~"}),
            ("Bash", {"command": "cat $HOME/secret.txt"}),
            ("Bash", {"command": f"cat {home}/dev/other/README.md"}),
            ("Bash", {"command": "cd .. && ls"}),
            ("Bash", {"command": "echo x > ../new.txt"}),
            ("Bash", {"command": "ls ../other"}),
            ("Bash", {"command": "ls /mnt/c"}),
            ("Bash", {"command": "NOTE=~/secret.txt env"}),
            ("Read", {"file_path": f"{home}/dev/other/README.md"}),
            ("Write", {"file_path": f"{home}/dev/other/new.txt", "content": "x"}),
            ("Glob", {"pattern": "~/dev/**"}),
            ("Grep", {"pattern": "x", "path": f"{home}/dev/other"}),
            ("mcp__srv__tool", {"file_path": f"{home}/dev/other/README.md"}),
            ("Read", {"file_path": f"{home}/.claude/projects/-other/memory/x.md"}),
        ], 2)

    def test_allows_paths_inside_and_plain_text(self) -> None:
        repo, home = self.repo, self.home
        self.check([
            ("Bash", {"command": "ls docs"}),
            ("Bash", {"command": 'grep -rn "../design/01-model.md" docs/'}),
            ("Bash", {"command": "git commit -m '../research/03 を直す'"}),
            ("Bash", {"command": "awk '$3 ~ /foo/' README.md"}),
            ("Bash", {"command": "[[ $x =~ ^a ]] && echo y"}),
            ("Bash", {"command": 'echo "5 ~ 10"'}),
            ("Bash", {"command": "cat ~/dev/maniau-private/note.txt"}),
            ("Bash", {"command": "ls ../maniau-private"}),
            ("Bash", {"command": "ls /usr/bin /tmp"}),
            ("Read", {"file_path": f"{repo}/README.md"}),
            ("Read", {"file_path": f"{repo}/README.md"}, repo / "docs"),
            ("Read", {"file_path": "README.md"}),
            ("Write", {"file_path": f"{self.memory}/memory/x.md", "content": "x"}),
            ("mcp__srv__tool", {"text": f"{home}/dev/other"}),
        ], 0)

    def test_blocks_when_input_cannot_be_checked(self) -> None:
        self.assertEqual(self.guard("Bash", {"command": None}), 2)
        self.assertEqual(self.guard("Bash", None, raw="{not json"), 2)


class GitHooksTest(unittest.TestCase):
    """一時のリポジトリに、このリポジトリのフックを入れて、コミットを試す。"""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp())
        self.repo = self.tmp / "repo"
        self.private = self.tmp / "private"
        self.private.mkdir()
        (self.private / "notice.txt").write_text("実在のおたより\n")
        self.repo.mkdir()
        # フックはリポジトリの外に置く（試験の後始末の git clean で消えないように）
        hooks = self.tmp / "hooks"
        hooks.mkdir()
        for name in ("pre-commit", "commit-msg"):
            shutil.copy(ROOT / "scripts" / "git-hooks" / name, hooks / name)
        self.env = {
            **os.environ,
            "HOME": str(self.tmp),
            "GIT_CONFIG_NOSYSTEM": "1",
            "MANIAU_PRIVATE_DIR": str(self.private),
        }
        self.env.pop("CLAUDECODE", None)
        self.git("init", "-q", "-b", "main")
        self.git("config", "user.name", "test")
        self.git("config", "user.email", "1+test@users.noreply.github.com")
        self.git("config", "core.hooksPath", str(hooks))
        self.git("config", "commit.gpgsign", "false")
        self.assertEqual(self.commit({"README.md": "x\n"}).returncode, 0)

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp)

    def git(self, *args: str, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
        return subprocess.run(["git", *args], cwd=self.repo, env=env or self.env, capture_output=True, text=True)

    def commit(self, files: dict[str, str | bytes], message: str = "試験", env: dict[str, str] | None = None):
        for name, content in files.items():
            path = self.repo / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(content if isinstance(content, bytes) else content.encode())
            self.git("add", "-f", "--", name)
        return self.git("commit", "-q", "-m", message, env=env)

    def blocked(self, files: dict[str, str | bytes]) -> bool:
        result = self.commit(files)
        self.git("reset", "-q", "--hard", "HEAD")
        self.git("clean", "-fdqx")
        return result.returncode != 0

    def last_message(self) -> str:
        return self.git("log", "-1", "--format=%B").stdout

    def test_allows_ordinary_files(self) -> None:
        self.assertFalse(self.blocked({"docs/a.md": "おたより\n", ".env.example": "KEY=\n", "a.jpg": b"\xff\xd8"}))

    def test_blocks_local_only_and_secret_files(self) -> None:
        for name in (".env", ".env.local", ".envrc", ".local/x.md", "web/.local/x.md", "private/x.md",
                     "AGENTS.md", "CLAUDE.md", "docs/CLAUDE.md", "CLAUDE.local.md", ".claude/settings.local.json"):
            with self.subTest(name=name):
                self.assertTrue(self.blocked({name: "x\n"}))

    def test_blocks_media_and_databases(self) -> None:
        for name in ("v.mp4", "V.MP4", "a.m4a", "p.HEIC", "data/events.sqlite3", "events.db", "events.db-wal"):
            with self.subTest(name=name):
                self.assertTrue(self.blocked({name: b"x"}))

    def test_blocks_large_files(self) -> None:
        self.assertTrue(self.blocked({"big.bin": b"0" * (5 * 1024 * 1024 + 1)}))

    def test_blocks_keys_even_in_a_long_diff(self) -> None:
        # 以前は、パイプの途中で grep -q が先に終わると、鍵を見逃した
        key = "sk-ant-" + "a" * 40
        self.assertTrue(self.blocked({"a.txt": key + "\n" + ("x" * 100 + "\n") * 3000}))
        self.assertTrue(self.blocked({"b.txt": "token = ghp_" + "b" * 36 + "\n"}))

    def test_blocks_copies_of_real_family_material(self) -> None:
        self.assertTrue(self.blocked({"data/copy.txt": "実在のおたより\n"}))

    def test_blocks_personal_author_email(self) -> None:
        self.git("config", "user.email", "someone@example.com")
        self.assertTrue(self.blocked({"docs/b.md": "x\n"}))

    def test_trailer_only_inside_claude_code(self) -> None:
        self.assertEqual(self.commit({"a.md": "1\n"}).returncode, 0)
        self.assertNotIn(CLAUDE_TRAILER, self.last_message())
        claude = {**self.env, "CLAUDECODE": "1"}
        self.assertEqual(self.commit({"b.md": "2\n"}, env=claude).returncode, 0)
        self.assertEqual(self.last_message().count(CLAUDE_TRAILER), 1)

    def test_trailer_not_duplicated_and_kept_last(self) -> None:
        claude = {**self.env, "CLAUDECODE": "1"}
        named = "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
        self.assertEqual(self.commit({"a.md": "1\n"}, f"題\n\n本文\n\n{named}", env=claude).returncode, 0)
        self.assertEqual(self.last_message().count("noreply@anthropic.com"), 1)
        self.assertEqual(self.commit({"b.md": "2\n"}, "題\n\n---\n本文", env=claude).returncode, 0)
        self.assertEqual(self.last_message().strip().splitlines()[-1], CLAUDE_TRAILER)

    def test_empty_message_still_aborts(self) -> None:
        claude = {**self.env, "CLAUDECODE": "1"}
        self.assertNotEqual(self.commit({"a.md": "1\n"}, "", env=claude).returncode, 0)


if __name__ == "__main__":
    unittest.main()
