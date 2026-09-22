// Scheduling rules for CleanIt.
// This module is imported by BOTH the browser app and the GitHub Action that
// sends reminders, so the two can never disagree about what's due.

export const DAY = 86_400_000;

/* ---------- timezone helpers (no dependencies) ---------- */

// How far the given instant's wall clock in `tz` is ahead of UTC, in ms.
function offsetMs(date, tz) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(date).map((p) => [p.type, p.value])
  );
  const asUTC = Date.UTC(
    +parts.year, +parts.month - 1, +parts.day,
    +parts.hour % 24, +parts.minute, +parts.second
  );
  return asUTC - date.getTime();
}

// Calendar fields of `date` as seen in `tz`.
export function zonedParts(date, tz) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour12: false, weekday: 'short',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(date).map((p) => [p.type, p.value])
  );
  const weekdays = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: +parts.year, month: +parts.month, day: +parts.day,
    hour: +parts.hour % 24, minute: +parts.minute, second: +parts.second,
    weekday: weekdays[parts.weekday],
  };
}

// Wall-clock time in `tz` -> the UTC instant it refers to.
// Two passes so it lands correctly on DST-transition days.
function zonedToInstant(y, m, d, h, mi, s, tz) {
  const wall = Date.UTC(y, m - 1, d, h, mi, s);
  let guess = wall;
  for (let i = 0; i < 2; i++) guess = wall - offsetMs(new Date(guess), tz);
  return new Date(guess);
}

/** Midnight at the start of `now`'s local day. */
export function startOfDay(now, tz) {
  const p = zonedParts(now, tz);
  return zonedToInstant(p.year, p.month, p.day, 0, 0, 0, tz);
}

// Days back to the Friday of the weekend in progress: Fri=0, Sat=1, Sun=2.
// Monday–Thursday there is none, and the caller decides which way to look.
const BACK_TO_FRIDAY = { 5: 0, 6: 1, 0: 2 };

// Friday 00:00 through Sunday 23:59:59 local, `shift` days from `p`'s date.
function windowFrom(p, shift, tz) {
  return {
    start: zonedToInstant(p.year, p.month, p.day + shift, 0, 0, 0, tz),
    end: zonedToInstant(p.year, p.month, p.day + shift + 2, 23, 59, 59, tz),
  };
}

/**
 * The weekend that `now` belongs to or is about to run into.
 * Friday 00:00 through Sunday 23:59:59 local. Monday–Thursday look ahead to
 * the coming weekend; Friday–Sunday use the one already in progress.
 */
export function weekendWindow(now, tz) {
  const p = zonedParts(now, tz);
  const backToFriday = BACK_TO_FRIDAY[p.weekday];
  const shift = backToFriday !== undefined ? -backToFriday : 5 - p.weekday;
  return windowFrom(p, shift, tz);
}

/**
 * The most recent weekend that has already *finished* — the deadline the
 * overdue reminders chase. Monday–Thursday that is the weekend just gone;
 * Friday–Sunday the current one is still running, so it is the one before.
 */
export function lastWeekendWindow(now, tz) {
  const p = zonedParts(now, tz);
  const backToFriday = BACK_TO_FRIDAY[p.weekday];
  const shift = backToFriday !== undefined ? -backToFriday - 7 : -(p.weekday + 2);
  return windowFrom(p, shift, tz);
}

/* ---------- state queries ---------- */

export function personName(state, id) {
  return state.people.find((p) => p.id === id)?.name ?? id;
}

export function otherPerson(state, id) {
  return state.people.find((p) => p.id !== id)?.id ?? id;
}

/** Most recent completion of a task, optionally narrowed to one person. */
export function lastDone(state, taskId, personId = null) {
  let best = null;
  for (const entry of state.log) {
    if (entry.taskId !== taskId) continue;
    if (personId && entry.by !== personId) continue;
    const t = new Date(entry.at);
    if (!best || t > best.at) best = { at: t, by: entry.by };
  }
  return best;
}

/* ---------- linked groups ----------
 *
 * Some tasks have to go to the same person because one blocks the other
 * (vacuum upstairs before you Swiffer it). Tasks with the same `group` share
 * one owner, stored on state.groups[group].nextOwner. A member marked
 * `opposite` always goes to the other person, which is how downstairs stays
 * paired against upstairs.
 *
 * The group's turn flips once every member has been done since the last flip,
 * so a half-finished group never splits across people.
 */

function groupOf(state, task) {
  return task.group ? state.groups?.[task.group] : null;
}

function groupMembers(state, groupId) {
  return state.tasks.filter((t) => t.group === groupId && t.active !== false);
}

/** Who a task currently belongs to (not meaningful for mode "each"). */
export function ownerOf(state, task) {
  const g = groupOf(state, task);
  if (g) {
    const base = g.nextOwner ?? state.people[0].id;
    return task.opposite ? otherPerson(state, base) : base;
  }
  return task.nextOwner ?? state.people[0].id;
}

