# CleanIt

A shared cleaning rotation for two people. No server, no database, no
third-party account — it runs on two GitHub repos:

- **this repo (public)** — the app, a static page served by GitHub Pages, plus
  the scheduling rules and the reminder script
- **`<name>-data` (private)** — your names, chores, and the full completion log,
  plus the GitHub Actions cron that sends the Friday reminders

The split exists because free GitHub Pages only publishes from a public repo.
Keeping the data in a separate private repo means nothing personal is exposed:
this repo holds code only, and the deployed site is an empty shell until someone
signs in with a token.

- **Friday afternoon** each person gets a push listing the chores they owe that
  weekend, with the how-to steps for each one. A **Saturday-night** nudge and a
  **Sunday 5pm** last call chase whatever is still outstanding. Anything still
  not done once Sunday is over is **past due**, and gets chased at **8am and
  6pm every day** until it is.
- **Tap a chore off** in the app. It records who did it and when, the next turn
  goes to the other person, and you get a small celebration on screen.
- **History** is the permanent record — and because every change is a git
  commit, `git log data/state.json` is an even more complete one.

## How the rotation works

The **Tasks** tab opens with the daily / after-use house rules — a reference
list with no tracking or reminders — then the rotating tasks, sectioned by how
often they come round. Tap a task to edit its name, frequency, or reminder
instructions; tap a name pill to hand it to the other person.

Each task carries its own frequency and its own "up next" person, so the two of
you split every weekend rather than trading whole weekends.

Tasks can be **linked** with a shared `group`, when one has to follow another.
The floors are linked so that whoever vacuums upstairs also Swiffers it — nobody
waits on the other person — while downstairs (marked `opposite`) always goes to
the other one. A linked group only rotates once every task in it is done, so it
can never end up split.

| Mode | Meaning |
| --- | --- |
| `alternate` | One of you does it; the turn flips to the other each time it's done. |
| `each` | You both do your own, every cycle, tracked separately. Used for the bathroom. |

A task appears on the weekend list when its due date (last done + frequency)
falls on or before that Sunday. Nothing is ever dropped: miss a weekend and it
carries over, marked how many days overdue it is.

The turn flips to whoever did *not* just do it — so if you cover for your
roommate, the next turn correctly goes back to them.

## Setup

```bash
gh auth login
npm install
npm run setup
```

`npm run setup` asks for your names and time zone, then creates the private data
repo from `template/`, generates the VAPID keypair, writes `config.js`, uploads
the Actions secrets, pushes both repos, and turns on Pages.

Then each of you, once:

