# Maniau

[日本語](README.md)

**Turns nursery and school notices into clear next steps for the family: what to decide, by when, and who does it.**

Putting an event in a calendar does not settle by when each decision must be made, who acts, or whose reply is still pending. In a family where both parents work, one person usually handles this: working out by when each decision has to be made, asking family members or grandparents, waiting for replies and following up, and cleaning up what was arranged when plans change. Maniau puts this hidden work on the family's screens so it can be shared.

## What it does

- **Read notices:** Claude reads text you paste or dictate, or a photo or PDF of a handout, and turns events, belongings, submissions and changes into items linked to the original text.
- **Show decision deadlines:** From the notice's deadlines, rules the family has registered (after-school care forms, leave requests, how far ahead to ask a grandparent) and the usual week, Maniau shows by when each option must be chosen and the next task.
- **Choose:** Maniau lists the options you can still choose with how long each one remains available, and shows a suggestion with its reason and what would happen if you chose each option, computed with the same calculation without recording anything.
- **Take it on and follow up:** Maniau proposes each task to one adult and records whether they take it on. Requests to grandparents or after-school care keep "awaiting a reply" separate from "confirmed". “What if they say no?” shows ahead of time what would happen if the answer is no.
- **Adapt to changes:** When a postponement arrives, Maniau removes preparations that are no longer needed and drafts cancellation messages for people who were already asked.
- **Handle other things to do:** What the family says and the attendance or applications a notice asks for go through the same flow. Claude can suggest ways to handle them (these are inferred, and nothing changes until the family corrects and saves them).
- **Update in a few words:** From a short update such as "Grandma says 12/7 is fine", Maniau finds the matching request or task and suggests what to record.

For details, see [Details and limitations](docs/scope.en.md).

The family makes the choices and contacts grandparents, after-school care, and others. Maniau never chooses for the family or sends those messages on its behalf.

Built with Claude: Japan 2026 entry

## Tour of the demo

Use the scene selector at the top to move between points in time, and “Viewing as” to switch between the two adults (健太 and 彩). Each scene also shows a one-line guide at the top of the screen.

1. **11/25 Notice arrives:** A school-event notice creates child care for 陽菜 on 12/7 and a shirt to prepare. Tap “Decide” to compare each option's decision deadline and what happens if you choose it.
2. **11/26 Errand on the way home:** 彩 asked おばあちゃん and is waiting for the reply. 健太 has a task to buy the shirt at a shop on the way home.
3. **11/29 No reply yet:** The after-school care deadline is close. On 彩's screen, Maniau asks whether to hold a backup, and “What if they say no?” shows the calculation if the answer is no.
4. **11/30 Backup booked:** After-school care is held as a backup while waiting for おばあちゃん. On 彩's screen, “What if they say no?” shows the plan moving on to it.
5. **12/4 Postponed:** Child care that is no longer needed, and the cancellations to send, split between the two adults.

To have Claude read a notice, tap “Snap” at the bottom, then “Insert a sample notice (fictional)”, then “Read it” (only on a server with a reading key). The sample postpones the school event. After reading, the Notices screen shows what each sentence was read as, and what went into the plan appears on the Today screen.

## How it works

1. **Read (Claude):** Claude reads the notice into typed items such as events, belongings, and deadlines, and records which sentence each item came from. Conditions such as "if the event is postponed" are kept as conditions.
2. **Check (code):** Code checks whether each quote appears in the original text and looks for clear mismatches between the month and day written in the text and the dates read. Items with a problem have no effect on the plan and are shown to the family as needing a check. These checks cover quotes and month-day dates only; they do not guarantee that a reading is correct.
3. **Plan (planning engine):** From the items and the household's information, the engine computes decision deadlines, next tasks, whom to propose each task to, and what a change makes unnecessary.
4. **Verify (verifier):** A verifier written separately from the engine checks plan and notification conditions and stops notifications when it finds a violation.

Date and time calculations, decision deadlines for each option, and decisions about whether to notify are made in code, not replaced by model output.

## Run it locally

You need Node.js 24 or later and pnpm 11.

```sh
pnpm install
pnpm dev
```

Open [http://localhost:5173](http://localhost:5173). The server uses port 8787. If the web app starts on another port, open the URL shown in the terminal. Without the family mode settings (database and Cloudflare Access), the app starts as a demo.

The demo runs on a fictional household and notices; it needs no API key or database. Use the scene selector at the top to move between five points in time, from the day the notice arrives (11/25) to the postponement notice (12/4), and the viewer selector to switch between the two adults. Each scene starts from a prepared state, and actions are kept only in server memory. The prepared notices use Claude responses recorded in advance from fictional text (if a recording is unavailable, a hand-written reading is used and the screen says so).

### Try your own text

When the server has `ANTHROPIC_API_KEY` set (as an environment variable or in `.env` at the repository root), you can try reading text and photos, quick updates, and ideas for ways with Claude. What is sent to Anthropic and the usage limits are in [Details and limitations](docs/scope.en.md#try-your-own-text). Please try it with fictional text.

## Scope and limitations

What Maniau can't do yet, and what hasn't been checked, is listed in [Details and limitations](docs/scope.en.md#current-scope-and-limitations).

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
