# Maniau (working title)

[日本語](README.md)

Maniau is an app in development that helps families turn school notices into decisions and next steps: what needs deciding, by when, and who can act. It keeps track of what someone has taken on, whose reply is pending, and what becomes unnecessary when plans change. The family makes the choices and contacts people themselves.

An entry for Built with Claude: Japan 2026.

## Try the demo

You need Node.js 24 or later and pnpm 11.

```sh
pnpm install
pnpm dev
```

Open [http://localhost:5173](http://localhost:5173). The web app normally uses port 5173 and the server uses port 8787. If the web app starts on another port, open the URL shown in the terminal. The server cannot start if port 8787 is already in use. Without the family database and Access environment variables, the app starts in demo mode.

The demo uses a fictional household and school notices; it needs no API key or database. Use the scene and viewer selectors at the top to explore a new notice, a pending reply and backup option, and cancellation messages after a postponement. Each scene starts from a prepared state. Actions are kept in server memory and are not persisted.

The demo uses Claude responses recorded in advance from fictional text. It does not call the Claude API while you use it. If a recording is unavailable, it uses a hand-written reading and identifies that on screen.

## What it does

- **Work out decision deadlines:** Suggest options and next tasks for childcare and purchases using the household's schedule and deadlines. Times and travel estimates depend on the information provided.
- **Let family members take on tasks:** Propose a task to another adult and record whether they accept or decline. A request awaiting a reply is kept distinct from a confirmed one.
- **Respond to changes:** Remove preparations that are no longer needed and draft cancellation messages for people who were already contacted. The family sends the messages.
- **Return to the original text:** Review the notice and the extracted items. The interface is available in Japanese and English.

The project includes a Claude-based text extraction component, a TypeScript planning engine, and a verifier written separately from the engine. The verifier checks plan and notification conditions and is also used before sending notifications. Family mode includes Cloudflare Access identity verification, Postgres storage, and Web Push sending.

## Not yet available or verified

- Adding a new notice from the interface and taking a photo for extraction are still in development. The demo uses prepared notices.
- The combination of an iPhone home-screen app, Cloudflare Access, and Web Push has not yet been verified on a real device. A push provider accepting a notification does not prove that a person received or read it.
- Do not enter real family data until authentication, deletion, notifications, and related safeguards have been checked in the actual environment. See the [foundation design](docs/design/02-foundation.md) for the requirements.
- Demo shops, opening hours, and travel times use prepared example data. Inventory, actual opening hours, routes, and arrival times are not guaranteed.

## Development

```sh
pnpm check
node --test eval/test/*.test.mjs
```

`pnpm check` runs formatting checks, type checks, and package tests. Tests and the demo run without an API key.

If you plan to commit changes, enable the repository checks once after cloning. You can test the hooks themselves with `python3 -m unittest discover -s tests/hooks`.

```sh
git config core.hooksPath scripts/git-hooks
```

| Path | Contents |
|---|---|
| [apps/web](apps/web) | Mobile-first interface |
| [apps/server](apps/server) | API, storage, notifications, and Claude extraction |
| [packages/core](packages/core) | Fact types, time, and planning engine |
| [packages/verify](packages/verify) | Independent verifier |
| [data/demo](data/demo) | Fictional household and notices |
| [eval](eval) | Boundary cases and comparison tooling |

For details, see the [model design](docs/design/01-model.md), [foundation design](docs/design/02-foundation.md), and [product plan](docs/plan/02-product.md).

## License

[MIT](LICENSE)
