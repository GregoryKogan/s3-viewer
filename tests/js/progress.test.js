import test from "node:test";
import assert from "node:assert/strict";
import { loadTs } from "./loadTs.mjs";

const { api, createPinia, setActivePinia, useProgressStore } = await loadTs(
  "tests/js/progressHarness.ts",
);

const view = (id, state, extra = {}) => ({ id, label: id, done: 0, state, ...extra });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Resolve/reject with the promise, but never leave a timer behind. */
function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Point the store's two IPC calls at one mutable backend list. */
function fakeBackend(initial) {
  let list = initial;
  api.transferProgress = async () => list.map((item) => ({ ...item }));
  api.clearTransfers = async () => {
    const before = list.length;
    list = list.filter((item) => item.state === "running");
    return before - list.length;
  };
  return {
    settle: (items) => {
      list = items;
    },
    get list() {
      return list;
    },
  };
}

test("clear keeps running rows and removes only settled ones", async () => {
  setActivePinia(createPinia());
  const backend = fakeBackend([view("run", "running"), view("done", "done")]);
  const progress = useProgressStore();

  assert.equal(await progress.poll(), true);
  assert.deepEqual(
    progress.items.map((item) => item.id).sort(),
    ["done", "run"],
  );

  await progress.clear();
  assert.deepEqual(
    progress.items.map((item) => item.id),
    ["run"],
  );
  // The backend pruned the finished entry and kept the running one.
  assert.deepEqual(
    backend.list.map((item) => item.id),
    ["run"],
  );
});

test("failed and cancelled rows outlive the done linger; done retries are dropped", async () => {
  setActivePinia(createPinia());
  const backend = fakeBackend([
    view("done", "done"),
    view("failed", "failed", { error: "boom" }),
    view("cancelled", "cancelled"),
  ]);
  const progress = useProgressStore();
  progress.registerRetry("done", async () => {});
  progress.registerRetry("failed", async () => {});
  progress.registerRetry("cancelled", async () => {});

  const originalNow = Date.now;
  let now = originalNow();
  Date.now = () => now;
  try {
    await progress.poll();
    assert.equal(progress.hasRetry("done"), false, "a done transfer does not need a retry");
    assert.equal(progress.hasRetry("failed"), true);
    assert.equal(progress.hasRetry("cancelled"), true);

    // Move past the seven-second linger for completed rows.
    now += 8000;
    await progress.poll();
    assert.deepEqual(
      progress.items.map((item) => item.id).sort(),
      ["cancelled", "failed"],
    );
  } finally {
    Date.now = originalNow;
  }
});

test("clear during a settle does not strand waitForAll", async () => {
  setActivePinia(createPinia());
  const backend = fakeBackend([view("a", "running")]);
  const progress = useProgressStore();

  const waiting = progress.waitForAll(["a"]);
  // Let the first poll observe the running transfer and start its 250 ms sleep.
  await sleep(60);

  // It settles, and the user clears before the next poll can see the result.
  backend.settle([view("a", "done")]);
  await progress.clear();

  const [outcome] = await withTimeout(waiting, 2000);
  assert.notEqual(outcome.state, "running");
  assert.equal(outcome.state, "cancelled");
  assert.match(outcome.error ?? "", /cleared before it settled/);
});

test("clear does not lose a settled row a waiter already observed", async () => {
  setActivePinia(createPinia());
  const backend = fakeBackend([view("a", "running")]);
  const progress = useProgressStore();

  const waiting = progress.waitForAll(["a"]);
  await sleep(10);
  // A normal poll observes the result while the waiter is asleep; Clear then
  // prunes the backend entry before the waiter's next poll.
  backend.settle([view("a", "done")]);
  await progress.poll();
  await progress.clear();

  const [outcome] = await withTimeout(waiting, 2000);
  assert.equal(outcome.state, "done");
});

test("a double click starts only one retry", async () => {
  setActivePinia(createPinia());
  fakeBackend([]);
  const progress = useProgressStore();

  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let started = 0;
  progress.registerRetry("x", async () => {
    started += 1;
    await gate;
  });

  const first = progress.retry("x");
  const second = progress.retry("x");
  assert.equal(started, 1);
  assert.equal(progress.isRetrying("x"), true);

  release();
  await Promise.all([first, second]);
  assert.equal(progress.isRetrying("x"), false);
  assert.equal(progress.hasRetry("x"), false);
});
