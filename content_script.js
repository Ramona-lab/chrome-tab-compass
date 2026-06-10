const THROTTLE_MS = 15 * 1000;
let lastSentAt = 0;

const activityEvents = [
  { eventName: "click", kind: "pointer" },
  { eventName: "pointerdown", kind: "pointer" },
  { eventName: "keydown", kind: "typing" },
  { eventName: "input", kind: "typing" },
  { eventName: "change", kind: "typing" },
  { eventName: "scroll", kind: "scroll" },
  { eventName: "selectionchange", kind: "selection" },
  { eventName: "copy", kind: "clipboard" },
  { eventName: "cut", kind: "clipboard" },
  { eventName: "paste", kind: "clipboard" }
];

for (const { eventName, kind } of activityEvents) {
  window.addEventListener(
    eventName,
    () => {
      const now = Date.now();
      if (now - lastSentAt < THROTTLE_MS) {
        return;
      }

      lastSentAt = now;
      chrome.runtime
        .sendMessage({
          type: "user-activity",
          at: now,
          kind
        })
        .catch(() => {
          // Extension reloads can invalidate the content-script context.
        });
    },
    { capture: true, passive: true }
  );
}