1. Create a [fine-grained token](https://github.com/settings/personal-access-tokens/new)
   scoped to **the private data repo only**, with **Contents: Read and write**.
2. On your iPhone open the Pages URL in Safari → Share → **Add to Home Screen**
   → open CleanIt from the icon.
3. Settings → pick who you are, paste the token, tap **Turn on reminders**.

Step 2 is not optional. iOS only delivers web push to a page that has been
installed to the Home Screen and opened from that icon — a normal Safari tab
will never receive one.

## Day-to-day

Tap the checkbox next to a chore. That's it. Tapping a completed one again undoes
it and restores the previous turn.

The **Tasks** tab is where you change how often something comes around, switch it
between `alternate` and `each`, hand the next turn to a specific person, or edit
the instructions that go out in the reminder.

## Celebrations

Checking a chore off plays a themed animation, chosen from the task's name in
`animations.js`:

| Task looks like | You get |
| --- | --- |
| vacuum, couch, carpet | little vacuums trundling across, hoovering up dust |
| swiffer, mop, sweep, floor | brooms sweeping past |
| bath, tub, shower, toilet, sink | bubbles rising |
| fridge, freezer, ice | snow and ice drifting down |
| stove, counter, kitchen, wipe | sparkles |
| anything else | confetti |

Rename a task and it re-matches on its own. To pin one explicitly, set an
`animation` field on the task to a theme name. Nothing plays for anyone whose
system asks for reduced motion.

## Reminders

Every stage only chases what is still outstanding — whoever has finished hears
nothing more:

| Stage | When (local) | Says |
| --- | --- | --- |
| `friday` | Friday, `reminderHour` (4pm) | the weekend's list, with how-to steps |
| `saturday` | Saturday, `saturdayHour` (8pm) | what's left, due tomorrow |
| `sunday` | Sunday, `sundayHour` (5pm) | last call, finish tonight |
| `overdue-<day>-am/pm` | Mon–Thu at `overdueMorningHour` (8am) and `overdueEveningHour` (6pm), plus Friday at 8am | past due, the list, and that we agreed on Sunday |

The first three chase the weekend **in progress**. The overdue ones chase the
weekend that has already **ended** — so on a Wednesday they list what was due
last Sunday, not what the coming weekend will bring. Finishing a chore pushes
its due date a full cycle forward, which drops it out of the overdue list by
itself; when someone's list is empty they stop hearing anything.

They run Monday 8am through Friday 8am. Friday gets a morning nudge only: the
new weekend list lands that afternoon carrying the same tasks, marked how many
days overdue they are, so an evening repeat would only say it all again.


The cron lives in the **data** repo (`.github/workflows/remind.yml`, created
from `template/`). It checks out this repo for the code and runs hourly from
Friday evening UTC through Monday's small hours, then four times a day
Monday–Friday for the past-due nudges. `scripts/send-reminders.mjs` works out
which stage the current *local* moment belongs to, from `timezone` and the hour
settings in the data repo's `state.json`.

The weekend lines never need editing — they run hourly, so daylight saving
cannot shift them. The weekday lines are the exception: they fire at the two
UTC hours that mean 8am and 6pm in `America/New_York` in either half of the
year, because running hourly all week would spend a lot of Actions minutes on a
private repo. Edit those two lines if you change `timezone`,
`overdueMorningHour` or `overdueEveningHour`.

It records who it has told for each stage, so a run delayed by GitHub still
lands exactly once. Earlier stages are marked superseded when a later one goes
out, so a missed Friday run can never deliver a stale Friday message on Sunday
— you get the Saturday or Sunday wording instead.

Preview what the notifications will say, without sending anything:

```bash
CLEANIT_DATA_DIR=../cleanit-data/data npm run remind -- --dry-run
```

Add `--stage=saturday` (or `friday`/`sunday`/`overdue`) to preview a specific
one, and `CLEANIT_NOW=2026-09-22T12:00:00Z` to pretend it is another moment —
useful for the overdue stages, which only exist Monday to Friday.

Send one right now (Actions tab → Chore reminders → Run workflow) if you want
to test on a real phone.

## Local development

```bash
npm run preview
```

Serves the app at <http://localhost:8787> against a small emulator of the GitHub
contents API, so the app code runs unmodified. It works on a scratch copy in
`.preview-data/` (seeded from `data/seed.json`, gitignored), so experimenting
never touches the real data. Any non-empty string works as the token. Push
notifications can't be exercised locally — that needs the deployed HTTPS site.

## What is and isn't public

Public, in this repo: the app source, the scheduling rules, and `data/seed.json`
— the starting chore template, with no names and an empty log.

Private, in the data repo: your names, your live chore list and instructions,
every completion date, and your push subscriptions.

The deployed Pages site is reachable by URL but contains no data — it fetches
everything from the private repo using the token in your browser. Your tokens
are never committed; they live in each browser's `localStorage` only.

If you would rather have a single private repo, GitHub Pro allows Pages from
one. Then move `data/` and the cron back here and point `config.js` at this
repo.

## Layout

This repo (public):

```
index.html  app.js  styles.css     the app
animations.js                      completion celebrations
schedule.js                        due dates and rotation, shared by app and cron
config.js                          data repo + VAPID public key (written by setup)
sw.js  manifest.webmanifest        service worker and PWA install metadata
data/seed.json                     starting chore template, no personal data
scripts/send-reminders.mjs         builds and sends the push reminders
scripts/setup.mjs                  creates both repos and wires them together
template/                          scaffold for the private data repo
.github/workflows/deploy.yml       publishes the app to Pages
```

The data repo (private):

```
data/state.json                    people, tasks, and the completion log
data/subscriptions.json            one push subscription per person
data/reminders-sent.json           dedupe marker for the cron
.github/workflows/remind.yml       weekend + past-due cron; checks out this repo
```
