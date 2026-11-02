# Maniau

[日本語](README.md)

**Turns nursery and school notices into clear next steps for the family: what to decide, by when, and who does it.**

Putting an event in a calendar does not settle by when each decision must be made, who acts, or whose reply is still pending. In a family where both parents work, one person usually handles this: working out by when each decision has to be made, asking family members or grandparents, waiting for replies and following up, and cleaning up what was arranged when plans change. Maniau puts this hidden work on the family's screens so it can be shared.

- **Read notices:** Claude reads text you paste or dictate with your phone keyboard's voice input, and extracts events, belongings, submissions, schedule changes, and more. Each item stays linked to the original text, and the Notices screen shows what was done with each sentence.
- **Show decision deadlines:** From the notice's deadlines, rules the family has registered (after-school care forms, leave requests, how far ahead to ask a grandparent), and the usual week (work, commute, and pickup duties), Maniau estimates by when each option must be chosen and shows the next task. For purchases, it shows when a shop on the way home is open.
- **Make clear who does what:** Maniau proposes each task to one adult and records whether they take it on or decline. Requests to grandparents or after-school care keep "awaiting a reply" separate from "confirmed". Tasks in an option the family is pursuing that have no one assigned appear on every adult's screen.
- **Adapt to changes:** When a postponement or other change arrives, Maniau removes preparations that are no longer needed and drafts cancellation messages for people who were already asked.

The family makes the choices and contacts grandparents, after-school care, and others. Maniau never chooses for the family or sends those messages on its behalf.

Built with Claude: Japan 2026 entry

## How it works

1. **Read (Claude):** Claude reads the notice into typed items such as events, belongings, and deadlines, and records which sentence each item came from. Conditions such as "if the event is postponed" are kept as conditions.
2. **Check (code):** Code confirms that each quote appears in the original text and looks for clear mismatches between the month and day written in the text and the dates read. Items with a problem have no effect on the plan and are shown to the family as needing a check. These checks cover quotes and month-day dates only; they do not guarantee that a reading is correct.
3. **Plan (planning engine):** From the items and the household's information, the engine computes decision deadlines, next tasks, whom to propose each task to, and what a change makes unnecessary.
4. **Verify (verifier):** A verifier written separately from the engine checks plan and notification conditions and stops notifications when it finds a violation.

Date and time calculations, decision deadlines for each option, and decisions about whether to notify are made in code, not replaced by model output.

## Try the demo

You need Node.js 24 or later and pnpm 11.

```sh
pnpm install
pnpm dev
```

Open [http://localhost:5173](http://localhost:5173). The server uses port 8787. If the web app starts on another port, open the URL shown in the terminal. Without the family mode settings (database and Cloudflare Access), the app starts as a demo.

The demo runs on a fictional household and notices; it needs no API key or database. Use the scene selector at the top to move between five points in time, from the day the notice arrives (11/25) to the postponement notice (12/4), and the viewer selector to switch between the two adults. Each scene starts from a prepared state, and actions are kept only in server memory. The prepared notices use Claude responses recorded in advance from fictional text (if a recording is unavailable, a hand-written reading is used and the screen says so).

### Try your own text

When the server has `ANTHROPIC_API_KEY` set (as an environment variable or in `.env` at the repository root), the Notices screen shows a box for your own text. Text you paste, or dictate with your phone keyboard's voice input, is read with the Claude API, and items that can be planned are added to the plan. Sentences with extracted items, and sentences that need a check, are marked as added to the plan, shown in the schedule, read only (no reminders yet), or needing a check.

The text and the items already read in that demo are sent to Anthropic, so use made-up text or remove anything that identifies a person or place. Readings are limited to 5 per demo, 100 per day (UTC) per server process, and 2 at a time. A server running in family mode does not offer demo readings.

## Current scope and limitations

- Reading from photos is in development. Adding a notice as text works only in the demo with an API key set (not yet in family mode).
- Family mode (identity checks with Cloudflare Access, Postgres storage, and Web Push notifications) is implemented. It has not yet been verified on a real device together with an iPhone home-screen app. A push provider accepting a notification does not prove that a person received or read it.
- Do not enter real family data until authentication, deletion, notifications, and related safeguards have been checked in the actual environment. See the [foundation design](docs/design/02-foundation.md) for the requirements.
- Times and travel durations are estimates based on the information entered. Demo shops, opening hours, and travel times are prepared examples; inventory, actual opening hours, routes, and arrival times are not guaranteed.

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