/** Completions of a task since its group's last flip. */
function doneThisCycle(state, task) {
  const g = groupOf(state, task);
  const since = g?.cycleStart ? new Date(g.cycleStart).getTime() : -Infinity;
  return state.log.some((e) => e.taskId === task.id && new Date(e.at).getTime() > since);
}

/**
 * Who does this task next time round. For a grouped task already done this
 * cycle, that is the other person, even though the group has not flipped yet.
 */
export function upNext(state, task) {
  if (task.mode === 'each') return null;
  const owner = ownerOf(state, task);
  return task.group && doneThisCycle(state, task) ? otherPerson(state, owner) : owner;
}

/**
 * Every (task, person) pairing that currently exists, with its due date.
 *
 *   mode "alternate" -> one assignment, owned by ownerOf(task)
 *   mode "each"      -> one assignment per person, tracked independently
 *
 * dueAt === null means "never done, due as soon as possible".
 */
export function assignments(state) {
  const out = [];
  for (const task of state.tasks) {
    if (task.active === false) continue;
    const owners =
      task.mode === 'each'
        ? state.people.map((p) => p.id)
        : [ownerOf(state, task)];

    for (const personId of owners) {
      const scopedTo = task.mode === 'each' ? personId : null;
      const done = lastDone(state, task.id, scopedTo);
      out.push({
        task,
        personId,
        lastDone: done,
        dueAt: done ? new Date(done.at.getTime() + task.frequencyDays * DAY) : null,
      });
    }
  }
  return out;
}

/** Assignments due on or before `cutoff` (never-done ones always qualify). */
export function dueBy(state, cutoff) {
  return assignments(state)
    .filter((a) => a.dueAt === null || a.dueAt <= cutoff)
    .sort((x, y) => (x.dueAt?.getTime() ?? 0) - (y.dueAt?.getTime() ?? 0));
}

function planFor(state, window) {
  const due = dueBy(state, window.end);
  return {
    window,
    byPerson: Object.fromEntries(
      state.people.map((p) => [p.id, due.filter((a) => a.personId === p.id)])
    ),
  };
}

/** What each person owes for the weekend `now` falls into. */
export function weekendPlan(state, now = new Date()) {
  const tz = state.timezone || 'UTC';
  return planFor(state, weekendWindow(now, tz));
}

/**
 * What each person still owes from the weekend that has already ended — the
 * genuinely past-due work, as opposed to what the coming weekend will bring.
 *
 * Anything finished since the deadline falls out on its own: completing a task
 * pushes its due date a full cycle forward, past this window's end.
 */
export function overduePlan(state, now = new Date()) {
  const tz = state.timezone || 'UTC';
  return planFor(state, lastWeekendWindow(now, tz));
}

/* ---------- mutation ---------- */

/**
 * Record a completion. The turn flips to whoever did NOT just do it, so
 * covering for your roommate correctly passes the next turn back to them.
 */
export function completeTask(state, taskId, personId, at = new Date()) {
  const task = state.tasks.find((t) => t.id === taskId);
  if (!task) throw new Error(`Unknown task: ${taskId}`);
  const entry = { taskId, by: personId, at: at.toISOString() };
  state.log.push(entry);

  const g = groupOf(state, task);
  if (g) {
    // Flip only once the whole group is done, and remember how to undo it.
    if (groupMembers(state, task.group).every((m) => doneThisCycle(state, m))) {
      entry.groupFlip = { prevOwner: g.nextOwner, prevCycleStart: g.cycleStart ?? null };
      g.nextOwner = otherPerson(state, g.nextOwner ?? state.people[0].id);
      g.cycleStart = entry.at;
    }
  } else if (task.mode !== 'each') {
    task.nextOwner = otherPerson(state, personId);
  }
  return state;
}

/** Undo the most recent completion of a task, restoring the previous turn. */
export function undoTask(state, taskId, personId) {
  for (let i = state.log.length - 1; i >= 0; i--) {
    const e = state.log[i];
    if (e.taskId !== taskId || (personId && e.by !== personId)) continue;

    state.log.splice(i, 1);
    const task = state.tasks.find((t) => t.id === taskId);
    const g = task && groupOf(state, task);

    if (g) {
      // If the group flipped at or after this entry, the cycle is no longer
      // complete: put the group back how it was before that flip.
      const flip = state.log
        .filter((x) => x.groupFlip && state.tasks.find((t) => t.id === x.taskId)?.group === task.group)
        .filter((x) => new Date(x.at) >= new Date(e.at))
        .pop() ?? (e.groupFlip ? e : null);
      if (flip) {
        g.nextOwner = flip.groupFlip.prevOwner;
        g.cycleStart = flip.groupFlip.prevCycleStart;
        delete flip.groupFlip;
      }
    } else if (task && task.mode !== 'each') {
      task.nextOwner = e.by;
    }
    return state;
  }
  return state;
}
