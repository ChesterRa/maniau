// 通知試験用の鍵を、表示せずに .local 内の新しい .env に作る。
// Railway へ渡す時も値を引数や環境変数にせず、標準入力で一つずつ渡す。
import { spawnSync } from 'node:child_process';
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import webpush from 'web-push';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
type Keys = { publicKey: string; privateKey: string };
type Runner = (args: string[], options: { cwd: string; input?: string }) => boolean;

function location(file: string): string {
  if (!file || basename(file) !== '.env') throw new Error('新しい .env のパスを指定してください');
  const root = realpathSync(repository);
  const local = realpathSync(resolve(root, '.local'));
  const localInRoot = relative(root, local);
  if (!localInRoot || localInRoot.startsWith('..') || isAbsolute(localInRoot)) {
    throw new Error('.local はリポジトリの中に置いてください');
  }
  const parent = realpathSync(dirname(resolve(file)));
  const parentInLocal = relative(local, parent);
  if (parentInLocal.startsWith('..') || isAbsolute(parentInLocal)) {
    throw new Error('.env はリポジトリの .local の中に置いてください');
  }
  return resolve(parent, '.env');
}

function validKey(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(value);
}

export function createVapidFile(
  file: string,
  generate: () => Keys = webpush.generateVAPIDKeys,
): void {
  const path = location(file);
  const descriptor = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const keys = generate();
    if (!validKey(keys.publicKey) || !validKey(keys.privateKey))
      throw new Error('鍵を作れませんでした');
    writeFileSync(
      descriptor,
      `VAPID_PUBLIC_KEY=${keys.publicKey}\nVAPID_PRIVATE_KEY=${keys.privateKey}\n`,
      'utf8',
    );
  } finally {
    closeSync(descriptor);
  }
}

function readVapidFile(file: string): Keys {
  const path = location(file);
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(descriptor);
    if (
      !stat.isFile() ||
      (stat.mode & 0o777) !== 0o600 ||
      (process.getuid && stat.uid !== process.getuid())
    ) {
      throw new Error('.env の所有者と権限を確認してください');
    }
    const lines = readFileSync(descriptor, 'utf8').trimEnd().split('\n');
    if (lines.length !== 2) throw new Error('この用途の .env ではありません');
    const publicMatch = /^VAPID_PUBLIC_KEY=([A-Za-z0-9_-]+)$/.exec(lines[0] ?? '');
    const privateMatch = /^VAPID_PRIVATE_KEY=([A-Za-z0-9_-]+)$/.exec(lines[1] ?? '');
    if (!publicMatch?.[1] || !privateMatch?.[1]) throw new Error('この用途の .env ではありません');
    return { publicKey: publicMatch[1], privateKey: privateMatch[1] };
  } finally {
    closeSync(descriptor);
  }
}

const railway: Runner = (args, { cwd, input }) => {
  const result = spawnSync('railway', args, {
    cwd,
    input,
    stdio: ['pipe', 'ignore', 'ignore'],
    timeout: 30_000,
  });
  return result.status === 0 && !result.error;
};

export function sendVapidFile(
  file: string,
  target: { project: string; environment: string; service: string },
  run: Runner = railway,
): void {
  if (
    ![target.project, target.environment, target.service].every((id) =>
      /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id),
    )
  ) {
    throw new Error('project・environment・service を指定してください');
  }
  const path = location(file);
  const keys = readVapidFile(path);
  const cwd = dirname(path);
  if (
    !run(
      [
        'link',
        '--project',
        target.project,
        '--environment',
        target.environment,
        '--service',
        target.service,
      ],
      { cwd },
    )
  ) {
    throw new Error('Railway の接続先を設定できませんでした');
  }
  for (const [name, value] of [
    ['VAPID_PUBLIC_KEY', keys.publicKey],
    ['VAPID_PRIVATE_KEY', keys.privateKey],
  ] as const) {
    if (
      !run(
        [
          'variable',
          'set',
          name,
          '--stdin',
          '--environment',
          target.environment,
          '--service',
          target.service,
          '--skip-deploys',
        ],
        { cwd, input: value },
      )
    ) {
      throw new Error(
        '設定は完了していません。片方だけ設定された可能性があります。再デプロイせず確認してください',
      );
    }
  }
}

function main(args: string[]): void {
  if (args[0] === 'create' && args.length === 2 && args[1]) {
    createVapidFile(args[1]);
    console.log('新しい .env に書きました。');
    return;
  }
  if (args[0] === 'send' && args.length === 5 && args[1] && args[2] && args[3] && args[4]) {
    sendVapidFile(args[1], { project: args[2], environment: args[3], service: args[4] });
    console.log('Railway に設定を送りました。反映はサービス側で確認してください。');
    return;
  }
  throw new Error(
    '使い方：create <新しい .env> または send <.env> <project> <environment> <service>',
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main(process.argv.slice(2));
  } catch {
    // ファイル内容や外部コマンドの出力を表示しない。
    console.error(
      '操作できませんでした。パス、権限、接続先を確認してください。途中で失敗した場合は片方だけ設定された可能性があります。',
    );
    process.exitCode = 1;
  }
}
